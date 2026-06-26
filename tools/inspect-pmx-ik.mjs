// PMX のボーン／IK 構造を解析して、足IK周りを表示する診断ツール。
//   使い方: node tools/inspect-pmx-ik.mjs "<pmxパス>"
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) { console.error('PMXパスを指定してください'); process.exit(1); }

const buf = await readFile(path);
let off = 0;
const u8 = () => buf.readUInt8(off++);
const i32 = () => { const v = buf.readInt32LE(off); off += 4; return v; };
const f32 = () => { const v = buf.readFloatLE(off); off += 4; return v; };

// signature + version
const sig = buf.toString('ascii', 0, 4); off = 4;
const version = f32();
const globalCount = u8();
const globals = [];
for (let i = 0; i < globalCount; i++) globals.push(u8());
const encoding = globals[0];      // 0=UTF-16LE, 1=UTF-8
const addUV = globals[1];
const vIdx = globals[2], tIdx = globals[3], mIdx = globals[4], bIdx = globals[5], moIdx = globals[6], rIdx = globals[7];

function text() {
  const len = i32();
  const s = encoding === 0 ? buf.toString('utf16le', off, off + len) : buf.toString('utf8', off, off + len);
  off += len;
  return s;
}
function idx(size) {
  let v;
  if (size === 1) v = buf.readInt8(off);
  else if (size === 2) v = buf.readInt16LE(off);
  else v = buf.readInt32LE(off);
  off += size;
  return v;
}

console.log(`sig=${sig.trim()} ver=${version} enc=${encoding === 0 ? 'UTF-16LE' : 'UTF-8'} boneIdxSize=${bIdx}`);
text(); text(); text(); text(); // names/comments

// vertices
const vCount = i32();
for (let i = 0; i < vCount; i++) {
  off += 12 + 12 + 8 + 16 * addUV; // pos normal uv addUV
  const wt = u8();
  if (wt === 0) off += bIdx;                        // BDEF1
  else if (wt === 1) off += bIdx * 2 + 4;           // BDEF2
  else if (wt === 2) off += bIdx * 4 + 16;          // BDEF4
  else if (wt === 3) off += bIdx * 2 + 4 + 36;      // SDEF
  else if (wt === 4) off += bIdx * 4 + 16;          // QDEF
  off += 4;                                         // edge scale
}

// surfaces
const sCount = i32();
off += sCount * vIdx;

// textures
const texCount = i32();
for (let i = 0; i < texCount; i++) text();

// materials
const matCount = i32();
for (let i = 0; i < matCount; i++) {
  text(); text();                 // name, nameEng
  off += 16 + 12 + 4 + 12;        // diffuse specular specularStr ambient
  off += 1;                       // drawFlag
  off += 16 + 4;                  // edgeColor edgeSize
  off += tIdx + tIdx + 1;         // tex, sphereTex, sphereMode
  const toonFlag = u8();
  off += toonFlag === 0 ? tIdx : 1;
  text();                         // memo
  off += 4;                       // surface count
}

// bones
const boneCount = i32();
const bones = [];
for (let i = 0; i < boneCount; i++) {
  const name = text();
  text();                         // nameEng
  const pos = [f32(), f32(), f32()]; // position
  const parent = idx(bIdx);
  const layer = i32();
  const flags = buf.readUInt16LE(off); off += 2;
  if (flags & 0x0001) off += bIdx; else off += 12; // connect index / offset
  let grant = null;
  if ((flags & 0x0100) || (flags & 0x0200)) {
    const gp = idx(bIdx); const gr = f32();
    grant = { parent: gp, ratio: gr, rot: !!(flags & 0x0100), pos: !!(flags & 0x0200) };
  }
  if (flags & 0x0400) off += 12;  // fixed axis
  if (flags & 0x0800) off += 24;  // local axis
  if (flags & 0x2000) off += 4;   // external parent
  let ik = null;
  if (flags & 0x0020) {
    const target = idx(bIdx);
    const loop = i32();
    const limitAngle = f32();
    const linkCount = i32();
    const links = [];
    for (let l = 0; l < linkCount; l++) {
      const li = idx(bIdx);
      const hasLimit = u8();
      let lower = null, upper = null;
      if (hasLimit) { lower = [f32(), f32(), f32()]; upper = [f32(), f32(), f32()]; }
      links.push({ index: li, hasLimit, lower, upper });
    }
    ik = { target, loop, limitAngle, links };
  }
  bones.push({ i, name, pos, parent, layer, flags, grant, ik });
}

const nameOf = (i) => (i >= 0 && i < bones.length) ? bones[i].name : `(${i})`;
const byName = (n) => bones.find((b) => b.name === n);
const dist = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);

console.log('\n=== 脚の実寸（左脚） ===');
const ashi = byName('左足'), hiza = byName('左ひざ'), kubi = byName('左足首'), ik = byName('左足ＩＫ');
if (ashi && hiza && kubi) {
  console.log(`  左足  Y=${ashi.pos[1].toFixed(2)}  (太もも長 足→ひざ = ${dist(ashi, hiza).toFixed(2)})`);
  console.log(`  左ひざ Y=${hiza.pos[1].toFixed(2)}  (すね長 ひざ→足首 = ${dist(hiza, kubi).toFixed(2)})`);
  console.log(`  左足首 Y=${kubi.pos[1].toFixed(2)}`);
  console.log(`  脚全長(足→ひざ→足首) = ${(dist(ashi, hiza) + dist(hiza, kubi)).toFixed(2)}`);
  if (ik) console.log(`  左足ＩＫ rest = [${ik.pos.map((v) => v.toFixed(2)).join(', ')}] (Y=${ik.pos[1].toFixed(2)})`);
}

console.log(`\n総ボーン数: ${boneCount}`);
// --- ビューワーの tuneModelIK と同じロジックで再ポイント結果をシミュレート ---
console.log('\n=== 再ポイント・シミュレーション（ひざを含む脚IKのみ） ===');
let simCount = 0;
for (const b of bones) {
  if (!b.ik) continue;
  const hasKnee = b.ik.links.some((l) => /ひざ|膝|knee/i.test(nameOf(l.index)));
  if (!hasKnee) continue;
  let probe = b.i, source = -1;
  for (let d = 0; d < 8 && probe >= 0 && bones[probe]; d++) {
    const g = bones[probe].grant;
    if (g && g.pos && g.parent >= 0) { source = g.parent; break; }
    probe = bones[probe].parent;
  }
  if (source >= 0 && source !== b.i) {
    console.log(`  脚IK "${b.name}"(#${b.i}) のターゲットを #${b.i} → #${source} "${nameOf(source)}" へ再ポイント`);
    simCount++;
  } else {
    console.log(`  脚IK "${b.name}"(#${b.i}) は付与チェーンなし → 変更しない（直結IK）`);
  }
}
if (!simCount) console.log('  （再ポイント対象なし）');

console.log('\n=== 足・IK 関連ボーン ===');
for (const b of bones) {
  if (/足|ひざ|膝|つま|IK|ＩＫ|脚|腿|すね|脛/i.test(b.name)) {
    const ikInfo = b.ik
      ? ` [IK target=${nameOf(b.ik.target)} loop=${b.ik.loop} limitAngle=${b.ik.limitAngle.toFixed(3)} links=${b.ik.links.map(l => nameOf(l.index) + (l.hasLimit ? '*' : '')).join(', ')}]`
      : '';
    const grantInfo = b.grant
      ? ` GRANT{parent=${nameOf(b.grant.parent)} ratio=${b.grant.ratio.toFixed(2)} ${b.grant.pos ? '移動' : ''}${b.grant.rot ? '回転' : ''}}`
      : '';
    console.log(`  #${b.i} "${b.name}" parent=${nameOf(b.parent)} layer=${b.layer} flags=0x${b.flags.toString(16)}${grantInfo}${ikInfo}`);
    if (b.ik) {
      for (const l of b.ik.links) {
        if (l.hasLimit) {
          console.log(`        link "${nameOf(l.index)}" lower=[${l.lower.map(v => v.toFixed(3)).join(',')}] upper=[${l.upper.map(v => v.toFixed(3)).join(',')}]`);
        }
      }
    }
  }
}

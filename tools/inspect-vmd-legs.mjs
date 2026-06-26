// VMD のボーンキーフレームを解析し、脚関連ボーンの動き（足ＩＫの位置で持ち上げているか／
// 足・ひざのFK回転か）を表示する診断ツール。
//   使い方: node tools/inspect-vmd-legs.mjs "<vmdパス>"
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) { console.error('VMDパスを指定してください'); process.exit(1); }
const buf = await readFile(path);
const sjis = new TextDecoder('shift_jis');

let off = 30; // header 30 bytes
off += 20;    // model name 20 bytes
const boneCount = buf.readUInt32LE(off); off += 4;

const stats = new Map(); // name -> {count, posY:[min,max], posAbsMax, rotMoved}
for (let i = 0; i < boneCount; i++) {
  const nameBytes = buf.subarray(off, off + 15);
  const nul = nameBytes.indexOf(0);
  const name = sjis.decode(nameBytes.subarray(0, nul === -1 ? 15 : nul));
  off += 15;
  const frame = buf.readUInt32LE(off); off += 4;
  const px = buf.readFloatLE(off); const py = buf.readFloatLE(off + 4); const pz = buf.readFloatLE(off + 8); off += 12;
  const qx = buf.readFloatLE(off); const qy = buf.readFloatLE(off + 4); const qz = buf.readFloatLE(off + 8); const qw = buf.readFloatLE(off + 12); off += 16;
  off += 64; // interpolation

  let s = stats.get(name);
  if (!s) { s = { count: 0, minY: Infinity, maxY: -Infinity, posAbsMax: 0, rotMax: 0 }; stats.set(name, s); }
  s.count++;
  s.minY = Math.min(s.minY, py);
  s.maxY = Math.max(s.maxY, py);
  s.posAbsMax = Math.max(s.posAbsMax, Math.abs(px), Math.abs(py), Math.abs(pz));
  // 回転の大きさ（恒等四元数 w=1 からのズレ）
  s.rotMax = Math.max(s.rotMax, 1 - Math.abs(qw));
}

console.log(`総ボーンキーフレーム数: ${boneCount} / ユニークボーン数: ${stats.size}`);
console.log('\n=== 脚関連ボーンのキーフレーム統計 ===');
console.log('(posAbsMax=位置移動の最大絶対値, Yレンジ=足の上下動, rotMax=回転量0..1)');
const legNames = [...stats.keys()].filter((n) => /足|ひざ|膝|つま|ＩＫ|IK|脚|腿|すね|脛/.test(n));
legNames.sort();
for (const n of legNames) {
  const s = stats.get(n);
  const yr = (s.maxY - s.minY);
  console.log(`  "${n}": keys=${s.count} posAbsMax=${s.posAbsMax.toFixed(2)} Yレンジ=${yr.toFixed(2)} rotMax=${s.rotMax.toFixed(3)}`);
}

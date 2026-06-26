// motions/ 直下の各サブフォルダ（＝曲フォルダ）を走査し、motions/motions.json を生成する。
// 各曲フォルダには .vmd（ダンスモーション）と音源（.mp3 等）を 1 セットで置く想定。
// 使い方:  node tools/build-motions-manifest.mjs
//   → motions/motions.json に { "motions": [ { name, vmd, audio }, ... ] } を書き出す。
// 曲を追加・削除・改名したら、このコマンドを実行してコミットすればよい。

import { readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOTIONS_DIR = join(ROOT, 'motions');
const VMD_EXT = '.vmd';
const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav'];

const lower = (s) => s.toLowerCase();
const isVmd = (name) => lower(name).endsWith(VMD_EXT);
const isAudio = (name) => AUDIO_EXTS.some((ext) => lower(name).endsWith(ext));

async function listSubdirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

const motions = [];
for (const folder of await listSubdirs(MOTIONS_DIR)) {
  const files = await listFiles(join(MOTIONS_DIR, folder));
  const vmd = files.find(isVmd);
  const audio = files.find(isAudio);
  if (!vmd || !audio) {
    console.warn(`スキップ: ${folder}（.vmd または音源が見つかりません）`);
    continue;
  }
  motions.push({ name: folder, vmd: `${folder}/${vmd}`, audio: `${folder}/${audio}` });
}

motions.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

const json = JSON.stringify({ motions }, null, 2) + '\n';
await writeFile(join(MOTIONS_DIR, 'motions.json'), json, 'utf8');
console.log(`motions/motions.json を更新しました（${motions.length} 件）:`);
for (const m of motions) console.log(`  - ${m.name}  (${m.vmd} / ${m.audio})`);

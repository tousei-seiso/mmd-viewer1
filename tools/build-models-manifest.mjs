// models/ 以下（サブフォルダ含む）の .pmx / .pmd を走査し、models/models.json を生成する。
// 使い方:  node tools/build-models-manifest.mjs
//   → models/models.json に { "models": ["foo/a.pmx", ...] } を書き出す。
// モデルを追加・削除・改名したら、このコマンドを実行してコミットすればよい。

import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'models');
const EXTS = ['.pmx', '.pmd'];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (EXTS.some((ext) => e.name.toLowerCase().endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(MODELS_DIR);
// models/ からの相対パスへ変換し、URL で使うため区切りを '/' に統一
const list = files
  .map((f) => relative(MODELS_DIR, f).split(sep).join('/'))
  .sort((a, b) => a.localeCompare(b, 'ja'));

const json = JSON.stringify({ models: list }, null, 2) + '\n';
await writeFile(join(MODELS_DIR, 'models.json'), json, 'utf8');
console.log(`models/models.json を更新しました（${list.length} 件）:`);
for (const m of list) console.log('  - ' + m);

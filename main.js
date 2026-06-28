// =============================================================================
// MMD Viewer ―― エントリーポイント
//   アプリ本体は役割ごとにモジュールへ分離済み。ここでは各モジュールの初期化を
//   正しい順序で呼び出すだけ。
//     sensor.js  … スマホの傾き(揺れ)・加速度センサーの検出／値保持／デバッグ表示
//     view3d.js  … 3D シーン・モデル・ダンス・物理エンジン本体と描画ループ
//     audio.js   … 楽曲(MP3)の読み込み・再生制御・シークバー（タイムライン）
//     ui.js      … 各種アイコン・ダイアログ・カラーパレット等の UI 配線
// =============================================================================

import { initSensors } from './sensor.js';
import { initAudio } from './audio.js';
import * as view3d from './view3d.js';
import { initUI } from './ui.js';

// 1) センサー入力（加速度・揺れもの）の購読開始
initSensors();

// 2) オーディオ・再生制御へ、3D 側の依存（ダンス共有状態・モデル準備状態・物理ゲート
//    同期・ミキサー適用）を注入して配線する。view3d の描画ループが動き出す前に行う。
initAudio({
  danceState: view3d.danceState,
  isModelReady: view3d.isModelReady,
  syncPhysics: view3d.syncPhysics,
  applyMixerDelta: view3d.applyMixerDelta,
});

// 3) 3D シーンの構築・入力イベント登録・モデル読み込み・描画ループ開始
view3d.initView3d();

// 4) UI（各種アイコン・ダイアログ・カラーパレット）の配線
initUI();

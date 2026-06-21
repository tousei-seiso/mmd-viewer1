// =============================================================================
// MMD Viewer ―― ステップ1：ステージ作成とモデル表示の土台
// Three.js + MMDLoader を CDN から読み込み、画面全体に 3D 空間を構築する。
// =============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';

// -----------------------------------------------------------------------------
// 設定値
// -----------------------------------------------------------------------------

// 後で自分でフォルダ内に配置する想定の「仮の」モデルファイル候補。
// 例：プロジェクト直下に models/ フォルダを作り、model.pmx か model.pmd を置く。
// 先頭から順に読み込みを試み、失敗したら次の候補へフォールバックする。
const MODEL_CANDIDATES = ['models/model.pmx', 'models/model.pmd'];

// キャラクターの「中心」とみなす高さ（MMD モデルは概ね 20 ユニット前後の身長。
// 腰〜胸あたりの 10 前後を注視点にすると自然に収まる）。
const CHARACTER_CENTER = new THREE.Vector3(0, 10, 0);

// ジャイロ連動の調整値
const TILT_LIMIT_DEG = 35; // この角度（度）で効果が最大になるよう正規化する
const OFFSET_MAX = 6;      // カメラ位置をずらす最大量（ワールド単位）
const OFFSET_SMOOTHING = 0.1; // オフセットの追従の滑らかさ（0〜1、小さいほど滑らか）

// -----------------------------------------------------------------------------
// 基本オブジェクト（シーン・カメラ・レンダラー）
// -----------------------------------------------------------------------------

const container = document.getElementById('viewer');
const statusEl = document.getElementById('status');

// シーン
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x223344);

// カメラ
const camera = new THREE.PerspectiveCamera(
  45,                                          // 視野角
  window.innerWidth / window.innerHeight,      // アスペクト比
  0.1,                                         // ニアクリップ
  1000                                         // ファークリップ
);
// 初期位置：キャラクターの「正面 少し斜め上」から見下ろす。
//   x:  少し右へずらして斜めから
//   y:  中心より高く（見下ろす）
//   z:  正面（+Z 側）に距離をとる
camera.position.set(8, 18, 28);

// レンダラー
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 高 DPI 端末の負荷を抑制
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// -----------------------------------------------------------------------------
// カメラ操作（OrbitControls）
//   常にキャラクターの中心を向くように target を設定する。
// -----------------------------------------------------------------------------

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CHARACTER_CENTER); // 注視点＝キャラクター中心
controls.enableDamping = true;          // 慣性つきで滑らかに（スマホ操作と相性が良い）
controls.dampingFactor = 0.08;
controls.minDistance = 5;               // 寄りすぎ防止
controls.maxDistance = 80;              // 引きすぎ防止
controls.maxPolarAngle = Math.PI * 0.95; // 床下まで回り込みすぎないように制限
controls.update();

// -----------------------------------------------------------------------------
// ライト・地面（ステージ）
// -----------------------------------------------------------------------------

// 環境光（全体を柔らかく底上げ）
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

// 平行光源（太陽光のような主光源。影を落とす）
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(10, 30, 20);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 100;
dirLight.shadow.camera.left = -25;
dirLight.shadow.camera.right = 25;
dirLight.shadow.camera.top = 25;
dirLight.shadow.camera.bottom = -25;
scene.add(dirLight);

// 地面（影を受けるステージ床）
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ color: 0x335577, roughness: 1.0 })
);
ground.rotation.x = -Math.PI / 2; // 水平に倒す
ground.receiveShadow = true;
scene.add(ground);

// グリッド（位置の目安）
const grid = new THREE.GridHelper(100, 50, 0x88aacc, 0x446688);
grid.material.opacity = 0.35;
grid.material.transparent = true;
scene.add(grid);

// -----------------------------------------------------------------------------
// MMD モデルの読み込み
// -----------------------------------------------------------------------------

const loader = new MMDLoader();

// 1 つのパスを Promise で読み込むラッパー。MMDLoader は拡張子（.pmx / .pmd）で
// パーサを自動的に切り替えるため、こちらは候補パスを渡すだけでよい。
function loadModel(path) {
  return new Promise((resolve, reject) => {
    loader.load(
      path,
      resolve,
      // 進捗
      (xhr) => {
        if (xhr.lengthComputable) {
          const percent = Math.floor((xhr.loaded / xhr.total) * 100);
          setStatus(`モデルを読み込んでいます… ${percent}%`);
        }
      },
      reject
    );
  });
}

// 候補パスを先頭から順に試し、成功した時点で確定する。
// （.pmx が見つからない／読み込めない場合は自動的に .pmd へフォールバック）
async function loadModelWithFallback(paths) {
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    try {
      const mesh = await loadModel(path);
      return { mesh, path };
    } catch (error) {
      console.warn(`読み込み失敗: ${path}`, error);
      // 次の候補があればリトライ、なければ最後のエラーを投げる
      if (i === paths.length - 1) throw error;
      setStatus(`${path} が見つかりません。次の候補を試します…`);
    }
  }
}

loadModelWithFallback(MODEL_CANDIDATES)
  .then(({ mesh, path }) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    console.log(`モデルを読み込みました: ${path}`);
    setStatus('読み込み完了', true);
  })
  .catch((error) => {
    // すべての候補が失敗（モデル未配置でもアプリが落ちないようにする）
    console.error('モデルの読み込みに失敗しました:', error);
    setStatus(`モデルを読み込めませんでした（${MODEL_CANDIDATES.join(' / ')} のいずれかを配置してください）`);
  });

// -----------------------------------------------------------------------------
// ジャイロ（傾きセンサー）連動
//   方針：OrbitControls が決める「ベースのカメラ位置」を毎フレームそのまま使い、
//   そこに傾き由来の「オフセット（ズレ量）」を加算してから描画する。
//   描画後にベース位置へ復元するため、OrbitControls はオフセットの影響を受けず、
//   スワイプ操作とジャイロがケンカしない。
// -----------------------------------------------------------------------------

let neutralOrientation = null; // 最初の傾きを基準（中立）として記録する

// 目標オフセットと、実際に適用中のオフセット（滑らかに目標へ追従させる）
const targetOffset = new THREE.Vector3(0, 0, 0);
const currentOffset = new THREE.Vector3(0, 0, 0);
// 描画前にベース位置を退避しておくための一時変数
const basePosition = new THREE.Vector3();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// DeviceOrientation：beta＝前後の傾き、gamma＝左右の傾き（いずれも度）。
function onDeviceOrientation(event) {
  if (event.beta === null || event.gamma === null) return;

  // 最初の有効なイベントの姿勢を「中立」として記録し、以降は相対角で扱う。
  // これにより、スマホの持ち方（角度）に依らず自然な操作感になる。
  if (!neutralOrientation) {
    neutralOrientation = { beta: event.beta, gamma: event.gamma };
  }

  // 中立からの差分を求め、効きすぎないよう上限角でクランプ
  const deltaBeta = clamp(event.beta - neutralOrientation.beta, -TILT_LIMIT_DEG, TILT_LIMIT_DEG);
  const deltaGamma = clamp(event.gamma - neutralOrientation.gamma, -TILT_LIMIT_DEG, TILT_LIMIT_DEG);

  // 左右の傾き → カメラ x、前後の傾き → カメラ y にマッピング（-1〜1 に正規化して拡大）
  targetOffset.x = (deltaGamma / TILT_LIMIT_DEG) * OFFSET_MAX;
  targetOffset.y = (deltaBeta / TILT_LIMIT_DEG) * OFFSET_MAX;
}

// 起動と同時に、無条件でジャイロ連動を開始する。
// （HTTP 環境＋ボタンなしの方針。許可ダイアログを出す端末では自動では動かない場合があるが、
//   その制約を受け入れたうえで強制登録する。）
window.addEventListener('deviceorientation', onDeviceOrientation);

// -----------------------------------------------------------------------------
// 描画ループ
// -----------------------------------------------------------------------------

function animate() {
  requestAnimationFrame(animate);

  controls.update(); // enableDamping を有効にしているため毎フレーム更新が必要

  // 実オフセットを目標へ滑らかに追従させる
  // （ジャイロ未受信の間は targetOffset が 0 のままなので影響しない）
  currentOffset.lerp(targetOffset, OFFSET_SMOOTHING);

  // OrbitControls が決めたベース位置を退避し、オフセットを加算して描画
  basePosition.copy(camera.position);
  camera.position.add(currentOffset);
  camera.lookAt(controls.target); // ずらしても常にキャラクター中心を向く

  renderer.render(scene, camera);

  // ベース位置へ復元 → 次フレームの controls.update がオフセットに汚染されない
  camera.position.copy(basePosition);
}
animate();

// -----------------------------------------------------------------------------
// 画面の向きを縦（portrait）に固定
//   大きく傾けたときの自動回転を防ぐ。Screen Orientation API は対応端末でのみ動作し、
//   多くのブラウザでは「フルスクリーン中のみ」ロック可能なため、失敗しても致命傷に
//   ならないよう握りつぶす（その場合は下のリサイズ追従で表示崩れを防ぐ）。
// -----------------------------------------------------------------------------

function lockPortrait() {
  const orientation = screen.orientation;
  if (orientation && typeof orientation.lock === 'function') {
    // Promise を返すので reject されても無視（非対応・フルスクリーン外など）
    orientation.lock('portrait').catch(() => {
      /* ロック不可の環境ではリサイズ追従に任せる */
    });
  }
}
lockPortrait();

// -----------------------------------------------------------------------------
// リサイズ対応（端末回転・ウィンドウサイズ変更・アドレスバー伸縮など）
//   どんな理由でビューポートが変わっても 3D 表示が崩れないよう、毎回カメラの
//   アスペクト比とレンダラーのサイズ・ピクセル比を実寸から再計算して追従する。
// -----------------------------------------------------------------------------

function resizeRenderer() {
  // コンテナの実寸を基準にする（アドレスバー等の影響を受けにくい）
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
}

// 各種「サイズが変わりうる」イベントすべてで再計算する
window.addEventListener('resize', resizeRenderer);
window.addEventListener('orientationchange', () => {
  // 回転直後は寸法が確定していないことがあるため、確定後にも再計算する
  resizeRenderer();
  setTimeout(resizeRenderer, 300);
});
if (screen.orientation) {
  screen.orientation.addEventListener('change', resizeRenderer);
}

// 初期化直後にも一度実寸へ合わせておく
resizeRenderer();

// -----------------------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------------------

function setStatus(message, autoHide = false) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
  if (autoHide) {
    // 少し見せてからフェードアウト
    setTimeout(() => statusEl.classList.add('hidden'), 1200);
  }
}

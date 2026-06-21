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
// 方針：ジャイロは「ワールドY軸まわりの公転（方位角）」と「見下ろし／見上げ（極角）」の
// オフセットとしてのみカメラに作用させる。モデルも地面も一切動かさない。
//   ・左右首振り（alpha, ワールド垂直軸まわりの回転）→ 方位角（カメラが水平に回り込む）
//   ・前後の傾け（beta, うつむく／仰ぐ）        → 極角（見下ろす／見上げる）
//   ・左右の傾け（gamma, ハンドル/ロール）       → 使わない（地平線を傾けないため）
const GYRO_YAW_SENS = 1.0;     // 首振りの感度（1.0＝スマホの回転と 1:1）
const GYRO_PITCH_SENS = 1.0;   // 前後傾きの感度（1.0＝スマホの傾きと 1:1）
const GYRO_YAW_DIR = 1;        // 首振りの向き（あべこべなら -1 に）
const GYRO_PITCH_DIR = 1;      // 前後傾きの向き（あべこべなら -1 に）
const GYRO_SMOOTHING = 0.2;    // オフセット追従の滑らかさ（0〜1。1 に近いほど即時）
const POLAR_MIN = 0.15;        // 極角の下限（真上に行き過ぎない）
const POLAR_MAX = Math.PI * 0.95; // 極角の上限（床下に回り込み過ぎない）

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

    // モデルは地面に立たせたまま固定する（位置・向きは一切動かさない）。
    // 動くのはカメラの視点だけ。
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
// ジャイロ（傾きセンサー）連動 ―― ワールド基準のOrbit方式
//   デバイス姿勢を「そのまま」適用すると、世界の上下軸ごと傾いてキャラクターが
//   浮いて見える。これを避けるため、ジャイロからは「ワールドY軸まわりの方位角」と
//   「見下ろし／見上げの極角」という2つのスカラー量だけを取り出し、OrbitControls が
//   決めた基準アングルへの“オフセット”として加える。世界の上（Y）は常に固定される。
// -----------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 角度差を -PI〜PI に正規化（alpha の 360°→0° の折り返しでカメラが飛ぶのを防ぐ）
function wrapAngle(rad) {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

// 最初の姿勢を基準（中立）にする。持ち方の角度に依存させないため。
let neutral = null; // { alpha, beta } ラジアン

// ジャイロ由来の「目標」オフセットと、滑らかに追従させる「現在」オフセット（ラジアン）
let targetYaw = 0;
let targetPitch = 0;
let currentYaw = 0;
let currentPitch = 0;

function onDeviceOrientation(event) {
  // 必要な角度が取れない端末・未許可では何もしない
  if (event.alpha === null || event.beta === null) return;

  const alpha = THREE.MathUtils.degToRad(event.alpha); // ワールド垂直軸まわり＝首振り
  const beta = THREE.MathUtils.degToRad(event.beta);   // 前後の傾き＝うつむく／仰ぐ

  if (!neutral) {
    neutral = { alpha, beta };
  }

  // 中立からの相対角だけを使う（絶対方位は使わない＝world Y まわりの“ズレ”のみ）
  targetYaw = wrapAngle(alpha - neutral.alpha) * GYRO_YAW_SENS * GYRO_YAW_DIR;
  targetPitch = wrapAngle(beta - neutral.beta) * GYRO_PITCH_SENS * GYRO_PITCH_DIR;
  // gamma（左右ロール）は意図的に無視 → 地平線は絶対に傾かない
}

// 起動と同時に、無条件でジャイロ連動を開始する。
// （HTTP 環境＋ボタンなしの方針。許可ダイアログを出す端末では自動では動かない場合があるが、
//   その制約を受け入れたうえで強制登録する。）
window.addEventListener('deviceorientation', onDeviceOrientation);

// -----------------------------------------------------------------------------
// 描画ループ
// -----------------------------------------------------------------------------

// 描画前にベース位置を退避するための一時変数
const _basePosition = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);

  // OrbitControls（指スワイプ）で基準アングルを更新
  controls.update(); // enableDamping を有効にしているため毎フレーム更新が必要

  // ジャイロのオフセットを目標へ滑らかに追従させる
  currentYaw += (targetYaw - currentYaw) * GYRO_SMOOTHING;
  currentPitch += (targetPitch - currentPitch) * GYRO_SMOOTHING;

  // OrbitControls が決めた「基準アングル」を取得（＝スワイプ操作の結果）
  const baseAzimuth = controls.getAzimuthalAngle();
  const basePolar = controls.getPolarAngle();
  const radius = controls.getDistance();
  const target = controls.target;

  // 基準アングルにジャイロのオフセットを加算（すべてワールドY軸基準の球面座標）
  const azimuth = baseAzimuth + currentYaw;
  const polar = clamp(basePolar + currentPitch, POLAR_MIN, POLAR_MAX);

  // ベース位置を退避 → 次フレームの controls.update がオフセットに汚染されないようにする
  _basePosition.copy(camera.position);

  // 球面座標 → カメラ位置（Three.js の Spherical と同じ規約。target を中心に公転）
  const sinPolar = Math.sin(polar);
  camera.position.set(
    target.x + radius * sinPolar * Math.sin(azimuth),
    target.y + radius * Math.cos(polar),
    target.z + radius * sinPolar * Math.cos(azimuth)
  );
  camera.up.set(0, 1, 0);   // 世界の「上」を常に固定（地平線が傾かない）
  camera.lookAt(target);    // 常にキャラクター中心を見つめる

  renderer.render(scene, camera);

  // ベース位置へ復元（OrbitControls の基準を汚さない）
  camera.position.copy(_basePosition);
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

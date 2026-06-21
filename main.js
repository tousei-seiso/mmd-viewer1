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
// デバイス方向（DeviceOrientation）から得たクォータニオンをモデルにそのまま適用し、
// スマホの 3 軸回転（首振り＝alpha / 前後＝beta / 左右ロール＝gamma）を 1 対 1 で同期させる。
const ROTATION_SMOOTHING = 0.2; // 回転追従の滑らかさ（0〜1。1 に近いほど即時＝完全 1:1、小さいほど滑らか）

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

// ジャイロで回転させる対象。モデルは「キャラクター中心」を軸に回したいので、
// 中心に置いたピボット（Group）の子として格納する。
let modelPivot = null;

loadModelWithFallback(MODEL_CANDIDATES)
  .then(({ mesh, path }) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // ピボットを中心位置に置き、モデルを中心ぶんだけ逆方向へずらして子にする。
    // こうすると見た目の位置は変えずに、回転だけが「中心まわり」になる。
    modelPivot = new THREE.Group();
    modelPivot.position.copy(CHARACTER_CENTER);
    mesh.position.sub(CHARACTER_CENTER);
    modelPivot.add(mesh);
    scene.add(modelPivot);

    console.log(`モデルを読み込みました: ${path}`);
    setStatus('読み込み完了', true);
  })
  .catch((error) => {
    // すべての候補が失敗（モデル未配置でもアプリが落ちないようにする）
    console.error('モデルの読み込みに失敗しました:', error);
    setStatus(`モデルを読み込めませんでした（${MODEL_CANDIDATES.join(' / ')} のいずれかを配置してください）`);
  });

// -----------------------------------------------------------------------------
// ジャイロ（傾きセンサー）連動 ―― クォータニオン方式
//   方針：DeviceOrientation の alpha / beta / gamma（オイラー角）から、Three.js 標準の
//   DeviceOrientationControls と同じ数式でデバイス姿勢のクォータニオンを生成し、それを
//   そのままモデルへ適用する。個別軸を別々に回さないためジンバルロックが起きず、
//   首振り・前後傾き・左右ロールの 3 軸すべてが 1 対 1 で同期する。
//
//   OrbitControls はカメラ（指スワイプでの視点移動）専用、ジャイロはモデルの回転専用と
//   役割を分けたので、両者は干渉しない。
// -----------------------------------------------------------------------------

// DeviceOrientation のオイラー角（ラジアン）→ デバイス姿勢クォータニオンへの変換用。
// （Three.js DeviceOrientationControls の setObjectQuaternion と同一ロジック）
const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
// 端末の「画面を手前」から「奥（-Z）を見る」向きへ補正する -90°(X軸) 回転
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function deviceQuaternion(quat, alpha, beta, gamma, screenOrient) {
  // 適用順序 'YXZ' が DeviceOrientation の仕様に対応する
  _euler.set(beta, alpha, -gamma, 'YXZ');
  quat.setFromEuler(_euler);          // デバイス姿勢
  quat.multiply(_q1);                 // 端末の向き補正
  quat.multiply(_q0.setFromAxisAngle(_zee, -screenOrient)); // 画面回転ぶんの補正
  return quat;
}

// センサーから受け取った最新のオイラー角（ラジアン）。未受信の間は null。
let deviceEuler = null;

// 回転計算用の作業オブジェクト
const _deviceQuat = new THREE.Quaternion(); // 現在のデバイス姿勢
const _targetQuat = new THREE.Quaternion(); // モデルに与える目標回転
let _initialQuatInv = null; // 最初の姿勢の逆クォータニオン（＝起動時を無回転の基準にする）

function onDeviceOrientation(event) {
  // alpha が取れない端末・未許可では何もしない（null チェック）
  if (event.alpha === null || event.beta === null || event.gamma === null) return;

  deviceEuler = {
    alpha: THREE.MathUtils.degToRad(event.alpha), // 首振り（縦軸まわり）
    beta: THREE.MathUtils.degToRad(event.beta),   // 前後の傾き
    gamma: THREE.MathUtils.degToRad(event.gamma), // 左右のロール
  };
}

// 現在の画面の向き（角度）をラジアンで返す
function getScreenOrientation() {
  const angle =
    (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
  return THREE.MathUtils.degToRad(angle);
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

  // ジャイロ：デバイス姿勢クォータニオンを生成し、起動時を基準にモデルへ同期する
  if (deviceEuler && modelPivot) {
    deviceQuaternion(
      _deviceQuat,
      deviceEuler.alpha,
      deviceEuler.beta,
      deviceEuler.gamma,
      getScreenOrientation()
    );

    // 最初の姿勢を「無回転の基準」にする（持ち方の角度に依存させない）。
    if (!_initialQuatInv) {
      _initialQuatInv = _deviceQuat.clone().invert();
    }

    // 起動時からの相対回転（ワールド基準）＝ 現在姿勢 × 初期姿勢の逆。
    // スマホを動かした分だけ、モデルが同じ向きに 1 対 1 で回る。
    _targetQuat.multiplyQuaternions(_deviceQuat, _initialQuatInv);

    // slerp で滑らかに追従（クォータニオン補間なのでジンバルロックなし）
    modelPivot.quaternion.slerp(_targetQuat, ROTATION_SMOOTHING);
  }

  renderer.render(scene, camera);
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

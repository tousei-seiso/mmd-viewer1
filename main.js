// =============================================================================
// MMD Viewer ―― ステップ1：ステージ作成とモデル表示の土台
// Three.js + MMDLoader を CDN から読み込み、画面全体に 3D 空間を構築する。
// =============================================================================

import * as THREE from 'three';
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

// カメラの注視点＝キャラクター中心（ここは絶対に動かさない）
const TARGET = CHARACTER_CENTER;

// カメラの公転半径（target からの距離）。元の初期位置とほぼ同じ距離感。
const ORBIT_RADIUS = 30;

// 起動時の基準アングル（ジャイロの中立時に見える構図）。「正面 少し斜め上から見下ろす」。
const BASE_YAW = THREE.MathUtils.degToRad(16);    // 少し斜め（横方向）
const BASE_PITCH = THREE.MathUtils.degToRad(-15); // 少し上から見下ろす（負＝見下ろし）

// ジャイロ各成分の感度と向き（あべこべなら DIR を -1 に）
const GYRO_YAW_SENS = 1.0,   GYRO_YAW_DIR = 1;   // 上下軸回転 → 水平周回（ワールドY軸）
const GYRO_PITCH_SENS = 1.0, GYRO_PITCH_DIR = 1; // 前後傾き   → 見上げ／見下ろし（ローカルX軸）
const GYRO_ROLL_SENS = 1.0,  GYRO_ROLL_DIR = -1; // 左右傾き   → 画面の傾き（ローカルZ軸＝視線軸）

const GYRO_SMOOTHING = 0.2; // 角度の追従の滑らかさ（0〜1。1 に近いほど即時）

// ピッチ（見上げ／見下ろし）の可動域。真上・真下を越えて反転しないよう制限。
const PITCH_MIN = THREE.MathUtils.degToRad(-85);
const PITCH_MAX = THREE.MathUtils.degToRad(85);

// 固定のワールド軸（回転軸として使う）
const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

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
// 初期位置・姿勢は描画ループ内のクォータニオン合成（BASE_YAW / BASE_PITCH）で決まる。

// レンダラー
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 高 DPI 端末の負荷を抑制
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

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
// ジャイロ（傾きセンサー）連動 ―― ワールド基準のクォータニオン合成
//
//   重要な前提：スマホを縦に立てて持つと、オイラー角と物理的な動きの対応がズレる
//   （Yaw が gamma の ±90° 制限に、Roll が alpha に出るなど）。生のオイラー角を軸へ
//   バラバラに代入すると、軸が斜めに引きずられて干渉し、Roll が周回に混ざる／Yaw が
//   ワープ・反転する。
//
//   そこで、まずデバイス姿勢クォータニオンを作り、そこから「物理的に独立した 3 成分」を
//   姿勢に依存しない形で抽出する：
//     ・Yaw   ＝ 視線方向を水平面へ投影した方位角（Roll でも Pitch でも変化しない）
//     ・Pitch ＝ 視線方向の仰角（asin(viewDir.y)。Roll で変化しない）
//     ・Roll  ＝ 視線軸まわりの「上ベクトル」のねじれ角（Yaw/Pitch から独立）
//   抽出した 3 つを、描画ループで独立クォータニオンとして合成する。
// -----------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 角度差を -PI〜PI に正規化（折り返しの飛びを防ぐ）
function wrapAngle(rad) {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

// --- DeviceOrientation のオイラー角 → デバイス姿勢クォータニオン -------------
//   （Three.js DeviceOrientationControls と同一ロジック）
const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90°(X軸)
const _deviceQuat = new THREE.Quaternion();
const _viewDir = new THREE.Vector3(); // デバイスの視線方向（forward）
const _devUp = new THREE.Vector3();   // デバイスの上方向（up）
const _refUp = new THREE.Vector3();   // ロール 0 のときの基準 up（worldUp を視線に直交化）
const _cross = new THREE.Vector3();

function buildDeviceQuaternion(quat, alpha, beta, gamma, screenOrient) {
  _euler.set(beta, alpha, -gamma, 'YXZ');
  quat.setFromEuler(_euler);
  quat.multiply(_q1);
  quat.multiply(_q0.setFromAxisAngle(_zee, -screenOrient));
  return quat;
}

// 現在の画面の向き（角度）をラジアンで返す（縦ロック中は通常 0）
function getScreenOrientation() {
  const angle =
    (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
  return THREE.MathUtils.degToRad(angle);
}

// Yaw は「方位角の累積」で連続化する（atan2 の ±π 折り返しをアンラップ）。
// これによりスマホを何周回しても飛ばずに、ぐるぐると連続して周回できる。
let prevHeading = null;  // 直前フレームの方位角（ラジアン）
let yawAccum = 0;        // 起動時を 0 とした累積 Yaw（ラジアン）
let neutralPitch = null; // Pitch の基準（中立）
let neutralRoll = null;  // Roll の基準（中立）

// 抽出した 3 成分の「目標値」と、滑らかに追従させる「現在値」（ラジアン）
let targetYaw = 0, targetPitch = 0, targetRoll = 0;
let currentYaw = 0, currentPitch = 0, currentRoll = 0;

function onDeviceOrientation(event) {
  // 必要な角度が取れない端末・未許可では何もしない
  if (event.alpha === null || event.beta === null || event.gamma === null) return;

  const alpha = THREE.MathUtils.degToRad(event.alpha);
  const beta = THREE.MathUtils.degToRad(event.beta);
  const gamma = THREE.MathUtils.degToRad(event.gamma);

  // デバイス姿勢クォータニオンと、その視線方向・上方向ベクトルを求める
  buildDeviceQuaternion(_deviceQuat, alpha, beta, gamma, getScreenOrientation());
  _viewDir.set(0, 0, -1).applyQuaternion(_deviceQuat).normalize();
  _devUp.set(0, 1, 0).applyQuaternion(_deviceQuat).normalize();

  // --- Yaw：視線方向の水平成分の方位角（Roll/Pitch から独立） ----------------
  const horizLenSq = _viewDir.x * _viewDir.x + _viewDir.z * _viewDir.z;
  if (horizLenSq > 1e-6) { // ほぼ真上／真下を向いているときは更新しない（方位が不定）
    const heading = Math.atan2(_viewDir.x, _viewDir.z);
    if (prevHeading === null) prevHeading = heading;
    yawAccum += wrapAngle(heading - prevHeading); // 差分を累積＝連続化（ワープ防止）
    prevHeading = heading;
    targetYaw = yawAccum * GYRO_YAW_SENS * GYRO_YAW_DIR;
  }

  // --- Pitch：視線方向の仰角（Roll から独立） --------------------------------
  const pitch = Math.asin(clamp(_viewDir.y, -1, 1));
  if (neutralPitch === null) neutralPitch = pitch;
  targetPitch = (pitch - neutralPitch) * GYRO_PITCH_SENS * GYRO_PITCH_DIR;

  // --- Roll：視線軸まわりの up のねじれ角（Yaw/Pitch から独立） --------------
  // 基準 up ＝ world up から「視線方向成分」を取り除いたもの（視線に直交）
  _refUp.copy(WORLD_Y).addScaledVector(_viewDir, -WORLD_Y.dot(_viewDir));
  if (_refUp.lengthSq() > 1e-6) { // 視線がほぼ垂直だと基準 up が不定 → 更新しない
    _refUp.normalize();
    let roll = Math.acos(clamp(_refUp.dot(_devUp), -1, 1));
    // 符号：基準 up→デバイス up の回転が視線軸まわりに正か負か
    _cross.crossVectors(_refUp, _devUp);
    if (_cross.dot(_viewDir) < 0) roll = -roll;
    if (neutralRoll === null) neutralRoll = roll;
    targetRoll = wrapAngle(roll - neutralRoll) * GYRO_ROLL_SENS * GYRO_ROLL_DIR;
  }
}

// 起動と同時に、無条件でジャイロ連動を開始する。
// （HTTP 環境＋ボタンなしの方針。許可ダイアログを出す端末では自動では動かない場合があるが、
//   その制約を受け入れたうえで強制登録する。）
window.addEventListener('deviceorientation', onDeviceOrientation);

// -----------------------------------------------------------------------------
// タッチ／マウス操作 ―― ドラッグ回転 ＆ ピンチ/ホイールズーム（ジャイロと共存）
//   ジャイロの回転（currentYaw/Pitch/Roll）とは独立に、ドラッグ由来の「基準角度の
//   オフセット（dragYaw/dragPitch）」と、ピンチ/ホイール由来の「距離（currentDistance）」を
//   保持する。これらは描画ループでジャイロ成分に加算・合成される。
//   ※ ジャイロのクォータニオン計算には一切手を加えない。
// -----------------------------------------------------------------------------

const MIN_DISTANCE = 5;          // 最も寄れる距離
const MAX_DISTANCE = 80;         // 最も引ける距離
const DRAG_ROT_SPEED = 0.005;    // ドラッグ回転の感度（ラジアン/px）
const DRAG_YAW_DIR = -1;         // 水平ドラッグの向き（好みで反転）
const DRAG_PITCH_DIR = -1;       // 垂直ドラッグの向き（好みで反転）
const DRAG_PITCH_LIMIT = 1.3;    // ドラッグで変えられる見上げ/見下ろし量の上限（ラジアン）
const WHEEL_ZOOM_SPEED = 0.0015; // ホイールズームの感度
const ZOOM_SMOOTHING = 0.2;      // ズーム距離の追従の滑らかさ

// ドラッグによる「基準角度オフセット」（ジャイロ回転に加算される）
let dragYaw = 0;
let dragPitch = 0;

// ピンチ/ホイールによるズーム距離（目標値と、滑らかに追従する現在値）
let targetDistance = ORBIT_RADIUS;
let currentDistance = ORBIT_RADIUS;

// 複数タッチ追跡（ポインタID → 最新座標）
const activePointers = new Map();
let pinchPrevDist = null; // 直前フレームの2指間距離

const canvas = renderer.domElement;

function pointerDistance() {
  const pts = [...activePointers.values()];
  if (pts.length < 2) return 0;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

function onPointerDown(event) {
  canvas.setPointerCapture?.(event.pointerId);
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (activePointers.size === 2) pinchPrevDist = pointerDistance(); // ピンチ開始
}

function onPointerMove(event) {
  const p = activePointers.get(event.pointerId);
  if (!p) return;
  const prevX = p.x;
  const prevY = p.y;
  p.x = event.clientX;
  p.y = event.clientY;

  if (activePointers.size === 1) {
    // 1本指（またはマウスドラッグ）→ カメラの周回・見上げ/見下ろしの基準角を変更
    dragYaw += (p.x - prevX) * DRAG_ROT_SPEED * DRAG_YAW_DIR;
    dragPitch += (p.y - prevY) * DRAG_ROT_SPEED * DRAG_PITCH_DIR;
    dragPitch = clamp(dragPitch, -DRAG_PITCH_LIMIT, DRAG_PITCH_LIMIT);
  } else if (activePointers.size === 2) {
    // 2本指 → ピンチズーム（指の間隔の比率で距離を伸縮）
    const dist = pointerDistance();
    if (pinchPrevDist !== null && dist > 0) {
      targetDistance = clamp(
        targetDistance * (pinchPrevDist / dist),
        MIN_DISTANCE,
        MAX_DISTANCE
      );
    }
    pinchPrevDist = dist;
  }
}

function onPointerUp(event) {
  activePointers.delete(event.pointerId);
  canvas.releasePointerCapture?.(event.pointerId);
  if (activePointers.size < 2) pinchPrevDist = null; // ピンチ終了
}

function onWheel(event) {
  event.preventDefault();
  targetDistance = clamp(
    targetDistance * (1 + event.deltaY * WHEEL_ZOOM_SPEED),
    MIN_DISTANCE,
    MAX_DISTANCE
  );
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('wheel', onWheel, { passive: false });

// -----------------------------------------------------------------------------
// 簡易揺れものシステム（フェイク物理）― 加速度センサーで服・髪だけをなびかせる
//   ※ 揺れ量の減衰計算とボーンへの適用は、メインの描画ループ animate() の中で行う
//     （モーション適用直後に相対加算するため）。ここでは入力と対象抽出のみ用意する。
//   ※ animate() は定義直後に同期実行されるため、これらの宣言は animate より前に置く。
// -----------------------------------------------------------------------------

// --- 揺れ量の調整値 ---
const SWAY_DECAY = 0.9;        // 毎フレームの減衰（1 に近いほど長く揺れる）
const SWAY_GAIN = 0.04;        // 加速度を揺れ量に変換する強さ
const SWAY_MAX = 3.0;          // 揺れ量ベクトルの上限（クランプ。発散防止）
const SWAY_ROT_FACTOR = 0.06;  // 揺れ量 → ボーン回転量（ラジアン）への係数
const SWAY_ROT_MAX = 0.4;      // 1 フレームに加算する回転量の上限（約23°）
const SWAY_DEBUG = true;       // [一時] 加速度・対象ボーン数を画面に表示して原因を切り分ける

// 揺らしたい部位のキーワード（英字は小文字で比較）
const SWAY_KEYWORDS = ['髪', 'hair', 'スカート', 'skirt', '袖', 'sleeve', '裾', 'リボン', 'ribbon', 'ひも'];
// 体幹など、絶対に揺らさないボーン（安全のための除外）
const SWAY_EXCLUDE = ['センター', 'center', '下半身', '上半身', '足', 'ひざ', '足首', 'つま先', 'body', 'グルーブ'];

// 重力を除いた加速度（動きだけ）。減衰しながら保持する揺れ量ベクトル。
let accX = 0, accY = 0, accZ = 0;
let swayX = 0, swayY = 0, swayZ = 0;

// 重力成分の低域通過推定（accelerationIncludingGravity から重力を差し引くため）。
// これにより端末を静止させているときは accX/Y/Z ≒ 0 となり、ボーンが勝手に曲がり続けない。
let gravX = 0, gravY = 0, gravZ = 0;
let gravInit = false;
const GRAVITY_LP = 0.9; // 1 に近いほど重力推定がゆっくり追従

function onDeviceMotion(event) {
  // 多くの Android で acceleration は null になるため、重力込みの値を使う
  const a = event.accelerationIncludingGravity;
  if (!a) return;
  const ax = a.x || 0, ay = a.y || 0, az = a.z || 0;

  if (!gravInit) { gravX = ax; gravY = ay; gravZ = az; gravInit = true; }
  // 低域通過で重力ベクトルを推定し、差し引いて「動き成分」だけを取り出す
  gravX = GRAVITY_LP * gravX + (1 - GRAVITY_LP) * ax;
  gravY = GRAVITY_LP * gravY + (1 - GRAVITY_LP) * ay;
  gravZ = GRAVITY_LP * gravZ + (1 - GRAVITY_LP) * az;
  accX = ax - gravX;
  accY = ay - gravY;
  accZ = az - gravZ;
}
window.addEventListener('devicemotion', onDeviceMotion);

// 対象ボーンを遅延抽出（モデル読み込み完了後、最初に見つかった時点で一度だけ）。
// 角度は毎フレーム踊りで変わるため基準値は保持せず、ボーン参照の配列だけを持つ。
let swayBones = null; // 抽出前は null

function ensureSwayBones() {
  if (swayBones !== null) return;
  let skinned = null;
  scene.traverse((obj) => {
    if (!skinned && obj.isSkinnedMesh && obj.skeleton) skinned = obj;
  });
  if (!skinned) return; // まだ読み込まれていない

  swayBones = [];
  for (const bone of skinned.skeleton.bones) {
    const name = bone.name || '';
    const lower = name.toLowerCase();
    if (SWAY_EXCLUDE.some((k) => name.includes(k) || lower.includes(k))) continue;
    if (SWAY_KEYWORDS.some((k) => name.includes(k) || lower.includes(k))) {
      swayBones.push(bone);
    }
  }
  console.log(`揺れもの対象ボーン: ${swayBones.length} 本`);
}

// -----------------------------------------------------------------------------
// 描画ループ
// -----------------------------------------------------------------------------

// カメラ姿勢合成用の一時オブジェクト
const _qYaw = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _camQuat = new THREE.Quaternion();
const _offset = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);

  // ジャイロの各成分を目標へ滑らかに追従させる（lerp）
  currentYaw += (targetYaw - currentYaw) * GYRO_SMOOTHING;
  currentPitch += (targetPitch - currentPitch) * GYRO_SMOOTHING;
  currentRoll += (targetRoll - currentRoll) * GYRO_SMOOTHING;

  // ズーム距離も滑らかに追従させる
  currentDistance += (targetDistance - currentDistance) * ZOOM_SMOOTHING;

  // 最終アングル＝ 起動時構図(BASE_*) ＋ ドラッグ基準オフセット ＋ ジャイロ回転傾き
  //   Yaw/Pitch にはドラッグ分を加算（共存）、Roll はジャイロのみ。
  const yaw = BASE_YAW + dragYaw + currentYaw;
  const pitch = clamp(BASE_PITCH + dragPitch + currentPitch, PITCH_MIN, PITCH_MAX);
  const roll = currentRoll;

  // 3 つの回転を「完全に独立」に作る。
  //   Qyaw : ワールド Y 軸まわり（スマホがどう傾こうが常に世界の真上が軸）
  //   Qpitch: ワールド X 軸まわり（合成順により実質ローカルX＝カメラの右向き軸になる）
  //   Qroll : ワールド Z 軸まわり（合成順により実質ローカルZ＝視線軸になる）
  _qYaw.setFromAxisAngle(WORLD_Y, yaw);
  _qPitch.setFromAxisAngle(WORLD_X, pitch);
  _qRoll.setFromAxisAngle(WORLD_Z, roll);

  // 合成順 Yaw × Pitch × Roll（内在回転）。
  //   この順序により Pitch はローカルX（右）軸、Roll はローカルZ（視線）軸まわりとなり、
  //   Yaw だけが純粋にワールドY軸まわりになる＝Roll は周回（Yaw）に 1 ピクセルも混ざらない。
  _camQuat.copy(_qYaw).multiply(_qPitch).multiply(_qRoll);

  // 姿勢からカメラ位置を決める：target を中心に、ズーム距離 currentDistance で公転。
  //   カメラのローカル +Z（視線の逆向き）方向へ距離分だけ離す → 常に target を見る。
  //   ＝「向きを決めてから、ピンチ距離だけ後ろに配置する」構成。
  _offset.set(0, 0, 1).applyQuaternion(_camQuat).multiplyScalar(currentDistance);
  camera.position.copy(TARGET).add(_offset);

  // 姿勢を直接適用（lookAt は使わない＝Roll の傾きが打ち消されないようにするため）
  camera.quaternion.copy(_camQuat);

  // --- 簡易揺れもの（フェイク物理）---------------------------------------------
  // ここは「モーション（VMD）が更新された直後」に相当する位置。モーション適用後の
  // ボーン角度に対して相対的に += するため、再生中の踊りを上書きして消さない。
  // 加速度（重力除去済み）を注入しつつ減衰 → 一瞬揺れて 0 へ戻る。クランプで発散防止。
  swayX = clamp(swayX * SWAY_DECAY + accX * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
  swayY = clamp(swayY * SWAY_DECAY + accY * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
  swayZ = clamp(swayZ * SWAY_DECAY + accZ * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);

  ensureSwayBones();
  if (swayBones && swayBones.length) {
    // 加速度と「逆方向」になびく（右に振ったら服は左へ）。1 フレーム分の加算量を上限クランプ。
    const offX = clamp(-swayZ * SWAY_ROT_FACTOR, -SWAY_ROT_MAX, SWAY_ROT_MAX);
    const offZ = clamp(-swayX * SWAY_ROT_FACTOR, -SWAY_ROT_MAX, SWAY_ROT_MAX);
    for (const bone of swayBones) {
      bone.rotation.x += offX; // モーション適用後の現在角度へ相対加算
      bone.rotation.z += offZ;
    }
  }

  // [一時診断] 加速度が実際に届いているか／対象ボーン数を画面に常時表示。
  // 端末を振っても acc が 0.00 のままなら devicemotion 未配信が原因。確認後 SWAY_DEBUG=false に。
  if (SWAY_DEBUG && statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.textContent =
      `acc ${accX.toFixed(2)} ${accY.toFixed(2)} ${accZ.toFixed(2)} | ` +
      `sway ${swayX.toFixed(2)} ${swayZ.toFixed(2)} | bones ${swayBones ? swayBones.length : '-'}`;
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

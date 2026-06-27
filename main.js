// =============================================================================
// MMD Viewer ―― ステップ1：ステージ作成とモデル表示の土台
// Three.js + MMDLoader を CDN から読み込み、画面全体に 3D 空間を構築する。
// =============================================================================

import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';

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

// 現在シーンに表示しているモデルと、その読み込みパス（差し替え時に使う）
let currentModel = null;
let currentModelPath = null;
// モデルが「ダンス再生に使える状態」かどうか（読み込み完了で true）。
// 再生ボタンの有効／無効判定（モデルとモーションが揃ったか）に使う。
let modelReady = false;

// モデルの GPU リソースを解放する（差し替え時のメモリリーク防止）
function disposeModel(obj) {
  obj.traverse((child) => {
    if (!child.isMesh && !child.isSkinnedMesh) return;
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of materials) {
      if (!mat) continue;
      // マテリアルが参照する全テクスチャを解放
      for (const key in mat) {
        const val = mat[key];
        if (val && val.isTexture) val.dispose();
      }
      mat.dispose?.();
    }
  });
}

// -----------------------------------------------------------------------------
// 移動付与(translation grant)をアニメーションへ焼き込み、足IKが正しく動くようにする
//   natsuyuki_ruri 系などは脚IKが「IK親＋付与チェーン」で構成される:
//     左足ＩＫ(VMDがアニメ) → s1[移動付与] → s2[回転付与] → 左足ＩＫd(IKソルバ)
//   IKソルバ(左足ＩＫd)の位置は s1 の「移動付与」で左足ＩＫから伝わる設計だが、Three.js の
//   MMDAnimationHelper は回転付与のみ対応し移動付与を無視する。そのため s1 が動かず、IK
//   ターゲット(左足ＩＫd)が静止 → 足が持ち上がらない。
//   さらに _restoreBones/_saveBones の仕組みで、付与結果を毎フレーム外から書いても上書き
//   されてしまう。そこで正攻法として、移動付与ボーン B（付与元 P・比率 r）の位置トラックを
//     B.localpos(t) = B.rest + r * (P.localpos(t) - P.rest)
//   としてクリップへ追加し、ミキサーに動かさせる（＝ベイク）。MMDLoader の位置トラック値は
//   「rest + VMDオフセット」の絶対ローカル位置なので、P.localpos(t) - P.rest = オフセット。
//   これで s1 が動き、s2 の回転付与(対応済み)と合わさって 左足ＩＫd が正しく動き、元の IK
//   構造のまま足が持ち上がり、つま先IKも追従する。
//   ※ 直結IK（ruri_Default やイヴ）は移動付与チェーンが無いので何も追加されない＝無変更。
function bakeTranslationGrants(mesh, clip) {
  const mmd = mesh.geometry && mesh.geometry.userData && mesh.geometry.userData.MMD;
  const bonesData = mmd && mmd.bones;
  if (!bonesData || !clip || !clip.tracks) return;

  // 既存の位置トラックをボーン名で引けるようにする
  const posTrackByName = new Map();
  for (const t of clip.tracks) {
    const m = /^\.bones\[(.+)\]\.position$/.exec(t.name);
    if (m) posTrackByName.set(m[1], t);
  }

  const newTracks = [];
  const done = new Set();
  let progress = true;
  // 多パス（不動点）で処理：付与元(親)のトラックが未確定なら次パスへ回し、連鎖付与にも対応する。
  while (progress) {
    progress = false;
    for (let i = 0; i < bonesData.length; i++) {
      if (done.has(i)) continue;
      const g = bonesData[i].grant;
      if (!g) { done.add(i); continue; }
      // grant のフィールド名はパーサ差で異なることがあるため両対応で読む（ここが効かないと焼き込みが0件になる）。
      const affectPosition = g.affectPosition ?? g.pos ?? false;
      const isLocal = g.isLocal ?? g.local ?? false;
      const parentIndex = g.parentIndex ?? g.parent ?? -1;
      const ratio = g.ratio ?? 0;
      if (!affectPosition || isLocal || parentIndex < 0) { done.add(i); continue; } // 移動付与(非ローカル)のみ

      const bName = bonesData[i].name;
      if (posTrackByName.has(bName)) { done.add(i); continue; } // 既に自前の位置アニメがある場合は触らない
      const pData = bonesData[parentIndex];
      const pName = pData && pData.name;
      const pTrack = pName && posTrackByName.get(pName);
      if (!pTrack) continue; // 付与元トラック未確定 → 次パスで再試行（連鎖付与対応）

      // ❗rest は「その時点のボーン姿勢」ではなく、MMDLoader が保持するローカルrest
      // (geometry.userData.MMD.bones[i].pos) から読む。bake 時にメッシュが bind 姿勢で
      // ない場合に bBone.position を読むと rest を誤り、トラックが正しく動かない（実機で
      // 「何も動かない」の原因はこれだった）。pos は姿勢に依存しないので安全。
      const bRest = bonesData[i].pos;
      const pRest = pData.pos;
      if (!bRest || !pRest) { done.add(i); continue; }
      const bx = bRest[0], by = bRest[1], bz = bRest[2]; // B.rest（ローカル）
      const px = pRest[0], py = pRest[1], pz = pRest[2]; // P.rest（ローカル）
      const pv = pTrack.values;
      const n = pTrack.times.length;
      const values = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        values[k * 3]     = bx + ratio * (pv[k * 3]     - px);
        values[k * 3 + 1] = by + ratio * (pv[k * 3 + 1] - py);
        values[k * 3 + 2] = bz + ratio * (pv[k * 3 + 2] - pz);
      }
      const track = new THREE.VectorKeyframeTrack(`.bones[${bName}].position`, Float32Array.from(pTrack.times), values);
      newTracks.push(track);
      posTrackByName.set(bName, track); // 生成したトラックも登録 → 連鎖付与が辿れるようにする
      done.add(i);
      progress = true;
    }
  }

  if (newTracks.length) {
    clip.tracks.push(...newTracks);
    if (typeof clip.resetDuration === 'function') clip.resetDuration(); // トラック追加後に長さを再計算
    console.log(`移動付与を ${newTracks.length} 件アニメへ焼き込み（足IK等が正しく動く）`);
  }
}

// 読み込んだメッシュをシーンへ適用する。既存モデルがあれば差し替える。
// モデルは地面に立たせたまま固定（位置・向きは動かさない）。動くのはカメラの視点だけ。
function applyModel(mesh, path) {
  if (currentModel) {
    // 旧モデルに紐づくダンス（VMD クリップ＋音源）を確実に停止・破棄してから差し替える。
    // クリップは旧モデルのスケルトンに束縛されているため、ここで一旦リセットする。
    clearDance();
    scene.remove(currentModel);
    disposeModel(currentModel);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  currentModel = mesh;
  currentModelPath = path;
  // 新しいモデルに対して揺れもの対象ボーンを再抽出させる（次フレームの ensureSwayBones で再構築）
  swayBones = null;
  modelReady = true;
  updateDancePlayButton(); // モデルが揃ったので再生ボタンの有効／無効を更新
  console.log(`モデルを読み込みました: ${path}`);
}

// 指定パスのモデルへ切り替える（ユーザーがダイアログから選択したとき）
async function switchModel(path) {
  // 切り替え中はモデル未準備として再生ボタンを無効化する
  modelReady = false;
  updateDancePlayButton();
  setStatus(`読み込んでいます… ${path.split('/').pop()}`);
  try {
    const mesh = await loadModel(path);
    applyModel(mesh, path);
    setStatus('読み込み完了', true);
  } catch (error) {
    console.error('モデルの切り替えに失敗しました:', error);
    setStatus(`読み込めませんでした: ${path.split('/').pop()}`);
  }
}

loadModelWithFallback(MODEL_CANDIDATES)
  .then(({ mesh, path }) => {
    applyModel(mesh, path);
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
const SWAY_GAIN = 0.08;        // 加速度を揺れ量に変換する強さ
const SWAY_MAX = 5.0;          // 揺れ量ベクトルの上限（クランプ。発散防止）
const SWAY_ROT_FACTOR = 0.18;  // 揺れ量 → ボーン回転量（ラジアン）への係数
const SWAY_ROT_MAX = 0.9;      // 揺れによる回転オフセットの上限（約50°）
let SWAY_DEBUG = false;        // 診断表示（加速度・揺れ量・対象ボーン数）。右上アイコンで切替

// 右上アイコンで診断表示を ON/OFF する
const debugToggleBtn = document.getElementById('debug-toggle');
if (debugToggleBtn) {
  debugToggleBtn.addEventListener('click', () => {
    SWAY_DEBUG = !SWAY_DEBUG;
    debugToggleBtn.setAttribute('aria-pressed', String(SWAY_DEBUG));
    if (!SWAY_DEBUG && statusEl) statusEl.classList.add('hidden'); // OFF 時は表示を隠す
  });
}

// -----------------------------------------------------------------------------
// 画面の向き固定トグル（🔓⇄🔒）
//   Android Edge/Chrome では screen.orientation.lock() は「フルスクリーン中のみ」
//   許可される。ボタンのタップ自体が必要なユーザー操作になるため、ここで
//   requestFullscreen() → lock('portrait') の順に呼べば確実に縦固定できる。
//   解除時は unlock() してフルスクリーンも抜ける。ユーザーが端末操作で
//   フルスクリーンを抜けた場合（＝ロックも自動解除）は UI を同期する。
// -----------------------------------------------------------------------------
const orientationLockBtn = document.getElementById('orientation-lock-toggle');
if (orientationLockBtn) {
  let isLocked = false;

  function updateLockUI(on) {
    isLocked = on;
    orientationLockBtn.setAttribute('aria-pressed', String(on));
    orientationLockBtn.textContent = on ? '🔒' : '🔓';
    orientationLockBtn.title = on ? '画面の向き固定を解除' : '画面の向きを縦に固定';
  }

  async function enableLock() {
    try {
      const el = document.documentElement;
      // lock() の前提となるフルスクリーンへ（既にフルスクリーンなら何もしない）
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen();
      }
      if (screen.orientation && typeof screen.orientation.lock === 'function') {
        await screen.orientation.lock('portrait');
      }
      updateLockUI(true);
    } catch (err) {
      // 非対応端末・拒否時はフルスクリーンだけ残さないよう後始末して元へ戻す
      console.log('画面の向き固定に失敗:', err);
      try { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); } catch (_) {}
      updateLockUI(false);
    }
  }

  async function disableLock() {
    try {
      if (screen.orientation && typeof screen.orientation.unlock === 'function') {
        screen.orientation.unlock();
      }
    } catch (_) { /* 非対応でも無視 */ }
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    } catch (_) { /* 無視 */ }
    updateLockUI(false);
  }

  orientationLockBtn.addEventListener('click', () => {
    if (isLocked) disableLock(); else enableLock();
  });

  // 端末側の操作でフルスクリーンを抜けたら向きロックも外れるので UI を合わせる
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isLocked) updateLockUI(false);
    // 全画面の出入りでビューポート寸法が変わるので 3D 表示を確定後に追従させる
    resizeRenderer();
    setTimeout(resizeRenderer, 300);
  });
}

// -----------------------------------------------------------------------------
// 正面・全身リセット（🧍 アイコン）
//   カメラの周回角を起動時の「正面」構図へ戻し、現在表示中モデルのバウンディング
//   ボックスから全身が画面に収まる距離を計算してズームを合わせる。
//   ※ TARGET（注視点）は動かさない方針なので、注視点を基準に上下・左右で必要な
//     距離をそれぞれ求め、より引いた方（＝全体が確実に収まる方）を採用する。
// -----------------------------------------------------------------------------

const resetViewBtn = document.getElementById('reset-view-toggle');
const _fitBox = new THREE.Box3();

// モデルの全身が画面に収まる、TARGET からのカメラ距離を求める
function computeFitDistance() {
  if (!currentModel) return ORBIT_RADIUS;
  _fitBox.setFromObject(currentModel);
  if (_fitBox.isEmpty()) return ORBIT_RADIUS;

  // 注視点(TARGET)から見て、上下方向・左右方向それぞれの最大はみ出し量
  const vExtent = Math.max(_fitBox.max.y - TARGET.y, TARGET.y - _fitBox.min.y);
  const hExtent = Math.max(_fitBox.max.x - TARGET.x, TARGET.x - _fitBox.min.x);

  // camera.fov は垂直方向の視野角（度）。水平FOV ＝ 垂直 × アスペクト。
  const halfV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const distV = vExtent / halfV;                   // 縦（全身の高さ）で収める距離
  const distH = hExtent / (halfV * camera.aspect); // 横（肩幅など）で収める距離
  const dist = Math.max(distV, distH) * 1.15;      // 少し余白を持たせる
  return clamp(dist, MIN_DISTANCE, MAX_DISTANCE);
}

// カメラを正面・全身表示へリセットする
function resetView() {
  // ドラッグで付いた周回・見上げ/見下ろしのオフセットを解除（→ BASE_* の正面構図へ）
  dragYaw = 0;
  dragPitch = 0;

  // ジャイロの中立基準を取り直す。次のセンサー値で「いまの端末姿勢」を正面とみなすため、
  // 累積 Yaw と各中立角をリセットし、目標角も 0 に戻す（現在値はループで滑らかに追従）。
  yawAccum = 0;
  prevHeading = null;
  neutralPitch = null;
  neutralRoll = null;
  targetYaw = 0;
  targetPitch = 0;
  targetRoll = 0;

  // 全身が収まる距離へズーム（currentDistance はループで滑らかに追従）
  targetDistance = computeFitDistance();
}

resetViewBtn?.addEventListener('click', resetView);

// -----------------------------------------------------------------------------
// モデル選択ダイアログ（📁 アイコン）
//   models/ 以下（サブフォルダ含む）の .pmx / .pmd を一覧表示し、選んだモデルへ
//   切り替える。テクスチャ名の衝突を避けるため、モデルは models/<名前>/ のように
//   個別のサブフォルダに収められている前提。
//
//   一覧の取得は次の優先順位:
//     1. models/models.json（マニフェスト）… GitHub Pages 等の静的ホスティングでも
//        確実に動く。`node tools/build-models-manifest.mjs` で再生成できる。
//     2. ディレクトリインデックスの再帰走査 … python http.server など autoindex を
//        返すローカル開発サーバ向け（マニフェストが無い/古いときの保険）。
//   ※ GitHub Pages はディレクトリ一覧を返さない（models/ は 404）。このため公開環境では
//     必ずマニフェストが必要。両方失敗したときだけ既知リストへフォールバックする。
// -----------------------------------------------------------------------------

const MODEL_DIR = 'models/';
const MODEL_MANIFEST = 'models/models.json';
const MODEL_EXTS = ['.pmx', '.pmd'];
const MODEL_MAX_DEPTH = 3; // models/ から潜る最大階層（暴走防止）
// マニフェストもディレクトリ一覧も取れない場合のフォールバック（models/ からの相対パス）
const FALLBACK_MODEL_FILES = [
  'MoonaHoshinova/MoonaHoshinova.pmx',
  'MoonaHoshinova/MoonaHoshinova_outeroff.pmx',
  'YukiYukari/結月ゆかり_純_ver1.0.pmd',
];

function isModelFile(name) {
  const lower = name.toLowerCase();
  return MODEL_EXTS.some((ext) => lower.endsWith(ext));
}

// 1 ディレクトリ分のインデックス HTML を取得し、そこに並ぶ「ファイル名」と
// 「サブディレクトリ名」を仕分けて返す。dirUrl は末尾スラッシュ付きの URL。
async function readDirIndex(dirUrl) {
  const files = [];
  const dirs = [];
  const res = await fetch(dirUrl, { headers: { Accept: 'text/html' } });
  if (!res.ok) return { files, dirs };
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('a[href]').forEach((a) => {
    let href = (a.getAttribute('href') || '').split('?')[0].split('#')[0];
    if (!href || href.startsWith('/') || href.includes('://')) return; // 絶対/外部リンクは無視
    const isDir = href.endsWith('/');
    let name = href.replace(/\/+$/, '');   // 末尾スラッシュ除去
    name = name.split('/').pop() || '';    // パス → 末尾の名前のみ
    if (name === '' || name === '.' || name === '..') return; // 親・自ディレクトリは除外
    try { name = decodeURIComponent(name); } catch { /* そのまま使う */ }
    if (isDir) dirs.push(name);
    else if (isModelFile(name)) files.push(name);
  });
  return { files, dirs };
}

// マニフェスト（models/models.json）を読み込む。形式は { "models": ["foo/a.pmx", ...] }
// または ["foo/a.pmx", ...] の素の配列でも可。取得・解析できなければ null を返す。
async function loadModelManifest() {
  try {
    const res = await fetch(MODEL_MANIFEST, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.models;
    if (!Array.isArray(list)) return null;
    const cleaned = list
      .filter((p) => typeof p === 'string')
      .map((p) => p.replace(/^\.?\/*/, '').replace(/^models\//, '')) // 先頭の ./ や models/ を除去
      .filter((p) => isModelFile(p));
    return cleaned.length ? [...new Set(cleaned)].sort((a, b) => a.localeCompare(b, 'ja')) : null;
  } catch (error) {
    console.warn('models.json を読み込めませんでした。', error);
    return null;
  }
}

// models/ 以下を再帰的にたどり、見つかった .pmx / .pmd を models/ からの相対パスで返す。
async function crawlModelFiles() {
  const results = [];        // 例: 'MoonaHoshinova/MoonaHoshinova.pmx'
  const visited = new Set(); // 同一ディレクトリの二重訪問を防ぐ
  let indexAvailable = false;

  async function crawl(relDir, depth) {
    if (depth > MODEL_MAX_DEPTH || visited.has(relDir)) return;
    visited.add(relDir);
    let entry;
    try {
      entry = await readDirIndex(MODEL_DIR + relDir);
    } catch (error) {
      return; // この階層は読めなかった（このフォルダだけスキップ）
    }
    indexAvailable = true;
    for (const f of entry.files) results.push(relDir + f);
    // サブディレクトリ（テクスチャ用フォルダ等も含む）へ潜る。モデルが無ければ何も拾わない。
    for (const d of entry.dirs) await crawl(`${relDir}${d}/`, depth + 1);
  }

  try {
    await crawl('', 0);
  } catch (error) {
    console.warn('モデル一覧の探索でエラーが発生しました。', error);
  }

  if (!indexAvailable) {
    // ディレクトリインデックスが使えない配信環境（GitHub Pages 等）
    console.warn('ディレクトリ一覧を取得できませんでした（autoindex 非対応の配信環境）。');
  }
  return results.length
    ? [...new Set(results)].sort((a, b) => a.localeCompare(b, 'ja'))
    : [];
}

// 一覧取得の入口。マニフェスト → ディレクトリ走査 → 既知リスト の順に試す。
async function listModelFiles() {
  const fromManifest = await loadModelManifest();
  if (fromManifest && fromManifest.length) return fromManifest;

  const fromCrawl = await crawlModelFiles();
  if (fromCrawl.length) return fromCrawl;

  return [...FALLBACK_MODEL_FILES].filter(isModelFile).sort((a, b) => a.localeCompare(b, 'ja'));
}

const modelPickerBtn = document.getElementById('model-picker-toggle');
const modelDialog = document.getElementById('model-dialog');
const modelListEl = document.getElementById('model-list');
const modelDialogClose = document.getElementById('model-dialog-close');

function closeModelDialog() {
  modelDialog?.classList.add('hidden');
  modelPickerBtn?.setAttribute('aria-expanded', 'false');
}

async function openModelDialog() {
  if (!modelDialog || !modelListEl) return;
  modelDialog.classList.remove('hidden');
  modelPickerBtn?.setAttribute('aria-expanded', 'true');
  modelListEl.innerHTML = '<li class="model-list-empty">読み込み中…</li>';

  const files = await listModelFiles();
  // 取得中にダイアログが閉じられていたら何もしない
  if (modelDialog.classList.contains('hidden')) return;

  modelListEl.innerHTML = '';
  if (!files.length) {
    modelListEl.innerHTML = '<li class="model-list-empty">モデルが見つかりません</li>';
    return;
  }
  for (const name of files) {
    const path = MODEL_DIR + name;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-list-item';
    btn.textContent = name;
    if (currentModelPath === path) btn.classList.add('is-current');
    btn.addEventListener('click', () => {
      closeModelDialog();
      if (path !== currentModelPath) switchModel(path);
    });
    li.appendChild(btn);
    modelListEl.appendChild(li);
  }
}

if (modelPickerBtn) {
  modelPickerBtn.addEventListener('click', () => {
    if (modelDialog && !modelDialog.classList.contains('hidden')) closeModelDialog();
    else openModelDialog();
  });
}
modelDialogClose?.addEventListener('click', closeModelDialog);
// 背景（パネル外）クリックで閉じる
modelDialog?.addEventListener('click', (event) => {
  if (event.target === modelDialog) closeModelDialog();
});

// 揺らしたい部位のキーワード（英字は小文字で比較）
const SWAY_KEYWORDS = ['髪', 'hair', 'スカート', 'skirt', '袖', 'sleeve', '裾', 'リボン', 'ribbon', 'ひも'];
// 体幹など、絶対に揺らさない／物理に渡さないボーン（安全のための除外）。
//   足・体幹に加え、足捩(あしよじり)・ひざ多段・補助/補正などの「変形連動(付与)用の特殊ボーン」も
//   除外する。これらに動的剛体があると、物理に引かれて太もも・すねが骨折したように歪むため、
//   揺れもの判定からも物理対象からも完全に外す（アニメ＋IK＋付与で正しく動かす）。
const SWAY_EXCLUDE = [
  'センター', 'center', '下半身', '上半身', '足', 'ひざ', '足首', 'つま先', 'body', 'グルーブ',
  // ↓ 時祭りイヴ等の特殊な補助ボーン（再生中の足の捩れ・歪みの原因）を物理から除外
  '捩', 'よじり', 'twist', '補助', '多段', '補正', 'インターポレート', 'interpolate', 'ＩＫ',
];

// 重力を除いた加速度（動きだけ）。減衰しながら保持する揺れ量ベクトル。
let accX = 0, accY = 0, accZ = 0;
let swayX = 0, swayY = 0, swayZ = 0;

// 重力成分の低域通過推定（accelerationIncludingGravity から重力を差し引くため）。
// これにより端末を静止させているときは accX/Y/Z ≒ 0 となり、ボーンが勝手に曲がり続けない。
let gravX = 0, gravY = 0, gravZ = 0;
let gravInit = false;
const GRAVITY_LP = 0.97; // 1 に近いほど重力推定がゆっくり追従＝振りの成分が acc に大きく残る

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
// 各ボーンの基準姿勢（restX/Z）を保存し、毎フレーム「基準＋減衰オフセット」で
// 絶対指定する。これにより加速度が止まると揺れが 0 に減衰し、元の位置へ戻る。
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
      swayBones.push({ bone, restX: bone.rotation.x, restZ: bone.rotation.z });
    }
  }
  console.log(`揺れもの対象ボーン: ${swayBones.length} 本`);
  // 親子チェーンの深さを計算（祖先が swayBones に含まれる数）
  const swayBoneSet = new Set(swayBones.map((b) => b.bone));
  for (const b of swayBones) {
    let depth = 0;
    let par = b.bone.parent;
    while (par) {
      if (swayBoneSet.has(par)) depth++;
      par = par.parent;
    }
    b.depth = depth;
  }
}

// =============================================================================
// ダンスモーション（VMD）＋ 楽曲（MP3）の選択・読み込み・同期再生
//   ・motions/<曲名>/ に dance.vmd と music.mp3 を 1 セットで配置する想定。
//   ・MMDAnimationHelper で VMD を再生する（スマホ負荷対策で物理演算 physics は false）。
//   ・音ズレ対策として、描画ループ内で Audio.currentTime を MMD のミキサーへ
//     強制同期する（mixer.setTime → helper.update(0)）。FPS が落ちても音と踊りが
//     ズレない。
//   ・モデル／楽曲を切り替えるときは、必ず音源を pause() して破棄・リセットする。
// -----------------------------------------------------------------------------

const MOTION_DIR = 'motions/';
const MOTION_MANIFEST = 'motions/motions.json';
const MOTION_VMD_EXT = '.vmd';
const MOTION_AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav'];
const MOTION_DEFAULT_VMD = 'dance.vmd';   // フォルダ名のみ与えられた場合の既定
const MOTION_DEFAULT_AUDIO = 'music.mp3';

// MMD モーション再生を司るヘルパー。物理演算は既定オフ（physicsEnabled で切替）。
//   pmxAnimation: true ―― PMX の「変形付与(Grant)・捩りボーン・補助ボーン」を、本家MMDと同じ
//   変形階層順（transformationClass 順）で毎フレーム計算させる重要設定。既定の false では
//   「IK→付与」を大雑把に一括処理するため、時祭りイヴ等の捩りボーンが正しい親角度を真似できず、
//   足が「太もも中間（足捩り）」「すね中間」で折れてしまう。true にすると _animatePMXMesh が
//   ボーンごとに付与＋IKを正しい順序で処理し、付与ボーンの回転が物理に潰されることもなくなる。
const mmdHelper = new MMDAnimationHelper({ pmxAnimation: true });

// 本格物理（Ammo.js）の ON/OFF。既定 OFF（軽量・Ammo 未ロード）。
// ON のときだけ Ammo.js を動的ロードし、helper.add 時に physics:true を渡す。
let physicsEnabled = false;

// 現在ロード中／再生中のダンス状態。1 つだけ保持する。
const danceState = {
  active: false,   // VMD クリップがモデルへ適用済みか（再生・一時停止を問わない）
  playing: false,  // 音源が再生中か
  loading: false,  // 読み込み中（多重ロード防止）
  name: null,      // 表示用の曲名
  mesh: null,      // クリップを適用したモデル（差し替え検知用）
  mixer: null,     // helper が内部生成した AnimationMixer（強制同期に使う）
  audio: null,     // HTML5 Audio オブジェクト
  clip: null,      // 読み込んだ VMD の AnimationClip（物理 ON/OFF 切替の再適用に使う）
  entry: null,     // 選択中モーションの { name, vmd, audio }（物理初回ONの再読込に使う）
};

const motionPickerBtn = document.getElementById('motion-picker-toggle');
const motionDialog = document.getElementById('motion-dialog');
const motionListEl = document.getElementById('motion-list');
const motionDialogClose = document.getElementById('motion-dialog-close');
const dancePlayBtn = document.getElementById('dance-play-toggle');
const nowPlayingEl = document.getElementById('now-playing');

// --- 画面最上部中央のステータス表示 -----------------------------------------
function setNowPlaying(text) {
  if (nowPlayingEl) nowPlayingEl.textContent = text;
}

// --- 再生ボタンの状態（有効／無効・アイコン）を一括更新 ----------------------
//   モデルとモーションの両方が揃うまでは disabled（CSS で半透明・タップ不可）。
function updateDancePlayButton() {
  if (!dancePlayBtn) return;
  const ready = modelReady && danceState.active;
  dancePlayBtn.disabled = !ready;
  dancePlayBtn.setAttribute('aria-pressed', String(danceState.playing));
  dancePlayBtn.textContent = danceState.playing ? '⏸️' : '▶️';
  dancePlayBtn.title = danceState.playing ? 'ダンスを一時停止' : 'ダンスを再生';
}

// --- ダンスの完全クリーンアップ（音源停止・破棄＋クリップ解除＋状態リセット） --
//   モデル切り替え・楽曲切り替えの前に必ず呼び、音が鳴り続けたり多重再生になるのを防ぐ。
function clearDance() {
  if (danceState.audio) {
    try {
      danceState.audio.pause();
      danceState.audio.removeAttribute('src');
      danceState.audio.load(); // バッファを解放
    } catch (_) { /* 破棄時のエラーは無視 */ }
  }
  mmdHelper.enable('physics', false); // 物理ゲートを必ずOFFにしてから外す
  if (danceState.mesh) {
    // helper から外す前に、全ボーンをバインドポーズへ戻す。曲変更で同じモデルが残る場合に、
    // 前の曲の補助ボーン（足捩り等）の歪みを持ち越さないため。
    resetMeshPose(danceState.mesh);
    try { mmdHelper.remove(danceState.mesh); } catch (_) { /* 未登録なら無視 */ }
  }
  danceState.active = false;
  danceState.playing = false;
  danceState.name = null;
  danceState.mesh = null;
  danceState.mixer = null;
  danceState.audio = null;
  danceState.clip = null;
  danceState.entry = null;
  updateDancePlayButton();
}

// -----------------------------------------------------------------------------
// 本格物理（Ammo.js）の動的ロードと ON/OFF
//   ・Ammo.js は重い（js+wasm で約 1MB）ため、ユーザーが物理を ON にした初回だけ
//     <script> を注入して読み込む。読み込んだ Ammo は MMDPhysics がグローバル参照
//     するので、初期化後に window.Ammo を解決済みインスタンスへ差し替える。
//   ・three と同じ CDN/バージョンから取得する（ammo.wasm.wasm も同階層にある）。
// -----------------------------------------------------------------------------
const AMMO_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/ammo.wasm.js';
let ammoReadyPromise = null;

function isAmmoReady() {
  return typeof window.Ammo !== 'undefined' && typeof window.Ammo.btVector3 === 'function';
}

// Ammo.js を一度だけ読み込み、初期化完了で解決する Promise を返す。
function ensureAmmo() {
  if (isAmmoReady()) return Promise.resolve();
  if (ammoReadyPromise) return ammoReadyPromise;
  ammoReadyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = AMMO_URL;
    script.async = true;
    script.onload = () => {
      // この時点で window.Ammo は「ファクトリ関数」。呼ぶと wasm 初期化の Promise を返す。
      try {
        window.Ammo().then((lib) => {
          window.Ammo = lib; // MMDPhysics が参照するグローバルを解決済みインスタンスへ
          resolve();
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error('Ammo.js を読み込めませんでした'));
    document.head.appendChild(script);
  });
  return ammoReadyPromise;
}

// -----------------------------------------------------------------------------
// 物理の「足除外フィルタ」は “ダンス読み込み時に 1 回だけ” 適用する設計。
//   ・足/ひざに動的剛体(type1/2)があると _optimizeIK が脚IKリンクを無効化 → CCDIKSolver が
//     break して脚IKを解けず、ホシノルリの足が骨折する。これを防ぐため、物理へ渡す剛体を
//     「揺れもの＋追従剛体(type0)」に絞ってから add する（＝足の動的剛体を物理から除外）。
//   ・この絞り込み＆ add は “ロード時の 1 回だけ”。再生中の ON/OFF では絶対に remove/add せず、
//     enable/reset のゲート操作のみにする。再生中（ボーンがスケール変形した状態）で add し直すと、
//     時祭りイヴの髪の物理スケール計算が壊れて巨大化・暴走するため。
// -----------------------------------------------------------------------------

// その剛体が紐づくボーンが「揺れもの（髪・スカート等）」かどうか。
// 既存の簡易 sway と同じ判定（SWAY_EXCLUDE で足・体幹・捩り/補助ボーンを確実に除外）。
function isSwayBoneName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (SWAY_EXCLUDE.some((k) => name.includes(k) || lower.includes(k))) return false;
  return SWAY_KEYWORDS.some((k) => name.includes(k) || lower.includes(k));
}

// MMDPhysics へ渡す剛体/拘束を「揺れもの＋追従剛体(type0)」だけに絞り込んだ配列を作る。
//   ・type0（追従：ボーン→剛体）は脚を動かさず、髪の拘束チェーンのアンカーにもなるので必ず保持。
//   ・type1/2（動的：剛体→ボーン）は揺れものボーンのものだけ保持し、足/体幹/腕は除外。
//   ・拘束は両端の剛体が残るものだけ残し、インデックスを新配列に再マップする。
function buildSwayOnlyPhysicsArrays(mesh) {
  const mmd = mesh.geometry.userData.MMD || {};
  const bones = mmd.bones || [];
  const srcBodies = mmd.rigidBodies || [];
  const srcConstraints = mmd.constraints || [];

  const indexMap = new Map(); // 旧剛体index → 新剛体index
  const bodies = [];
  srcBodies.forEach((rb, i) => {
    const keep = rb.type === 0 || isSwayBoneName(bones[rb.boneIndex] && bones[rb.boneIndex].name);
    if (keep) { indexMap.set(i, bodies.length); bodies.push(rb); }
  });

  const constraints = [];
  for (const c of srcConstraints) {
    const a = indexMap.get(c.rigidBodyIndex1);
    const b = indexMap.get(c.rigidBodyIndex2);
    if (a !== undefined && b !== undefined) {
      constraints.push(Object.assign({}, c, { rigidBodyIndex1: a, rigidBodyIndex2: b }));
    }
  }
  return { bodies, constraints, total: srcBodies.length };
}

// 足除外フィルタを適用してダンスを add する（＝物理システムを 1 回だけ確定させる）。
//   _createMMDPhysics は geometry.userData.MMD.rigidBodies/constraints を読むため、add の間だけ
//   絞り込んだ配列に差し替え、終わったら必ず元へ戻す。呼び出しは「ロード時の 1 回」に限定すること。
function addDanceWithPhysics(mesh, clip) {
  const mmd = mesh.geometry.userData.MMD;
  const origBodies = mmd.rigidBodies;
  const origConstraints = mmd.constraints;
  const filtered = buildSwayOnlyPhysicsArrays(mesh);
  mmd.rigidBodies = filtered.bodies;
  mmd.constraints = filtered.constraints;
  try {
    mmdHelper.add(mesh, { animation: clip, physics: true });
  } finally {
    mmd.rigidBodies = origBodies;       // MMDPhysics は構築時に取り込み済み。元データを復元
    mmd.constraints = origConstraints;
  }
  console.log(`物理剛体: ${filtered.bodies.length}/${filtered.total} を適用（揺れもの＋追従のみ／足・体幹は除外）`);
}

// 全 IK リンクを有効化して脚IKを復活させる（_optimizeIK が物理ONで切った分を戻す）。
//   足の動的剛体は除外済みなので、足は物理に上書きされず IK/アニメが制御できる。
function forceEnableAllIK(mesh) {
  const iks = mesh && mesh.geometry.userData.MMD && mesh.geometry.userData.MMD.iks;
  if (!iks) return;
  for (const ik of iks) {
    for (const link of ik.links) link.enabled = true;
  }
}

// 全ボーンをバインドポーズ（初期姿勢）へ完全リセットする。
//   再生終了・曲/モデル変更時に呼び、モーションで書き換えられた補助ボーン（足捩り等）の
//   変形が残らないようにする。pose() で全ボーンを初期化し、物理剛体も初期位置へ引き戻す。
//   ※ animate は playing=false の間ダンスを再適用しないため、この姿勢はそのまま保持される。
function resetMeshPose(mesh) {
  if (!mesh || typeof mesh.pose !== 'function') return;
  mesh.pose();                       // 全ボーン（補助・捩りボーン含む）をバインドポーズへ
  mesh.updateMatrixWorld(true);
  const objData = mmdHelper.objects.get(mesh);
  if (objData && objData.physics && typeof objData.physics.reset === 'function') {
    objData.physics.reset();         // 歪んだ剛体を初期位置へカチッと戻す
  }
  swayBones = null;                  // 簡易 sway の基準姿勢をバインドポーズで取り直す
}

// 物理ゲートを「現在あるべき状態」に同期する。
//   ❗暴走対策の肝：物理を有効化する瞬間は必ず
//     ① ゲートOFF（姿勢を動かす間、絶対に physics.update を走らせない）
//     ② 現在の音源位置へボーン姿勢を確定（アニメ＋IKのみ）
//     ③ physics.reset() で剛体を「今のボーン位置」へ強制スナップ
//     ④ ここで初めてゲートON
//   の順で行う。②の前にゲートをONのままだと、旧位置の剛体で拘束が暴れて体が崩壊する。
//   さらに「再生中(playing)かつ physicsEnabled」のときだけONにする（停止中・ロード直後はOFF）。
function syncPhysics(reposition = false) {
  // ① まず必ずゲートOFF
  mmdHelper.enable('physics', false);

  if (!danceState.mesh) return;
  const objData = mmdHelper.objects.get(danceState.mesh);
  const physics = objData ? objData.physics : null;

  // ② 必要なら現在の音源位置へボーン姿勢を確定（物理はゲートOFFなので走らない）
  if (reposition && danceState.mixer) {
    const t = danceState.audio ? danceState.audio.currentTime : 0;
    danceState.mixer.setTime(t);
    mmdHelper.update(0);
    danceState.mesh.updateMatrixWorld(true);
  }

  // ③④ 再生中かつ物理ONのときだけ、剛体リセット→ゲートON でクリーンに開始
  if (physicsEnabled && danceState.playing && physics && typeof physics.reset === 'function') {
    danceState.mesh.updateMatrixWorld(true); // reset は matrixWorld を読むので最新化
    physics.reset();
    mmdHelper.enable('physics', true);
    // enable('physics', true) は _optimizeIK で足IKリンクを無効化してしまう。
    // 足は物理対象外なので、ここで全IKリンクを有効へ戻し、脚IKをクリーンに再計算させる。
    forceEnableAllIK(danceState.mesh);
  }
}

// 現在のダンスに「物理オブジェクト」がまだ無ければ、一度だけ remove→add で生成する。
//   ❗remove は剛体を破棄せず・姿勢も戻さないため、再生中に繰り返すと warmup が変形姿勢から
//     再実行され崩壊が累積する。よって作り直しは「未生成のとき1回だけ」に限定する。
//     初回 ON 時点では物理は未稼働＝ボーンはアニメ由来のクリーンな姿勢なので安全に warmup できる。
// 現在のダンスに「足除外フィルタ済みの物理オブジェクト」があるか。
function hasPhysicsObject() {
  if (!danceState.mesh) return false;
  const obj = mmdHelper.objects.get(danceState.mesh);
  return !!(obj && obj.physics);
}

const physicsToggleBtn = document.getElementById('physics-toggle');

function updatePhysicsButton(busy = false) {
  if (!physicsToggleBtn) return;
  physicsToggleBtn.disabled = busy;
  physicsToggleBtn.setAttribute('aria-pressed', String(physicsEnabled));
  physicsToggleBtn.title = busy
    ? '物理エンジンを準備中…'
    : (physicsEnabled ? '本格物理：ON（タップでOFF）' : '本格物理：OFF（タップでON）');
}

// 物理 ON/OFF トグル。
//   ❗再構築（remove/add）は一切しない。物理オブジェクトはロード時に 1 回だけ生成済み（足除外）。
//     ・ON  … enable('physics', …) と physics.reset() のゲート操作のみ（syncPhysics）。
//     ・OFF … enable('physics', false) のみ。
//   例外：物理OFFのまま読み込んだダンスにはまだ物理オブジェクトが無い。その初回のみ、
//   モーションを「再読み込み」してロード時に物理を生成する（再生中の作り直しはしない＝
//   バインドポーズで生成されるのでスケールが壊れず、イヴの髪も巨大化しない）。
async function togglePhysics() {
  if (!physicsToggleBtn) return;
  const turningOn = !physicsEnabled;

  if (turningOn) {
    // ON 化：初回は Ammo.js のロードを待つ（ボタンは一時無効化）
    updatePhysicsButton(true);
    const prevText = nowPlayingEl ? nowPlayingEl.textContent : '';
    setNowPlaying('⏳ 物理エンジン(Ammo.js)を準備中...');
    try {
      await ensureAmmo();
    } catch (error) {
      console.error('Ammo.js の読み込みに失敗しました:', error);
      ammoReadyPromise = null; // 次回再試行できるようリセット
      setNowPlaying('⚠️ 物理エンジンを読み込めませんでした');
      updatePhysicsButton(false);
      return;
    }
    physicsEnabled = true;

    if (danceState.active && !hasPhysicsObject() && danceState.entry) {
      // 物理OFFのまま読み込んでいたダンス → 物理オブジェクト未生成。
      // 再生中の remove/add は避け、モーションを再読み込みしてロード時に 1 回だけ生成する。
      // 再読込中はボタンを無効のままにして二重タップを防ぐ。
      const entry = danceState.entry;
      setNowPlaying(`⏳ ${entry.name} に物理を適用中...`);
      await loadDance(entry);
      updatePhysicsButton(false);
    } else {
      updatePhysicsButton(false);
      setNowPlaying(prevText || '🎵 モーション未選択');
      syncPhysics(); // 再生中なら reset→ゲートON、停止中はOFFのまま
    }
  } else {
    // OFF 化：作り直さず、物理ゲートを閉じるだけ（剛体は保持＝次回ONが安価・安全）。
    physicsEnabled = false;
    updatePhysicsButton(false);
    syncPhysics(); // ゲートOFF。簡易 sway が再開する
  }
}

physicsToggleBtn?.addEventListener('click', () => { togglePhysics(); });

// --- VMD アニメーションを Promise で読み込むラッパー -------------------------
function loadAnimationClip(url, mesh) {
  return new Promise((resolve, reject) => {
    loader.loadAnimation(url, mesh, resolve, undefined, reject);
  });
}

// --- HTML5 Audio を「再生可能」になるまで待って返す -------------------------
function loadAudio(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'auto';
    const onReady = () => { cleanup(); resolve(audio); };
    const onError = () => { cleanup(); reject(new Error(`音源を読み込めません: ${url}`)); };
    function cleanup() {
      audio.removeEventListener('canplaythrough', onReady);
      audio.removeEventListener('loadeddata', onReady);
      audio.removeEventListener('error', onError);
    }
    audio.addEventListener('canplaythrough', onReady, { once: true });
    audio.addEventListener('loadeddata', onReady, { once: true }); // 保険（端末差）
    audio.addEventListener('error', onError, { once: true });
    audio.src = url;
    audio.load();
  });
}

// --- 選択された曲（VMD＋音源）をロードしてモデルへ適用 ----------------------
async function loadDance(entry) {
  if (danceState.loading) return;
  if (!currentModel || !modelReady) {
    setNowPlaying('🎵 先にモデルを読み込んでください');
    return;
  }
  const mesh = currentModel;
  danceState.loading = true;
  // 読み込み中はいったん既存ダンスを片付け、再生ボタンを無効化する
  clearDance();
  setNowPlaying(`⏳ ${entry.name} と音源を読み込み中...`);

  const vmdUrl = MOTION_DIR + entry.vmd;
  const audioUrl = MOTION_DIR + entry.audio;

  try {
    // VMD クリップと音源を並行して読み込む。物理 ON なら Ammo.js のロードも同時に待つ。
    const [clip, audio] = await Promise.all([
      loadAnimationClip(vmdUrl, mesh),
      loadAudio(audioUrl),
      physicsEnabled ? ensureAmmo() : Promise.resolve(),
    ]);

    // 読み込み中にモデルが差し替わっていたら破棄（古い mesh 用クリップは使えない）
    if (mesh !== currentModel) {
      try { audio.pause(); } catch (_) {}
      danceState.loading = false;
      return;
    }

    // 移動付与をクリップへ焼き込む（natsuyuki_ruri 系の足IKが正しく動くように）。
    // 直結IKのモデルでは何も追加されない（無変更）。helper.add の前に行う。
    bakeTranslationGrants(mesh, clip);

    // physicsEnabled に従って適用。OFF（既定）なら Ammo 不要で軽量、揺れは簡易 sway が担当。
    // ON なら揺れもの限定の本格物理（足・体幹は除外）で髪・スカートだけ揺れる（sway は抑止）。
    if (physicsEnabled) {
      addDanceWithPhysics(mesh, clip);
    } else {
      mmdHelper.add(mesh, { animation: clip, physics: false });
    }
    const objData = mmdHelper.objects.get(mesh);

    audio.addEventListener('ended', onAudioEnded);

    danceState.active = true;
    danceState.playing = false;
    danceState.name = entry.name;
    danceState.mesh = mesh;
    danceState.mixer = objData ? objData.mixer : null;
    danceState.audio = audio;
    danceState.clip = clip;
    danceState.entry = entry; // 物理初回ONの再読込に使う（clearDance 後に設定）

    // ロード直後は物理を必ずOFF（point3）。先頭フレームの姿勢だけ反映しておく
    // （再生前でも踊りの構えになる）。物理は再生ボタンが押された瞬間にクリーン開始する。
    mmdHelper.enable('physics', false);
    if (danceState.mixer) {
      danceState.mixer.setTime(0);
      mmdHelper.update(0);
    }
    syncPhysics(); // playing=false なのでゲートOFFのまま（停止中は物理スリープ）

    setNowPlaying(`🎵 選択中: ${entry.name}`);
    updateDancePlayButton();
  } catch (error) {
    console.error('ダンスの読み込みに失敗しました:', error);
    clearDance();
    setNowPlaying(`⚠️ 読み込めませんでした: ${entry.name}`);
  } finally {
    danceState.loading = false;
  }
}

// 音源が最後まで再生され終わったら、再生ボタンを「▶️（停止中）」へ戻し、物理もスリープし、
// 全ボーンをバインドポーズへリセットして（足捩り等の補助ボーンの歪み残りを解消）綺麗に直立させる。
function onAudioEnded() {
  danceState.playing = false;
  updateDancePlayButton();
  syncPhysics();                       // 停止中は物理ゲートOFF
  // ★終了時はバインドポーズへ戻さず、最終フレームのポーズをそのまま保持する。
  //   animate は playing=false の間ダンスを再適用しないので、最後に適用された姿勢が残る。
  // 音源位置だけ先頭へ戻す（ポーズは保持されたまま）。次に再生を押すと play 分岐の
  // syncPhysics(true) が頭(0秒)へ姿勢を合わせ直してから再生＝最初から踊り直す。
  try { if (danceState.audio) danceState.audio.currentTime = 0; } catch (_) {}
}

// --- 再生／一時停止トグル ----------------------------------------------------
function toggleDancePlayback() {
  if (!danceState.active || !danceState.audio) return;
  if (danceState.playing) {
    // 一時停止：物理もスリープさせる（停止中は剛体を進めない）
    danceState.audio.pause();
    danceState.playing = false;
    updateDancePlayButton();
    syncPhysics(); // ゲートOFF
  } else {
    // 再生開始／再開：まず現在の音源位置の踊り姿勢へ復帰させてから（終了後のバインドポーズや
    // 一時停止位置から確実に踊りへ戻す）、物理ONなら剛体リセット→ゲートONをクリーンに行う。
    danceState.playing = true;
    updateDancePlayButton();
    syncPhysics(true); // 現在位置へ姿勢確定 → physicsEnabled なら reset してゲートON
    // ボタンのタップ＝ユーザー操作なので、ここからの再生はモバイルでも許可される
    const p = danceState.audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.warn('音源の再生に失敗しました:', err);
        danceState.playing = false;
        updateDancePlayButton();
        syncPhysics(); // 再生に失敗したら物理も止める
      });
    }
  }
}

dancePlayBtn?.addEventListener('click', toggleDancePlayback);

// --- モーション一覧の取得（マニフェスト → ディレクトリ走査） ----------------
//   返り値は { name, vmd, audio } の配列（vmd/audio は motions/ からの相対パス）。
//   models 側と同じ思想：GitHub Pages では motions/motions.json が必須、autoindex
//   が使えるローカルサーバではディレクトリ走査でも拾える。

function isVmdFile(name) {
  return name.toLowerCase().endsWith(MOTION_VMD_EXT);
}
function isAudioFile(name) {
  const lower = name.toLowerCase();
  return MOTION_AUDIO_EXTS.some((ext) => lower.endsWith(ext));
}

// マニフェストの 1 要素を { name, vmd, audio } へ正規化する。
//   許容形式: "曲名"（フォルダ名のみ）/ { name, vmd, audio } / { name, dir }
function normalizeMotionEntry(item) {
  if (typeof item === 'string') {
    const folder = item.replace(/^\.?\/*/, '').replace(/^motions\//, '').replace(/\/+$/, '');
    if (!folder) return null;
    return { name: folder, vmd: `${folder}/${MOTION_DEFAULT_VMD}`, audio: `${folder}/${MOTION_DEFAULT_AUDIO}` };
  }
  if (item && typeof item === 'object') {
    const clean = (p) => typeof p === 'string' ? p.replace(/^\.?\/*/, '').replace(/^motions\//, '') : null;
    const dir = clean(item.dir)?.replace(/\/+$/, '');
    const vmd = clean(item.vmd) || (dir ? `${dir}/${MOTION_DEFAULT_VMD}` : null);
    const audio = clean(item.audio) || (dir ? `${dir}/${MOTION_DEFAULT_AUDIO}` : null);
    if (!vmd || !audio) return null;
    const name = item.name || dir || vmd.split('/')[0];
    return { name, vmd, audio };
  }
  return null;
}

async function loadMotionManifest() {
  try {
    const res = await fetch(MOTION_MANIFEST, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data?.motions;
    if (!Array.isArray(list)) return null;
    const cleaned = list.map(normalizeMotionEntry).filter(Boolean);
    return cleaned.length ? cleaned : null;
  } catch (error) {
    console.warn('motions.json を読み込めませんでした。', error);
    return null;
  }
}

// motions/ 直下の各サブフォルダを走査し、.vmd と音源ファイルが揃うフォルダを拾う。
async function crawlMotionFolders() {
  const results = [];
  let top;
  try {
    top = await readDirIndex(MOTION_DIR); // models 側と同じ index 解析を再利用
  } catch (error) {
    return results; // autoindex 非対応（GitHub Pages 等）
  }
  for (const dir of top.dirs) {
    let entry;
    try {
      entry = await readDirIndexAny(`${MOTION_DIR}${dir}/`);
    } catch (_) {
      continue;
    }
    const vmd = entry.files.find(isVmdFile);
    const audio = entry.files.find(isAudioFile);
    if (vmd && audio) {
      results.push({ name: dir, vmd: `${dir}/${vmd}`, audio: `${dir}/${audio}` });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

// readDirIndex は .pmx/.pmd しか files に入れないため、モーション用に全ファイルを返す版。
async function readDirIndexAny(dirUrl) {
  const files = [];
  const dirs = [];
  const res = await fetch(dirUrl, { headers: { Accept: 'text/html' } });
  if (!res.ok) return { files, dirs };
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('a[href]').forEach((a) => {
    let href = (a.getAttribute('href') || '').split('?')[0].split('#')[0];
    if (!href || href.startsWith('/') || href.includes('://')) return;
    const isDir = href.endsWith('/');
    let name = href.replace(/\/+$/, '');
    name = name.split('/').pop() || '';
    if (name === '' || name === '.' || name === '..') return;
    try { name = decodeURIComponent(name); } catch { /* そのまま */ }
    if (isDir) dirs.push(name); else files.push(name);
  });
  return { files, dirs };
}

async function listMotions() {
  const fromManifest = await loadMotionManifest();
  if (fromManifest && fromManifest.length) return fromManifest;
  return await crawlMotionFolders();
}

// --- モーション選択ダイアログ（🎵 アイコン） --------------------------------
function closeMotionDialog() {
  motionDialog?.classList.add('hidden');
  motionPickerBtn?.setAttribute('aria-expanded', 'false');
}

async function openMotionDialog() {
  if (!motionDialog || !motionListEl) return;
  motionDialog.classList.remove('hidden');
  motionPickerBtn?.setAttribute('aria-expanded', 'true');
  motionListEl.innerHTML = '<li class="model-list-empty">読み込み中…</li>';

  const motions = await listMotions();
  if (motionDialog.classList.contains('hidden')) return; // 取得中に閉じられた

  motionListEl.innerHTML = '';
  if (!motions.length) {
    motionListEl.innerHTML = '<li class="model-list-empty">モーションが見つかりません</li>';
    return;
  }
  for (const entry of motions) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-list-item'; // ダイアログ項目のスタイルを共用
    btn.textContent = entry.name;
    if (danceState.name === entry.name) btn.classList.add('is-current');
    btn.addEventListener('click', () => {
      closeMotionDialog();
      loadDance(entry);
    });
    li.appendChild(btn);
    motionListEl.appendChild(li);
  }
}

if (motionPickerBtn) {
  motionPickerBtn.addEventListener('click', () => {
    if (motionDialog && !motionDialog.classList.contains('hidden')) closeMotionDialog();
    else openMotionDialog();
  });
}
motionDialogClose?.addEventListener('click', closeMotionDialog);
motionDialog?.addEventListener('click', (event) => {
  if (event.target === motionDialog) closeMotionDialog();
});

// 起動時の初期表示
updateDancePlayButton();
updatePhysicsButton(false);
setNowPlaying('🎵 モーション未選択');

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

  // --- ダンス（VMD）と音源の強制同期 -------------------------------------------
  //   スマホで FPS が落ちても音と踊りがズレないよう、経過時間ではなく「音源の再生位置」
  //   へ毎フレーム追従させる。MMDAnimationHelper は _restoreBones → mixer.update(delta)
  //   → _saveBones → IK の順で処理し、ミキサーは delta だけ時間を進める実装なので、
  //   delta = audio.currentTime − mixer.time を渡せば、ミキサー時刻がちょうど音源時刻に
  //   一致する（＝強制同期）。setTime + update(0) では _restoreBones に姿勢を打ち消され、
  //   delta=0 で再適用されず固まるため、必ず差分を渡して update する。
  //   再生中(playing)のときだけ適用する。停止・一時停止・終了時は更新を止め、その時点の
  //   姿勢（停止＝直前の踊り、終了＝バインドポーズへリセット済み）をそのまま保持する。
  //   これにより、再生終了後に補助ボーンが歪んだまま再適用され続けるのを防ぐ。
  let danceUpdatedThisFrame = false;
  if (danceState.active && danceState.playing && danceState.mesh === currentModel && danceState.mixer && danceState.audio) {
    const delta = danceState.audio.currentTime - danceState.mixer.time;
    mmdHelper.update(delta);
    danceUpdatedThisFrame = true;
  }

  // --- 簡易揺れもの（フェイク物理）---------------------------------------------
  // ここは「モーション（VMD）が更新された直後」に相当する位置。モーション適用後の
  // ボーン角度に対して相対的に += するため、再生中の踊りを上書きして消さない。
  // 加速度（重力除去済み）を注入しつつ減衰 → 一瞬揺れて 0 へ戻る。クランプで発散防止。
  swayX = clamp(swayX * SWAY_DECAY + accX * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
  swayY = clamp(swayY * SWAY_DECAY + accY * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
  swayZ = clamp(swayZ * SWAY_DECAY + accZ * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);

  ensureSwayBones();
  // 本格物理が ON のときは MMDPhysics に揺れを委ねるため、簡易 sway は適用しない（二重適用回避）。
  if (!physicsEnabled && swayBones && swayBones.length) {
    // 加速度と「逆方向」になびく（右に振ったら服は左へ）。揺れ量はクランプ済み。
    const offX = clamp(-swayZ * SWAY_ROT_FACTOR, -SWAY_ROT_MAX, SWAY_ROT_MAX);
    const offZ = clamp(-swayX * SWAY_ROT_FACTOR, -SWAY_ROT_MAX, SWAY_ROT_MAX);
    for (const b of swayBones) {
      const factor = Math.pow(0.5, b.depth ?? 0);
      if (danceUpdatedThisFrame) {
        // ダンス再生中：helper が今フレームの踊り姿勢を書き込んだ直後なので、その上へ
        // 相対加算する（毎フレーム姿勢が再構築されるため累積しない）。踊りを消さずに
        // 髪・スカートだけ追加で揺らせる。
        b.bone.rotation.x += offX * factor;
        b.bone.rotation.z += offZ * factor;
      } else {
        // ダンス無し：「基準姿勢 ＋ 減衰オフセット」を絶対指定。offX/Z は加速度が
        // 止まると 0 へ減衰するので、基準姿勢（rest）へ自然に戻る（スプリングバック）。
        b.bone.rotation.x = b.restX + offX * factor;
        b.bone.rotation.z = b.restZ + offZ * factor;
      }
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
  // 第3引数を既定(true)にして canvas の表示サイズ(CSS)も毎回更新する。
  // false だと描画バッファ/カメラのアスペクトだけ変わり表示サイズが初期値のまま残り、
  // 全画面化などで高さが変わるとモデルが横に伸びる原因になる。
  renderer.setSize(width, height);
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

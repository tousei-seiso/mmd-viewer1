// =============================================================================
// sensor.js ―― スマートフォンの傾き(揺れ＝sway)・加速度(acc)センサー
//   ・加速度（重力除去済み）の検出と保持（DeviceMotion）
//   ・揺れ量（sway）の減衰付き値保持
//   ・診断（デバッグ）表示のオン／オフと描画
//
//   ※ 揺れ量を実際にボーンへ適用する処理は描画ループ（main.js の animate()）側に
//     残してある。このモジュールが担当するのは「センサー入力の検出・値の保持・
//     デバッグ表示」だけ。main.js からは下の export を import して使う。
// =============================================================================

// --- 揺れ量の調整値 ---
const SWAY_DECAY = 0.9;               // 毎フレームの減衰（1 に近いほど長く揺れる）
const SWAY_GAIN = 0.08;               // 加速度を揺れ量に変換する強さ
const SWAY_MAX = 5.0;                 // 揺れ量ベクトルの上限（クランプ。発散防止）
export const SWAY_ROT_FACTOR = 0.18;  // 揺れ量 → ボーン回転量（ラジアン）への係数
export const SWAY_ROT_MAX = 0.9;      // 揺れによる回転オフセットの上限（約50°）

// 重力成分の低域通過推定（accelerationIncludingGravity から重力を差し引く）。
// 1 に近いほど重力推定がゆっくり追従＝振りの成分が acc に大きく残る。
const GRAVITY_LP = 0.97;

// --- センサー値の保持（外部からは getAcc() / getSway() で参照する） ---
let accX = 0, accY = 0, accZ = 0;     // 重力を除いた加速度（動きだけ）
let swayX = 0, swayY = 0, swayZ = 0;  // 減衰しながら保持する揺れ量ベクトル

// 重力成分の推定値（accelerationIncludingGravity から差し引くため）。
// これにより端末を静止させているときは accX/Y/Z ≒ 0 となり、ボーンが勝手に曲がり続けない。
let gravX = 0, gravY = 0, gravZ = 0;
let gravInit = false;

// 診断表示（加速度・揺れ量・対象ボーン数）。右上アイコンで切替。
let swayDebug = false;

// 診断表示の出力先（画面最上部のステータス領域）
const statusEl = document.getElementById('status');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// --- 加速度センサーの検出（重力除去） ---------------------------------------
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

// --- 揺れ量の更新（毎フレーム呼ぶ：減衰＋加速度注入） -----------------------
//   加速度（重力除去済み）を注入しつつ減衰 → 一瞬揺れて 0 へ戻る。クランプで発散防止。
export function updateSway() {
  swayX = clamp(swayX * SWAY_DECAY + accX * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
  swayY = clamp(swayY * SWAY_DECAY + accY * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
  swayZ = clamp(swayZ * SWAY_DECAY + accZ * SWAY_GAIN, -SWAY_MAX, SWAY_MAX);
}

// --- DeviceOrientationEvent ―― 生の alpha/beta/gamma とロール不変な方位角の取得 ------
//   DeviceMotion とは別イベント。
//   raw な alpha/beta/gamma は view3d.js がクォータニオン合成に直接使用する。
//   orientationAlpha（ツイスト角）は後方互換で残す。
const _DEG = Math.PI / 180;
let orientationAlpha = null; // ラジアン。未受信時は null
let orientationActive = false;

// raw 角度（度単位）。未受信時はすべて 0 。
let _rawAlpha = 0, _rawBeta = 0, _rawGamma = 0;

function onDeviceOrientation(event) {
  const { alpha, beta, gamma } = event;
  if (alpha == null || beta == null || gamma == null) return;
  orientationActive = true;

  // raw 値を保存（view3d.js がクォータニオン合成に使う）
  _rawAlpha = alpha;
  _rawBeta  = beta;
  _rawGamma = gamma;

  // W3C ZXY オイラー角 → クォータニオン → ENU Z 軸スウィング・ツイスト分解
  const ha = alpha * _DEG * 0.5;
  const hb = beta  * _DEG * 0.5;
  const hg = gamma * _DEG * 0.5;
  const ca = Math.cos(ha), sa = Math.sin(ha);
  const cb = Math.cos(hb), sb = Math.sin(hb);
  const cg = Math.cos(hg), sg = Math.sin(hg);

  const fw = ca*cb*cg - sa*sb*sg;
  const fz = ca*sb*sg + sa*cb*cg;

  orientationAlpha = 2.0 * Math.atan2(fz, fw);
}

// --- センサー値の参照 -------------------------------------------------------
export function getAcc() { return { x: accX, y: accY, z: accZ }; }
export function getSway() { return { x: swayX, y: swayY, z: swayZ }; }
export function getGrav() { return { x: gravX, y: gravY, z: gravZ }; }
export function getOrientationAlpha() { return orientationAlpha; }
export function isOrientationActive() { return orientationActive; }
// DeviceOrientationEvent の生角度（度単位）。未受信時は { alpha:0, beta:0, gamma:0 }。
export function getOrientationAngles() { return { alpha: _rawAlpha, beta: _rawBeta, gamma: _rawGamma }; }

// --- 診断（デバッグ）表示の状態 ---------------------------------------------
export function isSwayDebug() { return swayDebug; }

// 診断表示の描画（ON のときだけ #status に出す）。boneCount は揺れもの対象ボーン数。
export function renderSwayDebug(boneCount) {
  if (!swayDebug || !statusEl) return;
  statusEl.classList.remove('hidden');
  statusEl.textContent =
    `acc ${accX.toFixed(2)} ${accY.toFixed(2)} ${accZ.toFixed(2)} | ` +
    `sway ${swayX.toFixed(2)} ${swayZ.toFixed(2)} | bones ${boneCount}`;
}

// --- 初期化：加速度センサーの購読＋DeviceOrientation 購読＋診断トグルの配線 --
//   起動と同時に、無条件で加速度センサーの購読を開始する。
//   DeviceOrientationEvent は iOS 13+ でパーミッションが必要なため、最初の
//   ユーザー操作（touchstart / pointerdown）を検知してから requestPermission() を呼ぶ。
//   Android・非 iOS ブラウザはそのまま購読を開始する。
export function initSensors() {
  window.addEventListener('devicemotion', onDeviceMotion);

  // DeviceOrientation（コンパス方位角 alpha）の購読
  function startOrientationListener() {
    window.addEventListener('deviceorientation', onDeviceOrientation);
  }

  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+: ユーザー操作を契機に permission を要求する（二重呼び出し防止フラグ付き）
    let permissionAsked = false;
    const askPermission = () => {
      if (permissionAsked) return;
      permissionAsked = true;
      DeviceOrientationEvent.requestPermission()
        .then(state => { if (state === 'granted') startOrientationListener(); })
        .catch(() => {});
    };
    // touchstart と pointerdown の両方を登録しておく（どちらが先に来ても OK）
    document.addEventListener('touchstart', askPermission, { once: true, passive: true });
    document.addEventListener('pointerdown', askPermission, { once: true });
  } else {
    startOrientationListener();
  }

  const debugToggleBtn = document.getElementById('debug-toggle');
  if (debugToggleBtn) {
    debugToggleBtn.addEventListener('click', () => {
      swayDebug = !swayDebug;
      debugToggleBtn.setAttribute('aria-pressed', String(swayDebug));
      if (!swayDebug && statusEl) statusEl.classList.add('hidden'); // OFF 時は表示を隠す
    });
  }
}

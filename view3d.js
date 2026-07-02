// =============================================================================
// view3d.js ―― 3D シーン・モデル・ダンス・物理エンジン本体
//   Three.js + MMDLoader で 3D 空間を構築し、モデル読み込み・ジャイロ/タッチ操作・
//   揺れもの適用・VMD ダンス再生・本格物理(Ammo.js)・描画ループを担当する。
//
//   ・センサー入力（加速度・揺れ量）は sensor.js から取り込む。
//   ・楽曲の読み込み・再生制御・シークバーは audio.js が担当し、ここからは
//     loadAudio / updateDancePlayButton / updateSeekBar / onAudioEnded /
//     isSeekScrubbing を import して連携する。
//   ・UI（各種アイコン・ダイアログ・カラーパレット）は ui.js が担当し、ここでは
//     その操作対象となる関数（resetView / switchModel / applyBgColor / loadDance
//     / 物理 ON-OFF 用プリミティブ等）を export する。
//   ・実際の起動（イベント登録・モデル読み込み・描画ループ開始）は initView3d() に
//     まとめてあり、エントリーポイント（main.js）から呼ばれる。
// =============================================================================

import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';

// スマホの傾き(揺れ＝sway)・加速度(acc)センサーの値参照・更新（sensor.js）
import {
  SWAY_ROT_FACTOR,
  SWAY_ROT_MAX,
  updateSway,
  getSway,
  isOrientationActive,
  getOrientationAngles,
  renderSwayDebug,
  isSwayDebug,
} from './sensor.js?v=11';

// 楽曲の読み込み・再生制御・シークバー（audio.js）
import {
  loadAudio,
  updateDancePlayButton,
  updateSeekBar,
  onAudioEnded,
  isSeekScrubbing,
} from './audio.js?v=11';

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

// 起動時の基準アングル（リセット時の正面構図を定義する）。「正面 少し斜め上から見下ろす」。
const BASE_YAW = THREE.MathUtils.degToRad(16);    // 少し斜め（横方向）
const BASE_PITCH = THREE.MathUtils.degToRad(-15); // 少し上から見下ろす（負＝見下ろし）


// カメラの up ベクトルに使う定数（frontViewQuat 計算に使用）
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
//   preserveDrawingBuffer: true ―― スクリーンショット（toDataURL）で描画バッファを
//   読み出せるようにする。これが無いと描画直後にバッファがクリアされ、キャプチャ画像が
//   真っ黒になる（takeScreenshot 参照）。
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 高 DPI 端末の負荷を抑制
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// -----------------------------------------------------------------------------
// ライト・地面（ステージ）
// -----------------------------------------------------------------------------

// ライティングの初期設定（テーマ：晴天の昼間）。
//   ・指向性光源（太陽）: 方位角45°・仰角45°から、白色・やや強め(1.2)で差し込む。
//   ・環境光: 全体を柔らかく底上げする補助光（白色・0.6）。
const LIGHT_DEFAULTS = {
  directional: { azimuth: 45, elevation: 45, intensity: 1.2, color: 0xffffff },
  ambient: { intensity: 0.6, color: 0xffffff },
};

// 指向性光源の公転半径（TARGET からライト位置までの距離）。方位角・仰角と合わせて
// Spherical 座標変換で position を決める（LightController._computeOffset 参照）。
const LIGHT_RADIUS = 10.0;

// -----------------------------------------------------------------------------
// LightController ―― AR ビューワーの光源設定を総合的に制御する
//   指向性光源（DirectionalLight）と環境光（AmbientLight）を 1 つにまとめ、UI からの
//   パラメータ変更（方位角・仰角・強度・色・モード）を即時反映する。既存のレンダリング
//   ループ・IK モーション制御には一切干渉しない（読むだけ／自分のライトしか書かない）。
//
//   ■ 指向性光源の位置（Spherical 座標変換, r = LIGHT_RADIUS 固定）
//       x = r * cos(β) * sin(α)
//       y = r * sin(β)
//       z = r * cos(β) * cos(α)
//     α = 方位角(0–360°), β = 仰角(0–90°)。この offset を注視点(TARGET＝モデル中心)へ
//     加えた点をライト位置とし、target を常に TARGET に固定してモデルを照らす。
//
//   ■ ライティングモード（lightMode）
//     'world'（既定）: offset をワールド空間へそのまま適用＝光源はワールドに固定され、
//                      太陽光のように「モデルが回っても光の向きは変わらない」。
//     'model'        : offset をモデルのワールド回転（＝Yaw のみ）で回してから適用＝
//                      光源はモデル正面に相対配置され、モデルが向きを変えても常に
//                      正面から光が当たる（モデル追従）。モデルが無ければワールド固定に退避。
// -----------------------------------------------------------------------------
class LightController {
  constructor(scene, target, defaults, radius) {
    this.scene = scene;
    this.target = target;          // 注視点＝モデル中心（TARGET, Vector3）。ライトの照射先。
    this.radius = radius;          // 公転半径 r（固定）
    this.lightMode = 'world';      // 既定は世界固定モード（太陽光）

    // 指向性光源の球面パラメータ（度）
    this.azimuth = defaults.directional.azimuth;     // 方位角 0–360°
    this.elevation = defaults.directional.elevation; // 仰角 0–90°

    // 指向性光源（主光源。影を落とす）
    this.dirLight = new THREE.DirectionalLight(
      defaults.directional.color,
      defaults.directional.intensity
    );
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.camera.near = 1;
    this.dirLight.shadow.camera.far = 100;
    this.dirLight.shadow.camera.left = -25;
    this.dirLight.shadow.camera.right = 25;
    this.dirLight.shadow.camera.top = 25;
    this.dirLight.shadow.camera.bottom = -25;
    this.scene.add(this.dirLight);
    // DirectionalLight は target（既定は原点）へ向かう。target をシーンに追加し、
    // 位置を TARGET（モデル中心）へ固定して常にモデルを照らす。
    this.scene.add(this.dirLight.target);

    // 2. ヘルパーの作成（クラス内部で完結させる）
    this.helper = new THREE.DirectionalLightHelper(this.dirLight, 5); // <--- 変更・追加
    this.scene.add(this.helper); // <--- 変更・追加

    // 環境光（全体を柔らかく底上げ）
    this.ambient = new THREE.AmbientLight(
      defaults.ambient.color,
      defaults.ambient.intensity
    );
    this.scene.add(this.ambient);

    // 使い回す一時オブジェクト（毎フレーム new しない）
    this._offset = new THREE.Vector3();
    this._modelQuat = new THREE.Quaternion();
    this._modelPos = new THREE.Vector3();   // 検知ノードのワールド位置（移動追従用）
    this._followCenter = new THREE.Vector3(); // 追従時の照射先＝公転中心（一時）
    this._euler = new THREE.Euler();       // ワールド回転 → YXZ Euler 変換用
    this._yawEuler = new THREE.Euler();     // Yaw のみの Euler
    this._yawQuat = new THREE.Quaternion(); // Yaw のみの Quaternion
    this._debugPos = null;                  // 直近で検知した水平位置 {x,z}（デバッグ用）

    // モデル追従モードで「実際に回転しているノード」をキャッシュする。
    //   MMD モデルは SkinnedMesh で、ダンス中の向きの変化はスケルトン内のボーン
    //   （センター等）で起きる。SkinnedMesh 自身の quaternion は回らないため、
    //   currentModel を getWorldQuaternion しても回転を検知できない（＝光源が追従しない）。
    //   そこで回転を担うルート／センターボーンを探し、その world 回転を採用する。
    this._rotSource = null;    // 検知した回転ノード（ボーン or モデル）
    this._rotSourceFor = null; // そのノードを解決した対象モデル（キャッシュキー）
    this._debugYaw = null;     // 直近フレームで検知した Yaw（ラジアン, デバッグ用）

    this.update(); // 初期位置を確定
  }

  _clampDeg(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // モデルの中から「体の向き（facing）を表すノード」を解決する（毎フレームは探索せずキャッシュ）。
  //   1. モデル自身／子孫から SkinnedMesh（スケルトンあり）を探す。
  //   2. スケルトンがあれば、向きを担う代表ボーンを優先順で探す。
  //      ※ 重要：getWorldQuaternion は「祖先」の回転しか累積せず、子孫の回転は含まない。
  //        実機診断で、ダンス中もセンター／全ての親の world Yaw は起動時の値のまま一定
  //        だと判明した（＝体の向き変更はセンターの“子”＝下半身／上半身側で起きている）。
  //        そのためセンターをサンプリングしても向きの変化を捉えられない。
  //        体の facing を最も安定して表すのは骨盤＝下半身なので、下半身を最優先で選ぶ。
  //        （上半身はダンスの捻りノイズが大きいため次点。センター系は最後の保険。）
  //   3. スケルトンが無ければモデル自身を返す（applyModelYaw の回転だけは拾える）。
  _resolveRotationSource(model) {
    if (!model) return null;
    if (this._rotSourceFor === model && this._rotSource) return this._rotSource;

    let skinned = model.isSkinnedMesh ? model : null;
    if (!skinned) {
      model.traverse((o) => { if (!skinned && o.isSkinnedMesh && o.skeleton) skinned = o; });
    }

    let node = null;
    if (skinned && skinned.skeleton && skinned.skeleton.bones.length) {
      const bones = skinned.skeleton.bones;
      // 体の向きを表すボーンを、下半身（骨盤）→上半身→センター系の順で探す。
      // 「先」（下半身先など表示専用でアニメしないボーン）や捻り系は避けたいので後ろへ。
      const priority = ['下半身', 'lower', '上半身', 'upper', 'グルーブ', 'groove', 'センター', 'center', '全ての親', 'root'];
      for (const key of priority) {
        const lower = key.toLowerCase();
        const found = bones.find((b) => {
          const n = b.name || '';
          // 「先」「捩」「補助」等の派生ボーンは体幹の facing 用には使わない。
          if (n.includes('先') || n.includes('捩') || n.includes('よじり') || n.includes('twist')) return false;
          return n.includes(key) || n.toLowerCase().includes(lower);
        });
        if (found) { node = found; break; }
      }
      if (!node) node = bones[0]; // 代表ボーンが見つからなければルートボーン
    }
    if (!node) node = model; // ボーンが無ければモデル自身

    this._rotSource = node;
    this._rotSourceFor = model;
    console.log(`[LightController] 回転検知ノード: ${node.name || node.type || '(model)'}`);
    return node;
  }

  // 球面パラメータ（方位角 α・仰角 β）から TARGET 基準のオフセットベクトルを求める。
  _computeOffset() {
    const a = THREE.MathUtils.degToRad(this.azimuth);
    const b = THREE.MathUtils.degToRad(this.elevation);
    const r = this.radius;
    return this._offset.set(
      r * Math.cos(b) * Math.sin(a),
      r * Math.sin(b),
      r * Math.cos(b) * Math.cos(a)
    );
  }

  // 指向性光源の位置とターゲットを更新する。
  //   毎フレーム animate() から呼ばれ、モデル追従モードではモデルの向きに追従させる。
  //   引数 model は現在のモデル（currentModel）。省略時はワールド固定として扱う。
  update(model) {
    const offset = this._computeOffset();

    // 公転中心＝照射先。既定はワールド固定の TARGET（モデル中心の高さ）。
    // モデル追従モードでは、検知ノードのワールド位置に合わせて水平（X/Z）に移動させる。
    const center = this._followCenter.copy(this.target);

    // モデル追従モード：モデルのワールド回転から Yaw（Y 軸回転）成分のみを抽出し、
    // その回転で offset を回して水平に追従させる。ワールド回転をそのまま適用すると
    // Pitch/Roll まで反映されて仰角（elevation）が傾いてしまうため、Yaw のみに限定する。
    // さらに、検知ノードのワールド位置に合わせて公転中心を水平移動させ、モデルが
    // 床の上を移動しても光源がついていくようにする（高さ TARGET.y は固定）。
    if (this.lightMode === 'model' && model) {
      // モデル自身ではなく「実際に回転するノード（センター等のボーン）」の world 姿勢を使う。
      const source = this._resolveRotationSource(model);
      source.getWorldQuaternion(this._modelQuat);
      source.getWorldPosition(this._modelPos);
      // YXZ 順の Euler に変換し、Y 成分（Yaw）だけを取り出した Quaternion を作る。
      const euler = this._euler.setFromQuaternion(this._modelQuat, 'YXZ');
      this._debugYaw = euler.y; // デバッグ用に検知した Yaw を保持
      const yawQuat = this._yawQuat.setFromEuler(this._yawEuler.set(0, euler.y, 0));
      offset.applyQuaternion(yawQuat);
      // 水平位置のみ追従（高さは注視点の高さを維持）。
      center.set(this._modelPos.x, this.target.y, this._modelPos.z);
      this._debugPos = { x: this._modelPos.x, z: this._modelPos.z };
    } else {
      this._debugYaw = null; // 世界固定モード or モデル無し
      this._debugPos = null;
    }

    // 照射先（target）は公転中心へ。ライト位置はその周囲 offset の点。
    this.dirLight.position.copy(center).add(offset);
    this.dirLight.target.position.copy(center);
    //this.dirLight.target.updateMatrixWorld();
    // 行列の強制更新と影の再計算トリガー
    this.dirLight.updateMatrixWorld(); // <--- 変更・追加
    this.dirLight.target.updateMatrixWorld(); // <--- 変更・追加
    if (this.dirLight.shadow) { // <--- 変更・追加
        this.dirLight.shadow.camera.updateProjectionMatrix(); // <--- 変更・追加
    } // <--- 変更・追加
    
    // ヘルパーの更新
    if (this.helper) this.helper.update(); // <--- 変更・追加
  }

  // --- UI から呼ばれる個別セッター（変更を即時反映） ---------------------------
  setAzimuth(deg)   { this.azimuth = this._clampDeg(deg, 0, 360); this.update(currentModel); }
  setElevation(deg) { this.elevation = this._clampDeg(deg, 0, 90); this.update(currentModel); }
  setDirIntensity(v) { this.dirLight.intensity = Math.max(0, v); }
  setDirColor(value) { this.dirLight.color.set(value); }
  setAmbientIntensity(v) { this.ambient.intensity = Math.max(0, v); }
  setAmbientColor(value) { this.ambient.color.set(value); }
  setLightMode(mode) {
    // 'world'（世界固定）/ 'model'（モデル追従）のみ受け付ける。
    this.lightMode = mode === 'model' ? 'model' : 'world';
    this.update(currentModel);
  }

  // 現在の設定を UI 初期化用に返す（副作用なし）。
  getState() {
    return {
      azimuth: this.azimuth,
      elevation: this.elevation,
      dirIntensity: this.dirLight.intensity,
      dirColor: '#' + this.dirLight.color.getHexString(),
      ambientIntensity: this.ambient.intensity,
      ambientColor: '#' + this.ambient.color.getHexString(),
      lightMode: this.lightMode,
    };
  }

  // --- 光源ヘルパー（DirectionalLightHelper）の表示 ON/OFF -----------------------
  setHelperVisible(visible) { if (this.helper) this.helper.visible = !!visible; }
  isHelperVisible() { return this.helper ? this.helper.visible : false; }

  // --- デバッグ情報（📊 診断表示で影が動かない原因の切り分けに使う） --------------
  //   mode   : 現在のライティングモード（'world' / 'model'）
  //   node   : 回転検知に使っているノード名（センター等のボーン名 / 'model'）
  //   yawDeg : そのノードから検知した Yaw（度）。null は世界固定 or モデル未検知。
  //   モデルが回っているのに yawDeg が変化しない → 検知ノードが回っていない（要2で対処）。
  //   yawDeg は変化しているのに影が動かない → 光源への適用側の問題、と切り分けられる。
  getDebugInfo() {
    return {
      mode: this.lightMode,
      node: this._rotSource ? (this._rotSource.name || this._rotSource.type || 'model') : '-',
      yawDeg: this._debugYaw == null ? null : THREE.MathUtils.radToDeg(this._debugYaw),
      pos: this._debugPos, // {x,z} または null
    };
  }
}

// コントローラ実体。以降シーンの光源はこれが一手に握る。
const lightController = new LightController(scene, TARGET, LIGHT_DEFAULTS, LIGHT_RADIUS);

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
export async function switchModel(path) {
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

// -----------------------------------------------------------------------------
// カメラ制御 ―― ARCameraController（フル AR：カメラ姿勢＝デバイス姿勢）
//
//   【設計の結論】要件「モデルの床が現実の床と平行（重力に対して垂直）」「ハンドル回し
//   してもモデルが傾かない」は、画面上で水平を保つ意味ではなく、“仮想世界を現実空間へ
//   登録し、モデルが常に現実の重力に対して立ち続ける”＝フル AR を意味する。よって
//   カメラ姿勢にデバイス姿勢クォータニオン q を「そのまま」用いる:
//
//     camera.quaternion = q
//     camera.position   = TARGET − distance × forward      （forward = (0,0,-1)·q）
//
//   ・q をそのまま使うのでジンバルロックも極での反転も折り返しも一切起きない
//     （クォータニオンは全姿勢で連続）。挙動1・2の「頭上/足裏を越えると戻る」も解消。
//   ・スマホをロール（ハンドル回し）すると q のロール成分でカメラも回り、画面上では
//     モデルが逆回転して見える＝モデルは現実の重力に対して立ち続ける（要件1）。
//   ・位置を TARGET から forward 方向へ distance だけ引くので、距離は常に一定（要件2）、
//     かつカメラは常に TARGET を正面に捉える（要件3）。
//   ・以前は「階層構造でロールを除去」していたが、それはモデルを画面に貼り付ける挙動で
//     要件と逆だった。ロールを含むフル AR が正しい。
//
//   ドラッグ操作は、デバイス姿勢に対する追加オービット（ローカル回転）として合成する。
//   平滑化はクォータニオンの slerp で行う（角度分解しないので破綻しない）。
//   モデルの正面方向はリセット時に applyModelYaw() で調整する（従来どおり）。
// -----------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// デバイス座標系 → カメラ座標系補正（X 軸まわり -90°）
const _Q_CORR_X = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

// フレームごとに使い回す一時オブジェクト
const _euler_dq   = new THREE.Euler();
const _deviceQuat = new THREE.Quaternion();
const _userDir    = new THREE.Vector3();   // resetView でのユーザー方向（一時）
const _targetQuat = new THREE.Quaternion(); // フレームごとの目標カメラ姿勢（一時）
const _dragQuat   = new THREE.Quaternion(); // ドラッグ・オービット回転（一時）
const _dragEuler  = new THREE.Euler();      // ドラッグ角→クォータニオン変換用（一時）
const _fwd        = new THREE.Vector3();    // カメラ前方ベクトル（一時）

// alpha/beta/gamma（度単位）→ _deviceQuat（Three.js DeviceOrientationControls 準拠）
function computeDeviceQuat(alpha, beta, gamma) {
  _euler_dq.set(
    THREE.MathUtils.degToRad(beta  ?? 0),
    THREE.MathUtils.degToRad(alpha ?? 0),
    -THREE.MathUtils.degToRad(gamma ?? 0),
    'YXZ'
  );
  _deviceQuat.setFromEuler(_euler_dq);
  _deviceQuat.multiply(_Q_CORR_X);
}

// モデルの Yaw（Y軸回転）を targetUserDir の方向に合わせる（リセット時のみ呼ぶ）
//   targetUserDir: ワールド空間での「モデル中心からユーザーへの方向」ベクトル（XZ 平面）
//   モデルのローカル前面（+Z 軸）がその方向を向くよう、WORLD_UP 軸まわりに回転する。
//   モデルの座標・ピッチ・ロールは一切変更しない。
function applyModelYaw(targetUserDir) {
  if (!currentModel) return;
  // モデルのワールド姿勢を取得してローカル前面（+Z）をワールド座標に変換
  const wq = new THREE.Quaternion();
  currentModel.getWorldQuaternion(wq);
  const modelFront = new THREE.Vector3(0, 0, 1).applyQuaternion(wq);
  // XZ 平面での現在 Yaw と目標 Yaw（atan2(x, z) = +Z 軸からの水平角）
  const currentYaw = Math.atan2(modelFront.x, modelFront.z);
  const targetYaw  = Math.atan2(targetUserDir.x, targetUserDir.z);
  let diff = targetYaw - currentYaw;
  while (diff >  Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  currentModel.rotateOnWorldAxis(WORLD_UP, diff);
}

// --- モデルの「体の向き（Yaw）」検出（カメラ追従用の共有ヘルパー）-----------------
//   光源追従（LightController._resolveRotationSource / update）と同じ手法。MMD モデルは
//   SkinnedMesh 自身の quaternion が回らず、向きの変化はスケルトン内のボーン（下半身等）で
//   起きる。そこで facing を最も安定して表す代表ボーンを解決し、その world 回転の Y 成分
//   （Yaw）のみを取り出す。カメラ追従 ON 時に、この Yaw をカメラの周回角へ加算して、
//   モデルが向きを変えてもカメラが同じ相対位置から見続けるようにする。
const _camYawQuat  = new THREE.Quaternion(); // 検知ノードの world 回転（一時）
const _camYawEuler = new THREE.Euler();      // world 回転 → YXZ Euler 変換用（一時）
const _camYawCache = { node: null, forModel: null }; // 回転検知ノードのキャッシュ

function resolveFacingBone(model, cache) {
  if (!model) return null;
  if (cache.forModel === model && cache.node) return cache.node;

  let skinned = model.isSkinnedMesh ? model : null;
  if (!skinned) model.traverse((o) => { if (!skinned && o.isSkinnedMesh && o.skeleton) skinned = o; });

  let node = null;
  if (skinned && skinned.skeleton && skinned.skeleton.bones.length) {
    const bones = skinned.skeleton.bones;
    // 体の向きを表すボーンを、下半身（骨盤）→上半身→センター系の順で探す（光源追従と同一）。
    const priority = ['下半身', 'lower', '上半身', 'upper', 'グルーブ', 'groove', 'センター', 'center', '全ての親', 'root'];
    for (const key of priority) {
      const lower = key.toLowerCase();
      const found = bones.find((b) => {
        const n = b.name || '';
        if (n.includes('先') || n.includes('捩') || n.includes('よじり') || n.includes('twist')) return false;
        return n.includes(key) || n.toLowerCase().includes(lower);
      });
      if (found) { node = found; break; }
    }
    if (!node) node = bones[0];
  }
  if (!node) node = model;

  cache.node = node;
  cache.forModel = model;
  return node;
}

// モデルの facing Yaw（ラジアン）を返す。モデル未検出時は 0。
function getModelFacingYaw(model, cache) {
  const node = resolveFacingBone(model, cache);
  if (!node) return 0;
  node.getWorldQuaternion(_camYawQuat);
  return _camYawEuler.setFromQuaternion(_camYawQuat, 'YXZ').y;
}

// --- ARCameraController ------------------------------------------------------
//   フル AR：毎フレーム camera.quaternion = q（デバイス姿勢）にし、位置を TARGET から
//   forward 方向へ distance だけ引く。ドラッグはローカル追加回転、平滑化は slerp。
const SMOOTH_ANGLE = 0.25; // 姿勢 slerp の滑らかさ（0=固定, 1=即時）

class ARCameraController {
  constructor(cam, target) {
    this.camera = cam;
    this.target = target;
    this.distance = ORBIT_RADIUS;
    this.lastFy = 0; // 直近の視線 f.y（テレメトリ表示用）

    // センサー未受信時の基準姿勢（起動時の「正面 少し見下ろし」構図）。
    this._baseQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(BASE_PITCH, BASE_YAW, 0, 'YXZ')
    );
    // 平滑化された現在のカメラ姿勢
    this.smoothQuat = this._baseQuat.clone();

    // カメラはシーングラフに属さず（親なし）、毎フレーム世界姿勢を直接代入する。
    cam.up.set(0, 1, 0);
    this._applyToCamera();
  }

  // 毎フレーム更新。q: デバイス姿勢クォータニオン。opts: { hasDevice, dragYaw, dragPitch, targetDistance }
  update(q, opts) {
    // 目標姿勢：デバイスがあれば q そのもの（フル AR）、無ければ基準姿勢。
    if (opts.hasDevice) {
      _targetQuat.copy(q);
      this.lastFy = _fwd.set(0, 0, -1).applyQuaternion(q).y; // テレメトリ用
    } else {
      _targetQuat.copy(this._baseQuat);
    }

    // ドラッグはデバイス座標系でのローカル追加回転（モデルは常に中心に保たれる）。
    if (opts.dragYaw || opts.dragPitch) {
      _dragEuler.set(opts.dragPitch, opts.dragYaw, 0, 'YXZ');
      _dragQuat.setFromEuler(_dragEuler);
      _targetQuat.multiply(_dragQuat);
    }

    // 姿勢を slerp で平滑化（角度分解しないのでどの姿勢でも破綻しない）。
    this.smoothQuat.slerp(_targetQuat, SMOOTH_ANGLE);

    // ズーム距離を滑らかに追従（要件2：距離一定）。
    this.distance += (opts.targetDistance - this.distance) * ZOOM_SMOOTHING;

    this._applyToCamera();
  }

  // smoothQuat と distance からカメラの世界姿勢・位置を確定する。
  //   camera.quaternion = 姿勢、position = TARGET − distance × forward（常に TARGET を注視）。
  _applyToCamera() {
    this.camera.quaternion.copy(this.smoothQuat);
    _fwd.set(0, 0, -1).applyQuaternion(this.smoothQuat); // カメラ前方
    this.camera.position.copy(this.target).addScaledVector(_fwd, -this.distance);
  }

  // ズーム距離を即時設定（リセット時に滑らか追従を待たず確定させる）
  setDistance(d) {
    this.distance = d;
    this._applyToCamera();
  }
}

// コントローラ実体。以降カメラの姿勢・位置はこれが一手に握る。
const cameraController = new ARCameraController(camera, TARGET);

// 毎フレーム呼ばれるカメラ姿勢更新（デバイス姿勢＋ドラッグ＋追従＋ズームを集約）
function updateCameraPose() {
  const hasDevice = isOrientationActive();
  if (hasDevice) {
    const angles = getOrientationAngles();
    computeDeviceQuat(angles.alpha, angles.beta, angles.gamma);
  }
  // カメラ追従 ON のときは、モデルの facing Yaw を周回角へ加算する（光源追従と同じ手法）。
  // これにより、モデルが向きを変えてもカメラは同じ相対位置からモデルを見続ける。
  const followYaw = (cameraFollow && currentModel) ? getModelFacingYaw(currentModel, _camYawCache) : 0;
  cameraController.update(_deviceQuat, {
    hasDevice,
    dragYaw: dragYaw + followYaw,
    dragPitch,
    targetDistance,
  });
}

// 📊 診断表示 ON のとき、カメラ角・生センサー値を #status に併記する（調整・原因切り分け用）。
//   renderSwayDebug（揺れもの情報 acc/sway/bones）が毎フレーム先に書いた内容の後ろへ、
//   α/β/γ（DeviceOrientation 生角度）・f.y（視線の上下成分）・dist（カメラ距離）を追記する。
//   renderSwayDebug が毎フレーム textContent を上書きするので、併記しても累積しない。
function renderCameraDebug() {
  if (!statusEl || !isSwayDebug()) return;
  const a = getOrientationAngles();
  const c = cameraController;
  statusEl.classList.remove('hidden');
  const cam =
    `α${Math.round(a.alpha)} β${Math.round(a.beta)} γ${Math.round(a.gamma)} | ` +
    `f.y ${c.lastFy.toFixed(2)} | dist ${Math.round(c.distance)}`;
  // 光源追従の切り分け情報：検知ノードと Yaw（度）。モデルを回して yaw が動くか確認する。
  const li = lightController.getDebugInfo();
  const light = li.mode === 'model'
    ? `light:model node=${li.node} yaw=${li.yawDeg == null ? '-' : Math.round(li.yawDeg) + '°'}` +
      (li.pos ? ` pos(${li.pos.x.toFixed(1)},${li.pos.z.toFixed(1)})` : '')
    : 'light:world';
  statusEl.textContent = statusEl.textContent ? `${statusEl.textContent} | ${cam} | ${light}` : `${cam} | ${light}`;
}

// -----------------------------------------------------------------------------
// タッチ／マウス操作 ―― ドラッグ回転 ＆ ピンチ/ホイールズーム
//   ピンチ/ホイール由来の距離（targetDistance）は cameraController がカメラの公転半径へ反映する。
// -----------------------------------------------------------------------------

const MIN_DISTANCE = 5;          // 最も寄れる距離
const MAX_DISTANCE = 80;         // 最も引ける距離
const DRAG_ROT_SPEED = 0.005;    // ドラッグ回転の感度（ラジアン/px）
const DRAG_YAW_DIR = -1;         // 水平ドラッグの向き（好みで反転）
const DRAG_PITCH_DIR = -1;       // 垂直ドラッグの向き（好みで反転）
const DRAG_PITCH_LIMIT = 1.3;    // ドラッグで変えられる見上げ/見下ろし量の上限（ラジアン）
const WHEEL_ZOOM_SPEED = 0.0015; // ホイールズームの感度
const ZOOM_SMOOTHING = 0.2;      // ズーム距離の追従の滑らかさ

// ドラッグによる「基準角度オフセット」（ジャイロ回転に加算される）。
// カメラ設定パネル（⚙️）の「方位角」「仰角」はこの dragYaw / dragPitch を指す
// （既定の正面構図＝リセット位置からのオフセット角）。
let dragYaw = 0;
let dragPitch = 0;

// ピンチ/ホイールによるズーム距離（目標値）。実距離の滑らか追従は cameraController が担う。
let targetDistance = ORBIT_RADIUS;

// カメラ追従（🎥）。ON のとき updateCameraPose がモデルの facing Yaw を周回角へ加算する。
let cameraFollow = false;

// カメラ角がドラッグ／リセットで変わったことを UI（設定パネル）へ通知するリスナー群。
// 「ドラッグ時に方位角・仰角の設定値を自動更新」する要件のための仕組み。
const cameraChangeListeners = [];
function notifyCameraChange() {
  for (const cb of cameraChangeListeners) { try { cb(); } catch (_) {} }
}

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
    // カメラ設定パネルの「方位角・仰角」をドラッグ位置へ自動追従させる。
    notifyCameraChange();
  } else if (activePointers.size === 2) {
    // 2本指 → ピンチズーム（指の間隔の比率で距離を伸縮）
    const dist = pointerDistance();
    if (pinchPrevDist !== null && dist > 0) {
      targetDistance = clamp(
        targetDistance * (pinchPrevDist / dist),
        MIN_DISTANCE,
        MAX_DISTANCE
      );
      notifyCameraChange(); // 距離スライダーもピンチに追従
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
  notifyCameraChange(); // 距離スライダーもホイールに追従
}

// -----------------------------------------------------------------------------
// 簡易揺れものシステム（フェイク物理）― 加速度センサーで服・髪だけをなびかせる
//   ※ 加速度の検出・揺れ量の値保持・診断表示のオン/オフは sensor.js が担当する。
//   ※ ここでは「揺らす対象ボーンの抽出」と、描画ループでの「揺れ量のボーン適用」を行う。
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// 正面・全身リセット（🧍 アイコン）
//   カメラの周回角を起動時の「正面」構図へ戻し、現在表示中モデルのバウンディング
//   ボックスから全身が画面に収まる距離を計算してズームを合わせる。
//   ※ TARGET（注視点）は動かさない方針なので、注視点を基準に上下・左右で必要な
//     距離をそれぞれ求め、より引いた方（＝全体が確実に収まる方）を採用する。
//   ※ ボタン配線は ui.js が行い、ここでは resetView() を export する。
// -----------------------------------------------------------------------------

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

// カメラをリセットする
//   リセット時点のスマホが向いている方向（orbitDir）をユーザーの方向と見なし、
//   モデルの正面（ローカル +Z）がその方向を向くよう applyModelYaw() で回転させる。
//   ズームは computeFitDistance() で最適距離を求めて即時反映する。
export function resetView() {
  dragYaw = 0;
  dragPitch = 0;

  // 現在のデバイスクォータニオンからユーザーの方向（= モデル中心→カメラ方向）を求める。
  // カメラ視線 f=(0,0,-1)·q に対し、ユーザーは反対側 (0,0,1)·q に居る。
  const angles = getOrientationAngles();
  computeDeviceQuat(angles.alpha, angles.beta, angles.gamma);
  _userDir.set(0, 0, 1).applyQuaternion(_deviceQuat);

  // モデルの正面をユーザー方向へ向ける（Y 軸回転のみ）
  applyModelYaw(_userDir);

  const fitDist = computeFitDistance();
  targetDistance = fitDist;
  cameraController.setDistance(fitDist); // 滑らか追従を待たず即時確定

  notifyCameraChange(); // 方位角・仰角・距離をリセット値へ同期（設定パネル反映）
}

// -----------------------------------------------------------------------------
// 背景・床の色変更（🎨 アイコン）
//   UI（ui.js）のカラーピッカーから渡された値を Three.js へ反映する。
//   背景: scene.background（THREE.Color を set） / 床: ground メッシュの material.color。
// -----------------------------------------------------------------------------
export function applyBgColor(value) {
  // AR 中は背景がカメラ映像（VideoTexture）なので、色は「AR 解除後に戻る背景」へ反映する。
  // これにより、AR を切った瞬間に選んだ色がそのまま現れる。
  if (arActive) {
    if (arSavedBackground && arSavedBackground.isColor) arSavedBackground.set(value);
    else arSavedBackground = new THREE.Color(value);
    return;
  }
  if (scene.background && scene.background.isColor) scene.background.set(value);
  else scene.background = new THREE.Color(value);
}
export function applyFloorColor(value) {
  if (ground && ground.material && ground.material.color) ground.material.color.set(value);
}

// -----------------------------------------------------------------------------
// 光源設定（💡 ライトパネル）
//   UI（ui.js）のスライダー・カラーピッカー・モード切替から渡された値を LightController
//   へ即時反映する。実処理はすべて lightController が持ち、ここは薄い橋渡しに徹する。
//   既存のレンダリング／IK モーション制御には一切干渉しない（自分の光源だけを触る）。
// -----------------------------------------------------------------------------
export function setLightAzimuth(deg)        { lightController.setAzimuth(deg); }
export function setLightElevation(deg)      { lightController.setElevation(deg); }
export function setLightDirIntensity(v)     { lightController.setDirIntensity(v); }
export function setLightDirColor(value)     { lightController.setDirColor(value); }
export function setLightAmbientIntensity(v) { lightController.setAmbientIntensity(v); }
export function setLightAmbientColor(value) { lightController.setAmbientColor(value); }
export function setLightMode(mode)          { lightController.setLightMode(mode); }
export function getLightState()             { return lightController.getState(); }
// 光源ヘルパー（DirectionalLightHelper）の表示 ON/OFF。トグル時は新しい表示状態を返す。
export function setLightHelperVisible(v)    { lightController.setHelperVisible(v); }
export function toggleLightHelper()         { const v = !lightController.isHelperVisible(); lightController.setHelperVisible(v); return v; }
export function isLightHelperVisible()      { return lightController.isHelperVisible(); }
// 📊 診断表示用：現在の光源追従デバッグ情報（モード・検知ノード・検知 Yaw）。
export function getLightDebugInfo()         { return lightController.getDebugInfo(); }

// -----------------------------------------------------------------------------
// カメラ設定（⚙️ カメラパネル ／ 🎥 カメラ追従トグル）
//   UI（ui.js）から方位角・仰角・距離・追従 ON/OFF を受け取り、既存のカメラ制御
//   （dragYaw / dragPitch / targetDistance / cameraFollow）へ橋渡しする。
//   ・方位角／仰角は「既定の正面構図（リセット位置）からのオフセット角」を表す。
//   ・距離は TARGET からのカメラ公転半径（実距離は滑らかに追従）。
//   ・追従 ON 時は updateCameraPose がモデルの facing Yaw を周回角へ加算する（光源追従と同手法）。
// -----------------------------------------------------------------------------

// 方位角を [0,360) 度へ正規化して返す（dragYaw はドラッグで無制限に累積するため）。
function normalizeAzimuthDeg(rad) {
  const deg = THREE.MathUtils.radToDeg(rad) % 360;
  return deg < 0 ? deg + 360 : deg;
}

// 仰角スライダーの可動域（度）。ドラッグの見上げ/見下ろし上限（DRAG_PITCH_LIMIT）に合わせる。
const CAMERA_ELEVATION_LIMIT_DEG = Math.floor(THREE.MathUtils.radToDeg(DRAG_PITCH_LIMIT)); // ≒74

export function setCameraAzimuth(deg)   { dragYaw = THREE.MathUtils.degToRad(deg); }
export function setCameraElevation(deg) {
  const r = THREE.MathUtils.degToRad(deg);
  dragPitch = clamp(r, -DRAG_PITCH_LIMIT, DRAG_PITCH_LIMIT);
}
export function setCameraDistance(v)    { targetDistance = clamp(v, MIN_DISTANCE, MAX_DISTANCE); }
export function setCameraFollow(on)     { cameraFollow = !!on; }
export function isCameraFollow()        { return cameraFollow; }

// 現在のカメラ設定を UI 同期用に返す（副作用なし）。スライダーの min/max もここで供給する。
export function getCameraState() {
  return {
    azimuth: normalizeAzimuthDeg(dragYaw),
    elevation: THREE.MathUtils.radToDeg(dragPitch),
    distance: targetDistance,
    follow: cameraFollow,
    minDistance: MIN_DISTANCE,
    maxDistance: MAX_DISTANCE,
    elevationLimit: CAMERA_ELEVATION_LIMIT_DEG,
  };
}

// カメラ角がドラッグ／ピンチ／リセットで変わったときに呼ばれるコールバックを登録する。
// ui.js がこれで設定パネルの表示（方位角・仰角・距離）をカメラ操作へ追従させる。
export function onCameraChange(cb) {
  if (typeof cb === 'function') cameraChangeListeners.push(cb);
}

// -----------------------------------------------------------------------------
// AR（背面カメラ）背景モード（📹 アイコン）
//   ON 時: 端末の背面カメラ映像を取得し、THREE.VideoTexture として scene.background に
//          設定する。通常の床(ground)・グリッド(grid)は隠し、モデルだけがカメラ映像の
//          上に重なって見える（“その場にモデルがいる”ように見せる簡易 AR）。
//          背景を VideoTexture にすることで描画は WebGL 内で完結し、既存の
//          スクリーンショット（描画バッファ読み出し）にもカメラ映像がそのまま写る。
//   OFF 時: ストリームを停止してテクスチャを破棄し、元の背景色と床/グリッドを復帰する。
//   ※ カメラ取得には HTTPS（または localhost）とユーザー許可が必要（GitHub Pages は HTTPS）。
//   ※ 端末を傾けるとジャイロ連動カメラ(updateCameraPose)でモデルの周囲を見回せる。
// -----------------------------------------------------------------------------
let arActive = false;
let arStream = null;                       // getUserMedia の MediaStream（停止時に track.stop()）
let arTexture = null;                      // scene.background に設定する VideoTexture
let arSavedBackground = scene.background;  // AR 解除後に戻す通常背景（THREE.Color）
const arVideo = document.getElementById('ar-video');

export function isArEnabled() { return arActive; }

// カメラ映像をビューポートへ「cover」（はみ出しを切り取り中央寄せ）で合わせる。
//   scene.background に設定したテクスチャは、その UV 変換（center/repeat）が背景描画へ
//   そのまま反映される。映像と画面のアスペクト比のズレをここで補正し、引き伸ばさない。
function updateArBackgroundFit() {
  if (!arActive || !arTexture || !arVideo) return;
  const vw = arVideo.videoWidth, vh = arVideo.videoHeight;
  if (!vw || !vh) return; // メタデータ未確定（loadedmetadata 前）はスキップ
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  const screenAspect = width / height;
  const videoAspect = vw / vh;
  arTexture.center.set(0.5, 0.5);
  if (screenAspect > videoAspect) {
    // 画面が映像より横長 → 縦（上下）を切り取って横幅を満たす
    arTexture.repeat.set(1, videoAspect / screenAspect);
  } else {
    // 画面が映像より縦長 → 横（左右）を切り取って高さを満たす
    arTexture.repeat.set(screenAspect / videoAspect, 1);
  }
  arTexture.needsUpdate = true;
}

async function enableAr() {
  if (arActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('このブラウザはカメラ取得に対応していません');
  }
  if (!arVideo) throw new Error('AR 用の video 要素が見つかりません');

  // 背面カメラを優先（ideal なので非対応端末では前面にフォールバック）。音声は不要。
  arStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  arVideo.srcObject = arStream;
  arVideo.muted = true;       // 自動再生の前提（音声トラックは無いが念のため）
  arVideo.playsInline = true; // iOS でフルスクリーン再生に奪われないように
  // メタデータが来てから videoWidth/Height が確定する。play() は環境により拒否されても続行。
  try { await arVideo.play(); } catch (_) { /* 自動再生制限でも以後フレームは届く */ }

  arTexture = new THREE.VideoTexture(arVideo);
  arTexture.colorSpace = THREE.SRGBColorSpace; // カメラ映像は sRGB
  arTexture.minFilter = THREE.LinearFilter;
  arTexture.magFilter = THREE.LinearFilter;

  // 解除後に戻すため、現在の通常背景を退避してから差し替える。
  arSavedBackground = scene.background;
  scene.background = arTexture;

  // 床・グリッドは AR では邪魔なので隠す（モデルだけをカメラ映像へ重ねる）。
  ground.visible = false;
  grid.visible = false;

  arActive = true;
  // アスペクト補正は即時＋メタデータ確定後の両方で行う（初回は寸法未確定のことが多い）。
  updateArBackgroundFit();
  arVideo.addEventListener('loadedmetadata', updateArBackgroundFit, { once: true });
}

function disableAr() {
  if (!arActive) return;
  arActive = false;
  // 背景を通常色へ戻し、床・グリッドを復帰させる。
  scene.background = arSavedBackground;
  ground.visible = true;
  grid.visible = true;
  // ストリーム停止（端末のカメラ使用インジケータを消す）とリソース解放。
  if (arStream) {
    for (const track of arStream.getTracks()) track.stop();
    arStream = null;
  }
  if (arVideo) {
    try { arVideo.pause(); } catch (_) { /* 無視 */ }
    arVideo.srcObject = null;
  }
  if (arTexture) {
    arTexture.dispose();
    arTexture = null;
  }
}

// ui.js の AR ボタンから呼ぶ。on=true で有効化、false で無効化。
// 失敗（非対応・許可拒否）時は例外を投げるので、呼び出し側でメッセージ表示・UI 復帰する。
export async function setArEnabled(on) {
  if (on) await enableAr();
  else disableAr();
}

// -----------------------------------------------------------------------------
// モデル一覧の取得（📁 ダイアログのデータソース）
//   models/ 以下（サブフォルダ含む）の .pmx / .pmd を一覧する。取得は次の優先順位:
//     1. models/models.json（マニフェスト）… GitHub Pages 等の静的ホスティングでも
//        確実に動く。`node tools/build-models-manifest.mjs` で再生成できる。
//     2. ディレクトリインデックスの再帰走査 … python http.server など autoindex を
//        返すローカル開発サーバ向け（マニフェストが無い/古いときの保険）。
//   ※ GitHub Pages はディレクトリ一覧を返さない（models/ は 404）。このため公開環境では
//     必ずマニフェストが必要。両方失敗したときだけ既知リストへフォールバックする。
//   ※ ダイアログの開閉・項目描画は ui.js が担当する（listModelFiles / MODEL_DIR を import）。
// -----------------------------------------------------------------------------

export const MODEL_DIR = 'models/';
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
export async function listModelFiles() {
  const fromManifest = await loadModelManifest();
  if (fromManifest && fromManifest.length) return fromManifest;

  const fromCrawl = await crawlModelFiles();
  if (fromCrawl.length) return fromCrawl;

  return [...FALLBACK_MODEL_FILES].filter(isModelFile).sort((a, b) => a.localeCompare(b, 'ja'));
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
export const danceState = {
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

const nowPlayingEl = document.getElementById('now-playing');

// --- 画面最上部中央のステータス表示 -----------------------------------------
export function setNowPlaying(text) {
  if (nowPlayingEl) nowPlayingEl.textContent = text;
}
// 現在の表示文字列（物理 ON 中の一時メッセージ後に元へ戻すため ui.js が参照する）
export function getNowPlaying() {
  return nowPlayingEl ? nowPlayingEl.textContent : '';
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
//   ※ ON/OFF トグルの UI は ui.js。ここでは ensureAmmo / resetAmmoLoad 等を export する。
// -----------------------------------------------------------------------------
const AMMO_URL = 'https://unpkg.com/three@0.160.0/examples/jsm/libs/ammo.wasm.js';
let ammoReadyPromise = null;

function isAmmoReady() {
  return typeof window.Ammo !== 'undefined' && typeof window.Ammo.btVector3 === 'function';
}

// Ammo.js を一度だけ読み込み、初期化完了で解決する Promise を返す。
export function ensureAmmo() {
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

// Ammo ロードに失敗したとき、次回再試行できるよう保持中の Promise を破棄する（ui.js から呼ぶ）。
export function resetAmmoLoad() {
  ammoReadyPromise = null;
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
export function syncPhysics(reposition = false) {
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

// 現在のダンスに「足除外フィルタ済みの物理オブジェクト」があるか。
//   ❗remove は剛体を破棄せず・姿勢も戻さないため、再生中に繰り返すと warmup が変形姿勢から
//     再実行され崩壊が累積する。よって作り直しは「未生成のとき1回だけ」に限定する。
export function hasPhysicsObject() {
  if (!danceState.mesh) return false;
  const obj = mmdHelper.objects.get(danceState.mesh);
  return !!(obj && obj.physics);
}

// --- VMD アニメーションを Promise で読み込むラッパー -------------------------
function loadAnimationClip(url, mesh) {
  return new Promise((resolve, reject) => {
    loader.loadAnimation(url, mesh, resolve, undefined, reject);
  });
}

// --- 選択された曲（VMD＋音源）をロードしてモデルへ適用 ----------------------
export async function loadDance(entry) {
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

// --- モーション一覧の取得（マニフェスト → ディレクトリ走査） ----------------
//   返り値は { name, vmd, audio } の配列（vmd/audio は motions/ からの相対パス）。
//   models 側と同じ思想：GitHub Pages では motions/motions.json が必須、autoindex
//   が使えるローカルサーバではディレクトリ走査でも拾える。
//   ※ ダイアログの開閉・項目描画は ui.js（listMotions / loadDance を import）。

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

export async function listMotions() {
  const fromManifest = await loadMotionManifest();
  if (fromManifest && fromManifest.length) return fromManifest;
  return await crawlMotionFolders();
}

// -----------------------------------------------------------------------------
// 描画ループ
// -----------------------------------------------------------------------------

function animate() {
  requestAnimationFrame(animate);

  // ---- カメラ姿勢更新 ---------------------------------------------------------
  updateCameraPose();

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
  //   ※ シーク中(seekScrubbing)は applySeek 側で姿勢を当てるため、ここでは同期しない。
  let danceUpdatedThisFrame = false;
  if (danceState.active && danceState.playing && !isSeekScrubbing() && danceState.mesh === currentModel && danceState.mixer && danceState.audio) {
    const delta = danceState.audio.currentTime - danceState.mixer.time;
    mmdHelper.update(delta);
    danceUpdatedThisFrame = true;
  }
  // 再生位置バーのつまみ・時刻を更新（ドラッグ中はドラッグ側が更新するのでスキップ）。
  if (!isSeekScrubbing()) updateSeekBar();

  // --- 簡易揺れもの（フェイク物理）---------------------------------------------
  // ここは「モーション（VMD）が更新された直後」に相当する位置。モーション適用後の
  // ボーン角度に対して相対的に += するため、再生中の踊りを上書きして消さない。
  // 加速度（重力除去済み）を注入しつつ減衰 → 一瞬揺れて 0 へ戻る（値保持は sensor.js）。
  updateSway();
  const sway = getSway();

  ensureSwayBones();
  // 本格物理が ON のときは MMDPhysics に揺れを委ねるため、簡易 sway は適用しない（二重適用回避）。
  if (!physicsEnabled && swayBones && swayBones.length) {
    // 加速度と「逆方向」になびく（右に振ったら服は左へ）。揺れ量はクランプ済み。
    const offX = clamp(-sway.z * SWAY_ROT_FACTOR, -SWAY_ROT_MAX, SWAY_ROT_MAX);
    const offZ = clamp(-sway.x * SWAY_ROT_FACTOR, -SWAY_ROT_MAX, SWAY_ROT_MAX);
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

  // ---- 光源更新 ---------------------------------------------------------------
  //   世界固定モードでは同じ位置を再確定するだけ（実質不変）、モデル追従モードでは
  //   モデルの向き（センター等のボーンのワールド回転）に合わせて指向性光源を追従させる。
  //   ダンスのボーン更新（mmdHelper.update）と揺れもの適用の「後」に呼ぶことで、
  //   今フレームの姿勢を遅延なく反映し、📊 のデバッグ Yaw も現在の見た目と一致させる。
  lightController.update(currentModel);

  // [一時診断] 加速度が実際に届いているか／対象ボーン数を画面に常時表示（sensor.js）。
  // 端末を振っても acc が 0.00 のままなら devicemotion 未配信が原因。右上アイコンで OFF にできる。
  renderSwayDebug(swayBones ? swayBones.length : '-');
  renderCameraDebug(); // 📊 ON 時はカメラ角・生センサー値を表示（sway 表示を上書き）

  // AR 背景（カメラ映像）は毎フレーム最新フレームへ更新する（VideoTexture の再アップロード）。
  if (arActive && arTexture) arTexture.needsUpdate = true;

  renderer.render(scene, camera);
}

// -----------------------------------------------------------------------------
// リサイズ対応（端末回転・ウィンドウサイズ変更・アドレスバー伸縮など）
//   どんな理由でビューポートが変わっても 3D 表示が崩れないよう、毎回カメラの
//   アスペクト比とレンダラーのサイズ・ピクセル比を実寸から再計算して追従する。
// -----------------------------------------------------------------------------

export function resizeRenderer() {
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

  // AR 背景中はビューポート変化に追従してカメラ映像の cover を再計算する。
  if (arActive) updateArBackgroundFit();
}

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

// -----------------------------------------------------------------------------
// 公開アクセサ（audio.js への依存注入や ui.js の物理トグルが使う）
// -----------------------------------------------------------------------------
export function isModelReady() { return modelReady; }
// 現在の 3D 画面を PNG の DataURL としてキャプチャして返す（ui.js のスクショボタンが使う）。
//   ・呼び出し直前に一度描画して、最新フレームを確実にバッファへ載せてから読み出す。
//   ・WebGLRenderer は preserveDrawingBuffer: true で生成済みなので toDataURL で読める
//     （無効だと描画バッファがクリアされ画像が真っ黒になる）。
export function takeScreenshot() {
  renderer.render(scene, camera); // 直近フレームを確実に描いてからキャプチャ
  return renderer.domElement.toDataURL('image/png');
}
export function applyMixerDelta(delta) { mmdHelper.update(delta); }
export function isPhysicsEnabled() { return physicsEnabled; }
export function setPhysicsEnabled(value) { physicsEnabled = value; }
export function getCurrentModelPath() { return currentModelPath; }

// -----------------------------------------------------------------------------
// 初期化（エントリーポイントから呼ぶ）
//   入力イベントの登録・初期モデル読み込み・描画ループ開始・初期サイズ合わせをまとめる。
// -----------------------------------------------------------------------------
export function initView3d() {
  // タッチ／マウス操作（ドラッグ回転・ピンチ/ホイールズーム）
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

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

  // 初期モデルの読み込み（候補を順に試す。未配置でもアプリが落ちないようにする）
  loadModelWithFallback(MODEL_CANDIDATES)
    .then(({ mesh, path }) => {
      applyModel(mesh, path);
      setStatus('読み込み完了', true);
    })
    .catch((error) => {
      console.error('モデルの読み込みに失敗しました:', error);
      setStatus(`モデルを読み込めませんでした（${MODEL_CANDIDATES.join(' / ')} のいずれかを配置してください）`);
    });

  // 起動時の初期表示
  setNowPlaying('🎵 モーション未選択');

  // 初期カメラ位置を確定（センサー未受信のため identity deviceQuat → +Z 方向）
  updateCameraPose();

  // 描画ループ開始
  animate();

  // 初期化直後にも一度実寸へ合わせておく
  resizeRenderer();
}

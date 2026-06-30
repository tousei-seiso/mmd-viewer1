// =============================================================================
// ui.js ―― 画面上の各種アイコン・ダイアログ・カラーパレットの UI
//   担当するもの:
//     ・画面の向き固定トグル（🔓⇄🔒）
//     ・正面・全身リセット（🧍）
//     ・背景／床の色変更（🎨 カラーパレットの表示切り替えと色の反映）
//     ・モデル選択ダイアログ（📁）
//     ・モーション選択ダイアログ（🎵）
//     ・本格物理 ON/OFF トグル（🧲）
//   ※ デバッグ表示トグルは sensor.js、再生/一時停止/停止・シークバーは audio.js が
//     それぞれ自前で配線する（このファイルでは扱わない）。
//   ※ 実際の効果（カメラ操作・色反映・モデル切替・ダンス読込・物理 ON/OFF 等）は
//     view3d.js の関数を import して呼び出す。配線は initUI() でまとめて行う。
// =============================================================================

import {
  resetView,
  applyBgColor,
  applyFloorColor,
  listModelFiles,
  getCurrentModelPath,
  MODEL_DIR,
  switchModel,
  listMotions,
  loadDance,
  danceState,
  isPhysicsEnabled,
  setPhysicsEnabled,
  ensureAmmo,
  resetAmmoLoad,
  hasPhysicsObject,
  syncPhysics,
  setNowPlaying,
  getNowPlaying,
  resizeRenderer,
  takeScreenshot,
} from './view3d.js?v=4';

// -----------------------------------------------------------------------------
// 画面の向き固定トグル（🔓⇄🔒）
//   Android Edge/Chrome では screen.orientation.lock() は「フルスクリーン中のみ」
//   許可される。ボタンのタップ自体が必要なユーザー操作になるため、ここで
//   requestFullscreen() → lock('portrait') の順に呼べば確実に縦固定できる。
//   解除時は unlock() してフルスクリーンも抜ける。ユーザーが端末操作で
//   フルスクリーンを抜けた場合（＝ロックも自動解除）は UI を同期する。
// -----------------------------------------------------------------------------
function setupOrientationLock() {
  const orientationLockBtn = document.getElementById('orientation-lock-toggle');
  if (!orientationLockBtn) return;
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
//   実際のカメラ操作は view3d.js の resetView()。ここはボタン配線のみ。
// -----------------------------------------------------------------------------
function setupResetView() {
  const resetViewBtn = document.getElementById('reset-view-toggle');
  resetViewBtn?.addEventListener('click', resetView);
}

// -----------------------------------------------------------------------------
// スクリーンショット（📷 アイコン）
//   現在の 3D 画面を view3d.js の takeScreenshot() で PNG の DataURL として取得し、
//   選択画面やダイアログを一切挟まずにサイレント保存する。一時的な <a download> を
//   動的生成して click() を発火させ、バックグラウンドで即座にダウンロードを実行する。
// -----------------------------------------------------------------------------
function setupScreenshot() {
  const screenshotBtn = document.getElementById('screenshot-toggle');
  if (!screenshotBtn) return;

  screenshotBtn.addEventListener('click', () => {
    let dataUrl;
    try {
      dataUrl = takeScreenshot();
    } catch (err) {
      console.error('スクリーンショットの取得に失敗しました:', err);
      return;
    }
    // 一時的な <a> を生成し、download 属性でファイル名を指定して即クリック → サイレント保存。
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'screenshot.png';
    document.body.appendChild(link); // 一部ブラウザは DOM 接続済みでないと click() が効かない
    link.click();
    document.body.removeChild(link);
  });
}

// -----------------------------------------------------------------------------
// 背景・床の色変更（🎨 アイコン）
//   HTML5 標準のカラーピッカー（<input type="color">）の値を view3d.js へ反映する。
//   パネルの表示切り替え（開閉）もここで行う。
// -----------------------------------------------------------------------------
function setupColorPanel() {
  const colorPickerBtn = document.getElementById('color-picker-toggle');
  const colorPanel = document.getElementById('color-panel');
  const bgColorInput = document.getElementById('bg-color');
  const floorColorInput = document.getElementById('floor-color');

  // カラーピッカーの初期値を実際の初期色に合わせておく（背景 #223344 / 床 #335577）。
  if (bgColorInput) bgColorInput.value = '#223344';
  if (floorColorInput) floorColorInput.value = '#335577';

  // 'input' で即時反映（ドラッグ中もリアルタイムに色が変わる）
  bgColorInput?.addEventListener('input', (e) => applyBgColor(e.target.value));
  floorColorInput?.addEventListener('input', (e) => applyFloorColor(e.target.value));

  function closeColorPanel() {
    colorPanel?.classList.add('hidden');
    colorPickerBtn?.setAttribute('aria-expanded', 'false');
  }
  function openColorPanel() {
    colorPanel?.classList.remove('hidden');
    colorPickerBtn?.setAttribute('aria-expanded', 'true');
  }
  colorPickerBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (colorPanel && colorPanel.classList.contains('hidden')) openColorPanel();
    else closeColorPanel();
  });
  // パネル外をクリックしたら閉じる（パネル内のクリックは伝播させない）
  colorPanel?.addEventListener('click', (e) => e.stopPropagation());
  window.addEventListener('click', () => closeColorPanel());
}

// -----------------------------------------------------------------------------
// モデル選択ダイアログ（📁 アイコン）
//   models/ 以下の .pmx / .pmd を一覧表示し、選んだモデルへ切り替える。
//   一覧の取得（listModelFiles）とパスの基準（MODEL_DIR）、現在のモデルパス
//   （getCurrentModelPath）、切り替え（switchModel）は view3d.js が提供する。
// -----------------------------------------------------------------------------
function setupModelDialog() {
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
      if (getCurrentModelPath() === path) btn.classList.add('is-current');
      btn.addEventListener('click', () => {
        closeModelDialog();
        if (path !== getCurrentModelPath()) switchModel(path);
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
}

// -----------------------------------------------------------------------------
// モーション選択ダイアログ（🎵 アイコン）
//   一覧の取得（listMotions）と読み込み（loadDance）、選択中曲名（danceState.name）は
//   view3d.js が提供する。
// -----------------------------------------------------------------------------
function setupMotionDialog() {
  const motionPickerBtn = document.getElementById('motion-picker-toggle');
  const motionDialog = document.getElementById('motion-dialog');
  const motionListEl = document.getElementById('motion-list');
  const motionDialogClose = document.getElementById('motion-dialog-close');

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
}

// -----------------------------------------------------------------------------
// 本格物理（Ammo.js）ON/OFF トグル（🧲 アイコン）
//   ❗再構築（remove/add）は一切しない。物理オブジェクトはロード時に 1 回だけ生成済み（足除外）。
//     ・ON  … enable('physics', …) と physics.reset() のゲート操作のみ（syncPhysics）。
//     ・OFF … enable('physics', false) のみ。
//   例外：物理OFFのまま読み込んだダンスにはまだ物理オブジェクトが無い。その初回のみ、
//   モーションを「再読み込み」してロード時に物理を生成する（再生中の作り直しはしない＝
//   バインドポーズで生成されるのでスケールが壊れず、イヴの髪も巨大化しない）。
//   ※ 物理エンジン側のプリミティブ（physicsEnabled の取得/設定・ensureAmmo・syncPhysics 等）
//     は view3d.js が提供する。ここはボタン表示とトグル手順のみを担当する。
// -----------------------------------------------------------------------------
function setupPhysicsToggle() {
  const physicsToggleBtn = document.getElementById('physics-toggle');

  function updatePhysicsButton(busy = false) {
    if (!physicsToggleBtn) return;
    physicsToggleBtn.disabled = busy;
    physicsToggleBtn.setAttribute('aria-pressed', String(isPhysicsEnabled()));
    physicsToggleBtn.title = busy
      ? '物理エンジンを準備中…'
      : (isPhysicsEnabled() ? '本格物理：ON（タップでOFF）' : '本格物理：OFF（タップでON）');
  }

  async function togglePhysics() {
    if (!physicsToggleBtn) return;
    const turningOn = !isPhysicsEnabled();

    if (turningOn) {
      // ON 化：初回は Ammo.js のロードを待つ（ボタンは一時無効化）
      updatePhysicsButton(true);
      const prevText = getNowPlaying();
      setNowPlaying('⏳ 物理エンジン(Ammo.js)を準備中...');
      try {
        await ensureAmmo();
      } catch (error) {
        console.error('Ammo.js の読み込みに失敗しました:', error);
        resetAmmoLoad(); // 次回再試行できるようリセット
        setNowPlaying('⚠️ 物理エンジンを読み込めませんでした');
        updatePhysicsButton(false);
        return;
      }
      setPhysicsEnabled(true);

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
      setPhysicsEnabled(false);
      updatePhysicsButton(false);
      syncPhysics(); // ゲートOFF。簡易 sway が再開する
    }
  }

  physicsToggleBtn?.addEventListener('click', () => { togglePhysics(); });

  // 起動時の初期表示
  updatePhysicsButton(false);
}

// -----------------------------------------------------------------------------
// 初期化（エントリーポイントから呼ぶ）。各 UI の DOM 取得・イベント配線をまとめる。
// -----------------------------------------------------------------------------
export function initUI() {
  setupOrientationLock();
  setupResetView();
  setupScreenshot();
  setupColorPanel();
  setupModelDialog();
  setupMotionDialog();
  setupPhysicsToggle();
}

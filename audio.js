// =============================================================================
// audio.js ―― 楽曲（MP3）の読み込み・再生制御・シークバー（タイムライン）
//   ・HTML5 Audio による楽曲の読み込み（loadAudio）
//   ・再生 / 一時停止 / 停止（頭出し）の再生制御
//   ・シークバー（タイムライン）の表示更新と、つまみドラッグによるシーク
//
//   ※ このモジュールは「オーディオと再生制御の UI」だけを担当する。MMD のミキサーや
//     物理ゲートなど “ダンス本体” の状態は main.js が保持しており、initAudio() で
//     依存（danceState / 物理同期 / ミキサー適用 / モデル準備状態）を受け取って連携する。
// =============================================================================

// --- main.js から注入される依存（initAudio で設定） -------------------------
let danceState = null;            // ダンス共有状態 { active, playing, audio, mixer, mesh, name … }
let isModelReady = () => false;   // モデルが再生可能状態か（再生ボタンの有効判定に使う）
let syncPhysics = () => {};       // 物理ゲートの同期（再生/停止に合わせて呼ぶ）
let applyMixerDelta = () => {};   // ミキサーへ時間差分を適用（mmdHelper.update のラッパー）

// --- DOM 参照（再生ボタン・停止ボタン・シークバー一式） ---------------------
const dancePlayBtn = document.getElementById('dance-play-toggle');
const danceStopBtn = document.getElementById('dance-stop-toggle');
const seekBar = document.getElementById('seek-bar');
const seekTrack = document.getElementById('seek-track');
const seekFill = document.getElementById('seek-fill');
const seekThumb = document.getElementById('seek-thumb');
const seekTimeCurrent = document.getElementById('seek-time-current');
const seekTimeTotal = document.getElementById('seek-time-total');

let seekScrubbing = false; // つまみドラッグ中か（animate 側の自動同期を一時停止する）

// 秒数を MM:SS（分:秒・2桁ゼロ詰め）へ整形
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// --- 再生ボタンの状態（有効／無効・アイコン）を一括更新 ----------------------
//   モデルとモーションの両方が揃うまでは disabled（CSS で半透明・タップ不可）。
//   ついでに停止ボタンとシークバーの状態もまとめて更新する。
export function updateDancePlayButton() {
  if (dancePlayBtn) {
    const ready = isModelReady() && danceState.active;
    dancePlayBtn.disabled = !ready;
    dancePlayBtn.setAttribute('aria-pressed', String(danceState.playing));
    dancePlayBtn.textContent = danceState.playing ? '⏸️' : '▶️';
    dancePlayBtn.title = danceState.playing ? 'ダンスを一時停止' : 'ダンスを再生';
  }
  updateDanceStopButton();
  updateSeekBar();
}

// --- 停止ボタンの状態（再生中のみ押せる） -----------------------------------
function updateDanceStopButton() {
  if (!danceStopBtn) return;
  danceStopBtn.disabled = !danceState.playing; // 再生中だけ有効
}

// --- 再生位置バーの表示更新（可視性・つまみ位置・時刻） ----------------------
let _seekLastSec = -1;
let _seekLastDur = -1;
export function updateSeekBar() {
  if (!seekBar) return;
  const a = danceState.audio;
  const dur = a ? a.duration : NaN;
  const active = danceState.active && a && isFinite(dur) && dur > 0;
  seekBar.classList.toggle('hidden', !active);
  if (!active) { _seekLastSec = -1; _seekLastDur = -1; return; }

  const cur = Math.min(Math.max(a.currentTime || 0, 0), dur);
  const pct = (cur / dur) * 100;
  if (seekFill) seekFill.style.width = pct + '%';
  if (seekThumb) seekThumb.style.left = pct + '%';

  const curSec = Math.floor(cur);
  if (curSec !== _seekLastSec) { // 秒が変わったときだけ文字を書き換える（無駄な更新を避ける）
    _seekLastSec = curSec;
    if (seekTimeCurrent) seekTimeCurrent.textContent = formatTime(cur);
  }
  const durSec = Math.floor(dur);
  if (durSec !== _seekLastDur) {
    _seekLastDur = durSec;
    if (seekTimeTotal) seekTimeTotal.textContent = formatTime(dur);
  }
}

// --- HTML5 Audio を「再生可能」になるまで待って返す -------------------------
export function loadAudio(url) {
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

// 音源が最後まで再生され終わったら、再生ボタンを「▶️（停止中）」へ戻し、物理もスリープする。
export function onAudioEnded() {
  danceState.playing = false;
  updateDancePlayButton();
  syncPhysics();                       // 停止中は物理ゲートOFF
  // ★終了時はバインドポーズへ戻さず、最終フレームのポーズをそのまま保持する。
  //   animate は playing=false の間ダンスを再適用しないので、最後に適用された姿勢が残る。
  //   音源位置も終端のまま（シークバーは右端を指す＝最終ポーズと一致）。次に再生を押すと
  //   play 分岐が終端を検知して頭(0秒)へ戻してから踊り直す。
  updateSeekBar();
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
    // 再生開始／再開。曲が最後まで終わっている（終端 or ended）場合は頭(0秒)へ戻して踊り直す。
    const a = danceState.audio;
    if (a.ended || (isFinite(a.duration) && a.duration > 0 && a.currentTime >= a.duration - 0.05)) {
      try { a.currentTime = 0; } catch (_) {}
    }
    // まず現在の音源位置の踊り姿勢へ復帰させてから（終了後の最終ポーズや一時停止位置から
    // 確実に踊りへ戻す）、物理ONなら剛体リセット→ゲートONをクリーンに行う。
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

// --- 停止（先頭へ戻す） ------------------------------------------------------
//   再生を完全に止め、音源位置を 0 秒へ戻し、先頭フレームの姿勢を表示する。
//   停止ボタンは再生中のみ押せる（updateDanceStopButton）。
function stopDance() {
  if (!danceState.active || !danceState.audio) return;
  try { danceState.audio.pause(); } catch (_) {}
  try { danceState.audio.currentTime = 0; } catch (_) {}
  danceState.playing = false;
  updateDancePlayButton();      // 再生→▶️、停止ボタン無効化、シークバー更新
  syncPhysics();                // 物理ゲートOFF
  // 先頭(0秒)の姿勢を表示（animate は停止中ダンスを再適用しないため明示的に当てる）
  if (danceState.mixer) {
    const delta = 0 - danceState.mixer.time; // 差分で確実に pose@0 を適用
    applyMixerDelta(delta);
  }
  updateSeekBar();
}

// --- 再生位置バーのドラッグ（シーク） ---------------------------------------
//   つまみ／トラックをドラッグすると任意位置へ早送り・巻き戻し。
//   ドラッグ中は音を一旦止め、離したら（再生中だった場合）その位置から再生再開する。
let _seekWasPlaying = false;

function seekRatioFromEvent(event) {
  if (!seekTrack) return 0;
  const rect = seekTrack.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

// 指定比率(0..1)の位置へシークし、姿勢とバー表示を更新する。
function applySeek(ratio) {
  const a = danceState.audio;
  if (!a || !isFinite(a.duration) || a.duration <= 0) return;
  const t = ratio * a.duration;
  try { a.currentTime = t; } catch (_) {}
  // ドラッグ中はその位置の踊り姿勢を即時表示（再生中・停止中どちらでも）。
  if (danceState.mixer) {
    const delta = t - danceState.mixer.time; // 差分で同期（animate と同じ方式）
    applyMixerDelta(delta);
  }
  updateSeekBar();
}

function onSeekDown(event) {
  if (!danceState.active || !danceState.audio) return;
  seekScrubbing = true;
  _seekWasPlaying = danceState.playing;
  // ドラッグ中は音を止める（スクラブ音を鳴らさない）。playing フラグは維持。
  if (_seekWasPlaying) { try { danceState.audio.pause(); } catch (_) {} }
  seekTrack.setPointerCapture?.(event.pointerId);
  applySeek(seekRatioFromEvent(event));
}

function onSeekMove(event) {
  if (!seekScrubbing) return;
  applySeek(seekRatioFromEvent(event));
}

function onSeekUp(event) {
  if (!seekScrubbing) return;
  seekScrubbing = false;
  seekTrack.releasePointerCapture?.(event.pointerId);
  if (_seekWasPlaying && danceState.audio) {
    // 再生中だった場合は、その位置から再生再開（物理もクリーンに同期し直す）
    syncPhysics(true);
    const p = danceState.audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
}

// シーク中フラグの参照（animate 側の自動同期スキップ判定に使う）
export function isSeekScrubbing() { return seekScrubbing; }

// --- 初期化：依存の受け取り＋再生/停止/シークの DOM 配線 --------------------
export function initAudio(deps) {
  danceState = deps.danceState;
  isModelReady = deps.isModelReady;
  syncPhysics = deps.syncPhysics;
  applyMixerDelta = deps.applyMixerDelta;

  dancePlayBtn?.addEventListener('click', toggleDancePlayback);
  danceStopBtn?.addEventListener('click', stopDance);

  if (seekTrack) {
    seekTrack.addEventListener('pointerdown', onSeekDown);
    seekTrack.addEventListener('pointermove', onSeekMove);
    seekTrack.addEventListener('pointerup', onSeekUp);
    seekTrack.addEventListener('pointercancel', onSeekUp);
  }

  // 起動時の初期表示（モデル・モーション未準備なので再生ボタンは無効・シークバーは非表示）
  updateDancePlayButton();
}

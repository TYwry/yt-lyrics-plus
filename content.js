// ============================================================================
// 自動捲動與翻譯（中文版新增）
// ============================================================================
const YLP_DEFAULTS = { autoScroll: true, pauseSeconds: 4, translate: true, targetLang: 'zh-TW' };
let ylpSettings = { ...YLP_DEFAULTS };
let ylpResumeTimer = null;
let ylpLastScrolledIndex = -1;
let ylpTranslateBusy = false;
let ylpTranslateAgain = false;
const ylpCache = new Map();   // `${語言}|${原文}` -> 譯文（'' 代表不用顯示）
const ylpFailed = new Set();  // 翻譯失敗的句子，不再重試

function ylpEscape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

chrome.storage.sync.get(YLP_DEFAULTS, (s) => {
  ylpSettings = { ...YLP_DEFAULTS, ...s };
  ylpUpdateTranslateButton();
  ylpApplyTranslations();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let changed = false;
  for (const k of Object.keys(YLP_DEFAULTS)) {
    if (k in changes) { ylpSettings[k] = changes[k].newValue ?? YLP_DEFAULTS[k]; changed = true; }
  }
  if (!changed) return;
  if ('targetLang' in changes) ylpFailed.clear();
  if ('autoScroll' in changes && ylpSettings.autoScroll) {
    try { userIsScrolling = false; } catch (e) {}
    ylpLastScrolledIndex = -1;
  }
  ylpUpdateTranslateButton();
  ylpApplyTranslations();
});

function ylpPauseAutoScroll() {
  userIsScrolling = true;
  clearTimeout(ylpResumeTimer);
  ylpResumeTimer = setTimeout(() => {
    userIsScrolling = false;
    ylpLastScrolledIndex = -1; // 恢復後立刻捲回目前這一句
  }, Math.max(0, Number(ylpSettings.pauseSeconds) || 0) * 1000);
}

function ylpScrollToLine(line, smooth = true) {
  const container = document.getElementById('lyrics-content');
  if (!container || container.clientHeight === 0) return;
  const cr = container.getBoundingClientRect();
  const lr = line.getBoundingClientRect();
  const delta = (lr.top + lr.height / 2) - (cr.top + cr.height / 2);
  if (Math.abs(delta) < 3) return;
  container.scrollTo({ top: container.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
}

function ylpUpdateTranslateButton() {
  const btn = document.getElementById('translate-btn');
  if (btn) btn.classList.toggle('off', !ylpSettings.translate);
}

function ylpLineElements() {
  const content = document.getElementById('lyrics-content');
  return content ? [...content.querySelectorAll('.synced-line, .plain-line')] : [];
}

function ylpOriginal(el) {
  const orig = el.querySelector(':scope > .ylp-orig');
  return (orig ? orig.textContent : '').replace(/\s+/g, ' ').trim();
}

function ylpShow(el, text) {
  let tr = el.querySelector(':scope > .ylp-translation');
  if (!text) { if (tr) tr.remove(); return; }
  if (!tr) {
    tr = document.createElement('div');
    tr.className = 'ylp-translation';
    el.appendChild(tr);
  }
  if (tr.textContent !== text) tr.textContent = text;
}

function ylpScriptOf(text) {
  if (/\p{Script=Hangul}/u.test(text)) return 'hangul';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'kana';
  if (/\p{Script=Han}/u.test(text)) return 'han';
  if (/\p{Script=Latin}/u.test(text)) return 'latin';
  return 'other';
}

// ============================================================================
// 卡拉OK模式：全螢幕只顯示 MV 和大字幕（中文版新增）
// ============================================================================
var ylpKaraokeActive = false;
var ylpLastVideoTitle = '';
var ylpLyricsState = 'searching';   // searching | found | plain | notfound
var ylpKaraokeShownIndex = null;
var ylpKaraokeShownKey = '';
var ylpIdleTimer = null;

var YLP_KARAOKE_CSS = `
  html.ylp-karaoke .ytp-chrome-top,
  html.ylp-karaoke .ytp-chrome-bottom,
  html.ylp-karaoke .ytp-gradient-top,
  html.ylp-karaoke .ytp-gradient-bottom,
  html.ylp-karaoke .ytp-ce-element,
  html.ylp-karaoke .ytp-cards-teaser,
  html.ylp-karaoke .ytp-cards-button,
  html.ylp-karaoke .iv-branding,
  html.ylp-karaoke .annotation,
  html.ylp-karaoke .ytp-paid-content-overlay,
  html.ylp-karaoke .ytp-pause-overlay,
  html.ylp-karaoke .ytp-caption-window-container,
  html.ylp-karaoke .ytp-fullscreen-grid,
  html.ylp-karaoke .ytp-fullscreen-quick-actions,
  html.ylp-karaoke .ytp-fullerscreen-edu-button,
  html.ylp-karaoke .ytp-suggested-action,
  html.ylp-karaoke .ytp-autonav-endscreen-countdown-overlay,
  html.ylp-karaoke .ytp-endscreen-content,
  html.ylp-karaoke .html5-endscreen,
  html.ylp-karaoke .ytp-bezel,
  html.ylp-karaoke .ytp-bezel-text-wrapper,
  html.ylp-karaoke .ytp-tooltip,
  html.ylp-karaoke .ytp-player-content,
  html.ylp-karaoke .ytp-chapter-hover-container,
  html.ylp-karaoke ytd-watch-flexy #columns {
    display: none !important;
  }
  html.ylp-karaoke { overflow: hidden !important; }
  html.ylp-karaoke.ylp-idle, html.ylp-karaoke.ylp-idle * { cursor: none !important; }

  #ylp-karaoke-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
    font-family: 'Microsoft JhengHei', 'Noto Sans TC', 'Malgun Gothic', 'Yu Gothic', system-ui, sans-serif;
  }
  #ylp-karaoke-overlay .ylp-k-subs {
    position: absolute;
    left: 50%;
    bottom: 7vh;
    transform: translateX(-50%);
    width: 92vw;
    text-align: center;
  }
  #ylp-karaoke-overlay .ylp-k-line {
    display: inline-block;
    font-size: clamp(28px, 4.2vw, 76px);
    font-weight: 800;
    line-height: 1.25;
    color: #fff;
    filter: drop-shadow(0 0 2px #000) drop-shadow(0 3px 6px rgba(0, 0, 0, 0.85));
  }
  #ylp-karaoke-overlay .ylp-k-line.wipe {
    color: transparent;
    background-image: linear-gradient(90deg, #5ec8ff 0 50%, #ffffff 50% 100%);
    background-size: 200% 100%;
    background-position: 100% 0;
    -webkit-background-clip: text;
    background-clip: text;
    animation-name: ylp-k-wipe;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
  @keyframes ylp-k-wipe { to { background-position: 0 0; } }
  #ylp-karaoke-overlay .ylp-k-tr {
    margin-top: 0.4em;
    font-size: clamp(18px, 2.4vw, 42px);
    font-weight: 600;
    color: #ffe58a;
    filter: drop-shadow(0 0 2px #000) drop-shadow(0 2px 4px rgba(0, 0, 0, 0.85));
  }
  #ylp-karaoke-overlay .ylp-k-next {
    margin-top: 0.9em;
    font-size: clamp(16px, 2vw, 34px);
    font-weight: 600;
    color: rgba(255, 255, 255, 0.6);
    filter: drop-shadow(0 0 2px #000) drop-shadow(0 2px 4px rgba(0, 0, 0, 0.85));
  }
  #ylp-karaoke-overlay .ylp-k-current { animation: ylp-k-in 0.25s ease-out; }
  @keyframes ylp-k-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  #ylp-karaoke-overlay .ylp-k-status {
    font-size: clamp(16px, 1.8vw, 28px);
    color: rgba(255, 255, 255, 0.8);
    filter: drop-shadow(0 0 2px #000);
  }
  #ylp-karaoke-overlay .ylp-k-exit {
    position: absolute;
    top: 24px;
    right: 24px;
    pointer-events: auto;
    padding: 10px 16px;
    border: 0;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font: inherit;
    font-size: 15px;
    cursor: pointer;
    transition: opacity 0.3s;
  }
  html.ylp-idle #ylp-karaoke-overlay .ylp-k-exit { opacity: 0; pointer-events: none; }
`;

// 這些變數在檔案後段才宣告；程式剛載入時讀取會出錯，所以包一層保護
function ylpSyncedLines() {
  try { return Array.isArray(currentSyncedLines) ? currentSyncedLines : []; } catch (e) { return []; }
}
function ylpActiveIndex() {
  try { return typeof currentActiveLineIndex === 'number' ? currentActiveLineIndex : -1; } catch (e) { return -1; }
}

function ylpEnsureKaraokeStyle() {
  if (document.getElementById('ylp-karaoke-style')) return;
  const style = document.createElement('style');
  style.id = 'ylp-karaoke-style';
  style.textContent = YLP_KARAOKE_CSS;
  document.head.appendChild(style);
}

function ylpKaraokeOverlay() {
  let overlay = document.getElementById('ylp-karaoke-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'ylp-karaoke-overlay';
    const exit = document.createElement('button');
    exit.className = 'ylp-k-exit';
    exit.textContent = '✕ 結束卡拉OK（Esc）';
    exit.addEventListener('click', () => ylpKaraokeExit());
    const subs = document.createElement('div');
    subs.className = 'ylp-k-subs';
    overlay.append(exit, subs);
  }
  // 全螢幕時只有全螢幕元素裡面的東西看得到，所以要把字幕放進去
  const parent = document.fullscreenElement || document.body;
  if (overlay.parentElement !== parent) parent.appendChild(overlay);
  return overlay;
}

function ylpOnActivity() {
  document.documentElement.classList.remove('ylp-idle');
  clearTimeout(ylpIdleTimer);
  ylpIdleTimer = setTimeout(() => {
    if (ylpKaraokeActive) document.documentElement.classList.add('ylp-idle');
  }, 2500);
}

async function ylpKaraokeEnter() {
  ylpKaraokeActive = true;
  ylpEnsureKaraokeStyle();
  document.documentElement.classList.add('ylp-karaoke');
  if (!document.fullscreenElement) {
    const fsBtn = document.querySelector('.ytp-fullscreen-button');
    if (fsBtn) {
      fsBtn.click(); // 用 YouTube 自己的全螢幕，影片大小會由 YouTube 處理
    } else {
      try { await document.getElementById('movie_player')?.requestFullscreen(); } catch (e) {}
    }
  }
  document.addEventListener('mousemove', ylpOnActivity, true);
  ylpOnActivity();
  ylpKaraokeRender(true);
  setTimeout(() => ylpKaraokeRender(true), 400);
}

function ylpKaraokeExit() {
  if (!ylpKaraokeActive) return;
  ylpKaraokeActive = false;
  document.documentElement.classList.remove('ylp-karaoke', 'ylp-idle');
  document.removeEventListener('mousemove', ylpOnActivity, true);
  clearTimeout(ylpIdleTimer);
  document.getElementById('ylp-karaoke-overlay')?.remove();
  ylpKaraokeShownIndex = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function ylpKaraokeToggle() {
  if (ylpKaraokeActive) ylpKaraokeExit();
  else ylpKaraokeEnter();
}

document.addEventListener('fullscreenchange', () => {
  if (!ylpKaraokeActive) return;
  if (!document.fullscreenElement) {
    ylpKaraokeExit(); // 按 Esc 離開全螢幕時一併結束卡拉OK模式
  } else {
    ylpKaraokeRender(true);
  }
});

// 每 0.1 秒由歌詞同步呼叫；只有句子或翻譯改變時才重畫
function ylpKaraokeRender(force = false) {
  if (!ylpKaraokeActive) return;
  const overlay = ylpKaraokeOverlay();
  const subs = overlay.querySelector('.ylp-k-subs');
  const lines = ylpSyncedLines();
  const video = document.querySelector('video');

  const idx = ylpActiveIndex();
  const lang = ylpSettings.targetLang;
  const cur = lines[idx];
  const trKey = cur && ylpSettings.translate ? (ylpCache.get(lang + '|' + cur.text.replace(/\s+/g, ' ').trim()) || '') : '';
  const stateKey = [ylpLyricsState, lines.length, idx, trKey].join('|');

  // 播放／暫停時同步字幕填色動畫
  const wipe = subs.querySelector('.ylp-k-line.wipe');
  if (wipe && video) wipe.style.animationPlayState = video.paused ? 'paused' : 'running';

  if (!force && stateKey === ylpKaraokeShownKey) return;
  const indexChanged = idx !== ylpKaraokeShownIndex;
  ylpKaraokeShownKey = stateKey;
  ylpKaraokeShownIndex = idx;
  subs.textContent = '';

  if (!lines.length) {
    const msg = document.createElement('div');
    msg.className = 'ylp-k-status';
    msg.textContent = ylpLyricsState === 'plain' ? '這首歌沒有同步歌詞，無法顯示卡拉OK字幕'
      : ylpLyricsState === 'notfound' ? '找不到這首歌的歌詞'
      : '正在尋找歌詞…';
    subs.appendChild(msg);
    return;
  }

  const box = document.createElement('div');
  box.className = indexChanged ? 'ylp-k-current' : '';

  if (cur) {
    const line = document.createElement('div');
    line.className = 'ylp-k-line';
    line.textContent = cur.text;
    const next = lines[idx + 1];
    if (next && video) {
      // 從左到右填色，時間 = 這一句到下一句的間隔
      const dur = Math.max(0.3, Math.min(next.time - cur.time, 15));
      const elapsed = Math.max(0, video.currentTime - cur.time);
      line.classList.add('wipe');
      line.style.animationDuration = dur + 's';
      line.style.animationDelay = (-elapsed) + 's';
      line.style.animationPlayState = video.paused ? 'paused' : 'running';
    }
    box.appendChild(line);
    if (trKey) {
      const tr = document.createElement('div');
      tr.className = 'ylp-k-tr';
      tr.textContent = trKey;
      box.appendChild(tr);
    }
  }

  const nextLine = lines[idx + 1];
  if (nextLine) {
    const nx = document.createElement('div');
    nx.className = 'ylp-k-next';
    nx.textContent = nextLine.text;
    box.appendChild(nx);
  }
  subs.appendChild(box);
}

// 把目前面板上的歌詞加上翻譯（已翻過的直接顯示，沒翻過的送出翻譯）
async function ylpApplyTranslations() {
  const els = ylpLineElements();
  if (!ylpSettings.translate) {
    els.forEach((el) => ylpShow(el, ''));
    return;
  }
  const lang = ylpSettings.targetLang;
  const todo = new Set();
  for (const el of els) {
    const text = ylpOriginal(el);
    if (!text || !/\p{L}/u.test(text)) continue;
    const key = lang + '|' + text;
    if (ylpCache.has(key)) ylpShow(el, ylpCache.get(key));
    else if (!ylpFailed.has(key)) todo.add(text);
  }
  // 卡拉OK模式或縮小模式時面板上沒有完整歌詞，也把同步歌詞列入翻譯
  {
    for (const l of ylpSyncedLines()) {
      const text = String(l.text || '').replace(/\s+/g, ' ').trim();
      if (!text || !/\p{L}/u.test(text)) continue;
      const key = lang + '|' + text;
      if (!ylpCache.has(key) && !ylpFailed.has(key)) todo.add(text);
    }
  }
  if (todo.size === 0) { ylpKaraokeRender(true); return; }
  if (ylpTranslateBusy) { ylpTranslateAgain = true; return; }

  ylpTranslateBusy = true;
  try {
    // 依文字種類分組送出（韓文、日文、中文、英文分開），自動偵測語言比較準
    const groups = {};
    for (const t of todo) (groups[ylpScriptOf(t)] ||= []).push(t);
    for (const texts of Object.values(groups)) {
      let res;
      try {
        res = await chrome.runtime.sendMessage({ action: 'ylpTranslate', texts, target: lang });
      } catch (e) {
        res = { ok: false, error: String(e) };
      }
      if (!res || !res.ok) {
        console.warn('[翻譯] 失敗：', res && res.error);
        texts.forEach((t) => ylpFailed.add(lang + '|' + t));
        continue;
      }
      texts.forEach((t, i) => {
        const tr = String(res.result[i] || '').trim();
        ylpCache.set(lang + '|' + t, tr.toLowerCase() === t.toLowerCase() ? '' : tr);
      });
    }
  } finally {
    ylpTranslateBusy = false;
  }

  // 套用結果；翻譯插入後行高改變，重新對準目前這一句
  for (const el of ylpLineElements()) {
    const key = ylpSettings.targetLang + '|' + ylpOriginal(el);
    if (ylpSettings.translate && ylpCache.has(key)) ylpShow(el, ylpCache.get(key));
  }
  ylpLastScrolledIndex = -1;
  ylpKaraokeRender(true);
  if (ylpTranslateAgain) { ylpTranslateAgain = false; ylpApplyTranslations(); }
}


console.log('🎵 YouTube Lyrics Extension – Real-Time Synced Lyrics | YT Lyrics');

// SEGMENTED PROGRESS BAR CONFIGURATION
// Boxes map to real operations: cleaning (2) + cache (1) + searches (5)
const PROGRESS_TOTAL_BOXES = 8;

let currentFilledBoxes = 0;
let loadingLabel = '';
let loadingPhaseDescriptions = [];

// Helper to truncate long text for labels
function truncateForLabel(text, maxLength = 35) {
  if (!text || text === 'undefined') return '';
  text = String(text).trim();
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// Smart Music Video Detection Helper
function isLikelyMusicVideo(title, channelName) {
  const titleLower = title.toLowerCase();
  const channelLower = channelName.toLowerCase();
  
  // DENY LIST - If any of these are found, NOT a music video
  const denyKeywords = ['reaction', 'reacts', 'review', 'reviewed', 'reviewing', 'explained', 'explanation', 'analysis', 'breakdown', 'analyzed', 'how to', 'tutorial', 'guide', 'lesson', 'interview', 'interviewing', 'talks about', 'vlog', 'vlogger', 'daily vlog', 'podcast', 'episode', 'shorts', 'short', 'clip', 'clips', 'highlights', 'highlight', 'best moments'];
  
  // Check deny list first
  for (const keyword of denyKeywords) {
    if (titleLower.includes(keyword)) {
      console.log('❌ Denied by keyword:', keyword);
      return false;
    }
  }
  
  // ALLOW LIST - Music video indicators
  const musicKeywords = ['official video', 'official music video', 'official mv', 'official visualizer', 'official performance video', 'official audio video', 'official audio', 'lyrics', 'lyric video', 'official lyrics', 'with lyrics', 'karaoke', 'sing along', 'singalong', '字幕', '歌詞', '가사', 'lirik', 'vevo', 'umg', 'universal music', 'sony music', 'warner music', 'atlantic records', 'interscope', 'republic records', 'capitol records', 'columbia records', 'def jam', 'auto-generated by youtube', 'provided to youtube by', 'audio', 'visualizer', 'topic', '- topic', 'records', 'music', 'official', 'live', 'live performance', 'live session', 'acoustic', 'unplugged', 'concert', 'on stage', 'radio session', 'tiny desk'];
  
  // Check title for music keywords
  for (const keyword of musicKeywords) {
    if (titleLower.includes(keyword)) {
      console.log('✅ Matched keyword in title:', keyword);
      return true;
    }
  }
  
  // Check channel name for music indicators
  const channelKeywords = ['vevo', 'topic', '- topic', 'official', 'records', 'music', 'umg', 'sony music', 'warner music', 'universal music'];
  
  for (const keyword of channelKeywords) {
    if (channelLower.includes(keyword)) {
      console.log('✅ Matched keyword in channel:', keyword);
      return true;
    }
  }
  
  console.log('⏸️ No music video keywords found');
  return false;
}

// Settings state
let autoShowLyrics = false;
let smartAutoShow = true;

// Tooltip Badge Helper
let tooltipShown = false;



// FREQUENCY FATIGUE - suppress tooltip after 3 consecutive ignores
function getTooltipIgnoreCount() {
  const count = localStorage.getItem('yt_lyrics_tooltip_ignore_count');
  return count ? parseInt(count, 10) : 0;
}

function incrementTooltipIgnoreCount() {
  const count = getTooltipIgnoreCount() + 1;
  localStorage.setItem('yt_lyrics_tooltip_ignore_count', count.toString());
  return count;
}

function resetTooltipIgnoreCount() {
  localStorage.setItem('yt_lyrics_tooltip_ignore_count', '0');
}

function getTooltipSuppressionCount() {
  const count = localStorage.getItem('yt_lyrics_tooltip_suppression_remaining');
  return count ? parseInt(count, 10) : 0;
}

function decrementSuppressionCount() {
  const count = getTooltipSuppressionCount();
  if (count > 0) {
    localStorage.setItem('yt_lyrics_tooltip_suppression_remaining', (count - 1).toString());
  }
}

function startSuppressionCycle() {
  localStorage.setItem('yt_lyrics_tooltip_suppression_remaining', '2');
}

function shouldSuppressTooltip() {
  const suppressionCount = getTooltipSuppressionCount();
  if (suppressionCount > 0) {
    console.log('🔇 Tooltip suppressed, remaining:', suppressionCount);
    // Don't decrement here - let the video change handler do it
    return true;
  }
  
  return false;
}

// ADD NEW FUNCTION to call on video change
function decrementSuppressionOnVideoChange() {
  const suppressionCount = getTooltipSuppressionCount();
  if (suppressionCount > 0) {
    decrementSuppressionCount();
    console.log('🔽 Suppression count decremented, remaining:', getTooltipSuppressionCount());
  }
}

let isWatchPageReady = false;

function checkWatchPageReady() {
  const watchFlexy = document.querySelector('ytd-watch-flexy');
  if (!watchFlexy) return false;
  
  const videoIdAttr = watchFlexy.getAttribute('video-id');
  if (!videoIdAttr) return false;
  
  const urlVideoId = new URLSearchParams(window.location.search).get('v');
  if (videoIdAttr !== urlVideoId) return false;
  
  const titleElement = document.querySelector('ytd-watch-flexy h1.ytd-watch-metadata yt-formatted-string');
  const channelElement = document.querySelector('ytd-watch-flexy ytd-channel-name a');
  
  if (!titleElement || !channelElement) return false;
  if (!titleElement.textContent.trim() || !channelElement.textContent.trim()) return false;
  
  return true;
}

function showLyricsTooltip() {
  // CHECK SUPPRESSION
  if (shouldSuppressTooltip()) {
    console.log('🔇 Tooltip suppressed due to frequency fatigue');
    return;
  }
  
  if (tooltipShown) return;
  
  // DECLARE DURATION FIRST (before using it)
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  const tooltipDuration = isFullscreen ? 3000 : 8000;
  console.log('⏱️ Tooltip duration:', tooltipDuration, 'ms');
  
  // Remove any existing tooltip first
  const existingTooltip = document.getElementById('yt-lyrics-tooltip-badge');
  if (existingTooltip) {
    existingTooltip.remove();
  }
  
  const tooltip = document.createElement('div');
  tooltip.id = 'yt-lyrics-tooltip-badge';
  tooltip.innerHTML = '🎵 點這裡顯示歌詞';
  
  // COUNTDOWN SHRINK INDICATOR
  const countdownBar = document.createElement('div');
  countdownBar.style.cssText = `
    position: absolute;
    bottom: 0;
    left: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.7);
    border-radius: 0 0 12px 12px;
    animation: shrinkCountdown ${tooltipDuration}ms linear forwards;
  `;
  tooltip.appendChild(countdownBar);
  tooltip.style.cssText = `
    position: fixed;
    top: 100px;
    right: 24px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 14px 24px;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    z-index: 9999999;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4), 0 4px 8px rgba(0, 0, 0, 0.3);
    transition: all 0.3s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    border: 2px solid rgba(255, 255, 255, 0.3);
    backdrop-filter: blur(10px);
    animation: slideInBounce 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
    @keyframes shrinkCountdown {
        from { width: 100%; }
        to { width: 0%; }
      }
  `;
  
  // Add hover effect
  tooltip.addEventListener('mouseenter', () => {
    tooltip.style.transform = 'scale(1.05) translateY(-2px)';
    tooltip.style.boxShadow = '0 12px 32px rgba(102, 126, 234, 0.5), 0 6px 12px rgba(0, 0, 0, 0.4)';
  });
  
  tooltip.addEventListener('mouseleave', () => {
    tooltip.style.transform = 'scale(1) translateY(0)';
    tooltip.style.boxShadow = '0 8px 24px rgba(102, 126, 234, 0.4), 0 4px 8px rgba(0, 0, 0, 0.3)';
  });
  
  tooltip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('🎵 Tooltip clicked - triggering lyrics detection');
    
    // RESET IGNORE COUNT ON CLICK
    resetTooltipIgnoreCount();
    
    // Remove tooltip immediately
    tooltip.remove();
    tooltipShown = true;
    
    // Trigger lyrics detection
    detectAndShowLyrics();
  });
  // Add animation keyframes
  if (!document.getElementById('yt-lyrics-tooltip-animations')) {
    const style = document.createElement('style');
    style.id = 'yt-lyrics-tooltip-animations';
    style.textContent = `
      @keyframes slideInBounce {
        0% {
          transform: translateX(400px);
          opacity: 0;
        }
        60% {
          transform: translateX(-20px);
          opacity: 1;
        }
        80% {
          transform: translateX(10px);
        }
        100% {
          transform: translateX(0);
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(tooltip);
  tooltipShown = true;
  
  setTimeout(() => {
    // INCREMENT IGNORE COUNT IF NOT CLICKED
    const ignoreCount = incrementTooltipIgnoreCount();
    console.log('⏱️ Tooltip ignored, count:', ignoreCount);
    
    if (ignoreCount >= 3) {
      console.log('🔇 Starting suppression cycle (2 videos)');
      startSuppressionCycle();
      resetTooltipIgnoreCount();
    }
    
    tooltip.style.opacity = '0';
    tooltip.style.transform = 'translateX(400px)';
    setTimeout(() => {
      if (tooltip.parentNode) {
        tooltip.remove();
      }
      // RESET FLAG after tooltip is removed
      tooltipShown = false;
      console.log('🔄 Tooltip flag reset');
    }, 300);
  }, tooltipDuration);
}

function shouldAutoShowLyrics(title, channelName) {
  // Never auto-show if disabled
  if (!autoShowLyrics) {
    return false;
  }
  
  // If smart mode is off, always auto-show (legacy behavior)
  if (!smartAutoShow) {
    return true;
  }
  
  // Smart mode: only auto-show for music videos
  return isLikelyMusicVideo(title, channelName);
}

let lyricsPanel = null;
let currentVideoId = null;
let darkModeEnabled = true;
let isMinimized = false;

// STRICT SCROLL STATE - NO TIMERS, NO AUTO-RESUME
let autoScrollEnabled = true;  // Default enabled
let userIsScrolling = false;   // True when user manually scrolls

// CACHE: Track if current request is a refresh (bypasses cache)
let isRefreshRequest = false;

// Load settings (consolidated)
chrome.storage.sync.get(['autoShowLyrics', 'smartAutoShow', 'darkMode'], (result) => {
  autoShowLyrics = result.autoShowLyrics === true;      // Will be false if undefined
  smartAutoShow = result.smartAutoShow !== false;        // Will be true if undefined
  darkModeEnabled = result.darkMode !== false;
  console.log('✅ Settings loaded - autoShow:', autoShowLyrics, 'smartAuto:', smartAutoShow, 'Dark:', darkModeEnabled);
});

// ============================================================================
// SEGMENTED PROGRESS BAR HELPERS
// ============================================================================

/**
 * Reset progress to 0 boxes
 */
function resetProgress() {
  currentFilledBoxes = 0;
  loadingLabel = '';
  loadingPhaseDescriptions = [];
  console.log('🔄 Progress reset to 0 boxes');
}

/**
 * Fill one box after a phase completes (success or failure)
 */
function fillNextBox(phaseLabel = '') {
  if (currentFilledBoxes < PROGRESS_TOTAL_BOXES) {
    currentFilledBoxes++;
    loadingLabel = phaseLabel;
    loadingPhaseDescriptions.push(phaseLabel);
    console.log(`📦 Box ${currentFilledBoxes}/${PROGRESS_TOTAL_BOXES} filled - ${phaseLabel}`);
    updateProgressBarUI();
  }
}

/**
 * Fill all remaining boxes (used on final success)
 */
function fillAllBoxes(label = '') {
  if (currentFilledBoxes < PROGRESS_TOTAL_BOXES) {
    currentFilledBoxes = PROGRESS_TOTAL_BOXES;
    loadingLabel = label;
    console.log(`✅ All boxes filled - ${label}`);
    updateProgressBarUI();
  }
}

/**
 * Render segmented progress bar HTML with dynamically created manual search
 * Using timestamp to ensure fresh input instance (prevents Chrome autofill tracking)
 */
function renderProgressBar() {
  let boxesHTML = '';
  
  for (let i = 0; i < PROGRESS_TOTAL_BOXES; i++) {
    const isFilled = i < currentFilledBoxes;
    const boxClass = isFilled ? 'progress-box-filled' : 'progress-box-empty';
    boxesHTML += `<div class="progress-box ${boxClass}"></div>`;
  }
  
  const percentage = Math.round((currentFilledBoxes / PROGRESS_TOTAL_BOXES) * 100);
  
  // Generate unique ID to prevent Chrome from tracking input across renders
  const uniqueInputId = `manual-search-loading-input-${Date.now()}`;
  const uniqueButtonId = `manual-search-loading-btn-${Date.now()}`;
  
  return `
    <div class="lyrics-loading">
      <div class="segmented-progress-container">
        ${boxesHTML}
      </div>
      <div class="progress-info">
        <span class="progress-label">${loadingLabel}</span>
        <span class="progress-percentage">${percentage}%</span>
      </div>
      <div class="manual-search-box" style="margin-top: 16px;">
        <div class="manual-search-title" style="margin-bottom: 8px; font-size: 12px;">
          <span>⏱️</span>
          <span>或手動搜尋</span>
        </div>
        <input 
          type="text" 
          class="manual-search-input" 
          placeholder="歌手 - 歌名"
          id="${uniqueInputId}"
          name="no-autofill-${Date.now()}"
          autocomplete="new-password"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          inputmode="search"
          data-form-type="other"
          data-lpignore="true"
          style="margin-bottom: 8px;"
        />
        <button class="manual-search-button" id="${uniqueButtonId}" style="padding: 8px 16px; font-size: 13px;">立即搜尋</button>
      </div>
    </div>
  `;
}

/**
 * Update progress bar in DOM (if it exists)
 */
function updateProgressBarUI() {
  const content = document.getElementById('lyrics-content');
  if (!content) return;
  
  // Only update if loading UI is visible
  const loadingDiv = content.querySelector('.lyrics-loading');
  if (loadingDiv) {
    content.innerHTML = renderProgressBar();
    
    // Find dynamically generated input and button by class
    const input = content.querySelector('.manual-search-box .manual-search-input');
    const button = content.querySelector('.manual-search-box .manual-search-button');
    
    if (input && button) {
      setupManualSearchDynamic(input, button, true);
    }
  }
}

// ============================================================================
// LYRICS CACHE SYSTEM
// ============================================================================

const CACHE_MAX_ENTRIES = 200;
const CACHE_MIN_CONFIDENCE = 0.7;

/**
 * Check if video is cacheable (not live stream, has valid duration)
 */
function isVideoCacheable() {
  const video = document.querySelector('video');
  if (!video) return false;
  
  // Check if live stream (duration is Infinity or NaN)
  if (!isFinite(video.duration) || isNaN(video.duration) || video.duration === 0) {
    console.log('⏸️ Video not cacheable: live stream or invalid duration');
    return false;
  }
  
  return true;
}

/**
 * Calculate confidence score for caching decision
 */
function calculateConfidence(parsedData, result, hasMusicSection) {
  let confidence = 0.5; // Base score
  
  // Boost for synced lyrics
  if (result.synced) {
    confidence += 0.2;
  }
  
  // Boost for YouTube Music section
  if (hasMusicSection) {
    confidence += 0.15;
  }
  
  // Boost for official/topic/verified channels
  const channelLower = parsedData.artistFromChannel.toLowerCase();
  if (channelLower.includes('vevo') || 
      channelLower.includes('topic') || 
      channelLower.includes('official')) {
    confidence += 0.15;
  }
  
  // Boost if not a cover
  if (!parsedData.isCover) {
    confidence += 0.1;
  }
  
  return Math.min(confidence, 1.0);
}

/**
 * Get cache key for video ID
 */
function getCacheKey(videoId) {
  return `lyrics_${videoId}`;
}

/**
 * Lookup cached lyrics for video ID
 */
async function getCachedLyrics(videoId) {
  try {
    const cacheKey = getCacheKey(videoId);
    const result = await chrome.storage.local.get(cacheKey);
    
    if (result[cacheKey]) {
      console.log('💾 Cache HIT for video:', videoId);
      return result[cacheKey];
    }
    
    console.log('💨 Cache MISS for video:', videoId);
    return null;
  } catch (error) {
    console.error('❌ Cache read error:', error);
    return null;
  }
}

/**
 * Save lyrics to cache with eviction
 */
async function saveLyricsToCache(videoId, lyricsData, parsedData, channelName, confidence) {
  try {
    // Don't cache if confidence too low
    if (confidence < CACHE_MIN_CONFIDENCE) {
      console.log(`⏭️ Skipping cache: confidence ${confidence.toFixed(2)} < ${CACHE_MIN_CONFIDENCE}`);
      return;
    }
    
    // Don't cache if video not cacheable
    if (!isVideoCacheable()) {
      console.log('⏭️ Skipping cache: video not cacheable');
      return;
    }
    
    const cacheKey = getCacheKey(videoId);
    
    // Build cache entry
    const cacheEntry = {
      lyrics: lyricsData.lyrics,
      synced: lyricsData.synced,
      source: lyricsData.source,
      artist: lyricsData.artist,
      song: lyricsData.song,
      confidence: confidence,
      isCover: parsedData.isCover || false,
      channelName: channelName,
      cachedAt: Date.now()
    };
    
    // Get current metadata
    const metadataResult = await chrome.storage.local.get('lyrics_metadata');
    let metadata = metadataResult.lyrics_metadata || {};
    
    // Add new entry to metadata
    metadata[videoId] = {
      cachedAt: cacheEntry.cachedAt,
      confidence: confidence
    };
    
    // Check if eviction needed
    const entryCount = Object.keys(metadata).length;
    if (entryCount > CACHE_MAX_ENTRIES) {
      console.log(`🗑️ Cache full (${entryCount}/${CACHE_MAX_ENTRIES}), evicting oldest entry`);
      
      // Find oldest entry
      let oldestId = null;
      let oldestTime = Infinity;
      
      for (const [id, meta] of Object.entries(metadata)) {
        if (meta.cachedAt < oldestTime) {
          oldestTime = meta.cachedAt;
          oldestId = id;
        }
      }
      
      if (oldestId) {
        console.log('🗑️ Evicting:', oldestId);
        await chrome.storage.local.remove(getCacheKey(oldestId));
        delete metadata[oldestId];
      }
    }
    
    // Save cache entry and metadata
    await chrome.storage.local.set({
      [cacheKey]: cacheEntry,
      lyrics_metadata: metadata
    });
    
    console.log(`💾 快取 lyrics for ${videoId} (confidence: ${confidence.toFixed(2)})`);
    
  } catch (error) {
    console.error('❌ Cache save error:', error);
  }
}

/**
 * Clear cache entry (used on refresh)
 */
async function clearCachedLyrics(videoId) {
  try {
    const cacheKey = getCacheKey(videoId);
    
    // Remove cache entry
    await chrome.storage.local.remove(cacheKey);
    
    // Update metadata
    const metadataResult = await chrome.storage.local.get('lyrics_metadata');
    let metadata = metadataResult.lyrics_metadata || {};
    
    if (metadata[videoId]) {
      delete metadata[videoId];
      await chrome.storage.local.set({ lyrics_metadata: metadata });
    }
    
    console.log('🗑️ Cleared cache for:', videoId);
  } catch (error) {
    console.error('❌ Cache clear error:', error);
  }
}

// ============================================================================
// AI-POWERED TITLE CLEANER WITH MULTILINGUAL SUPPORT
// ============================================================================

class TitleCleaner {
  constructor() {
    this.patterns = {
      quality: /\b(4K|8K|HD|HQ|UHD|1080p|720p|480p|360p|240p|60fps|120fps)\b/gi,
      brackets: /[\[\(]([^\]\)]*?(official|video|audio|lyric|music|mv|visualizer|premiere|hd|hq|4k|remaster|explicit|clean|radio edit|extended|instrumental|acoustic|live|feat\.|ft\.|featuring|prod\.|produced).*?)[\]\)]/gi,
      phrases: /\b(official music video|official video|official audio|music video|audio|lyric video|lyrics|with lyrics|letra|legendado|tradução|translation|sub español|eng sub|color coded|han rom eng)\b/gi,
      year: /[\[\(]?\b(19|20)\d{2}\b[\]\)]?/g,
      labels: /\b(vevo|records|entertainment|music|productions?|official)\b/gi,
      extra: /[\(\[].*?(remaster|remix|edit|mix).*?[\)\]]$/gi,
      coverDetection: /\s*[\(\[]?\s*(cover|acoustic cover|piano cover|guitar cover|drum cover|vocal cover|remake|reimagined|version by|翻唱|歌ってみた|カバー|커버)\s*[\)\]]?\s*/gi,
      social: /#\w+/g,
      urls: /https?:\/\/\S+/g,
      emojis: /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]/gu,
      spaces: /\s{2,}/g,
      symbols: /^[\s\-\–\—\|]+|[\s\-\–\—\|]+$/g
    };
    
    this.artistSeparators = [
      ' - ', ' – ', ' — ', ' | ', ' • ',
      '・', '·',
      ' / ',
    ];
    
    this.featPatterns = [
      /\s*[\(\[]?\s*feat\.?\s+/gi,
      /\s*[\(\[]?\s*ft\.?\s+/gi,
      /\s*[\(\[]?\s*featuring\s+/gi,
      /\s*[\(\[]?\s*with\s+/gi,
      /\s*[\(\[]?\s*x\s+/gi,
      /\s*[\(\[]?\s*con\s+/gi,
      /\s*[\(\[]?\s*feat\.\s+/gi,
      /\s*[\(\[]?\s*part\.\s+/gi,
      /\s*[\(\[]?\s*feat\s+/gi,
      /\s*×\s*/gi,
    ];
  }
  
  detectLanguage(text) {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(text);
    const hasKorean = /[\uac00-\ud7af]/.test(text);
    const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff]/.test(text);
    const hasChinese = /[\u4e00-\u9fff]/.test(text);
    
    if (hasKorean) return 'ko';
    if (hasJapanese) return 'ja';
    if (hasChinese) return 'zh';
    if (/[áéíóúñü]/i.test(text)) return 'es';
    return 'en';
  }
  
  clean(rawTitle, channelName = '', isCover = false) {
    console.log('🧹 Cleaning title:', rawTitle);
    console.log('📺 Channel name:', channelName);
    console.log('🎤 Is cover:', isCover);
    
    // PROGRESS: Box 1 - Start cleaning
    fillNextBox(`整理標題：${truncateForLabel(rawTitle)}`);
    
    let title = rawTitle;
    
    title = title.replace(this.patterns.urls, '');
    title = title.replace(this.patterns.emojis, '');
    title = title.replace(this.patterns.quality, '');
    title = title.replace(this.patterns.phrases, '');
    title = title.replace(this.patterns.year, '');
    title = title.replace(this.patterns.labels, '');
    title = title.replace(this.patterns.brackets, '');
    title = title.replace(this.patterns.extra, '');
    title = title.replace(this.patterns.social, '');
    title = title.replace(this.patterns.spaces, ' ');
    title = title.replace(this.patterns.symbols, '');
    title = title.trim();
    
    console.log('✨ Cleaned title:', title);
    
    return this.parseArtistAndSong(title, channelName, isCover);
  }
  
  cleanChannelName(channelName) {
    if (!channelName) return '';
    
    let cleaned = channelName
      .replace(/\s*-?\s*(official|vevo|topic|music|channel|ost|soundtrack)/gi, '')
      .replace(/\s*-?\s*(lyrics|letra|lyric)/gi, '')
      .trim();
    
    console.log('🎤 Cleaned channel name:', cleaned);
    return cleaned;
  }
  
  parseArtistAndSong(title, channelName = '', isCover = false) {
    let artistFromTitle = '';
    let artistFromChannel = this.cleanChannelName(channelName);
    let song = '';
    let separator = null;
    
    const language = this.detectLanguage(title);
    console.log('🌐 Detected language:', language);
    
    let coverArtist = '';
    const byMatch = title.match(/\s+by\s+(.+?)(?:\s*[\(\[]|$)/i);
    if (byMatch && isCover) {
      coverArtist = byMatch[1].trim();
      console.log('🎤 Detected cover artist:', coverArtist);
      title = title.replace(/\s+by\s+.+?(?=\s*[\(\[]|$)/i, '').trim();
    }
    
    // 韓團等常見格式：歌手 (韓文名) 'Song' Official MV、歌手 “Song” M/V
    // 標題沒有「-」分隔時，原本只會抓到歌名，歌手變成頻道名稱（例如 HYBE LABELS），導致找不到歌
    const quotedMatch = title.match(/^(.+?)\s+["'‘“「『](\S[^"'‘’“”「」『』]*?)["'’”」』](?=\s|$|[\(\[（【])/);
    if (quotedMatch) {
      const prefix = quotedMatch[1]
        .replace(/[\(\[（【][^\)\]）】]*[\)\]）】]/g, '')
        .replace(/[\s\-–—|:：_]+$/, '')
        .trim();
      if (prefix && !/\s[-–—|]\s/.test(prefix)) {
        artistFromTitle = /[A-Za-z]/.test(prefix)
          ? prefix.replace(/[\p{Script=Hangul}]+/gu, '').replace(/\s+/g, ' ').trim() || prefix
          : prefix;
        song = quotedMatch[2].trim();
        console.log('🎯 Parsed quoted song title with artist prefix');
      }
    }
    
    if (!song && (language === 'ja' || language === 'zh')) {
      if (title.includes('・') || title.includes('·')) {
        const dotSep = title.includes('・') ? '・' : '·';
        const parts = title.split(dotSep);
        if (parts.length >= 2) {
          artistFromTitle = parts[0].trim();
          song = parts.slice(1).join(dotSep).trim();
          separator = dotSep;
          console.log('🎯 Parsed with CJK separator:', dotSep);
        }
      }
      
      if (!song && title.includes('「') && title.includes('」')) {
        const quoteMatch = title.match(/(.+?)「(.+?)」/);
        if (quoteMatch) {
          artistFromTitle = quoteMatch[1].trim();
          song = quoteMatch[2].trim();
          console.log('🎯 Parsed with Japanese quotes');
        }
      }
    }
    
    if (language === 'ko' && !song) {
      for (const sep of [' - ', ' | ', ' – ']) {
        if (title.includes(sep)) {
          const parts = title.split(sep);
          if (parts.length >= 2) {
            artistFromTitle = parts[0].trim();
            song = parts.slice(1).join(sep).trim();
            separator = sep;
            console.log('🎯 Parsed Korean with separator:', sep);
            break;
          }
        }
      }
    }
    
    if (!artistFromTitle || !song) {
      for (const sep of this.artistSeparators) {
        if (title.includes(sep)) {
          const parts = title.split(sep);
          if (parts.length >= 2) {
            artistFromTitle = parts[0].trim();
            song = parts.slice(1).join(sep).trim();
            separator = sep;
            break;
          }
        }
      }
    }
    
    if (!artistFromTitle || !song) {
      const byMatch = title.match(/^(.+?)\s+by\s+(.+)$/i);
      if (byMatch) {
        song = byMatch[1].trim();
        artistFromTitle = byMatch[2].trim();
        console.log('🎯 Parsed "by" pattern');
      }
    }
    
    if (!artistFromTitle && !song) {
      const quoteMatch = title.match(/["'「」]([^"'「」]+)["'「」]/);
      if (quoteMatch) {
        song = quoteMatch[1].trim();
        console.log('🎯 Using quoted text as song title');
      } else {
        song = title;
        console.log('🎯 Using full title as song');
      }
    }
    
    song = this.cleanFeaturing(song);
    song = this.cleanExtraParens(song);
    
    artistFromTitle = this.finalClean(artistFromTitle);
    artistFromChannel = this.finalClean(artistFromChannel);
    song = this.finalClean(song);
    
    console.log('🎯 Parsed - ArtistFromTitle:', artistFromTitle, '| ArtistFromChannel:', artistFromChannel, '| Song:', song, '| CoverArtist:', coverArtist);
    
    return { 
      artistFromTitle, 
      artistFromChannel,
      coverArtist,
      song, 
      originalTitle: title,
      isCover,
      language
    };
  }
  
  cleanExtraParens(text) {
    const endParensPattern = /\s*[\(\[](?:live|version|acoustic|unplugged|demo|instrumental|karaoke|remix|remaster|edit|taylor's version).*?[\)\]]$/gi;
    return text.replace(endParensPattern, '').trim();
  }
  
  cleanFeaturing(text) {
    let cleaned = text;
    for (const pattern of this.featPatterns) {
      const match = cleaned.match(pattern);
      if (match) {
        const index = cleaned.search(pattern);
        cleaned = cleaned.substring(0, index).trim();
        cleaned = cleaned.replace(/[\(\[]$/, '').trim();
      }
    }
    return cleaned;
  }
  
  finalClean(text) {
    return text
      .replace(/^[\s\-\–\—\|•]+|[\s\-\–\—\|•]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  
  generateSearchVariations(parsedData) {
    const { artistFromTitle, artistFromChannel, coverArtist, song, isCover, language } = parsedData;
    const variations = [];
    
    console.log('🔄 Generating variations from:', { artistFromTitle, artistFromChannel, coverArtist, song, isCover, language });
    
    // PROGRESS: Box 2 - Parsing complete
    const displayArtist = artistFromTitle || artistFromChannel || 'Unknown';
    const displaySong = song || 'Unknown';
    fillNextBox(`解析：${truncateForLabel(displayArtist)} – ${truncateForLabel(displaySong)}`);
    
    const songClean = song.replace(this.patterns.coverDetection, '').trim();
    const songNoParens = songClean.replace(/[\(\[].*?[\)\]]/g, '').trim();
    
    if (isCover) {
      console.log('🎤 COVER DETECTED - Generating cover-aware variations');
      
      if (artistFromTitle && songClean) {
        variations.push({ 
          artist: artistFromTitle, 
          song: songClean, 
          source: 'title-artist',
          priority: 1,
          label: 'cover-original-artist' 
        });
      }
      
      if (artistFromChannel && songClean && artistFromChannel !== artistFromTitle) {
        variations.push({ 
          artist: artistFromChannel, 
          song: songClean, 
          source: 'channel',
          priority: 2,
          label: 'cover-channel-artist' 
        });
      }
      
      if (coverArtist && songClean) {
        variations.push({ 
          artist: coverArtist, 
          song: songClean, 
          source: 'cover-artist',
          priority: 3,
          label: 'cover-by-artist' 
        });
      }
      
      if (songClean) {
        variations.push({ 
          artist: '', 
          song: songClean, 
          source: 'song-only',
          priority: 4,
          label: 'cover-song-only' 
        });
      }
      
      if (songNoParens && songNoParens !== songClean) {
        if (artistFromTitle) {
          variations.push({ 
            artist: artistFromTitle, 
            song: songNoParens, 
            source: 'title-artist',
            priority: 5,
            label: 'cover-original-clean' 
          });
        }
        variations.push({ 
          artist: '', 
          song: songNoParens, 
          source: 'song-only',
          priority: 6,
          label: 'cover-song-clean' 
        });
      }
      
    } else {
      console.log('🎵 Regular song - Generating standard variations');
      
      if (artistFromTitle && songClean) {
        variations.push({ 
          artist: artistFromTitle, 
          song: songClean, 
          source: 'title-artist',
          priority: 1,
          label: 'exact' 
        });
      }
      
      if (artistFromChannel && songClean && artistFromChannel !== artistFromTitle) {
        variations.push({ 
          artist: artistFromChannel, 
          song: songClean, 
          source: 'channel',
          priority: 2,
          label: 'channel-as-artist' 
        });
      }
      
      if (artistFromChannel && songClean && artistFromTitle) {
        variations.push({ 
          artist: songClean, 
          song: artistFromChannel, 
          source: 'reversed',
          priority: 3,
          label: 'reversed-search' 
        });
      }
      
      if (songClean) {
        variations.push({ 
          artist: '', 
          song: songClean, 
          source: 'song-only',
          priority: 4,
          label: 'song-only' 
        });
      }
      
      if (songNoParens && songNoParens !== songClean) {
        if (artistFromTitle) {
          variations.push({ 
            artist: artistFromTitle, 
            song: songNoParens, 
            source: 'title-artist',
            priority: 5,
            label: 'no-parens' 
          });
        }
        variations.push({ 
          artist: '', 
          song: songNoParens, 
          source: 'song-only',
          priority: 6,
          label: 'song-only-clean' 
        });
      }
      
      if (artistFromTitle && songClean) {
        variations.push({ 
          artist: '', 
          song: `${artistFromTitle} ${songClean}`, 
          source: 'combined',
          priority: 7,
          label: 'combined-fallback' 
        });
      }
      
      if (artistFromChannel && songClean && artistFromChannel !== artistFromTitle) {
        variations.push({ 
          artist: '', 
          song: `${artistFromChannel} ${songClean}`, 
          source: 'combined',
          priority: 8,
          label: 'combined-channel' 
        });
      }
    }
    
    if (language === 'zh' || language === 'ja' || language === 'ko') {
      const songNoSpaces = songClean.replace(/\s+/g, '');
      if (songNoSpaces !== songClean) {
        if (artistFromTitle) {
          variations.push({ 
            artist: artistFromTitle, 
            song: songNoSpaces, 
            source: 'cjk',
            priority: 9,
            label: 'cjk-no-space' 
          });
        }
        variations.push({ 
          artist: '', 
          song: songNoSpaces, 
          source: 'cjk',
          priority: 10,
          label: 'cjk-song-only' 
        });
      }
      
      const songWithSpaces = songClean.split('').join(' ');
      if (artistFromTitle && songWithSpaces.length < 100) {
        variations.push({ 
          artist: artistFromTitle, 
          song: songWithSpaces, 
          source: 'cjk',
          priority: 11,
          label: 'cjk-spaced' 
        });
      }
    }
    
    variations.sort((a, b) => a.priority - b.priority);
    
    console.log(`✅ Generated ${variations.length} ranked variations`);
    return variations;
  }
  
  removeEmojis(text) {
    return text.replace(this.patterns.emojis, '').replace(/\s{2,}/g, ' ').trim();
  }
}

const titleCleaner = new TitleCleaner();

// ============================================================================
// YOUTUBE INFO EXTRACTION
// ============================================================================

function getChannelName() {
  const watchFlexy = document.querySelector('ytd-watch-flexy');
  if (!watchFlexy) {
    console.log('⚠️ No watch-flexy container found');
    return '';
  }
  
  const selectors = [
    'ytd-channel-name#channel-name yt-formatted-string a',
    'ytd-channel-name#channel-name a',
    '#channel-name a',
    'ytd-video-owner-renderer .ytd-channel-name a',
    '#owner-name a'
  ];
  
  for (const selector of selectors) {
    const element = watchFlexy.querySelector(selector);
    if (element && element.textContent) {
      const channelName = element.textContent.trim();
      console.log('📺 Found channel name:', channelName);
      return channelName;
    }
  }
  
  console.log('⚠️ Could not find channel name');
  return '';
}

function getVideoTitle() {
  const watchFlexy = document.querySelector('ytd-watch-flexy');
  if (!watchFlexy) {
    throw new Error('找不到 YouTube 影片區塊');
  }
  
  const titleElement = watchFlexy.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
                      watchFlexy.querySelector('h1.title');
  
  if (!titleElement) {
    throw new Error('找不到影片標題');
  }
  
  return titleElement.textContent.trim();
}

function isCoverVideo() {
  const title = getVideoTitle().toLowerCase();
  const description = document.querySelector('#description-inline-expander')?.textContent.toLowerCase() || '';
  
  const coverKeywords = [
    'cover', 'acoustic cover', 'piano cover', 'guitar cover', 'drum cover',
    'vocal cover', 'remake', 'reimagined', 'version by',
    '翻唱', '歌ってみた', 'カバー', '커버'
  ];
  
  const hasCover = coverKeywords.some(keyword => 
    title.includes(keyword) || description.includes(keyword)
  );
  
  console.log('🎤 Is cover video:', hasCover);
  return hasCover;
}

function getMusicInfoFromMusicSection() {
  try {
    const musicRenderers = document.querySelectorAll('ytd-structured-description-content-renderer, ytd-music-description-shelf-renderer');
    
    for (const renderer of musicRenderers) {
      const songElement = renderer.querySelector('.content-title, .title');
      const artistElement = renderer.querySelector('.content-subtitle, .subtitle');
      
      if (songElement && artistElement) {
        let song = songElement.textContent.trim();
        let artist = artistElement.textContent.trim();
        
        song = song.replace(/\s*[\(\[]?\s*(cover|acoustic cover|piano cover|guitar cover|drum cover|vocal cover|remake|reimagined|version by|翻唱|歌ってみた|カバー|커버)\s*[\)\]]?\s*/gi, '').trim();
        
        console.log('🎵 Found Music section info - Song:', song, '| Artist:', artist);
        
        if (song && artist) {
          return { song, artist };
        }
      }
    }
    
    const structuredDesc = document.querySelector('ytd-video-description-music-section-renderer');
    if (structuredDesc) {
      const rows = structuredDesc.querySelectorAll('.item');
      let song = '';
      let artist = '';
      
      rows.forEach(row => {
        const label = row.querySelector('.label')?.textContent.toLowerCase().trim();
        const value = row.querySelector('.value')?.textContent.trim();
        
        if (label === 'song' && value) {
          song = value.replace(/\s*[\(\[]?\s*(cover|acoustic cover|piano cover|guitar cover|drum cover|vocal cover|remake|reimagined|version by|翻唱|歌ってみた|カバー|커버)\s*[\)\]]?\s*/gi, '').trim();
        }
        if (label === 'artist' && value) {
          artist = value;
        }
      });
      
      if (song && artist) {
        console.log('🎵 Found Music section (structured) - Song:', song, '| Artist:', artist);
        return { song, artist };
      }
    }
    
    console.log('⚠️ No Music section found');
    return null;
  } catch (error) {
    console.log('⚠️ Error parsing music section:', error);
    return null;
  }
}

// ============================================================================
// LYRICS SOURCES
// ============================================================================

async function searchLRCLIB(artist, song) {
  try {
    const searches = [
      artist && song ? 
        `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(song)}` 
        : null,
      song ? 
        `https://lrclib.net/api/search?track_name=${encodeURIComponent(song)}`
        : null,
      artist && song ?
        `https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${song}`.trim())}`
        : null
    ].filter(Boolean);
    
    for (const url of searches) {
      console.log('🔍 LRCLIB searching:', url);
      const response = await fetch(url);
      
      if (!response.ok) continue;
      
      const results = await response.json();
      
      if (results && results.length > 0) {
        // 挑選結果：有指定歌手時，只接受歌手名稱相符的結果（原本會直接拿第一筆，
        // 用「OMG」這種常見歌名搜尋時，常拿到別的歌手的同名歌曲）；同樣相符時優先選有同步歌詞的
        const norm = (t) => String(t || '').toLowerCase().replace(/[\s\-_.·'’]+/g, '');
        const a = norm(artist);
        const t = norm(song);
        let candidates = results.filter(r => r.syncedLyrics || r.plainLyrics);
        if (a) {
          candidates = candidates.filter(r => {
            const n = norm(r.artistName);
            return n && (n.includes(a) || a.includes(n));
          });
          if (candidates.length === 0) continue; // 歌手對不上，換下一種搜尋方式
        }
        const rank = (r) => (r.syncedLyrics ? 2 : 0) + (norm(r.trackName) === t ? 1 : 0);
        candidates.sort((x, y) => rank(y) - rank(x));
        const match = candidates[0];
        if (!match) continue;
        
        console.log('✅ LRCLIB found:', match.trackName, 'by', match.artistName);
        
        if (match.syncedLyrics) {
          return {
            lyrics: match.syncedLyrics,
            synced: true,
            source: 'LRCLIB (Synced)',
            artist: match.artistName,
            song: match.trackName
          };
        } else if (match.plainLyrics) {
          return {
            lyrics: match.plainLyrics,
            synced: false,
            source: 'LRCLIB (Plain)',
            artist: match.artistName,
            song: match.trackName
          };
        }
      }
    }
    
    throw new Error('LRCLIB 沒有搜尋結果');
  } catch (error) {
    console.log('❌ LRCLIB failed:', error.message);
    throw error;
  }
}

async function searchLyricsOVH(artist, song) {
  try {
    if (!artist || !song) {
      throw new Error('Lyrics.ovh 需要歌手和歌名');
    }
    
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(song)}`;
    console.log('🔍 Lyrics.ovh searching:', url);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error('Lyrics.ovh 連線失敗');
    }
    
    const data = await response.json();
    
    if (data.lyrics) {
      console.log('✅ Lyrics.ovh found lyrics');
      return {
        lyrics: data.lyrics,
        synced: false,
        source: 'Lyrics.ovh',
        artist: artist,
        song: song
      };
    }
    
    throw new Error('Lyrics.ovh 找不到歌詞');
  } catch (error) {
    console.log('❌ Lyrics.ovh failed:', error.message);
    throw error;
  }
}

async function searchAllSources(parsedData) {
  console.log('🚀 Starting multi-source search...');
  console.log('📦 Parsed data:', parsedData);
  
  const variations = titleCleaner.generateSearchVariations(parsedData);
  console.log('🔄 Generated', variations.length, 'search variations');
  
  // Track which major search phases we've tried
  let boxesFilled = {
    titleArtist: false,
    channelArtist: false,
    songOnly: false,
    fallback1: false,
    fallback2: false
  };
  
  for (let i = 0; i < variations.length; i++) {
    const variant = variations[i];
    console.log(`📍 Trying variation ${i + 1}/${variations.length} (${variant.label}):`, { artist: variant.artist, song: variant.song });
    
    // Build dynamic label with real data
    let searchLabel = '';
    if (variant.artist && variant.song) {
      searchLabel = `${truncateForLabel(variant.artist)} – ${truncateForLabel(variant.song)}`;
    } else if (variant.song) {
      searchLabel = `${truncateForLabel(variant.song)}`;
    } else {
      searchLabel = '搜尋中...';
    }
    
    // Fill box 3: Artist + Song from title
    if (!boxesFilled.titleArtist && variant.artist && variant.source === 'title-artist') {
      fillNextBox(`搜尋：${searchLabel}`);
      boxesFilled.titleArtist = true;
    }
    // Fill box 4: Channel artist + Song
    else if (!boxesFilled.channelArtist && variant.artist && variant.source === 'channel') {
      fillNextBox(`頻道：${searchLabel}`);
      boxesFilled.channelArtist = true;
    }
    // Fill box 5: Song-only fallback
    else if (!boxesFilled.songOnly && !variant.artist && variant.source === 'song-only') {
      fillNextBox(`備用搜尋：${searchLabel}`);
      boxesFilled.songOnly = true;
    }
    // Fill box 6: Combined/reversed fallbacks
    else if (!boxesFilled.fallback1 && (variant.source === 'combined' || variant.source === 'reversed')) {
      fillNextBox(`嘗試：${searchLabel}`);
      boxesFilled.fallback1 = true;
    }
    // Fill box 7: CJK and final fallbacks
    else if (!boxesFilled.fallback2 && variant.source === 'cjk') {
      fillNextBox(`中日韓搜尋：${searchLabel}`);
      boxesFilled.fallback2 = true;
    }
    
    try {
      const result = await searchLRCLIB(variant.artist, variant.song);
      if (result) {
        console.log(`✅ SUCCESS with variation: ${variant.label}`);
        return result;
      }
    } catch (e) {
      console.log(`  ⏭️  LRCLIB miss (${variant.label})`);
    }
    
    if (variant.artist && variant.song) {
      try {
        const result = await searchLyricsOVH(variant.artist, variant.song);
        if (result) {
          console.log(`✅ SUCCESS with variation: ${variant.label}`);
          return result;
        }
      } catch (e) {
        console.log(`  ⏭️  Lyrics.ovh miss (${variant.label})`);
      }
    }
  }
  
  throw new Error('所有來源都找不到歌詞');
}

// ============================================================================
// UI COMPONENTS
// ============================================================================

function createLyricsPanel() {
  const panel = document.createElement('div');
  panel.id = 'lyrics-extension-panel';
  panel.innerHTML = `
    <style>
      #lyrics-extension-panel {
        position: fixed;
        top: 80px;
        right: 20px;
        width: 380px;
        max-height: 70vh;
        background: ${darkModeEnabled ? 'rgba(28, 28, 30, 0.95)' : 'rgba(255, 255, 255, 0.95)'};
        backdrop-filter: blur(20px) saturate(180%);
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        border: 1px solid ${darkModeEnabled ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'};
        transition: height 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      
      #lyrics-extension-panel.minimized {
        height: 60px;
        max-height: 60px;
      }
      
      .lyrics-header {
        flex-shrink: 0;
        padding: 16px 20px;
        background: ${darkModeEnabled ? 'linear-gradient(180deg, #2c2c2e 0%, #1c1c1e 100%)' : 'linear-gradient(180deg, #fafafa 0%, #f0f0f0 100%)'};
        border-bottom: 1px solid ${darkModeEnabled ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'};
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        user-select: none;
        backdrop-filter: blur(20px);
      }
      
      .lyrics-title {
        font-size: 14px;
        font-weight: 600;
        color: ${darkModeEnabled ? '#f5f5f7' : '#1d1d1f'};
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .lyrics-controls {
        display: flex;
        gap: 8px;
      }
      
      .lyrics-btn {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        border: none;
        background: ${darkModeEnabled ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)'};
        color: ${darkModeEnabled ? '#f5f5f7' : '#1d1d1f'};
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: all 0.2s;
      }
      
      .lyrics-btn:hover {
        background: ${darkModeEnabled ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)'};
        transform: scale(1.05);
      }
      
      .lyrics-content {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        color: ${darkModeEnabled ? '#f5f5f7' : '#1d1d1f'};
        line-height: 1.8;
        font-size: 14px;
      }
      
      .lyrics-content::-webkit-scrollbar {
        width: 8px;
      }
      
      .lyrics-content::-webkit-scrollbar-track {
        background: ${darkModeEnabled ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)'};
        border-radius: 4px;
      }
      
      .lyrics-content::-webkit-scrollbar-thumb {
        background: ${darkModeEnabled ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)'};
        border-radius: 4px;
      }
      
      .lyrics-content::-webkit-scrollbar-thumb:hover {
        background: ${darkModeEnabled ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)'};
      }
      
      .lyrics-loading {
        text-align: center;
        padding: 40px 20px;
        color: ${darkModeEnabled ? '#98989d' : '#86868b'};
      }
      
      .segmented-progress-container {
        display: flex;
        gap: 8px;
        justify-content: center;
        margin-bottom: 16px;
      }
      
      .progress-box {
        width: 36px;
        height: 10px;
        border-radius: 3px;
        transition: none;
        border: 1px solid ${darkModeEnabled ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)'};
      }
      
      .progress-box-filled {
        background: ${darkModeEnabled ? 'linear-gradient(90deg, #8E8E93 0%, #AEAEB2 100%)' : 'linear-gradient(90deg, #636366 0%, #8E8E93 100%)'};
        border-color: ${darkModeEnabled ? '#8E8E93' : '#636366'};
        box-shadow: 0 0 3px ${darkModeEnabled ? 'rgba(142, 142, 147, 0.3)' : 'rgba(99, 99, 102, 0.2)'};
      }
      
      .progress-box-empty {
        background: ${darkModeEnabled ? 'rgba(142, 142, 147, 0.08)' : 'rgba(99, 99, 102, 0.06)'};
      }
      
      .progress-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 8px;
      }
      
      .progress-label {
        font-size: 13px;
        font-weight: 500;
        color: ${darkModeEnabled ? '#98989d' : '#86868b'};
        flex: 1;
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      
      .progress-percentage {
        font-size: 12px;
        font-weight: 600;
        color: ${darkModeEnabled ? '#8E8E93' : '#636366'};
        margin-left: 12px;
        flex-shrink: 0;
      }
      
      .manual-search-box {
        background: ${darkModeEnabled ? 'rgba(255, 214, 10, 0.12)' : 'rgba(255, 204, 0, 0.08)'};
        border: 1px solid ${darkModeEnabled ? 'rgba(255, 214, 10, 0.3)' : 'rgba(255, 204, 0, 0.3)'};
        border-radius: 12px;
        padding: 16px;
        margin-top: 16px;
      }
      
      .manual-search-title {
        font-size: 13px;
        font-weight: 600;
        color: ${darkModeEnabled ? '#f5f5f7' : '#1d1d1f'};
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .manual-search-input {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid ${darkModeEnabled ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.12)'};
        border-radius: 8px;
        font-size: 14px;
        font-family: inherit;
        background: ${darkModeEnabled ? 'rgba(44, 44, 46, 0.9)' : 'rgba(255, 255, 255, 0.9)'};
        color: ${darkModeEnabled ? '#f5f5f7' : '#1d1d1f'};
        margin-bottom: 10px;
        transition: all 0.2s ease;
        box-sizing: border-box;
      }
      
      .manual-search-input:focus {
        outline: none;
        border-color: ${darkModeEnabled ? '#0A84FF' : '#007AFF'};
        box-shadow: 0 0 0 3px ${darkModeEnabled ? 'rgba(10, 132, 255, 0.15)' : 'rgba(0, 122, 255, 0.1)'};
      }
      
      .manual-search-button {
        width: 100%;
        padding: 10px 16px;
        background: ${darkModeEnabled ? '#0A84FF' : '#007AFF'};
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        font-family: inherit;
      }
      
      .manual-search-button:hover {
        background: ${darkModeEnabled ? '#006EDB' : '#0051D5'};
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 122, 255, 0.3);
      }
      
      .manual-search-button:active {
        transform: translateY(0);
      }
      
      .manual-search-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }
      
      .manual-search-hint {
        font-size: 11px;
        color: ${darkModeEnabled ? '#98989d' : '#86868b'};
        margin-top: 8px;
        text-align: center;
      }
      
      .lyrics-error {
        text-align: center;
        padding: 40px 20px;
        color: ${darkModeEnabled ? '#ff453a' : '#d70015'};
      }
      
      .lyrics-metadata {
        padding: 12px 20px;
        background: ${darkModeEnabled ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)'};
        border-bottom: 1px solid ${darkModeEnabled ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)'};
        font-size: 12px;
        color: ${darkModeEnabled ? '#98989d' : '#86868b'};
      }
      
      .lyrics-metadata-row {
        display: flex;
        justify-content: space-between;
        margin: 4px 0;
      }
      
      .lyrics-source-badge {
        display: inline-block;
        padding: 4px 8px;
        background: ${darkModeEnabled ? 'rgba(10, 132, 255, 0.2)' : 'rgba(0, 122, 255, 0.1)'};
        color: ${darkModeEnabled ? '#0a84ff' : '#007AFF'};
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
      }
      
      .synced-line {
        padding: 8px 0;
        transition: all 0.3s;
        opacity: 0.5;
        cursor: pointer;
      }
      
      .synced-line:hover {
        opacity: 0.8;
        background: ${darkModeEnabled ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)'};
      }
      
      .synced-line.active {
        color: #007AFF;
        font-weight: 600;
        transform: translateX(4px);
        opacity: 1;
        font-size: 15px;
      }
      
      .synced-line.passed {
        opacity: 0.3;
      }
      
      .synced-line.upcoming {
        opacity: 0.5;
      }
      
      .lyrics-minimized-view {
        padding: 16px 20px;
        text-align: center;
      }
      
      .lyrics-minimized-view .mini-line {
        padding: 4px 0;
        font-size: 13px;
        line-height: 1.6;
        transition: all 0.3s;
      }
      
      .lyrics-minimized-view .mini-line.previous,
      .lyrics-minimized-view .mini-line.next {
        opacity: 0.4;
        color: ${darkModeEnabled ? '#98989d' : '#86868b'};
      }
      
      .lyrics-minimized-view .mini-line.current {
        opacity: 1;
        font-weight: 600;
        color: ${darkModeEnabled ? '#f5f5f7' : '#1d1d1f'};
        font-size: 14px;
      }
      #lyrics-extension-panel .ylp-translation {
        font-size: 0.85em;
        line-height: 1.4;
        margin-top: 2px;
        opacity: 0.75;
        font-weight: normal;
        pointer-events: none;
      }
      #lyrics-extension-panel .synced-line.active .ylp-translation { opacity: 0.95; }
      #lyrics-extension-panel .plain-line { margin-bottom: 6px; }
      #lyrics-extension-panel .ylp-translate-btn.off { opacity: 0.4; }
    </style>
    
    <div class="lyrics-header" id="lyrics-header">
      <div class="lyrics-title">
        <span>🎵</span>
        <span>歌詞</span>
      </div>
      <div class="lyrics-controls">
        <button class="lyrics-btn" id="karaoke-btn" title="卡拉OK模式（全螢幕，只顯示 MV 與字幕）">
          <span style="font-size: 14px; line-height: 1;">🎤</span>
        </button>
        <button class="lyrics-btn ylp-translate-btn" id="translate-btn" title="顯示／隱藏翻譯">
          <span style="font-size: 13px; line-height: 1;">譯</span>
        </button>
        <button class="lyrics-btn" id="minimize-btn" title="縮小">
          <span style="font-size: 16px; line-height: 1;">−</span>
        </button>
        <button class="lyrics-btn" id="refresh-btn" title="重新搜尋歌詞">
          <span style="font-size: 16px; line-height: 1;">↻</span>
        </button>
        <button class="lyrics-btn" id="close-btn" title="關閉">
          <span style="font-size: 16px; line-height: 1;">×</span>
        </button>
      </div>
    </div>
    
    <div class="lyrics-content" id="lyrics-content">
      ${renderProgressBar()}
    </div>
  `;
  
  document.body.appendChild(panel);
  
  // PROGRESS: Reset on refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    console.log('🔄 Refresh button clicked - bypassing cache');
    isRefreshRequest = true;
    resetProgress();
    if (window.analytics) {
      window.analytics.trackPanelInteraction('refresh');
    }
    detectAndShowLyrics();
  });
  
  document.getElementById('close-btn').addEventListener('click', () => {
    if (window.analytics) {
      window.analytics.trackPanelInteraction('close');
    }
    
    panel.remove();
    lyricsPanel = null;
  });
  
  document.getElementById('minimize-btn').addEventListener('click', () => {
    panel.classList.toggle('minimized');
    isMinimized = panel.classList.contains('minimized');
    
    if (window.analytics) {
      window.analytics.trackPanelInteraction(isMinimized ? 'minimize' : 'maximize');
    }
    
    // Update lyrics rendering based on minimized state
    if (isMinimized && currentSyncedLines.length > 0) {
      renderMinimizedLyrics();
    } else if (!isMinimized && currentSyncedLines.length > 0) {
      // Restore full lyrics view
      const content = document.getElementById('lyrics-content');
      if (content && content.querySelector('.lyrics-minimized-view')) {
        // Re-render full lyrics
        displayLyrics(currentLyricsResult, currentLyricsResult.isCached);
      }
    }
  });
  
  // 原本用 scroll 事件判斷「使用者捲動」，但程式自己捲動也會觸發，導致自動捲動第一次就被永久關閉。
  // 改成只偵測真正的手動操作（滾輪、觸控、拖曳捲軸、鍵盤），並在幾秒後自動恢復。
  const lyricsContent = document.getElementById('lyrics-content');
  lyricsContent.addEventListener('wheel', ylpPauseAutoScroll, { passive: true });
  lyricsContent.addEventListener('touchmove', ylpPauseAutoScroll, { passive: true });
  lyricsContent.addEventListener('keydown', ylpPauseAutoScroll);
  lyricsContent.addEventListener('mousedown', (e) => {
    if (e.target === lyricsContent) ylpPauseAutoScroll(); // 按在捲軸上
  });

  document.getElementById('karaoke-btn').addEventListener('click', () => ylpKaraokeToggle());

  document.getElementById('translate-btn').addEventListener('click', () => {
    chrome.storage.sync.set({ translate: !ylpSettings.translate });
  });
  ylpUpdateTranslateButton();
  
  makeDraggable(panel, document.getElementById('lyrics-header'));
  
  return panel;
}

function makeDraggable(element, header) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  
  header.onmousedown = dragMouseDown;
  
  function dragMouseDown(e) {
    if (e.target.closest('.lyrics-btn')) return;
    
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
    header.style.cursor = 'grabbing';
  }
  
  function elementDrag(e) {
    e.preventDefault();
    
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    let newTop = element.offsetTop - pos2;
    let newLeft = element.offsetLeft - pos1;
    
    const rect = element.getBoundingClientRect();
    const maxTop = window.innerHeight - rect.height;
    const maxLeft = window.innerWidth - rect.width;
    
    newTop = Math.max(0, Math.min(newTop, maxTop));
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    
    element.style.top = newTop + "px";
    element.style.left = newLeft + "px";
    element.style.right = 'auto';
  }
  
  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    header.style.cursor = 'move';
  }
}

async function detectAndShowLyrics() {
  try {
    console.log('🎬 Detecting song from YouTube...');
    
    // PROGRESS: Reset progress
    resetProgress();
    
    const rawTitle = getVideoTitle();
    const channelName = getChannelName();
    const isCover = isCoverVideo();
    
    console.log('📺 Raw YouTube title:', rawTitle);
    console.log('📺 Channel name:', channelName);
    console.log('🎤 Is cover:', isCover);

    const videoIdMatch = window.location.search.match(/[?&]v=([^&]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;
    
    if (window.analytics && videoId) {
      window.analytics.trackVideoViewed(videoId, channelName);
    }
    
    if (!videoId) {
      throw new Error('無法取得影片 ID');
    }
    
    if (isRefreshRequest) {
      console.log('🔄 Refresh mode: clearing existing cache for', videoId);
      await clearCachedLyrics(videoId);
      isRefreshRequest = false;
    }
    
    // Boxes 1-2 filled during cleaning/parsing
    const parsedData = titleCleaner.clean(rawTitle, channelName, isCover);
    
    if (!lyricsPanel) {
      lyricsPanel = createLyricsPanel();
    }
    
    const content = document.getElementById('lyrics-content');
    content.innerHTML = renderProgressBar();
    
    // Setup manual search during loading using selector-based approach
    setupManualSearchBySelector('.manual-search-box', true);
    
    // Box 3: Cache lookup (using parsed artist/song if available)
    const displayArtist = parsedData.artistFromTitle || parsedData.artistFromChannel || '';
    const displaySong = parsedData.song || '';
    let cacheLabel = '檢查快取';
    if (displayArtist && displaySong) {
      cacheLabel = `快取：${truncateForLabel(displayArtist)} – ${truncateForLabel(displaySong)}`;
    } else if (displaySong) {
      cacheLabel = `快取：${truncateForLabel(displaySong)}`;
    }
    
    if (!isRefreshRequest) {
      fillNextBox(cacheLabel);
      const cachedResult = await getCachedLyrics(videoId);
      if (cachedResult) {
        console.log('💾 Using cached lyrics - skipping search');
        fillAllBoxes('✓ 從快取載入');
        await new Promise(resolve => setTimeout(resolve, 150)); // Brief visual feedback
        displayLyrics(cachedResult, true);
        return;
      }
    }
    
    // Boxes 4-8: Search sources (filled inside searchAllSources with dynamic labels)
    try {
      const result = await searchAllSources(parsedData);
      
      // Success: fill remaining boxes
      fillAllBoxes('✓ 找到歌詞');
      
      const hasMusicSection = getMusicInfoFromMusicSection() !== null;
      const confidence = calculateConfidence(parsedData, result, hasMusicSection);
      console.log('📊 Confidence score:', confidence.toFixed(2));
      
      await saveLyricsToCache(videoId, result, parsedData, channelName, confidence);
      
      displayLyrics(result, false);
      return;
    } catch (error) {
      console.log('❌ Search failed with parsed info, trying Music section...');
      
      const musicInfo = getMusicInfoFromMusicSection();
      
      if (musicInfo && musicInfo.artist && musicInfo.song) {
        console.log('✅ Trying with Music section info');
        
        const musicParsed = {
          artistFromTitle: musicInfo.artist,
          artistFromChannel: '',
          coverArtist: '',
          song: musicInfo.song,
          originalTitle: musicInfo.song,
          isCover: false,
          language: 'en'
        };
        
        const result = await searchAllSources(musicParsed);
        
        fillAllBoxes('✓ 找到歌詞');
        
        const confidence = calculateConfidence(musicParsed, result, true);
        await saveLyricsToCache(videoId, result, musicParsed, channelName, confidence);
        
        displayLyrics(result, false);
        return;
      }
      
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    
    // Fill all boxes on failure
    fillAllBoxes('✗ 找不到');
    ylpLyricsState = 'notfound';
    ylpKaraokeRender(true);

    const rawTitleForError = getVideoTitle();
    if (window.analytics && rawTitleForError) {
      window.analytics.trackLyricsError(rawTitleForError, 'not_found');
    }
    
    if (lyricsPanel) {
      const content = document.getElementById('lyrics-content');
      content.innerHTML = `
        <div class="lyrics-error">
          <div style="font-size: 48px; margin-bottom: 12px;">😔</div>
          <div style="font-weight: 600; margin-bottom: 8px;">找不到歌詞</div>
          <div style="font-size: 12px; opacity: 0.7;">${ylpEscape(error.message)}</div>
          <div class="manual-search-box">
            <div class="manual-search-title">
              <span>🔍</span>
              <span>手動搜尋</span>
            </div>
            <input 
              type="text" 
              class="manual-search-input" 
              placeholder="歌手 - 歌名"
              id="manual-search-input-${Date.now()}"
              name="no-autofill-error-${Date.now()}"
              autocomplete="new-password"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              inputmode="search"
              data-form-type="other"
              data-lpignore="true"
            />
            <button class="manual-search-button" id="manual-search-btn-${Date.now()}">重新搜尋</button>
            <div class="manual-search-hint">
              💡 請輸入完整的歌手與歌名
            </div>
          </div>
        </div>
      `;
      
      setupManualSearchBySelector('.manual-search-box', false);
    }
  }
}

function setupManualSearch(inputId, buttonId, cancelLoading = false) {
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);
  
  if (!input || !button) return;
  
  setupManualSearchDynamic(input, button, cancelLoading);
}

function setupManualSearchBySelector(containerSelector, cancelLoading = false) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  
  const input = container.querySelector('.manual-search-input');
  const button = container.querySelector('.manual-search-button');
  
  if (!input || !button) return;
  
  setupManualSearchDynamic(input, button, cancelLoading);
}

function setupManualSearchDynamic(input, button, cancelLoading = false) {
  if (!input || !button) return;
  
  // AGGRESSIVE AUTOFILL PREVENTION
  
  // Clear value immediately
  input.value = '';
  
  // Force all anti-autofill attributes
  input.setAttribute('autocomplete', 'new-password');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('inputmode', 'search');
  input.setAttribute('data-lpignore', 'true'); // LastPass ignore
  input.setAttribute('data-form-type', 'other');
  input.setAttribute('name', `no-autofill-${Date.now()}`);
  
  // Clear on focus (Chrome autofill workaround)
  input.addEventListener('focus', () => {
    input.value = '';
    input.setAttribute('autocomplete', 'new-password');
  });
  
  // Clear on blur if empty (prevent Chrome from saving)
  input.addEventListener('blur', () => {
    if (!input.value.trim()) {
      input.value = '';
    }
  });
  
  // Prevent form submission from triggering autosave
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
    }
  });
  
  const performManualSearch = async () => {
    const manualQuery = input.value.trim();
    if (!manualQuery) return;
    
    console.log('🔍 Manual search:', manualQuery);
    
    button.disabled = true;
    button.textContent = '⏳ 搜尋中...';
    
    // PROGRESS: Reset for manual search
    resetProgress();
    
    let manualArtist = '';
    let manualSong = manualQuery;
    
    const separators = [' - ', ' – ', ' — ', ' | '];
    for (const sep of separators) {
      if (manualQuery.includes(sep)) {
        const parts = manualQuery.split(sep);
        manualArtist = parts[0].trim();
        manualSong = parts.slice(1).join(sep).trim();
        break;
      }
    }
    
    try {
      const manualParsed = {
        artistFromTitle: manualArtist,
        artistFromChannel: '',
        coverArtist: '',
        song: manualSong,
        originalTitle: manualSong,
        isCover: false,
        language: 'en'
      };
      
      const result = await searchAllSources(manualParsed);
      
      if (window.analytics) {
        window.analytics.trackManualSearch(manualQuery, result ? true : false);
      }
      
      if (result) {
        fillAllBoxes('✓ 找到歌詞');
        
        const videoIdMatch = window.location.search.match(/[?&]v=([^&]+)/);
        const videoId = videoIdMatch ? videoIdMatch[1] : null;
        
        if (videoId) {
          const confidence = 0.8;
          const channelName = getChannelName();
          await saveLyricsToCache(videoId, result, manualParsed, channelName, confidence);
        }
        
        // Clear input after successful search
        input.value = '';
        
        displayLyrics(result, false);
      } else {
        button.textContent = '❌ 還是找不到';
        setTimeout(() => {
          button.disabled = false;
          button.textContent = '重新搜尋';
        }, 2000);
      }
    } catch (err) {
      console.error('Manual search error:', err);
      button.textContent = '❌ 找不到';
      setTimeout(() => {
        button.disabled = false;
        button.textContent = cancelLoading ? '立即搜尋' : '重新搜尋';
      }, 2000);
    }
  };
  
  button.addEventListener('click', performManualSearch);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      performManualSearch();
    }
  });
}

function displayLyrics(result, isCached = false) {
  const content = document.getElementById('lyrics-content');
  
  // Store current result for re-rendering (minimize toggle)
  currentLyricsResult = { ...result, isCached };
  ylpLyricsState = result.synced ? 'found' : 'plain';
  if (!result.synced) { currentSyncedLines = []; ylpKaraokeRender(true); }
  
  const cleanArtist = titleCleaner.removeEmojis(result.artist || '未知歌手');
  const cleanSong = titleCleaner.removeEmojis(result.song || '未知歌曲')
    .replace(/\s*[\(\[]?\s*(cover|acoustic cover|piano cover|guitar cover|drum cover|vocal cover|remake|reimagined|version by|翻唱|歌ってみた|カバー|커버)\s*[\)\]]?\s*/gi, '')
    .trim();
  
  const cacheIndicator = isCached ? '<span style="color: #34C759; margin-left: 8px;">💾 快取</span>' : '';
  
  let metadata = `
    <div class="lyrics-metadata">
      <div class="lyrics-metadata-row">
        <span>🎤 ${ylpEscape(cleanArtist)}</span>
        <span class="lyrics-source-badge">${ylpEscape(result.source)}${cacheIndicator}</span>
      </div>
      <div class="lyrics-metadata-row">
        <span>🎵 ${ylpEscape(cleanSong)}</span>
        ${result.synced ? '<span style="color: #34C759;">⚡ 同步歌詞・點一句可跳轉</span>' : ''}
      </div>
    </div>
  `;
  
  let lyricsHTML = '';
  
  if (result.synced) {
    const lines = result.lyrics.split('\n');
    const parsedLines = [];
    
    lines.forEach(line => {
      const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
      if (match) {
        const minutes = parseInt(match[1]);
        const seconds = parseFloat(match[2]);
        const text = match[3].trim();
        const timeInSeconds = minutes * 60 + seconds;
        
        if (text) {
          parsedLines.push({
            time: timeInSeconds,
            text: text
          });
        }
      }
    });
    
    parsedLines.forEach((line, index) => {
      lyricsHTML += `<div class="synced-line upcoming" data-time="${line.time}" data-index="${index}"><span class="ylp-orig">${ylpEscape(line.text)}</span></div>`;
    });
    
    setTimeout(() => {
      const lineElements = document.querySelectorAll('.synced-line');
      lineElements.forEach(lineElement => {
        lineElement.addEventListener('click', function() {
          const time = parseFloat(this.getAttribute('data-time'));
          const video = document.querySelector('video');
          if (video && !isNaN(time)) {
            video.currentTime = time;
            userIsScrolling = false;
            clearTimeout(ylpResumeTimer);
            ylpLastScrolledIndex = -1;
            console.log('⏩ Seeked to:', time, 'seconds | Auto-scroll RE-ENABLED via lyric click');
          }
        });
      });
      
      startLyricsSync(parsedLines);
    }, 100);
    
  } else {
    lyricsHTML = result.lyrics
      .split('\n')
      .map(line => line.trim() ? `<div class="plain-line"><span class="ylp-orig">${ylpEscape(line)}</span></div>` : '<div><br></div>')
      .join('');
  }
  
  const compactSearchPrompt = `
    <div class="manual-search-box" style="margin: 16px 20px; padding: 12px;">
      <div class="manual-search-title" style="margin-bottom: 8px; font-size: 12px;">
        <span>🔍</span>
        <span>歌不對？手動輸入</span>
      </div>
      <input 
        type="text" 
        class="manual-search-input" 
        placeholder="歌手 - 歌名"
        id="manual-search-input-top-${Date.now()}"
        name="no-autofill-top-${Date.now()}"
        autocomplete="new-password"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        inputmode="search"
        data-form-type="other"
        data-lpignore="true"
        style="margin-bottom: 8px;"
      />
      <button class="manual-search-button" id="manual-search-btn-top-${Date.now()}" style="padding: 8px 16px; font-size: 13px;">搜尋其他歌曲</button>
    </div>
  `;
  
  content.innerHTML = metadata + compactSearchPrompt + `<div style="padding: 0 20px 20px 20px;">${lyricsHTML}</div>`;
  ylpLastScrolledIndex = -1;
  ylpApplyTranslations();
  
  if (window.analytics) {
    window.analytics.trackLyricsDisplayed(cleanArtist, cleanSong, result.source, result.synced);
  }
  
  // Setup manual search using selector-based approach (works with dynamic IDs)
  setupManualSearchBySelector('.manual-search-box', false);
}

let currentSyncedLines = [];
let syncInterval = null;
let currentLyricsResult = null;
let currentActiveLineIndex = -1;

function startLyricsSync(parsedLines) {
  currentSyncedLines = parsedLines;
  
  if (syncInterval) {
    clearInterval(syncInterval);
  }
  
  syncInterval = setInterval(updateLyricsHighlight, 100);
  
  console.log('✅ Lyrics sync started with', parsedLines.length, 'lines');
}

function renderMinimizedLyrics() {
  const content = document.getElementById('lyrics-content');
  if (!content || currentSyncedLines.length === 0) return;
  
  const activeIndex = currentActiveLineIndex;
  
  let previousLine = '';
  let currentLine = '';
  let nextLine = '';
  
  if (activeIndex > 0) {
    previousLine = currentSyncedLines[activeIndex - 1].text;
  }
  
  if (activeIndex >= 0 && activeIndex < currentSyncedLines.length) {
    currentLine = currentSyncedLines[activeIndex].text;
  }
  
  if (activeIndex >= 0 && activeIndex < currentSyncedLines.length - 1) {
    nextLine = currentSyncedLines[activeIndex + 1].text;
  }
  
  // Fallback if no active line yet
  if (!currentLine && currentSyncedLines.length > 0) {
    currentLine = currentSyncedLines[0].text;
    if (currentSyncedLines.length > 1) {
      nextLine = currentSyncedLines[1].text;
    }
  }
  
  const miniLyricsHTML = `
    <div class="lyrics-minimized-view">
      <div class="mini-line previous">${ylpEscape(previousLine) || '•••'}</div>
      <div class="mini-line current">${ylpEscape(currentLine) || '目前沒有歌詞'}</div>
      <div class="mini-line next">${ylpEscape(nextLine) || '•••'}</div>
    </div>
  `;
  
  content.innerHTML = miniLyricsHTML;
}

function updateLyricsHighlight() {
  const video = document.querySelector('video');
  if (!video || !currentSyncedLines.length) return;
  
  const currentTime = video.currentTime;
  
  let activeIndex = -1;
  for (let i = 0; i < currentSyncedLines.length; i++) {
    if (currentTime >= currentSyncedLines[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }
  
  currentActiveLineIndex = activeIndex;
  ylpKaraokeRender();
  
  // If minimized, render 3-line view instead of highlighting full list
  if (isMinimized) {
    renderMinimizedLyrics();
    return;
  }
  
  // Full lyrics mode
  const lineElements = document.querySelectorAll('.synced-line');
  lineElements.forEach((element, index) => {
    element.classList.remove('active', 'passed', 'upcoming');
    
    if (index === activeIndex) {
      element.classList.add('active');
    } else if (index < activeIndex) {
      element.classList.add('passed');
    } else {
      element.classList.add('upcoming');
    }
  });
  
  // Only auto-scroll if NOT minimized and auto-scroll enabled
  // 目前這一句改變時，把它捲到面板中間（只捲動歌詞面板，不會捲動整個 YouTube 頁面）
  if (!isMinimized && ylpSettings.autoScroll && !userIsScrolling && activeIndex >= 0 && lineElements[activeIndex]
      && activeIndex !== ylpLastScrolledIndex) {
    ylpLastScrolledIndex = activeIndex;
    ylpScrollToLine(lineElements[activeIndex]);
  }
}

function observeVideoChanges() {
  const videoIdMatch = window.location.search.match(/[?&]v=([^&]+)/);
  const newVideoId = videoIdMatch ? videoIdMatch[1] : null;
  
  if (newVideoId && newVideoId !== currentVideoId) {
    currentVideoId = newVideoId;
    console.log('🎬 New video detected:', currentVideoId);
    
    // 換歌前歌詞面板（或卡拉OK模式）是開著的，換歌後就自動幫新歌找歌詞，不必再按一次
    const keepLyricsOpen = !!lyricsPanel || ylpKaraokeActive;
    const previousTitle = ylpLastVideoTitle;
    let titleChecks = 0;
    ylpLyricsState = 'searching';
    
    if (lyricsPanel) {
      console.log('🗑️ Closing existing lyrics panel');
      lyricsPanel.remove();
      lyricsPanel = null;
    }
    
    // PROGRESS: Reset on video change
    resetProgress();
    
    // Reset minimized state and lyrics data
    isMinimized = false;
    currentSyncedLines = [];
    currentLyricsResult = null;
    currentActiveLineIndex = -1;
    
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
    ylpKaraokeRender(true);
    
    tooltipShown = false;
    isWatchPageReady = false;
    autoScrollEnabled = true;
    userIsScrolling = false;
    isRefreshRequest = false;
    
    console.log('🔄 State reset - autoScroll: enabled, userScrolling: false, minimized: false');
    
    decrementSuppressionOnVideoChange();
    
    const checkTitle = setInterval(() => {
      if (!checkWatchPageReady()) {
        console.log('⏸️ Watch page not ready, waiting...');
        return;
      }
      
      isWatchPageReady = true;
      
      const watchFlexy = document.querySelector('ytd-watch-flexy');
      if (!watchFlexy) {
        console.log('⏸️ No watch-flexy found');
        return;
      }
      
      const titleElement = watchFlexy.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      const channelElement = watchFlexy.querySelector('ytd-channel-name a');
      titleChecks++;
      
      // YouTube 換頁時標題會晚一點才更新；確認頁面已經是新影片，避免拿舊標題去搜尋
      const flexyVideoId = watchFlexy.getAttribute('video-id');
      if (flexyVideoId && flexyVideoId !== newVideoId) return;
      const currentTitle = titleElement ? titleElement.textContent.trim() : '';
      if (currentTitle && currentTitle === previousTitle && titleChecks < 6) return;
      
      if (titleElement && titleElement.textContent.trim()) {
        clearInterval(checkTitle);
        
        const title = titleElement.textContent.trim();
        ylpLastVideoTitle = title;
        const channelName = channelElement?.textContent.trim() || '';
        
        console.log('✅ Video title loaded:', title);
        console.log('📺 Channel:', channelName);
        console.log('⚙️ Settings - autoShowLyrics:', autoShowLyrics, 'smartAutoShow:', smartAutoShow);
        
        const isMusicVideo = isLikelyMusicVideo(title, channelName);
        console.log('🎵 Is music video?', isMusicVideo);
        
        let shouldAutoShow = false;
        let shouldShowTooltip = false;
        
        if (autoShowLyrics && smartAutoShow) {
          shouldAutoShow = true;
          console.log('✅ Will auto-show (auto ON + smart ON = always show)');
        }
        else if (autoShowLyrics && !smartAutoShow) {
          shouldAutoShow = true;
          console.log('✅ Will auto-show (auto ON + smart OFF = always show)');
        }
        else if (!autoShowLyrics && smartAutoShow) {
          if (isMusicVideo) {
            shouldAutoShow = true;
            console.log('✅ Will auto-show (auto OFF + smart ON + music video)');
          } else {
            shouldShowTooltip = true;
            console.log('🔔 Will show tooltip (auto OFF + smart ON + NOT music video)');
          }
        }
        else if (!autoShowLyrics && !smartAutoShow) {
          shouldShowTooltip = true;
          console.log('🔔 Will show tooltip (auto OFF + smart OFF = always tooltip)');
        }
        
        if (keepLyricsOpen) {
          shouldAutoShow = true;
          shouldShowTooltip = false;
        }
        
        if (shouldAutoShow) {
          setTimeout(() => {
            detectAndShowLyrics();
          }, 1000);
        } else if (shouldShowTooltip) {
          setTimeout(() => {
            showLyricsTooltip();
          }, 2000);
        }
      }
    }, 500);
    
    setTimeout(() => clearInterval(checkTitle), 10000);
  }
}

let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    observeVideoChanges();
  }
}).observe(document, { subtree: true, childList: true });

if (document.readyState === 'complete') {
  observeVideoChanges();
} else {
  window.addEventListener('load', () => {
    setTimeout(() => {
      observeVideoChanges();
    }, 1000);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('📨 Message received:', request.action);
  
  if (request.action === 'detectSong') {
    detectAndShowLyrics();
    sendResponse({ success: true });
  }
  
  if (request.action === 'updateAutoShow') {
    autoShowEnabled = request.enabled;
    console.log('🔄 Auto-show updated:', autoShowEnabled);
    sendResponse({ success: true });
    if (window.analytics) {
      window.analytics.trackAutoDisplayToggle(request.enabled);
    }
  }

  if (request.action === 'updateSmartAutoShow') {
    smartAutoShow = request.enabled;
    console.log('🎯 Smart auto-show updated:', smartAutoShow);
    sendResponse({ success: true });
  }
  
  if (request.action === 'updateDarkMode') {
    darkModeEnabled = request.enabled;
    console.log('🌙 Dark mode updated:', darkModeEnabled);
    if (window.analytics) {
      window.analytics.trackThemeToggle(request.enabled);
    } 
    if (lyricsPanel) {
      const wasMinimized = lyricsPanel.classList.contains('minimized');
      lyricsPanel.remove();
      lyricsPanel = null;
      detectAndShowLyrics();
      if (wasMinimized) {
        setTimeout(() => {
          lyricsPanel?.classList.add('minimized');
        }, 100);
      }
    }
    
    sendResponse({ success: true });
  }
  
  if (request.action === 'refreshExtension') {
    console.log('🔄 Refreshing extension...');
    
    if (lyricsPanel) {
      lyricsPanel.remove();
      lyricsPanel = null;
    }
    
    currentVideoId = null;
    
    chrome.storage.sync.get(['autoShowLyrics', 'smartAutoShow', 'darkMode'], (result) => {
      autoShowLyrics = result.autoShowLyrics === true;
      smartAutoShow = result.smartAutoShow !== false;
      darkModeEnabled = result.darkMode !== false;
      console.log('✅ Settings reloaded');
      observeVideoChanges();
    });
    
    sendResponse({ success: true });
  }
  
  return true;
});

console.log('✅ YTLyrics loaded successfully!');


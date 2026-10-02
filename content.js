// ============================================================================
// 自動捲動與翻譯（中文版新增）
// ============================================================================
const YLP_DEFAULTS = { autoScroll: true, pauseSeconds: 4, translate: true, targetLang: 'zh-TW', karaokeWipe: true, useYouTubeCaptions: true, miniTransparency: 0, tapKey: 'Enter', undoKey: 'Backspace', offsetStep: 0.2, ...YLP_THEME_DEFAULTS };
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

// ---------- 字幕時間微調（每部影片各自記住） ----------
// ylpOffset：秒。正數＝字幕提早出現（字幕太慢時用），負數＝字幕延後出現
var ylpOffset = 0;
var ylpOffsetVideo = null;
var ylpSyncDirty = true;   // 需要重畫歌詞高亮
const YLP_OFFSET_LIMIT = 30; // 最多調整 ±30 秒

function ylpOffsetKey(videoId) { return 'ylpOffset:' + videoId; }

// 播放位置＋微調後，用來比對歌詞時間
function ylpLyricTime(video) {
  return (video ? video.currentTime : 0) + ylpOffset;
}

// 每按一次＋／−調整的秒數（標題列的下拉選單）
const YLP_OFFSET_STEPS = [0.2, 0.5, 1, 2, 3, 5, 10];
function ylpOffsetStep() {
  const n = Number(ylpSettings.offsetStep);
  return YLP_OFFSET_STEPS.includes(n) ? n : 0.2;
}

// 按一下＋／−：照選的間距加減（例如間距 0.2：0 → 0.2 → 0.4 → 0.6 …），到 ±30 秒就停住
function ylpOffsetNudge(dir) {
  const cur = ylpOffset;
  const next = Math.max(-YLP_OFFSET_LIMIT, Math.min(YLP_OFFSET_LIMIT, Math.round((cur + dir * ylpOffsetStep()) * 10) / 10));
  if (Math.abs(next - cur) >= 0.001) ylpSetOffset(next);
}

function ylpOffsetText(v) {
  if (Math.abs(v) < 0.05) return '±0';
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1) + 's';
}

function ylpOffsetTitle(v) {
  if (Math.abs(v) < 0.05) return '字幕時間：沒有微調';
  return '字幕目前' + (v > 0 ? '提早 ' : '延後 ') + Math.abs(v).toFixed(1) + ' 秒出現。點一下歸零';
}

function ylpUpdateOffsetUI() {
  for (const el of document.querySelectorAll('.ylp-offset-val')) {
    el.textContent = ylpOffsetText(ylpOffset);
    el.title = ylpOffsetTitle(ylpOffset);
    el.classList.toggle('moved', Math.abs(ylpOffset) >= 0.05);
  }
  const step = String(ylpOffsetStep());
  for (const sel of document.querySelectorAll('.ylp-off-step')) if (sel.value !== step) sel.value = step;
}

async function ylpLoadOffset(videoId) {
  ylpOffsetVideo = videoId || null;
  let v = 0;
  if (videoId) {
    try {
      const r = await chrome.storage.local.get(ylpOffsetKey(videoId));
      const n = Number(r[ylpOffsetKey(videoId)]);
      if (Number.isFinite(n)) v = Math.max(-YLP_OFFSET_LIMIT, Math.min(YLP_OFFSET_LIMIT, n));
    } catch (e) { /* 讀不到就當 0 */ }
  }
  if (ylpOffsetVideo !== (videoId || null)) return; // 讀取期間已經換歌
  ylpOffset = v;
  ylpSyncDirty = true;
  ylpUpdateOffsetUI();
  try { ylpKaraokeRender(true); } catch (e) {}
}

function ylpSetOffset(v) {
  v = Math.round(Math.max(-YLP_OFFSET_LIMIT, Math.min(YLP_OFFSET_LIMIT, Number(v) || 0)) * 10) / 10;
  ylpOffset = v;
  ylpSyncDirty = true;
  ylpUpdateOffsetUI();
  try { ylpKaraokeRender(true); } catch (e) {}
  const id = ylpOffsetVideo;
  if (!id) return;
  try {
    if (v === 0) chrome.storage.local.remove(ylpOffsetKey(id));
    else chrome.storage.local.set({ [ylpOffsetKey(id)]: v });
  } catch (e) { /* 擴充功能重新載入後舊頁面會失效，忽略 */ }
}

// 微調控制（歌詞面板標題列與卡拉OK畫面共用）：− ［目前微調，點一下歸零］ ＋
function ylpOffsetControlsHTML() {
  return `<span class="ylp-offset-ctl">`
    + `<button type="button" class="ylp-off-btn" data-ylp-off="-" title="字幕延後（字幕太早出現時按）">−</button>`
    + `<button type="button" class="ylp-off-btn ylp-offset-val" data-ylp-off="reset" title="${ylpOffsetTitle(ylpOffset)}">${ylpOffsetText(ylpOffset)}</button>`
    + `<button type="button" class="ylp-off-btn" data-ylp-off="+" title="字幕提早（字幕跟不上時按）">+</button>`
    + `<select class="ylp-off-step" title="每按一次＋／−調整幾秒" aria-label="每次調整的秒數">`
    + YLP_OFFSET_STEPS.map((v) => `<option value="${v}"${v === ylpOffsetStep() ? ' selected' : ''}>${v}s</option>`).join('')
    + `</select>`
    + `</span>`;
}

function ylpInOffsetCtl(e) {
  const t = e.target && e.target.closest ? e.target.closest('.ylp-offset-ctl') : null;
  return t && t.closest('#lyrics-extension-panel, #ylp-karaoke-overlay') ? t : null;
}

document.addEventListener('click', (e) => {
  if (!ylpInOffsetCtl(e)) return;
  const b = e.target.closest('[data-ylp-off]');
  e.stopPropagation(); // 不讓點擊傳到 YouTube 播放器（否則會暫停／播放）
  if (!b) return;
  e.preventDefault();
  const d = b.getAttribute('data-ylp-off');
  if (d === 'reset') ylpSetOffset(0);
  else ylpOffsetNudge(d === '+' ? 1 : -1);
}, true);

// 下拉選單換間距：記住選擇，所有畫面（面板、卡拉OK）同步
document.addEventListener('change', (e) => {
  if (!ylpInOffsetCtl(e) || !e.target.classList.contains('ylp-off-step')) return;
  const v = Number(e.target.value);
  if (!YLP_OFFSET_STEPS.includes(v)) return;
  ylpSettings.offsetStep = v;
  ylpUpdateOffsetUI();
  try { chrome.storage.sync.set({ offsetStep: v }); } catch (err) { /* 忽略 */ }
}, true);

// 焦點在微調按鈕上時按鍵，不要觸發 YouTube 的快捷鍵
for (const type of ['keydown', 'keyup', 'keypress']) {
  document.addEventListener(type, (e) => { if (ylpInOffsetCtl(e)) e.stopPropagation(); }, true);
}

// ---------- 標題列的手動搜尋（歌不對時用） ----------
function ylpToggleHeaderSearch(show) {
  const bar = document.getElementById('ylp-search-bar');
  if (!bar) return;
  if (show === undefined) show = bar.hidden;
  if (show && isMinimized) document.getElementById('minimize-btn')?.click(); // 縮小時先展開面板
  bar.hidden = !show;
  document.getElementById('ylp-search-btn')?.classList.toggle('on', show);
  if (show) {
    const input = bar.querySelector('.ylp-search-input');
    if (input && !input.value) {
      // 預先填入目前的歌手／歌名，方便修改
      const r = currentLyricsResult;
      if (r && (r.artist || r.song)) input.value = [r.artist, r.song].filter(Boolean).join(' - ');
    }
    input?.focus();
    input?.select();
  }
}

async function ylpHeaderSearch(bar) {
  const input = bar.querySelector('.ylp-search-input');
  const go = bar.querySelector('.ylp-search-go');
  const q = input.value.trim();
  if (!q || go.disabled) return;
  go.disabled = true;
  go.textContent = '搜尋中…';
  ylpSearchGen++; // 停止還在進行的自動搜尋
  let artist = '', song = q;
  for (const sep of [' - ', ' – ', ' — ', ' | ']) {
    if (q.includes(sep)) {
      const parts = q.split(sep);
      artist = parts[0].trim();
      song = parts.slice(1).join(sep).trim();
      break;
    }
  }
  const parsed = { artistFromTitle: artist, artistFromChannel: '', coverArtist: '', song, originalTitle: song, isCover: false, language: 'en' };
  let result = null;
  try { result = await ylpSearchAll(parsed); } catch (e) { result = null; }
  if (!document.body.contains(bar)) return; // 搜尋期間面板被關掉或換歌
  go.disabled = false;
  if (result) {
    go.textContent = '搜尋';
    input.value = '';
    ylpToggleHeaderSearch(false);
    try {
      if (currentVideoId) await saveLyricsToCache(currentVideoId, result, parsed, getChannelName(), 0.8);
    } catch (e) { /* 快取失敗不影響顯示 */ }
    displayLyrics(result, false);
  } else {
    go.textContent = '找不到';
    setTimeout(() => { if (!go.disabled) go.textContent = '搜尋'; }, 2000);
  }
}

function ylpSetupHeaderSearch(panel) {
  const bar = panel.querySelector('#ylp-search-bar');
  const btn = panel.querySelector('#ylp-search-btn');
  if (!bar || !btn) return;
  const input = bar.querySelector('.ylp-search-input');
  btn.addEventListener('click', () => ylpToggleHeaderSearch());
  bar.querySelector('.ylp-search-go').addEventListener('click', () => ylpHeaderSearch(bar));
  // 在搜尋框打字時，不要觸發 YouTube 的快捷鍵
  for (const type of ['keydown', 'keyup', 'keypress']) input.addEventListener(type, (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ylpHeaderSearch(bar); }
    else if (e.key === 'Escape') { e.preventDefault(); ylpToggleHeaderSearch(false); }
  });
}

// 縮小時按鈕顯示「展開」圖示，展開時顯示「−」
function ylpUpdateMinimizeIcon() {
  const btn = document.getElementById('minimize-btn');
  const panel = document.getElementById('lyrics-extension-panel');
  if (!btn || !panel) return;
  const min = panel.classList.contains('minimized');
  const icon = btn.querySelector('.ylp-min-icon');
  if (icon) {
    icon.textContent = min ? '⤢' : '−';
    icon.style.fontSize = min ? '14px' : '16px';
  }
  btn.title = min ? '展開歌詞' : '縮小';
}

// ---------- 縮成一個小圓點 ----------
var ylpDotMode = false;
var ylpDotPos = null; // { left, top }

function ylpDotEl() {
  let dot = document.getElementById('ylp-dot');
  if (dot) return dot;
  dot = document.createElement('div');
  dot.id = 'ylp-dot';
  dot.title = '點一下展開歌詞（可以拖曳移動）';
  dot.setAttribute('role', 'button');
  dot.innerHTML = '<span class="ylp-dot-eq"><i></i><i></i><i></i></span>';
  let sx = 0, sy = 0, sl = 0, st = 0, moved = false, down = false;
  dot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    down = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    const r = dot.getBoundingClientRect();
    sl = r.left; st = r.top;
    try { dot.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  });
  dot.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 5) return; // 移動很少＝點一下
    moved = true;
    ylpPlaceDot(sl + dx, st + dy);
  });
  const up = () => {
    if (!down) return;
    down = false;
    if (!moved) ylpExitDot(true);
  };
  dot.addEventListener('pointerup', up);
  dot.addEventListener('pointercancel', () => { down = false; });
  dot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!lyricsPanel) ylpRemoveSuggestDot(); // 建議用的圓點：按右鍵關掉
    else ylpExitDot(true);                   // 面板縮成的圓點：按右鍵也是展開
  });
  dot.addEventListener('mouseenter', () => { ylpDotHover = true; ylpApplyDotTransparency(); });
  dot.addEventListener('mouseleave', () => { ylpDotHover = false; ylpApplyDotTransparency(); });
  document.body.appendChild(dot);
  ylpDotHover = false;
  ylpApplyDotTransparency();
  return dot;
}

// 小圓點透明度：跟隨縮小列，或用自己的設定；滑鼠移上去時恢復不透明
var ylpDotHover = false;
function ylpApplyDotTransparency() {
  const dot = document.getElementById('ylp-dot');
  if (!dot) return;
  const src = ylpSettings.dotFollowBar !== false ? ylpSettings.miniTransparency : ylpSettings.dotTransparency;
  const t = Math.min(90, Math.max(0, Number(src) || 0));
  if (!ylpDotHover && t > 0) dot.style.setProperty('opacity', String((100 - t) / 100), 'important');
  else dot.style.removeProperty('opacity');
}

function ylpPlaceDot(left, top) {
  const dot = document.getElementById('ylp-dot');
  if (!dot) return;
  const size = 44;
  left = Math.max(4, Math.min(window.innerWidth - size - 4, left));
  top = Math.max(4, Math.min(window.innerHeight - size - 4, top));
  dot.style.left = left + 'px';
  dot.style.top = top + 'px';
  ylpDotPos = { left, top };
}

function ylpEnterDot() {
  const panel = document.getElementById('lyrics-extension-panel');
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  ylpDotMode = true;
  panel.classList.add('ylp-dotted');
  ylpDotEl();
  // 圓點出現在面板右上角的位置
  if (ylpDotPos) ylpPlaceDot(ylpDotPos.left, ylpDotPos.top);
  else ylpPlaceDot(r.right - 44, r.top);
}

// 偵測到音樂影片時，只出現一顆小圓點（不打開面板），點一下才打開歌詞
function ylpShowSuggestDot() {
  if (lyricsPanel || ylpKaraokeActive) return;
  ylpDotMode = true;
  const dot = ylpDotEl();
  dot.classList.add('suggest');
  dot.title = '偵測到音樂：點一下打開歌詞（可以拖曳；按右鍵關掉）';
  if (ylpDotPos) ylpPlaceDot(ylpDotPos.left, ylpDotPos.top);
  else ylpPlaceDot(window.innerWidth - 20 - 44, 80);
}

// 只收起「建議用」的圓點（歌詞面板縮成圓點時不動）
function ylpRemoveSuggestDot() {
  if (lyricsPanel) return;
  const dot = document.getElementById('ylp-dot');
  if (dot) dot.remove();
  ylpDotMode = false;
}

// expand＝true：展開成一般的完整歌詞面板
function ylpExitDot(expand) {
  const dot = document.getElementById('ylp-dot');
  const wasDot = ylpDotMode;
  ylpDotMode = false;
  if (dot) dot.remove();
  if (!expand || !wasDot) return;
  const panel = document.getElementById('lyrics-extension-panel');
  if (!panel) {
    if (/[?&]v=/.test(location.search)) detectAndShowLyrics();
    return;
  }
  panel.classList.remove('ylp-dotted');
  if (isMinimized) document.getElementById('minimize-btn')?.click(); // 展開成完整歌詞
  // 面板的右上角對齊圓點，並確保整個面板在畫面內
  if (ylpDotPos) {
    const w = panel.offsetWidth || 400;
    const left = Math.max(0, Math.min(window.innerWidth - w, ylpDotPos.left + 44 - w));
    const top = Math.max(0, Math.min(window.innerHeight - 120, ylpDotPos.top));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
  }
  ylpSyncDirty = true;
  ylpLastScrolledIndex = -1;
}

// ---------- 調整面板大小（字跟著縮放） ----------
const YLP_PANEL_BASE_W = 400;

function ylpApplyPanelSize(panel, w, h) {
  if (!panel) return;
  if (!w) {
    panel.style.removeProperty('--ylp-w');
    panel.style.removeProperty('--ylp-h');
    panel.style.removeProperty('--ylp-fs');
    panel.classList.remove('ylp-sized');
    return;
  }
  panel.style.setProperty('--ylp-w', w + 'px');
  panel.style.setProperty('--ylp-fs', String(Math.round(Math.max(1, w / YLP_PANEL_BASE_W) * 100) / 100));
  if (h) {
    panel.style.setProperty('--ylp-h', h + 'px');
    panel.classList.add('ylp-sized');
  }
}

function ylpSetupResize(panel) {
  const grip = panel.querySelector('.ylp-resize');
  if (!grip) return;
  // 套用上次的大小
  chrome.storage.local.get('ylpPanelSize').then((r) => {
    const d = r && r.ylpPanelSize;
    if (d && d.w) ylpApplyPanelSize(panel, Math.min(d.w, window.innerWidth - 16), Math.min(d.h || 0, window.innerHeight - 16) || 0);
  }).catch(() => {});

  // 用 pointer capture：滑鼠拖到視窗外放開也能正確結束
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    const rect = panel.getBoundingClientRect();
    // 改成用左上角定位，往左下拉時右邊保持不動
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    const sx = e.clientX, sy = e.clientY, right = rect.right;
    let w = rect.width, h = rect.height;
    const move = (ev) => {
      w = Math.round(Math.max(YLP_PANEL_BASE_W, Math.min(right - 8, 1000, rect.width + (sx - ev.clientX))));
      h = Math.round(Math.max(160, Math.min(window.innerHeight - rect.top - 8, rect.height + (ev.clientY - sy))));
      panel.style.left = (right - w) + 'px';
      ylpApplyPanelSize(panel, w, h);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      ylpApplyMiniTransparency(); // 恢復原本的動畫設定
      ylpLastScrolledIndex = -1; // 大小改變後重新對準目前這一句
      try { chrome.storage.local.set({ ylpPanelSize: { w, h } }); } catch (err) { /* 忽略 */ }
    };
    panel.style.setProperty('transition', 'none', 'important'); // 拖曳時不要有動畫，才不會延遲
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    ylpApplyPanelSize(panel, 0);
    panel.style.left = Math.max(0, rect.right - YLP_PANEL_BASE_W) + 'px';
    ylpLastScrolledIndex = -1;
    try { chrome.storage.local.remove('ylpPanelSize'); } catch (err) { /* 忽略 */ }
  });
}

// ---------- 影片上的字幕（類似 CC） ----------
var ylpCcShownKey = '';
var ylpCcObserver = null;
var ylpCcObservedPlayer = null;
const YLP_CC_SIZES = { s: 0.036, m: 0.046, l: 0.06 };

function ylpUpdateCcButton() {
  const b = document.getElementById('ylp-cc-btn');
  if (b) b.classList.toggle('on', !!ylpSettings.ccSubs);
}

// 字的大小跟著播放器高度變（視窗縮放、劇院模式、全螢幕都會自動調整）
function ylpCcFit(player, el) {
  const k = YLP_CC_SIZES[ylpSettings.ccSize] || YLP_CC_SIZES.m;
  el.style.setProperty('--ylp-cc-fs', Math.max(12, Math.round(player.clientHeight * k)) + 'px');
}

function ylpCcRender(force = false) {
  const player = document.getElementById('movie_player');
  let el = document.getElementById('ylp-cc');
  const lines = ylpSyncedLines();
  const idx = ylpActiveIndex();
  let cur = idx >= 0 ? lines[idx] : null;
  // 這句有結束時間、而且已經唱完：影片字幕先收起來，等下一句
  if (cur && Number.isFinite(cur.end)) {
    const v = document.querySelector('video');
    if (v && ylpLyricTime(v) > cur.end + 0.3) cur = null;
  }
  const show = !!(ylpSettings.ccSubs && player && lyricsPanel && !ylpKaraokeActive && cur);
  if (!show) {
    if (el) el.hidden = true;
    ylpCcShownKey = '';
    return;
  }
  if (!el || el.parentElement !== player) {
    el = el || document.createElement('div');
    el.id = 'ylp-cc';
    player.appendChild(el);
  }
  if (ylpCcObservedPlayer !== player) {
    if (ylpCcObserver) ylpCcObserver.disconnect();
    ylpCcObserver = new ResizeObserver(() => {
      const c = document.getElementById('ylp-cc');
      if (c) ylpCcFit(player, c);
    });
    ylpCcObserver.observe(player);
    ylpCcObservedPlayer = player;
  }
  const lang = ylpSettings.targetLang;
  const tr = ylpSettings.translate ? (ylpCache.get(lang + '|' + cur.text.replace(/\s+/g, ' ').trim()) || '') : '';
  const key = [idx, cur.text, tr, ylpSettings.ccSize].join('|');
  el.hidden = false;
  if (!force && key === ylpCcShownKey) return;
  ylpCcShownKey = key;
  ylpCcFit(player, el);
  el.textContent = '';
  const row = (cls, text) => {
    const r = document.createElement('div');
    r.className = 'ylp-cc-row';
    const sp = document.createElement('span');
    sp.className = cls;
    sp.textContent = text;
    r.appendChild(sp);
    el.appendChild(r);
  };
  row('ylp-cc-line', cur.text);
  if (tr) row('ylp-cc-tr', tr);
}

// ---------- 主題顏色與背景透明度 ----------
function ylpApplyTheme() {
  let st = document.getElementById('ylp-theme-style');
  if (!st) {
    st = document.createElement('style');
    st.id = 'ylp-theme-style';
    (document.head || document.documentElement).appendChild(st);
  }
  const th = ylpResolveTheme(ylpSettings);
  const t = Math.min(90, Math.max(0, Number(ylpSettings.panelTransparency) || 0));
  const alpha = (100 - t) / 100 * 0.96;
  const light = ylpThemeIsLight(th);
  const T = th.text, A = th.accent;
  const onAccent = ylpLuminance(A) > 0.45 ? '#111111' : '#ffffff';
  const P = '#lyrics-extension-panel';
  // 卡拉OK填色用強調色；太暗的顏色在影片上看不清楚，改用預設的亮藍色
  const kt = ylpResolveKaraokeTheme(ylpSettings, A);
  st.textContent = `
    :root { --ylp-k-accent: ${kt.fill}; --ylp-k-text: ${kt.text}; --ylp-k-tr: ${kt.tr}; --ylp-k-next: ${ylpRgba(kt.text, 0.6)}; }
    ${P} {
      background: ${ylpThemeBackground(th, alpha)} !important;
      border-color: ${ylpRgba(T, 0.14)} !important;
      color: ${T} !important;
      ${t > 0 ? 'backdrop-filter: blur(' + Math.round(20 * (1 - t / 100)) + 'px) saturate(160%) !important;' : ''}
    }
    ${P} .lyrics-header {
      background: ${light ? 'rgba(255,255,255,' + (0.35 * alpha).toFixed(3) + ')' : 'rgba(0,0,0,' + (0.18 * alpha).toFixed(3) + ')'} !important;
      border-bottom-color: ${ylpRgba(T, 0.12)} !important;
    }
    ${P} .lyrics-title, ${P} .lyrics-content, ${P} .manual-search-title,
    ${P} .lyrics-minimized-view .mini-line.current, ${P} .synced-line, ${P} .plain-line { color: ${T} !important; }
    ${t >= 30 ? `${P} .lyrics-content, ${P} .lyrics-title { text-shadow: 0 1px 3px ${light ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)'}; }` : ''}
    ${P} .lyrics-btn { color: ${T} !important; background: ${ylpRgba(T, 0.12)} !important; }
    ${P} .lyrics-btn:hover { background: ${ylpRgba(T, 0.22)} !important; }
    ${P} .lyrics-metadata { background: ${ylpRgba(T, 0.06)} !important; color: ${ylpRgba(T, 0.65)} !important; }
    ${P} .manual-search-hint, ${P} .progress-label, ${P} .progress-percentage, ${P} .lyrics-loading,
    ${P} .lyrics-minimized-view .mini-line.previous, ${P} .lyrics-minimized-view .mini-line.next { color: ${ylpRgba(T, 0.6)} !important; }
    ${P} .lyrics-source-badge { background: ${ylpRgba(A, 0.2)} !important; color: ${A} !important; }
    ${P} .synced-line.active { color: ${A} !important; }
    ${P} .synced-line:hover { background: ${ylpRgba(T, 0.07)} !important; }
    ${P} .manual-search-box { background: ${ylpRgba(A, 0.1)} !important; }
    ${P} .manual-search-input, ${P} .ylp-ed-text {
      background: ${ylpRgba(light ? '#ffffff' : '#000000', light ? 0.7 : 0.25)} !important;
      color: ${T} !important; border-color: ${ylpRgba(T, 0.2)} !important;
    }
    ${P} .manual-search-button { background: ${A} !important; color: ${onAccent} !important; }
    ${P} .manual-search-button:hover { filter: brightness(1.08); }
    ${P} .ylp-tap-line.next { background: ${ylpRgba(A, 0.22)} !important; }
    ${P} .progress-box-filled { background: ${A} !important; border-color: ${A} !important; }
    ${P} .lyrics-content::-webkit-scrollbar-thumb { background: ${ylpRgba(T, 0.25)} !important; }
    ${P} .lyrics-content::-webkit-scrollbar-track { background: ${ylpRgba(T, 0.05)} !important; }
    ${P} .lyrics-header { padding-left: 10px !important; padding-right: 10px !important; gap: 5px; }
    ${P} .lyrics-controls { gap: 3px !important; }
    ${P} .lyrics-controls .lyrics-btn { width: 25px !important; height: 26px !important; }
    ${P} { width: var(--ylp-w, 400px) !important; }
    ${P}.ylp-sized:not(.minimized) { height: var(--ylp-h) !important; max-height: calc(100vh - 16px) !important; }
    ${P} .lyrics-content { font-size: calc(14px * var(--ylp-fs, 1)) !important; }
    ${P} .synced-line.active { font-size: calc(15px * var(--ylp-fs, 1)) !important; }
    ${P} .lyrics-metadata { font-size: calc(12px * var(--ylp-fs, 1)) !important; }
    ${P} .ylp-resize {
      position: absolute; left: 0; bottom: 0; width: 18px; height: 18px; cursor: nesw-resize; z-index: 5;
      background: linear-gradient(45deg, transparent 0 45%, ${ylpRgba(T, 0.35)} 45% 52%, transparent 52% 64%, ${ylpRgba(T, 0.35)} 64% 71%, transparent 71%);
      transform: scaleX(-1); border-bottom-right-radius: 16px; opacity: 0.6;
    }
    ${P} .ylp-resize:hover { opacity: 1; }
    ${P}.minimized .ylp-resize { display: none; }
    ${P} #ylp-cc-btn { font-size: 10px; font-weight: 800; letter-spacing: -0.3px; }
    ${P} #ylp-cc-btn.on { background: ${ylpRgba(A, 0.3)} !important; color: ${A} !important; }
    #ylp-cc {
      position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); z-index: 40;
      width: max-content; max-width: 88%; text-align: center; pointer-events: none;
      font-family: 'Microsoft JhengHei', 'Noto Sans TC', 'Malgun Gothic', 'Yu Gothic', system-ui, sans-serif;
      font-size: var(--ylp-cc-fs, 22px); line-height: 1.35; transition: bottom 0.2s;
    }
    #movie_player:not(.ytp-autohide) #ylp-cc { bottom: calc(7% + 52px); }
    #ylp-cc[hidden] { display: none; }
    #ylp-cc .ylp-cc-line, #ylp-cc .ylp-cc-tr {
      display: inline; padding: 0.08em 0.4em; border-radius: 0.18em; background: rgba(8, 8, 8, 0.7);
      -webkit-box-decoration-break: clone; box-decoration-break: clone;
    }
    #ylp-cc .ylp-cc-line { color: var(--ylp-k-text, #fff); font-weight: 600; }
    #ylp-cc .ylp-cc-tr { color: var(--ylp-k-tr, #ffe58a); font-size: 0.78em; }
    #ylp-cc .ylp-cc-row + .ylp-cc-row { margin-top: 0.2em; }
    ${P} .ylp-other-video { margin-top: 6px; padding: 6px 8px; border-radius: 6px; font-size: 11px; line-height: 1.5; background: rgba(255, 159, 10, 0.15); color: ${light ? '#8a4b00' : '#ffcc80'}; }
    ${P} .ylp-confirm label { display: block; margin: 8px 0 4px; font-size: 12px; opacity: 0.8; }
    ${P} .ylp-confirm .ylp-confirm-video { margin-top: 8px; font-size: 12px; opacity: 0.7; word-break: break-all; }
    ${P}.ylp-dotted { display: none !important; }
    #ylp-dot {
      position: fixed; z-index: 999999; width: 44px; height: 44px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; cursor: pointer; touch-action: none; user-select: none;
      background: radial-gradient(circle at 30% 30%, ${ylpRgba(A, 1)}, ${ylpRgba(A, 0.75)});
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35), 0 0 0 3px ${ylpRgba(A, 0.25)};
      transition: transform 0.15s, box-shadow 0.15s, opacity 0.2s;
    }
    #ylp-dot:hover { transform: scale(1.1); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4), 0 0 0 5px ${ylpRgba(A, 0.3)}; }
    #ylp-dot .ylp-dot-eq { display: flex; align-items: flex-end; gap: 2px; height: 16px; }
    #ylp-dot .ylp-dot-eq i { width: 3px; height: 40%; border-radius: 2px; background: ${onAccent}; animation: ylp-eq 1.1s ease-in-out infinite; }
    #ylp-dot .ylp-dot-eq i:nth-child(2) { animation-delay: -0.6s; }
    #ylp-dot .ylp-dot-eq i:nth-child(3) { animation-delay: -0.3s; }
    #ylp-dot.paused .ylp-dot-eq i { animation-play-state: paused; }
    ${P} .ylp-loading-head { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 4px 0 18px; }
    ${P} .ylp-eq { display: flex; align-items: flex-end; gap: 3px; height: 22px; }
    ${P} .ylp-eq span { width: 4px; height: 30%; border-radius: 2px; background: ${A}; animation: ylp-eq 1s ease-in-out infinite; }
    ${P} .ylp-eq span:nth-child(2) { animation-delay: -0.8s; }
    ${P} .ylp-eq span:nth-child(3) { animation-delay: -0.55s; }
    ${P} .ylp-eq span:nth-child(4) { animation-delay: -0.3s; }
    ${P} .ylp-eq span:nth-child(5) { animation-delay: -0.1s; }
    ${P} .ylp-loading-title { font-size: 14px; font-weight: 600; color: ${T} !important; }
    ${P} .ylp-dots i { font-style: normal; animation: ylp-dot 1.2s infinite; opacity: 0.2; }
    ${P} .ylp-dots i:nth-child(2) { animation-delay: 0.2s; }
    ${P} .ylp-dots i:nth-child(3) { animation-delay: 0.4s; }
    ${P} .progress-box { transition: background 0.3s, border-color 0.3s, box-shadow 0.3s !important; }
    ${P} .progress-box-current { animation: ylp-box-pulse 1s ease-in-out infinite; border-color: ${ylpRgba(A, 0.6)} !important; }
    ${P} .progress-box-filled { box-shadow: 0 0 6px ${ylpRgba(A, 0.5)} !important; }
    @keyframes ylp-eq { 0%, 100% { height: 25%; } 50% { height: 100%; } }
    @keyframes ylp-dot { 0%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
    @keyframes ylp-box-pulse { 0%, 100% { background: ${ylpRgba(A, 0.12)}; } 50% { background: ${ylpRgba(A, 0.55)}; } }
    @media (prefers-reduced-motion: reduce) {
      ${P} .ylp-eq span, ${P} .ylp-dots i, ${P} .progress-box-current, #ylp-dot .ylp-dot-eq i { animation: none; }
    }
    ${P} .ylp-toast {
      position: absolute; left: 12px; right: 12px; bottom: 14px; z-index: 6; padding: 8px 12px; border-radius: 10px;
      font-size: 12px; line-height: 1.5; text-align: center; color: ${onAccent} !important; background: ${ylpRgba(A, 0.92)};
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); transition: opacity 0.4s; pointer-events: none;
    }
    ${P} .ylp-toast.hide { opacity: 0; }
    ${P} .ylp-nf-actions { display: flex; gap: 8px; }
    ${P} .ylp-nf-actions .manual-search-button { flex: 1; width: auto !important; margin: 0 !important; white-space: nowrap; font-size: 13px !important; padding: 10px 6px !important; }
    ${P} .ylp-auto-retry-btn { background: ${ylpRgba(T, 0.14)} !important; color: ${T} !important; }
    ${P} .ylp-auto-retry-btn:hover { background: ${ylpRgba(T, 0.24)} !important; filter: none !important; }
    ${P} .ylp-field-label { display: block; font-size: 12px; margin: 0 0 6px; color: ${ylpRgba(T, 0.75)} !important; }
    ${P} .ylp-search-bar { display: flex; gap: 6px; padding: 8px 12px; flex-shrink: 0; border-bottom: 1px solid ${ylpRgba(T, 0.12)}; }
    ${P} .ylp-search-bar[hidden] { display: none; }
    ${P} .ylp-hs-label { align-self: center; flex-shrink: 0; font-size: 12px; white-space: nowrap; color: ${ylpRgba(T, 0.75)} !important; }
    ${P} .ylp-search-input {
      flex: 1; min-width: 0; height: 30px; padding: 0 10px; border-radius: 8px; font: inherit; font-size: 13px; outline: none;
      background: ${ylpRgba(light ? '#ffffff' : '#000000', light ? 0.7 : 0.25)} !important;
      color: ${T} !important; border: 1px solid ${ylpRgba(T, 0.2)} !important;
    }
    ${P} .ylp-search-input:focus { border-color: ${A} !important; }
    ${P} .ylp-search-go {
      height: 30px; padding: 0 12px; border: 0; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
      background: ${A} !important; color: ${onAccent} !important;
    }
    ${P} .ylp-search-go:disabled { opacity: 0.6; cursor: default; }
    ${P} #ylp-search-btn.on { background: ${ylpRgba(A, 0.3)} !important; }
    ${P} .ylp-offset-ctl { display: flex; align-items: center; gap: 2px; cursor: default; }
    ${P} .ylp-off-btn {
      height: 26px; min-width: 24px; border: 0; border-radius: 6px; padding: 0 5px; cursor: pointer;
      font: inherit; font-size: 14px; font-weight: 700; line-height: 26px;
      color: ${T} !important; background: ${ylpRgba(T, 0.12)} !important;
    }
    ${P} .ylp-off-btn:hover { background: ${ylpRgba(T, 0.24)} !important; }
    ${P} .ylp-off-step {
      height: 26px; max-width: 54px; padding: 0 1px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 11px;
      color: ${T} !important; background: ${ylpRgba(T, 0.12)} !important; border: 1px solid ${ylpRgba(T, 0.15)} !important;
    }
    ${P} .ylp-off-step option { color: #111; background: #fff; }
    ${P} .ylp-offset-val { min-width: 42px; font-size: 11px !important; font-variant-numeric: tabular-nums; }
    ${P} .ylp-offset-val.moved { color: ${A} !important; background: ${ylpRgba(A, 0.18)} !important; }
  `;
}

// 縮小後的歌詞列透明度（0%～90%）
// 直接寫在面板元素上（優先權最高，不會被其他樣式蓋掉）；滑鼠停在面板上時暫時恢復不透明，方便按按鈕
var ylpPanelHover = false;
function ylpApplyMiniTransparency() {
  const panel = document.getElementById('lyrics-extension-panel');
  if (!panel) return;
  if (!panel.dataset.ylpHoverBound) {
    panel.dataset.ylpHoverBound = '1';
    panel.addEventListener('mouseenter', () => { ylpPanelHover = true; ylpApplyMiniTransparency(); });
    panel.addEventListener('mouseleave', () => { ylpPanelHover = false; ylpApplyMiniTransparency(); });
  }
  const t = Math.min(90, Math.max(0, Number(ylpSettings.miniTransparency) || 0));
  const minimized = panel.classList.contains('minimized');
  panel.style.setProperty('transition', 'opacity 0.2s, height 0.3s cubic-bezier(0.4, 0, 0.2, 1)', 'important');
  if (minimized && !ylpPanelHover && t > 0) {
    panel.style.setProperty('opacity', String((100 - t) / 100), 'important');
  } else {
    panel.style.removeProperty('opacity');
  }
}

// 設定視窗拖動滑桿時即時預覽（不寫入設定，避免超過 Chrome 的寫入次數限制）
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'ylpPreview' && request.values && typeof request.values === 'object') {
    // 只接受已知的設定項目
    for (const k of Object.keys(request.values)) if (k in YLP_DEFAULTS) ylpSettings[k] = request.values[k];
    ylpApplyTheme();
    ylpApplyMiniTransparency();
    ylpApplyDotTransparency();
    sendResponse({ ok: true });
  }
});

chrome.storage.sync.get(YLP_DEFAULTS, (s) => {
  ylpSettings = { ...YLP_DEFAULTS, ...s };
  ylpApplyTheme();
  ylpUpdateOffsetUI();
  ylpApplyMiniTransparency();
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
  if ('karaokeWipe' in changes) ylpKaraokeRender(true);
  if ('offsetStep' in changes) ylpUpdateOffsetUI();
  if ('ccSubs' in changes || 'ccSize' in changes || 'translate' in changes || 'targetLang' in changes) { ylpUpdateCcButton(); ylpCcRender(true); }
  if ('miniTransparency' in changes) ylpApplyMiniTransparency();
  if ('miniTransparency' in changes || 'dotFollowBar' in changes || 'dotTransparency' in changes) ylpApplyDotTransparency();
  ylpApplyTheme();
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
var ylpKeepMinimized = false;  // 換歌時是否維持縮小
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
    color: var(--ylp-k-text, #fff);
    filter: drop-shadow(0 0 2px #000) drop-shadow(0 3px 6px rgba(0, 0, 0, 0.85));
  }
  #ylp-karaoke-overlay .ylp-k-line.wipe {
    color: transparent;
    background-image: linear-gradient(90deg, var(--ylp-k-accent, #5ec8ff) 0 50%, var(--ylp-k-text, #ffffff) 50% 100%);
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
    color: var(--ylp-k-tr, #ffe58a);
    filter: drop-shadow(0 0 2px #000) drop-shadow(0 2px 4px rgba(0, 0, 0, 0.85));
  }
  #ylp-karaoke-overlay .ylp-k-next {
    margin-top: 0.9em;
    font-size: clamp(16px, 2vw, 34px);
    font-weight: 600;
    color: var(--ylp-k-next, rgba(255, 255, 255, 0.6));
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
  #ylp-karaoke-overlay .ylp-k-offset {
    position: absolute;
    top: 24px;
    left: 24px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 14px;
    pointer-events: auto;
    transition: opacity 0.3s;
  }
  #ylp-karaoke-overlay .ylp-offset-ctl { display: flex; align-items: center; gap: 6px; }
  #ylp-karaoke-overlay .ylp-off-btn {
    min-width: 34px;
    border: 0;
    border-radius: 999px;
    padding: 5px 10px;
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    font: inherit;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
  }
  #ylp-karaoke-overlay .ylp-off-btn:hover { background: rgba(255, 255, 255, 0.3); }
  #ylp-karaoke-overlay .ylp-off-step {
    border: 0;
    border-radius: 999px;
    padding: 5px 8px;
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }
  #ylp-karaoke-overlay .ylp-off-step option { color: #111; background: #fff; }
  #ylp-karaoke-overlay .ylp-offset-val { min-width: 64px; font-size: 14px; font-variant-numeric: tabular-nums; }
  #ylp-karaoke-overlay .ylp-offset-val.moved { color: var(--ylp-k-accent, #5ec8ff); }
  html.ylp-idle #ylp-karaoke-overlay .ylp-k-offset { opacity: 0; pointer-events: none; }
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
    const off = document.createElement('div');
    off.className = 'ylp-k-offset';
    off.innerHTML = '<span class="ylp-k-offset-label">⏱ 字幕時間</span>' + ylpOffsetControlsHTML();
    // 不讓點擊傳到 YouTube 播放器（否則會暫停／播放）
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
      off.addEventListener(t, (e) => e.stopPropagation());
    }
    overlay.append(exit, off, subs);
    ylpUpdateOffsetUI();
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
  // 進入卡拉OK模式時，把歌詞面板縮到最小
  if (lyricsPanel && !isMinimized) document.getElementById('minimize-btn')?.click();
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
  const stateKey = [ylpLyricsState, lines.length, idx, trKey, ylpSettings.karaokeWipe].join('|');

  // 播放／暫停時同步字幕填色動畫
  const wipe = subs.querySelector('.ylp-k-line.wipe');
  if (wipe && video) {
    wipe.style.animationPlayState = video.paused ? 'paused' : 'running';
    // 填色動畫是獨立計時的；影片緩衝、改變播放速度時會慢慢偏掉，這裡對回影片時間
    const cur0 = lines[idx];
    const anim = wipe.getAnimations ? wipe.getAnimations()[0] : null;
    if (anim && cur0) {
      if (anim.playbackRate !== video.playbackRate) anim.playbackRate = video.playbackRate || 1;
      const want = Math.max(0, ylpLyricTime(video) - cur0.time) * 1000;
      if (Math.abs((Number(anim.currentTime) || 0) - want) > 150) anim.currentTime = want;
    }
  }

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
    if ((next || Number.isFinite(cur.end)) && video && ylpSettings.karaokeWipe) {
      // 從左到右填色，時間 = 這一句到下一句的間隔
      // 有打點結束時間就用它；沒有的話用到下一句開始為止（最多 15 秒）
      const dur = Number.isFinite(cur.end) && cur.end > cur.time
        ? Math.max(0.3, cur.end - cur.time)
        : Math.max(0.3, Math.min(next.time - cur.time, 15));
      const elapsed = Math.max(0, ylpLyricTime(video) - cur.time);
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

// ============================================================================
// 更多歌詞來源：本機歌詞、YouTube 影片字幕（中文版新增）
// ============================================================================
var ylpCaptured = new Map();   // `${影片ID}|${語言}` -> 播放器下載的字幕內容
var ylpReqSeq = 0;
var ylpPending = new Map();

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== 'ylp-page') return;
  const d = e.data;
  if (d.type === 'timedtext') {
    if (typeof d.text === 'string' && d.text.length > 20) {
      ylpCaptured.set(d.videoId + '|' + d.lang, d.text);
      // 只保留最近 10 份字幕，避免長時間聽歌時記憶體一直增加
      while (ylpCaptured.size > 10) ylpCaptured.delete(ylpCaptured.keys().next().value);
    }
    return;
  }
  const wait = ylpPending.get(d.id);
  if (wait) { ylpPending.delete(d.id); wait(d); }
});

function ylpPageRequest(type, extra = {}, timeout = 2000) {
  return new Promise((resolve) => {
    const id = 'r' + (++ylpReqSeq);
    const timer = setTimeout(() => { ylpPending.delete(id); resolve(null); }, timeout);
    ylpPending.set(id, (d) => { clearTimeout(timer); resolve(d); });
    window.postMessage({ source: 'ylp-content', type, id, ...extra }, location.origin);
  });
}

// 字幕（json3 或 XML 格式）→ [{ time, text }]
function ylpParseTimedText(text) {
  const out = [];
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').replace(/^[♪♫\s]+|[♪♫\s]+$/g, '').trim();
  const t = String(text || '').trim();
  if (t.startsWith('{')) {
    const data = JSON.parse(t);
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const line = clean(ev.segs.map((s) => s.utf8 || '').join(''));
      if (line) out.push({ time: (ev.tStartMs || 0) / 1000, text: line, end: ev.dDurationMs ? ((ev.tStartMs || 0) + ev.dDurationMs) / 1000 : undefined });
    }
  } else if (t.startsWith('<')) {
    const doc = new DOMParser().parseFromString(t, 'text/xml');
    for (const p of doc.querySelectorAll('p, text')) {
      const start = p.hasAttribute('t') ? Number(p.getAttribute('t')) / 1000 : Number(p.getAttribute('start'));
      const dur = p.hasAttribute('d') ? Number(p.getAttribute('d')) / 1000 : Number(p.getAttribute('dur'));
      const line = clean(p.textContent);
      if (line && Number.isFinite(start)) out.push({ time: start, text: line, end: Number.isFinite(dur) && dur > 0 ? start + dur : undefined });
    }
  }
  // 去掉只有「[音樂]」「[Music]」之類的行
  return out.filter((l) => !/^[\[(（【].{0,12}[\])）】]$/.test(l.text)).sort((a, b) => a.time - b.time);
}

function ylpFormatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

// 句子有結束時間（end）時，在後面加一行只有時間、沒有文字的「結束標記」（一般 LRC 播放器也看得懂）
function ylpLinesToLrc(lines) {
  const out = [];
  lines.forEach((l, i) => {
    out.push(`[${ylpFormatTime(Math.max(0, l.time))}]${l.text}`);
    const next = lines[i + 1];
    if (Number.isFinite(l.end) && l.end > l.time && (!next || next.time - l.end > 0.05)) {
      out.push(`[${ylpFormatTime(Math.max(0, l.end))}]`);
    }
  });
  return out.join('\n');
}

// 各種 LRC 寫法統一成 [mm:ss.xx]歌詞；一行多個時間標記會拆開
function ylpNormalizeLrc(lrc) {
  const lines = [];
  // [offset:+500]：LRC 標準的整體時間調整（毫秒，正數＝歌詞提早）
  const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/im.exec(String(lrc || ''));
  const shift = off ? Number(off[1]) / 1000 : 0;
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) {
      const time = parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')) - shift;
      if (Number.isFinite(time)) lines.push({ time: Math.max(0, time), text });
    }
  }
  return ylpApplyEndMarks(lines);
}

// 只有時間沒有文字的行＝上一句的結束時間
function ylpApplyEndMarks(lines) {
  lines.sort((a, b) => a.time - b.time || (a.text ? 1 : -1));
  const out = [];
  for (const l of lines) {
    if (l.text) { out.push({ time: l.time, text: l.text }); continue; }
    const prev = out[out.length - 1];
    if (prev && prev.end === undefined && l.time > prev.time) prev.end = l.time;
  }
  return out;
}

function ylpPickTrack(tracks) {
  const manual = tracks.filter((t) => t.kind !== 'asr' && !String(t.vssId).startsWith('a.'));
  if (!manual.length) return null; // 自動產生的字幕對歌曲很不準，不採用
  const prefer = ['zh-TW', 'zh-Hant', 'zh-HK', 'zh', 'zh-Hans', 'zh-CN', 'ja', 'ko', 'en'];
  for (const code of prefer) {
    const hit = manual.find((t) => t.languageCode === code);
    if (hit) return hit;
  }
  return manual[0];
}

// 從目前影片的 CC 字幕取得同步歌詞
async function ylpFetchYouTubeCaptions(videoId) {
  const info = await ylpPageRequest('getTracks');
  if (!info || info.videoId !== videoId) throw new Error('讀不到影片字幕資訊');
  const track = ylpPickTrack(info.tracks || []);
  if (!track) throw new Error('這部影片沒有字幕');

  let text = ylpCaptured.get(videoId + '|' + track.languageCode) || '';

  // 先直接下載
  if (!text && track.baseUrl && track.baseUrl.startsWith('https://www.youtube.com/')) {
    try {
      const r = await fetch(track.baseUrl + '&fmt=json3', { credentials: 'include' });
      if (r.ok) text = await r.text();
    } catch (e) { /* 改用下一個方法 */ }
  }

  // 下載不到（YouTube 有時會擋），就請播放器自己載入字幕，再讀取它下載的內容
  if (!text || text.length < 20) {
    await ylpPageRequest('enableTrack', { languageCode: track.languageCode });
    const key = videoId + '|' + track.languageCode;
    for (let i = 0; i < 25 && !ylpCaptured.has(key); i++) await new Promise((r) => setTimeout(r, 200));
    text = ylpCaptured.get(key) || '';
    if (!info.captionsOn) await ylpPageRequest('disableCaptions'); // 原本沒開字幕就關回去
  }

  const lines = ylpParseTimedText(text);
  if (lines.length < 4) throw new Error('字幕內容太少，不像是歌詞');
  const r = currentLyricsResult || {};
  return {
    lyrics: ylpLinesToLrc(lines),
    synced: true,
    source: 'YouTube 字幕' + (track.name ? `（${track.name}）` : ''),
    artist: r.artist || '',
    song: r.song || '',
  };
}

// 搜尋順序：LRCLIB／Lyrics.ovh 的同步歌詞 → YouTube 字幕 → 純文字歌詞
async function ylpSearchAll(parsedData) {
  // 手動搜尋時也先找自己歌詞庫裡的同一首歌
  const mine = await ylpFindLocalBySong(ylpSongCandidates(parsedData).slice(0, 1));
  if (mine) return mine;
  let plain = null;
  try {
    const r = await searchAllSources(parsedData);
    if (r && r.synced) return r;
    plain = r;
  } catch (e) { /* 繼續試其他來源 */ }

  if (ylpSettings.useYouTubeCaptions !== false && currentVideoId) {
    try {
      fillNextBox('YouTube 字幕');
      const r = await ylpFetchYouTubeCaptions(currentVideoId);
      if (!r.artist) r.artist = parsedData.artistFromTitle || parsedData.artistFromChannel || '';
      if (!r.song) r.song = parsedData.song || '';
      return r;
    } catch (e) {
      console.log('YouTube 字幕：', e.message);
    }
  }
  if (plain) return plain;
  throw new Error('所有來源都找不到歌詞');
}

// ---------- 本機歌詞（自己打點或貼上的 LRC，存在這台電腦） ----------
function ylpLocalKey(videoId) { return 'ylpLocal:' + videoId; }

// 影片不同但同一首歌：用「歌名＋歌手」在本機歌詞庫找（例如朋友看的是 MV，你做的是官方音訊版）
function ylpSongKey(v) {
  return String(v || '').normalize('NFKC').toLowerCase()
    .replace(/[\(\[（【].*?[\)\]）】]/g, '')   // 去掉括號裡的註記
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

async function ylpFindLocalBySong(candidates) {
  const wanted = (candidates || [])
    .map((c) => ({ song: ylpSongKey(c && c.song), artist: ylpSongKey(c && c.artist) }))
    .filter((c) => c.song.length >= 2);
  if (!wanted.length) return null;
  let all;
  try { all = await chrome.storage.local.get(null); } catch (e) { return null; }
  let best = null;
  for (const [k, d] of Object.entries(all)) {
    if (!k.startsWith('ylpLocal:') || !d || !d.lrc || k === ylpLocalKey(currentVideoId)) continue;
    const song = ylpSongKey(d.song), artist = ylpSongKey(d.artist);
    if (!song) continue;
    for (const w of wanted) {
      if (w.song !== song) continue;
      const artistOk = w.artist && artist
        ? (w.artist === artist || w.artist.includes(artist) || artist.includes(w.artist))
        : song.length >= 4; // 缺歌手資料時，歌名要夠長才算，避免「Love」這種常見歌名認錯
      if (!artistOk) continue;
      if (!best || (Number(d.updated) || 0) > (Number(best.d.updated) || 0)) best = { id: k.slice(9), d };
    }
  }
  if (!best) return null;
  return {
    lyrics: best.d.lrc, synced: true, source: '本機歌詞（別的影片）',
    artist: best.d.artist || '', song: best.d.song || '', otherVideo: best.id,
  };
}

function ylpSongCandidates(parsedData) {
  const out = [];
  if (parsedData) {
    out.push({ song: parsedData.song, artist: parsedData.artistFromTitle || parsedData.artistFromChannel || '' });
    if (parsedData.artistFromChannel && parsedData.artistFromTitle) out.push({ song: parsedData.song, artist: parsedData.artistFromChannel });
  }
  try {
    const m = getMusicInfoFromMusicSection();
    if (m && m.song) out.push({ song: m.song, artist: m.artist || '' });
  } catch (e) { /* 忽略 */ }
  return out;
}

async function ylpGetLocal(videoId) {
  if (!videoId) return null;
  try {
    const r = await chrome.storage.local.get(ylpLocalKey(videoId));
    const d = r[ylpLocalKey(videoId)];
    if (!d || !d.lrc) return null;
    return { lyrics: d.lrc, synced: true, source: '本機歌詞', artist: d.artist || '', song: d.song || '' };
  } catch (e) { return null; }
}

async function ylpSaveLocal(videoId, lrc, artist, song, title) {
  const key = ylpLocalKey(videoId);
  let created = Date.now();
  try {
    const old = (await chrome.storage.local.get(key))[key];
    if (old && Number(old.created)) created = Number(old.created);
  } catch (e) { /* 忽略 */ }
  // source: mine＝自己做的（匯入別人的歌詞庫時不會被覆蓋）
  await chrome.storage.local.set({ [key]: { lrc, artist, song, title: title || '', source: 'mine', created, updated: Date.now() } });
  try { await clearCachedLyrics(videoId); } catch (e) { /* 忽略 */ }
}

async function ylpDeleteLocal(videoId) {
  await chrome.storage.local.remove(ylpLocalKey(videoId));
  try { await clearCachedLyrics(videoId); } catch (e) { /* 忽略 */ }
}

// ---------- 製作同步歌詞（打點）編輯器 ----------
var ylpTap = null;   // 打點中的狀態

function ylpEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function ylpCurrentMeta() {
  const r = currentLyricsResult || {};
  let title = '';
  try { title = getVideoTitle(); } catch (e) { /* 忽略 */ }
  return { artist: r.artist || '', song: r.song || title };
}

function ylpOpenEditor(prefillOverride) {
  const content = document.getElementById('lyrics-content');
  if (!content || !currentVideoId) return;
  if (isMinimized && lyricsPanel) {
    lyricsPanel.classList.remove('minimized');
    isMinimized = false;
    ylpKeepMinimized = false;
    ylpUpdateMinimizeIcon();
  }
  ylpStopTap();

  const r = currentLyricsResult;
  // 有微調時，編輯器裡的時間直接套用微調（儲存後微調會歸零，避免重複計算）
  const synced = ylpSyncedLines();
  const prefill = typeof prefillOverride === 'string' ? prefillOverride : r
    ? (r.synced && Math.abs(ylpOffset) >= 0.05 && synced.length
      ? ylpLinesToLrc(synced.map((l) => ({ time: l.time - ylpOffset, text: l.text, end: Number.isFinite(l.end) ? l.end - ylpOffset : undefined })))
      : r.lyrics)
    : '';

  const box = ylpEl('div', 'ylp-editor');
  box.append(
    ylpEl('div', 'ylp-ed-title', '製作／編輯同步歌詞'),
    ylpEl('div', 'ylp-ed-hint', '把歌詞貼在下面（一行一句），按「開始打點」：影片會從頭播放，每一句開始唱時按住 ' + ylpKeyLabel(ylpSettings.tapKey) + '、唱完放開（可在設定視窗更改按鍵）。已經有 LRC 格式（每行前面有 [00:12.34]）的歌詞，可以直接按「儲存」；只有部分時間不準的話，按「開始打點」後點那一句，就能只重打那一段。朋友傳來的 .lrc 檔用「匯入」載入後按「儲存」。歌詞只存在這台電腦，這部影片以後會優先使用。')
  );
  const ta = ylpEl('textarea', 'ylp-ed-text');
  ta.value = prefill || '';
  ta.setAttribute('aria-label', '歌詞（一行一句）'); // 用途寫在上方說明，框內不放提示字
  ta.spellcheck = false;
  // 避免在輸入框打字時觸發 YouTube 快捷鍵
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  ta.addEventListener('paste', () => {
    setTimeout(() => {
      // 貼上後整理：去掉每行前後空白與多餘空行
      ta.value = ta.value.split(/\r?\n/).map((l) => l.trim()).filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim())).join('\n').trim();
      const n = ta.value.split('\n').filter(Boolean).length;
      msg.textContent = `已貼上 ${n} 行。確認內容後按「開始打點」。`;
    }, 0);
  });
  const msg = ylpEl('div', 'ylp-ed-msg');
  const row = ylpEl('div', 'ylp-ed-actions');
  const btn = (label, fn, primary) => {
    const b = ylpEl('button', 'manual-search-button ylp-ed-btn' + (primary ? ' primary' : ''), label);
    b.addEventListener('click', fn);
    row.appendChild(b);
    return b;
  };

  btn('🔍 手動搜尋', () => {
    ylpWebSearchLyrics();
    msg.textContent = '已在新分頁搜尋。複製歌詞後回到這裡，在上方輸入框按 Ctrl+V 貼上，再按「開始打點」。';
    ta.focus();
  });

  btn('▶ 開始打點', () => {
    const lines = ta.value.split(/\r?\n/).map((l) => l.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean);
    if (lines.length < 2) { msg.textContent = '請先貼上至少兩行歌詞。'; return; }
    // 已經有時間的歌詞：保留原本的時間，可以只重打其中一段
    const timed = ylpNormalizeLrc(ta.value);
    const orig = timed.length === lines.length && timed.every((l, i) => l.text === lines[i]) ? timed : null;
    ylpStartTap(lines, orig);
  }, true);

  btn('💾 儲存', async () => {
    const lines = ylpNormalizeLrc(ta.value);
    if (lines.length < 2) { msg.textContent = '找不到時間標記。沒有時間的歌詞請用「開始打點」。'; return; }
    await ylpFinishLocal(lines);
  });

  btn('⬆ 匯出（分享給朋友）', () => {
    const lines = ylpNormalizeLrc(ta.value);
    if (!lines.length) { msg.textContent = '沒有時間標記的歌詞無法匯出，請先打點或儲存。'; return; }
    ylpDownloadLrc(ylpLinesToLrc(lines));
    msg.textContent = '已匯出 .lrc 檔（在瀏覽器的下載資料夾）。把檔案傳給朋友，他在同一部影片按 ✎ →「匯入」→「儲存」即可。';
  });

  const fileInput = ylpEl('input');
  fileInput.type = 'file';
  fileInput.accept = '.lrc,.txt,text/plain';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > 1024 * 1024) { msg.textContent = '檔案太大（超過 1 MB），不像是歌詞檔。'; return; }
    const text = await f.text();
    const lines = ylpNormalizeLrc(text);
    if (lines.length < 2) { msg.textContent = '這個檔案裡找不到有時間標記的歌詞。'; return; }
    ta.value = ylpLinesToLrc(lines);
    const src = (/^\[yt:([\w-]{6,20})\]/m.exec(text) || [])[1];
    msg.textContent = `已載入 ${lines.length} 行，按「💾 儲存」套用到這部影片。`
      + (src && src !== currentVideoId ? '　⚠ 這份歌詞原本是給另一部影片做的，時間可能對不上（例如 MV 版和音樂版的前奏長度不同）。' : '');
  });
  btn('📂 匯入', () => fileInput.click());
  box.appendChild(fileInput);

  btn('🗑 刪除本機歌詞', async () => {
    await ylpDeleteLocal(currentVideoId);
    msg.textContent = '已刪除，重新搜尋中…';
    isRefreshRequest = true;
    detectAndShowLyrics();
  });

  btn('📚 歌詞庫', () => {
    try { chrome.runtime.sendMessage({ action: 'ylpOpenLibrary' }); } catch (e) { msg.textContent = '外掛剛更新過，請重新整理頁面。'; }
  });

  btn('取消', () => {
    if (currentLyricsResult) displayLyrics(currentLyricsResult, currentLyricsResult.isCached);
  });

  box.append(ta, row, msg);
  content.textContent = '';
  content.appendChild(box);
  content.scrollTop = 0;
  ta.focus();
}

// 用瀏覽器新分頁搜尋「目前影片標題 + 歌詞」
function ylpWebSearchLyrics() {
  let title = '';
  try { title = getVideoTitle(); } catch (e) { title = ylpCurrentMeta().song || ''; }
  const q = `${title} 歌詞`.trim();
  window.open('https://www.google.com/search?q=' + encodeURIComponent(q), '_blank', 'noopener');
}

function ylpDownloadLrc(lrc) {
  const meta = ylpCurrentMeta();
  // 檔案開頭加上歌名、歌手、影片 ID（一般播放器會忽略這些標籤）
  const clean = (v) => String(v || '').replace(/[\[\]\r\n]/g, ' ').trim();
  const head = [
    meta.song ? `[ti:${clean(meta.song)}]` : '',
    meta.artist ? `[ar:${clean(meta.artist)}]` : '',
    currentVideoId ? `[yt:${currentVideoId}]` : '',
    '[by:YT 歌詞（中文版）]',
  ].filter(Boolean).join('\n');
  lrc = head + '\n' + lrc;
  const name = `${meta.artist ? meta.artist + ' - ' : ''}${meta.song || 'lyrics'}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
  const url = URL.createObjectURL(new Blob([lrc], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.lrc';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// direct＝true（打點完成）：不跳確認畫面，直接用目前的歌名、歌手儲存
async function ylpFinishLocal(lines, direct) {
  const lrc = ylpLinesToLrc(lines);
  const msgBox = () => document.querySelector('#lyrics-extension-panel .ylp-ed-msg') || (ylpTap && ylpTap.head);
  if (!currentVideoId) {
    const box = msgBox();
    if (box) box.textContent = '找不到這部影片的 ID，無法儲存。請重新整理頁面後再試。';
    return;
  }
  if (!direct) {
    ylpStopTap();
    ylpConfirmSave(lrc);
    return;
  }
  // 歌名、歌手：這部影片之前存過就沿用，否則用自動辨識的（之後可以在歌詞庫「改名稱」）
  let meta = ylpCurrentMeta();
  let title = '';
  try { title = getVideoTitle() || ''; } catch (e) { /* 忽略 */ }
  try {
    const old = (await chrome.storage.local.get(ylpLocalKey(currentVideoId)))[ylpLocalKey(currentVideoId)];
    if (old && (old.song || old.artist)) meta = { song: old.song || meta.song, artist: old.artist || meta.artist };
  } catch (e) { /* 忽略 */ }
  const song = (meta.song || title || '未命名歌曲').trim();
  const artist = (meta.artist || '').trim();
  try {
    await ylpSaveLocal(currentVideoId, lrc, artist, song, title);
  } catch (e) {
    const box = msgBox();
    if (box) box.textContent = '儲存失敗：' + (String(e && e.message || e).includes('QUOTA') ? '儲存空間已滿，請先到歌詞庫刪除一些不用的歌。' : String(e && e.message || e));
    return; // 打點資料還在，可以再按「完成並儲存」
  }
  ylpStopTap();
  ylpSetOffset(0); // 新存的歌詞時間已經是對的，微調歸零
  displayLyrics({ lyrics: lrc, synced: true, source: '本機歌詞', artist, song }, false);
  ylpToast('✅ 已儲存同步歌詞。歌名、歌手可以到「📚 歌詞庫」修改');
}

// 面板上方短暫顯示一行提示
function ylpToast(text) {
  const panel = document.getElementById('lyrics-extension-panel');
  if (!panel) return;
  panel.querySelector('.ylp-toast')?.remove();
  const t = ylpEl('div', 'ylp-toast', text);
  panel.appendChild(t);
  setTimeout(() => t.classList.add('hide'), 3500);
  setTimeout(() => t.remove(), 4000);
}

// 儲存前確認歌名與歌手（自動辨識有時會錯，這裡可以修正；歌詞庫與分享給朋友時都會用到）
async function ylpConfirmSave(lrc) {
  const content = document.getElementById('lyrics-content');
  if (!content) return;
  let meta = ylpCurrentMeta();
  let title = '';
  try { title = getVideoTitle() || ''; } catch (e) { /* 忽略 */ }
  try {
    const old = (await chrome.storage.local.get(ylpLocalKey(currentVideoId)))[ylpLocalKey(currentVideoId)];
    if (old && (old.song || old.artist)) meta = { song: old.song || meta.song, artist: old.artist || meta.artist };
  } catch (e) { /* 忽略 */ }

  const box = ylpEl('div', 'ylp-editor ylp-confirm');
  box.appendChild(ylpEl('div', 'ylp-ed-title', '儲存同步歌詞'));
  box.appendChild(ylpEl('div', 'ylp-ed-hint', `共 ${ylpNormalizeLrc(lrc).length} 句。請確認歌名和歌手，之後在歌詞庫、分享給朋友時會用到。`));
  const field = (label, value) => {
    const l = ylpEl('label', '', label);
    const input = ylpEl('input', 'manual-search-input');
    input.type = 'text';
    input.value = value || '';
    input.maxLength = 200;
    input.autocomplete = 'off';
    input.spellcheck = false;
    for (const t of ['keydown', 'keyup', 'keypress']) input.addEventListener(t, (e) => e.stopPropagation());
    box.append(l, input);
    return input;
  };
  const songIn = field('歌名', meta.song);
  const artistIn = field('歌手', meta.artist);
  if (title) box.appendChild(ylpEl('div', 'ylp-confirm-video', '影片：' + title));
  const msg = ylpEl('div', 'ylp-ed-msg');
  const row = ylpEl('div', 'ylp-ed-actions');
  const mk = (label, fn, primary) => {
    const b = ylpEl('button', 'manual-search-button ylp-ed-btn' + (primary ? ' primary' : ''), label);
    b.addEventListener('click', fn);
    row.appendChild(b);
    return b;
  };
  const save = async () => {
    const song = songIn.value.trim();
    const artist = artistIn.value.trim();
    if (!song) { msg.textContent = '請輸入歌名。'; songIn.focus(); return; }
    try {
      await ylpSaveLocal(currentVideoId, lrc, artist, song, title);
    } catch (e) {
      // 最常見的原因是外掛的儲存空間滿了（本機歌詞太多）
      msg.textContent = '儲存失敗：' + (String(e && e.message || e).includes('QUOTA') ? '儲存空間已滿，請先到歌詞庫刪除一些不用的歌。' : String(e && e.message || e));
      return;
    }
    ylpSetOffset(0); // 新存的歌詞時間已經是對的，微調歸零
    displayLyrics({ lyrics: lrc, synced: true, source: '本機歌詞', artist, song }, false);
  };
  mk('💾 確認儲存', save, true);
  mk('返回編輯', () => ylpOpenEditor(lrc));
  for (const input of [songIn, artistIn]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } });
  }
  box.append(row, msg);
  content.textContent = '';
  content.appendChild(box);
  content.scrollTop = 0;
  songIn.focus();
  songIn.select();
}

// 按鍵代碼 → 顯示名稱
function ylpKeyLabel(code) {
  const map = { Enter: 'Enter', NumpadEnter: '數字鍵 Enter', Space: '空白鍵', Backspace: 'Backspace', Tab: 'Tab',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: '左 Shift', ShiftRight: '右 Shift',
    ControlLeft: '左 Ctrl', ControlRight: '右 Ctrl', AltLeft: '左 Alt', AltRight: '右 Alt', Delete: 'Delete' };
  if (map[code]) return map[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return '數字鍵 ' + code.slice(6);
  return code || '?';
}

function ylpKeyMatches(e, code) {
  return e.code === code || (code === 'Enter' && e.code === 'NumpadEnter');
}

// 打點：按住＝這一句開始，放開＝這一句結束（卡拉OK填色會照實際唱的長度，不會拖到下一句才結束）
// 只是快速點一下（按住不到 0.25 秒）的話，就不記錄結束時間，改用下一句開始當作結束
const YLP_TAP_MIN_HOLD = 0.25;

function ylpStartTap(lines, orig) {
  const content = document.getElementById('lyrics-content');
  const video = document.querySelector('video');
  if (!content || !video) return;

  // orig：原本的時間（有的話可以從中間重打，沒重打到的句子保留原本的時間）
  ylpTap = { lines, orig: orig || null, marks: [], video, holding: -1, choosing: !!orig };
  const box = ylpEl('div', 'ylp-tap');
  const head = ylpEl('div', 'ylp-tap-head');
  const tip = ylpEl('div', 'ylp-ed-hint', orig
    ? `點下面任何一句，就從那一句開始重打：影片會跳到那句前 3 秒。前面的句子保留原本的時間；重打完需要的句子後按「完成並儲存」，後面沒重打的句子也會保留原本的時間。打點方式：每句開始唱時按住 ${ylpKeyLabel(ylpSettings.tapKey)}，唱完放開。`
    : `每一句開始唱時「按住」${ylpKeyLabel(ylpSettings.tapKey)}，這句唱完就「放開」。句子之間有空檔（間奏、換氣）時，卡拉OK字幕會準時結束，不會拖到下一句。`);
  const list = ylpEl('div', 'ylp-tap-list' + (orig ? ' pickable' : ''));
  lines.forEach((l, i) => {
    const row = ylpEl('div', 'ylp-tap-line');
    row.append(ylpEl('span', 'ylp-tap-time', '--:--'), ylpEl('span', 'ylp-tap-text', l));
    row.dataset.i = i;
    row.addEventListener('click', () => ylpTapFrom(i));
    list.appendChild(row);
  });
  const row = ylpEl('div', 'ylp-ed-actions');
  const mk = (label, fn, primary) => {
    const b = ylpEl('button', 'manual-search-button ylp-ed-btn' + (primary ? ' primary' : ''), label);
    b.addEventListener('click', (e) => { b.blur(); fn(e); }); // 點完就移開焦點，避免按鍵再次觸發按鈕
    row.appendChild(b);
    return b;
  };
  // 畫面上的打點按鈕也一樣：按住開始、放開結束
  const tapBtn = ylpEl('button', 'manual-search-button ylp-ed-btn primary', `按住打點（${ylpKeyLabel(ylpSettings.tapKey)}）`);
  tapBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { tapBtn.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    ylpTapDown();
  });
  tapBtn.addEventListener('pointerup', () => ylpTapUp());
  tapBtn.addEventListener('pointercancel', () => ylpTapUp());
  row.appendChild(tapBtn);
  mk(`退回上一句（${ylpKeyLabel(ylpSettings.undoKey)}）`, ylpTapUndo);
  if (orig) mk('從頭開始', () => ylpTapFrom(0));
  mk('完成並儲存', ylpTapFinish);
  mk('取消（Esc）', () => { ylpStopTap(); ylpOpenEditor(); });

  box.append(head, tip, row, list);
  content.textContent = '';
  content.appendChild(box);
  ylpTap.head = head;
  ylpTap.list = list;

  // 掛在 window 的最前面攔截，YouTube 才不會先收到按鍵（例如空白鍵暫停）
  for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, ylpTapKeys, true);
  window.addEventListener('blur', ylpTapUp); // 切換視窗時當作放開
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (orig) {
    video.pause(); // 先選要從哪一句開始
  } else {
    video.currentTime = 0;
    video.play().catch(() => {});
  }
  ylpTapRefresh();
}

// 從第 k 句開始（重新）打點：前面的句子保留（已經重打過的用新的時間，其餘用原本的時間）
function ylpTapFrom(k) {
  if (!ylpTap) return;
  const { marks, orig, video, lines } = ylpTap;
  if (k < 0 || k >= lines.length) return;
  if (!orig && k > marks.length) return; // 沒有原本時間時，不能跳過還沒打的句子
  const kept = [];
  for (let i = 0; i < k; i++) {
    if (i < marks.length) kept.push(marks[i]);
    else kept.push({ start: orig[i].time, end: orig[i].end, kept: true });
  }
  ylpTap.marks = kept;
  ylpTap.holding = -1;
  ylpTap.choosing = false;
  const ref = orig ? orig[k].time : (marks[k] ? marks[k].start : (kept.length ? kept[kept.length - 1].start : 0));
  video.currentTime = Math.max(0, ref - 3);
  video.play().catch(() => {});
  ylpTapRefresh();
}

function ylpTapKeys(e) {
  if (!ylpTap) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const isTap = ylpKeyMatches(e, ylpSettings.tapKey);
  const isUndo = ylpKeyMatches(e, ylpSettings.undoKey);
  const isEsc = e.code === 'Escape';
  if (!isTap && !isUndo && !isEsc) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (isTap) {
    if (e.type === 'keydown' && !e.repeat) ylpTapDown();   // 按下＝這句開始（按住不放不會重複打點）
    else if (e.type === 'keyup') ylpTapUp();               // 放開＝這句結束
    return;
  }
  if (e.type !== 'keydown' || e.repeat) return;
  if (isUndo) ylpTapUndo();
  else { ylpStopTap(); ylpOpenEditor(); }
}

function ylpTapDown() {
  if (!ylpTap || ylpTap.holding >= 0) return;
  if (ylpTap.choosing) {
    ylpTap.head.textContent = '請先點一句歌詞，選擇要從哪一句開始重打（或按「從頭開始」）。';
    return;
  }
  const { marks, lines, video } = ylpTap;
  if (marks.length >= lines.length) return;
  const prev = marks[marks.length - 1];
  const start = Math.max(video.currentTime, prev ? prev.start + 0.05 : 0);
  // 新的開始時間比上一句的結束還早：把上一句的結束提前
  if (prev && Number.isFinite(prev.end) && prev.end > start) prev.end = start - prev.start >= YLP_TAP_MIN_HOLD ? start : undefined;
  marks.push({ start });
  ylpTap.holding = marks.length - 1;
  ylpTapRefresh();
}

function ylpTapUp() {
  if (!ylpTap || ylpTap.holding < 0) return;
  const { marks, lines, video } = ylpTap;
  const m = marks[ylpTap.holding];
  ylpTap.holding = -1;
  if (m && video.currentTime - m.start >= YLP_TAP_MIN_HOLD) m.end = Math.max(video.currentTime, m.start + 0.05);
  ylpTapRefresh();
  if (marks.length === lines.length) ylpTapFinish();
}

function ylpTapUndo() {
  if (!ylpTap || !ylpTap.marks.length || ylpTap.choosing) return;
  const removed = ylpTap.marks.pop();
  ylpTap.holding = -1;
  ylpTap.video.currentTime = Math.max(0, removed.start - 3); // 倒回這句前 3 秒重新打點
  ylpTapRefresh();
}

function ylpTapFinish() {
  if (!ylpTap) return;
  const { marks, lines, video, orig } = ylpTap;
  if (ylpTap.holding >= 0) { // 還按著就按完成：用現在的時間當結束
    const m = marks[ylpTap.holding];
    if (m && video.currentTime - m.start >= YLP_TAP_MIN_HOLD) m.end = video.currentTime;
    ylpTap.holding = -1;
  }
  if (orig && ylpTap.choosing) { ylpTap.head.textContent = '還沒有重打任何一句。點一句歌詞開始重打，或按「取消」。'; return; }
  if (!orig && marks.length < 2) { ylpTap.head.textContent = '至少要打點兩句才能儲存。'; return; }
  const out = marks.map((m, i) => ({ time: m.start, text: lines[i], end: m.end }));
  // 沒有重打到的後面句子：保留原本的時間
  if (orig) for (let i = marks.length; i < lines.length; i++) out.push({ time: orig[i].time, text: lines[i], end: orig[i].end });
  // 確保時間順序正確：後一句不能比前一句早，前一句的結束不能晚於後一句開始
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1], cur = out[i];
    if (cur.time <= prev.time) cur.time = prev.time + 0.05;
    if (Number.isFinite(prev.end) && prev.end > cur.time) prev.end = cur.time - prev.time >= YLP_TAP_MIN_HOLD ? cur.time : undefined;
    if (Number.isFinite(cur.end) && cur.end <= cur.time) cur.end = undefined;
  }
  ylpFinishLocal(out, true); // 打點完成直接儲存，不用再確認
}

function ylpTapRefresh() {
  if (!ylpTap) return;
  const { marks, lines, head, list, holding, orig, choosing } = ylpTap;
  const n = marks.length;
  const key = ylpKeyLabel(ylpSettings.tapKey);
  const span = (a, b) => ylpFormatTime(a) + (Number.isFinite(b) ? ' ～ ' + ylpFormatTime(b) : '');
  head.textContent = choosing
    ? '要從哪一句開始重打？點那一句（前後沒重打的句子都會保留原本的時間）'
    : holding >= 0
      ? `第 ${holding + 1} 句唱完時放開 ${key}（${n} / ${lines.length}）`
      : n < lines.length
        ? `打點中：第 ${n + 1} 句 / 共 ${lines.length} 句　開始唱時按住 ${key}` + (orig ? '　（重打完需要的句子就可以按「完成並儲存」）' : '')
        : `全部完成：${n} / ${lines.length}`;
  list.querySelectorAll('.ylp-tap-line').forEach((row, i) => {
    const m = marks[i];
    const o = orig && orig[i];
    row.classList.toggle('done', !!m && i !== holding && !m.kept);
    row.classList.toggle('kept', !!m && !!m.kept);
    row.classList.toggle('orig', !m && !!o);
    row.classList.toggle('holding', i === holding);
    row.classList.toggle('next', !choosing && holding < 0 && i === n);
    row.querySelector('.ylp-tap-time').textContent = m
      ? (i === holding ? ylpFormatTime(m.start) + ' ～' : span(m.start, m.end))
      : o ? span(o.time, o.end) : '--:--';
    row.title = orig || i <= n ? '從這一句開始重打' : '';
  });
  const focus = list.querySelector('.ylp-tap-line.holding, .ylp-tap-line.next');
  const content = document.getElementById('lyrics-content');
  if (focus && content) ylpScrollToLine(focus);
}

function ylpStopTap() {
  if (!ylpTap) return;
  for (const type of ['keydown', 'keyup', 'keypress']) window.removeEventListener(type, ylpTapKeys, true);
  window.removeEventListener('blur', ylpTapUp);
  ylpTap = null;
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

// 判斷要不要顯示「偵測到音樂」的小圓點
// 依序看：YouTube 自己的影片分類是不是「音樂」、說明欄有沒有「音樂」區塊、標題與頻道關鍵字
async function ylpCheckMusicForDot(videoId, title, channelName, keywordMusic) {
  let category = '';
  for (let i = 0; i < 3 && !category; i++) {
    const info = await ylpPageRequest('getInfo', {}, 1500);
    if (info && info.videoId === videoId) category = info.category || '';
    else await new Promise((r) => setTimeout(r, 800)); // 播放器還沒換成新影片，等一下再問
  }
  if (currentVideoId !== videoId || lyricsPanel) return; // 已經換歌或已經打開歌詞
  let musicSection = false;
  try { musicSection = !!getMusicInfoFromMusicSection(); } catch (e) { /* 忽略 */ }
  const extraKeywords = /(^|[\s\[【(（|｜])(m\/?v|mv)([\s\]】)）|｜]|$)|music video|lyric|官方|主題曲|主题曲|片頭曲|片尾曲|插曲|\bost\b|翻唱|\bcover\b|\bfeat\.?|\bft\.|歌ってみた|커버|뮤직비디오/i;
  // 預告片、遊戲實況、Vlog 等常帶有 official、live 等字，只有 YouTube 分類是「音樂」時才算
  const notMusic = /\b(trailer|teaser|gameplay|walkthrough|let'?s play|vlog|podcast|reaction|unboxing|tutorial|review|news|highlights?|livestream|stream)\b|預告|预告|實況|实况|遊戲|游戏|開箱|开箱|教學|教学|新聞|新闻|直播|精華|精华/i;
  const isMusic = category === 'Music' || musicSection || ((keywordMusic || extraKeywords.test(title)) && !notMusic.test(title));
  const instrumental = ylpIsInstrumental(title, channelName);
  console.log('🎵 小圓點判斷：分類=' + (category || '?') + ' 音樂區塊=' + musicSection + ' 關鍵字=' + keywordMusic + ' 純音樂=' + instrumental);
  if (isMusic && !instrumental && smartAutoShow) ylpShowSuggestDot();
  else ylpRemoveSuggestDot();
}

// 純音樂（沒有人聲、沒有歌詞）的影片：不顯示「偵測到音樂」的小圓點
const YLP_INSTRUMENTAL_PATTERNS = [
  /\binstrumentals?\b/i, /\binst\b\.?/i, /\boff[\s-]?vocal\b/i, /\bno vocals?\b/i, /\bbacking track\b/i,
  /\b(piano|guitar|violin|cello|flute|sax(ophone)?|harp|erhu|guzheng|ukulele|marimba|orchestra(l)?)\s*(cover|version|ver\.?|solo|arrangement|instrumental)\b/i,
  /\bmusic ?box\b/i, /\blo-?fi\b/i, /\b(relaxing|study|sleep|calm|focus|meditation|healing|spa|cafe|coffee shop|background)\s+music\b/i,
  /\bambient\b/i, /\bwhite noise\b/i, /\bbgm\b/i, /\b\d+\s*(hours?|hrs?)\b/i,
  /純音樂|纯音乐|伴奏|純樂器|演奏版|演奏曲|鋼琴版|钢琴版|鋼琴曲|钢琴曲|鋼琴演奏|钢琴演奏|古箏|古筝|二胡|琵琶|笛子|小提琴|大提琴|吉他演奏|八音盒|音樂盒|音乐盒|輕音樂|轻音乐|背景音樂|背景音乐|白噪音|助眠|冥想/,
  /インスト|オルゴール|ピアノ(ver|バージョン|アレンジ|ソロ|演奏)|演奏してみた|弾いてみた/,
  /연주|피아노\s*(커버|버전|ver)|반주/,
];

function ylpIsInstrumental(title, channelName) {
  const t = String(title || '');
  const c = String(channelName || '');
  if (YLP_INSTRUMENTAL_PATTERNS.some((re) => re.test(t))) return true;
  // 頻道本身就是純音樂頻道（例如鋼琴、輕音樂、Lo-fi 頻道）
  return /\b(piano|lo-?fi|instrumental|relaxing|sleep music|music box)\b/i.test(c) || /鋼琴|钢琴|純音樂|纯音乐|輕音樂|轻音乐/.test(c);
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
chrome.storage.sync.get(['autoShowLyrics', 'smartAutoShow', 'darkMode', 'theme'], (result) => {
  autoShowLyrics = result.autoShowLyrics === true;      // Will be false if undefined
  smartAutoShow = result.smartAutoShow !== false;        // Will be true if undefined
  darkModeEnabled = result.darkMode !== false;
  // 之前選的主題已被移除（例如純白）時，改回深色，避免面板底色和文字顏色對不上
  if (result.theme && result.theme !== 'custom' && !YLP_THEMES[result.theme]) darkModeEnabled = true;
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
    boxesHTML += `<div class="progress-box ${ylpProgressBoxClass(i)}"></div>`;
  }
  
  const percentage = Math.round((currentFilledBoxes / PROGRESS_TOTAL_BOXES) * 100);
  
  // Generate unique ID to prevent Chrome from tracking input across renders
  const uniqueInputId = `manual-search-loading-input-${Date.now()}`;
  const uniqueButtonId = `manual-search-loading-btn-${Date.now()}`;
  
  return `
    <div class="lyrics-loading">
      <div class="ylp-loading-head">
        <div class="ylp-eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
        <div class="ylp-loading-title">正在尋找歌詞<span class="ylp-dots"><i>.</i><i>.</i><i>.</i></span></div>
      </div>
      <div class="segmented-progress-container">
        ${boxesHTML}
      </div>
      <div class="progress-info">
        <span class="progress-label">${ylpEscape(loadingLabel)}</span>
        <span class="progress-percentage">${percentage}%</span>
      </div>
      <div class="manual-search-box" style="margin-top: 16px;">
        <div class="manual-search-title" style="margin-bottom: 8px; font-size: 12px;">
          <span>⏱️</span>
          <span>或手動搜尋</span>
        </div>
        <label class="ylp-field-label" for="${uniqueInputId}">輸入「歌手 - 歌名」</label>
        <input 
          type="text" 
          class="manual-search-input" 
          aria-label="歌手 - 歌名"
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
// 已填滿／正在找（會閃動）／還沒輪到
function ylpProgressBoxClass(i) {
  if (i < currentFilledBoxes) return 'progress-box-filled';
  if (i === currentFilledBoxes) return 'progress-box-empty progress-box-current';
  return 'progress-box-empty';
}

function updateProgressBarUI() {
  const content = document.getElementById('lyrics-content');
  if (!content) return;
  
  // Only update if loading UI is visible
  const loadingDiv = content.querySelector('.lyrics-loading');
  // 直接更新格子與文字，不整個重畫：動畫不會中斷，手動搜尋框裡打到一半的字也不會被清掉
  const boxes = loadingDiv ? loadingDiv.querySelectorAll('.progress-box') : [];
  if (loadingDiv && boxes.length === PROGRESS_TOTAL_BOXES) {
    boxes.forEach((b, i) => { b.className = 'progress-box ' + ylpProgressBoxClass(i); });
    const label = loadingDiv.querySelector('.progress-label');
    if (label) label.textContent = loadingLabel;
    const pct = loadingDiv.querySelector('.progress-percentage');
    if (pct) pct.textContent = Math.round((currentFilledBoxes / PROGRESS_TOTAL_BOXES) * 100) + '%';
    return;
  }
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
    // 【】裡如果只是「MV」「官方完整版」「動態歌詞」這類註記，先拿掉，不要當成歌名或歌手
    const NOTE = /^(官方|完整版|高畫質|高音質|動態歌詞|歌詞|字幕|中字|首播|預告|官方版|正式版|official|mv|m\/v|music video|lyrics?|lyric video|audio|hd|hq|4k|live|teaser|preview|ktv|karaoke)/i;
    title = title.replace(/【([^】]*)】/g, (m, inner) => (NOTE.test(inner.trim()) ? ' ' : m)).replace(/\s{2,}/g, ' ').trim();
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
    
    // 華語常見格式：歌手中文名 英文名 -【歌名】、周杰倫JayChou【龍捲風】
    if (!song) {
      const bm = title.match(/^(.*?)【([^】]+)】(.*)$/);
      if (bm) {
        const prefix = bm[1].replace(/[\s\-–—|:：_~～]+$/, '').trim();
        const inner = bm[2].trim();
        const rest = bm[3].replace(/^[\s\-–—|:：_~～]+/, '').trim();
        if (prefix && inner) {
          artistFromTitle = prefix;
          song = inner;
          console.log('🎯 Parsed 【歌名】 with artist prefix');
        } else if (!prefix && inner && rest) {
          // 【歌手】歌名 的寫法
          artistFromTitle = inner;
          song = rest.replace(/[\(\[（【].*$/, '').trim() || rest;
          console.log('🎯 Parsed 【歌手】 song');
        }
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
      language,
      // 中英文並列的名字拆開來各搜一次（例如「周杰倫JayChou」→「周杰倫」「Jay Chou」）
      artistAliases: ylpNameAliases(artistFromTitle),
      songAliases: ylpNameAliases(song),
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
    
    // 中英文並列名稱的組合（優先順序排在「完全照標題」之後）
    const seen = new Set(variations.map((v) => v.artist + '|' + v.song));
    const addVar = (artist, s, priority, label, source) => {
      const key = artist + '|' + s;
      if (!s || seen.has(key)) return;
      seen.add(key);
      variations.push({ artist, song: s, source, priority, label });
    };
    const aAliases = [artistFromTitle, ...(parsedData.artistAliases || [])].filter(Boolean);
    const sAliases = [songClean, ...(parsedData.songAliases || [])].filter(Boolean);
    let n = 0;
    for (const a of aAliases) for (const sn of sAliases) if (n++ < 8) addVar(a, sn, 1.5, 'alias', 'title-artist');
    for (const sn of (parsedData.songAliases || [])) addVar('', sn, 4.5, 'alias-song-only', 'song-only');
    
    variations.sort((a, b) => a.priority - b.priority);
    
    console.log(`✅ Generated ${variations.length} ranked variations`);
    return variations;
  }
  
  removeEmojis(text) {
    return text.replace(this.patterns.emojis, '').replace(/\s{2,}/g, ' ').trim();
  }
}

// 名字裡同時有中日韓文字和英文時，拆成各自的版本（不含原本的寫法）
// 「高爾宣 OSN」→「高爾宣」「OSN」；「周杰倫JayChou」→「周杰倫」「Jay Chou」「JayChou」
function ylpNameAliases(name) {
  const s = String(name || '').replace(/[()（）\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  if (!CJK.test(s) || !/[A-Za-z]/.test(s)) return [];
  const out = new Set();
  const cjk = (s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]*/gu) || [])
    .map((x) => x.trim()).filter(Boolean);
  const latin = s.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (cjk[0]) out.add(cjk[0]);
  if (latin && /[A-Za-z]{2,}/.test(latin)) {
    out.add(latin);
    const spaced = latin.replace(/([a-z])([A-Z])/g, '$1 $2'); // JayChou → Jay Chou
    if (spaced !== latin) out.add(spaced);
  }
  out.delete(s);
  return [...out];
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

// 網路請求加上逾時（原本沒有逾時，某個網站很慢時整個搜尋會卡住好幾分鐘）
// 同一次搜尋中，相同網址只請求一次
var ylpFetchMemo = new Map();
var ylpSearchGen = 0; // 每開始一次新的搜尋就 +1，舊的搜尋結果不再顯示
function ylpFetchJson(url, timeoutMs = 8000) {
  if (ylpFetchMemo.has(url)) return ylpFetchMemo.get(url);
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null; // 逾時或網路錯誤：當作沒有結果
    } finally {
      clearTimeout(timer);
    }
  })();
  ylpFetchMemo.set(url, p);
  return p;
}

async function searchLRCLIB(artist, song) {
  try {
    const searches = [
      artist && song ? 
        `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(song)}` 
        : null,
      song ? 
        `https://lrclib.net/api/search?track_name=${encodeURIComponent(song)}`
        : null,
      // 沒有歌手時也用關鍵字搜尋：手動輸入「NewJeans OMG」（沒有加「-」）原本會被當成歌名而找不到
      song ?
        `https://lrclib.net/api/search?q=${encodeURIComponent(`${artist || ''} ${song}`.trim())}`
        : null
    ].filter(Boolean);
    
    for (const url of searches) {
      console.log('🔍 LRCLIB searching:', url);
      const results = await ylpFetchJson(url, 8000);
      
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
    
    const data = await ylpFetchJson(url, 6000);
    
    if (data && data.lyrics) {
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
  ylpFetchMemo = new Map();
  const myGen = parsedData._gen || ylpSearchGen;
  
  // Track which major search phases we've tried
  let boxesFilled = {
    titleArtist: false,
    channelArtist: false,
    songOnly: false,
    fallback1: false,
    fallback2: false
  };
  
  for (let i = 0; i < variations.length; i++) {
    if (myGen !== ylpSearchGen) throw new Error('已改用新的搜尋'); // 使用者開始了新的搜尋，這次的就停下來
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
        width: 400px;
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
      #lyrics-extension-panel .ylp-ed-title { font-weight: 600; font-size: 15px; margin-bottom: 6px; }
      #lyrics-extension-panel .ylp-ed-hint { font-size: 12px; opacity: 0.7; line-height: 1.6; margin-bottom: 10px; }
      #lyrics-extension-panel .ylp-ed-text {
        width: 100%; min-height: 220px; box-sizing: border-box; resize: vertical;
        padding: 10px; border-radius: 8px; font: inherit; font-size: 13px; line-height: 1.6;
        background: ${darkModeEnabled ? 'rgba(255,255,255,0.06)' : '#fff'};
        color: inherit; border: 1px solid ${darkModeEnabled ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'};
      }
      #lyrics-extension-panel .ylp-ed-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
      #lyrics-extension-panel .ylp-ed-btn { width: auto !important; padding: 6px 10px !important; font-size: 12px !important; margin: 0 !important; }
      #lyrics-extension-panel .ylp-ed-btn:not(.primary) { opacity: 0.85; }
      #lyrics-extension-panel .ylp-ed-msg { font-size: 12px; color: #ff9f0a; min-height: 1em; }
      #lyrics-extension-panel .ylp-tap-head { font-weight: 600; font-size: 13px; }
      #lyrics-extension-panel .ylp-tap-line { display: flex; gap: 10px; padding: 4px 6px; border-radius: 6px; opacity: 0.5; }
      #lyrics-extension-panel .ylp-tap-line.done { opacity: 0.8; }
      #lyrics-extension-panel .ylp-tap-line.next { opacity: 1; font-weight: 600; background: rgba(10, 132, 255, 0.18); }
      #lyrics-extension-panel .ylp-tap-time { font-variant-numeric: tabular-nums; opacity: 0.7; min-width: 64px; white-space: nowrap; font-size: 0.9em; }
      #lyrics-extension-panel .ylp-tap-line.holding { opacity: 1; font-weight: 700; background: rgba(255, 159, 10, 0.25); }
      #lyrics-extension-panel .ylp-tap-line { cursor: pointer; }
      #lyrics-extension-panel .ylp-tap-line:hover { outline: 1px dashed rgba(128, 128, 128, 0.5); }
      #lyrics-extension-panel .ylp-tap-line.kept, #lyrics-extension-panel .ylp-tap-line.orig { opacity: 0.55; font-style: italic; }
    </style>
    
    <div class="lyrics-header" id="lyrics-header">
      <div class="lyrics-title">
        ${ylpOffsetControlsHTML()}
      </div>
      <div class="lyrics-controls">
        <button class="lyrics-btn" id="ylp-search-btn" title="歌不對？手動搜尋">
          <span style="font-size: 12px; line-height: 1;">🔍</span>
        </button>
        <button class="lyrics-btn" id="edit-btn" title="製作／編輯同步歌詞">
          <span style="font-size: 13px; line-height: 1;">✎</span>
        </button>
        <button class="lyrics-btn" id="karaoke-btn" title="卡拉OK模式（全螢幕，只顯示 MV 與字幕）">
          <span style="font-size: 14px; line-height: 1;">🎤</span>
        </button>
        <button class="lyrics-btn" id="ylp-cc-btn" title="影片字幕：把歌詞顯示在影片下方（像 CC 字幕）">CC</button>
        <button class="lyrics-btn ylp-translate-btn" id="translate-btn" title="顯示／隱藏翻譯">
          <span style="font-size: 13px; line-height: 1;">譯</span>
        </button>
        <button class="lyrics-btn" id="ylp-dot-btn" title="縮成一個小圓點（點圓點就會展開）">
          <span style="font-size: 9px; line-height: 1;">●</span>
        </button>
        <button class="lyrics-btn" id="minimize-btn" title="縮小">
          <span class="ylp-min-icon" style="font-size: 16px; line-height: 1;">−</span>
        </button>
        <button class="lyrics-btn" id="close-btn" title="關閉">
          <span style="font-size: 16px; line-height: 1;">×</span>
        </button>
      </div>
    </div>
    
    <div class="ylp-search-bar" id="ylp-search-bar" hidden>
      <label class="ylp-hs-label" for="ylp-hs-input">歌手 - 歌名</label>
      <input type="text" class="ylp-search-input" id="ylp-hs-input" aria-label="歌手 - 歌名"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        data-lpignore="true" data-form-type="other" maxlength="200" />
      <button type="button" class="ylp-search-go">搜尋</button>
    </div>
    <div class="lyrics-content" id="lyrics-content">
      ${renderProgressBar()}
    </div>
    <div class="ylp-resize" title="拖曳調整大小（字會跟著縮放）；按兩下恢復預設大小"></div>
  `;
  
  document.body.appendChild(panel);
  if (ylpKeepMinimized) {
    panel.classList.add('minimized');
    isMinimized = true;
  }
  if (ylpDotMode) panel.classList.add('ylp-dotted'); // 換歌時維持小圓點
  setTimeout(ylpUpdateMinimizeIcon, 0);
  ylpPanelHover = false;
  ylpApplyMiniTransparency();
  
  document.getElementById('close-btn').addEventListener('click', () => {
    if (window.analytics) {
      window.analytics.trackPanelInteraction('close');
    }
    
    ylpStopTap();
    panel.remove();
    lyricsPanel = null;
    ylpExitDot(false);
    ylpCcRender(true); // 關掉面板時，影片上的字幕也一起收起來
  });
  
  document.getElementById('minimize-btn').addEventListener('click', () => {
    panel.classList.toggle('minimized');
    isMinimized = panel.classList.contains('minimized');
    ylpKeepMinimized = isMinimized;
    ylpUpdateMinimizeIcon();
    ylpApplyMiniTransparency();
    
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
  document.getElementById('edit-btn').addEventListener('click', () => ylpOpenEditor());
  ylpSetupHeaderSearch(panel);
  document.getElementById('ylp-dot-btn').addEventListener('click', () => ylpEnterDot());
  // 在面板上按右鍵：折疊（縮成一條標題列）／展開，和按「−」一樣
  // 輸入框、編輯與打點畫面保留原本的右鍵選單；按住 Shift 再按右鍵也會出現瀏覽器原本的選單
  panel.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return;
    if (e.target.closest('input, textarea, select, .ylp-editor, .ylp-tap')) return;
    e.preventDefault();
    document.getElementById('minimize-btn')?.click();
  });
  ylpSetupResize(panel);
  document.getElementById('ylp-cc-btn').addEventListener('click', () => {
    chrome.storage.sync.set({ ccSubs: !ylpSettings.ccSubs });
  });
  ylpUpdateCcButton();

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
    if (e.target.closest('.lyrics-btn, .ylp-offset-ctl')) return;
    
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
  let gen = -1;
  try {
    console.log('🎬 Detecting song from YouTube...');
    
    // PROGRESS: Reset progress
    resetProgress();
    gen = ++ylpSearchGen; // 這次搜尋的編號；之後如果開始別的搜尋，這次的結果就不顯示
    
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
    parsedData._gen = gen;
    
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
    
    // 自己製作的本機歌詞最優先
    const localResult = await ylpGetLocal(videoId);
    if (localResult) {
      isRefreshRequest = false;
      fillAllBoxes('✓ 本機歌詞');
      if (gen !== ylpSearchGen) return;
      displayLyrics(localResult, false);
      return;
    }
    // 同一首歌在別的影片做過歌詞
    const songMatch = await ylpFindLocalBySong(ylpSongCandidates(parsedData));
    if (songMatch) {
      isRefreshRequest = false;
      fillAllBoxes('✓ 本機歌詞（別的影片）');
      if (gen !== ylpSearchGen) return;
      displayLyrics(songMatch, false);
      return;
    }
    
    if (!isRefreshRequest) {
      fillNextBox(cacheLabel);
      const cachedResult = await getCachedLyrics(videoId);
      if (cachedResult) {
        console.log('💾 Using cached lyrics - skipping search');
        fillAllBoxes('✓ 從快取載入');
        await new Promise(resolve => setTimeout(resolve, 150)); // Brief visual feedback
        if (gen !== ylpSearchGen) return;
        displayLyrics(cachedResult, true);
        return;
      }
    }
    
    // Boxes 4-8: Search sources (filled inside searchAllSources with dynamic labels)
    try {
      const result = await ylpSearchAll(parsedData);
      
      // Success: fill remaining boxes
      fillAllBoxes('✓ 找到歌詞');
      
      const hasMusicSection = getMusicInfoFromMusicSection() !== null;
      const confidence = calculateConfidence(parsedData, result, hasMusicSection);
      console.log('📊 Confidence score:', confidence.toFixed(2));
      
      await saveLyricsToCache(videoId, result, parsedData, channelName, confidence);
      
      if (gen !== ylpSearchGen) return;
      
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
        
        const result = await ylpSearchAll(musicParsed);
        
        fillAllBoxes('✓ 找到歌詞');
        
        const confidence = calculateConfidence(musicParsed, result, true);
        await saveLyricsToCache(videoId, result, musicParsed, channelName, confidence);
        
        if (gen !== ylpSearchGen) return;
        
        displayLyrics(result, false);
        return;
      }
      
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    if (gen !== -1 && gen !== ylpSearchGen) return; // 已經有新的搜尋在進行
    
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
            <label class="ylp-field-label" for="ylp-nf-input">輸入「歌手 - 歌名」</label>
            <input 
              type="text" 
              class="manual-search-input" 
              aria-label="歌手 - 歌名"
              id="ylp-nf-input"
              name="no-autofill-error-${Date.now()}"
              autocomplete="new-password"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              inputmode="search"
              data-form-type="other"
              data-lpignore="true"
            />
            <div class="ylp-nf-actions">
              <button class="manual-search-button" id="manual-search-btn-${Date.now()}">搜尋這首</button>
              <button class="manual-search-button ylp-auto-retry-btn" title="清除這部影片的暫存，照影片標題重新自動找一次">🔄 重新自動搜尋</button>
            </div>
            <div class="manual-search-hint">
              💡 請輸入完整的歌手與歌名
            </div>
            <button class="manual-search-button ylp-web-search-btn" style="margin-top: 8px;">
              🔍 手動搜尋（用瀏覽器找歌詞，再貼回來打點）
            </button>
          </div>
        </div>
      `;
      
      setupManualSearchBySelector('.manual-search-box', false);
      content.querySelector('.ylp-auto-retry-btn')?.addEventListener('click', async () => {
        // 不用暫存，照影片標題從頭自動搜尋一次（網路不穩、資料庫剛更新時有用）
        try { if (currentVideoId) await clearCachedLyrics(currentVideoId); } catch (e) { /* 忽略 */ }
        isRefreshRequest = true;
        resetProgress();
        detectAndShowLyrics();
      });
      content.querySelector('.ylp-web-search-btn')?.addEventListener('click', () => {
        ylpWebSearchLyrics();
        ylpOpenEditor();
      });
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
    ylpSearchGen++; // 停止還在進行的自動搜尋，避免它之後蓋掉手動搜尋的結果
    
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
      
      const result = await ylpSearchAll(manualParsed);
      
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
  if (ylpOffsetVideo !== currentVideoId) ylpLoadOffset(currentVideoId);
  ylpLyricsState = result.synced ? 'found' : 'plain';
  if (!result.synced) { currentSyncedLines = []; ylpKaraokeRender(true); ylpCcRender(true); }
  
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
      </div>
      ${result.otherVideo ? '<div class="ylp-other-video">⚠ 這份歌詞是在同一首歌的另一部影片做的，前奏長度不同時會對不上，可以用左上角的 + / − 微調時間。</div>' : ''}
    </div>
  `;
  
  let lyricsHTML = '';
  
  if (result.synced) {
    // 支援一行多個時間標記、[mm:ss]、[offset:]，並依時間排序（順序亂掉會讓高亮卡住）
    const parsedLines = ylpNormalizeLrc(result.lyrics);
    
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
            video.currentTime = Math.max(0, time - ylpOffset);
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
  
  content.innerHTML = metadata + `<div style="padding: 0 20px 20px 20px;">${lyricsHTML}</div>`;
  ylpLastScrolledIndex = -1;
  ylpSyncDirty = true;
  ylpUpdateOffsetUI();
  ylpApplyTranslations();
  
  if (window.analytics) {
    window.analytics.trackLyricsDisplayed(cleanArtist, cleanSong, result.source, result.synced);
  }
  
}

let currentSyncedLines = [];
let syncInterval = null;
let currentLyricsResult = null;
let currentActiveLineIndex = -1;

let ylpSyncRaf = 0;
let ylpSyncShownIndex = null;
let ylpSyncShownMin = null;
let ylpSyncFirstEl = null;

// 每一個畫面更新一次（約 1/60 秒），比原本每 0.1 秒檢查一次準
function ylpSyncFrame() {
  ylpSyncRaf = 0;
  if (!syncInterval || !currentSyncedLines.length) return;
  updateLyricsHighlight();
  ylpSyncRaf = requestAnimationFrame(ylpSyncFrame);
}

function ylpStopSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  if (ylpSyncRaf) { cancelAnimationFrame(ylpSyncRaf); ylpSyncRaf = 0; }
}

function startLyricsSync(parsedLines) {
  currentSyncedLines = parsedLines;
  ylpStopSync();
  ylpSyncDirty = true;
  // 分頁在背景時瀏覽器會暫停畫面更新，用計時器備援
  syncInterval = setInterval(() => { if (!ylpSyncRaf) updateLyricsHighlight(); }, 250);
  ylpSyncRaf = requestAnimationFrame(ylpSyncFrame);
  // 分頁回到前景時重新開始逐格更新
  if (!window.ylpSyncVisBound) {
    window.ylpSyncVisBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && syncInterval && !ylpSyncRaf) ylpSyncRaf = requestAnimationFrame(ylpSyncFrame);
    });
  }
  
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
  
  if (ylpDotMode) { const d = document.getElementById('ylp-dot'); if (d) d.classList.toggle('paused', video.paused); }
  const currentTime = ylpLyricTime(video);
  
  // 二分搜尋：找最後一句「時間 <= 現在」的歌詞
  let lo = 0, hi = currentSyncedLines.length - 1, activeIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (currentSyncedLines[mid].time <= currentTime) { activeIndex = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  
  currentActiveLineIndex = activeIndex;
  ylpKaraokeRender();
  ylpCcRender();
  
  const content = document.getElementById('lyrics-content');
  const lineElements = isMinimized ? [] : document.querySelectorAll('.synced-line');
  const firstEl = isMinimized ? (content && content.querySelector('.lyrics-minimized-view')) : lineElements[0];
  // 只有這一句改變、切換縮小、或面板重畫過時才更新畫面（每格都重畫會拖慢 YouTube）
  const changed = ylpSyncDirty || activeIndex !== ylpSyncShownIndex || isMinimized !== ylpSyncShownMin || firstEl !== ylpSyncFirstEl || !firstEl;
  
  if (changed) {
    ylpSyncDirty = false;
    ylpSyncShownIndex = activeIndex;
    ylpSyncShownMin = isMinimized;
    if (isMinimized) {
      renderMinimizedLyrics();
      ylpSyncFirstEl = content && content.querySelector('.lyrics-minimized-view');
      return;
    }
    ylpSyncFirstEl = firstEl;
    lineElements.forEach((element, index) => {
      const cls = index === activeIndex ? 'active' : index < activeIndex ? 'passed' : 'upcoming';
      if (!element.classList.contains(cls) || element.classList.length > 2) {
        element.classList.remove('active', 'passed', 'upcoming');
        element.classList.add(cls);
      }
    });
  }
  
  if (isMinimized) return;
  
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
    // 換歌前面板是縮小（折疊）的，新面板也維持縮小
    ylpKeepMinimized = !!lyricsPanel && isMinimized;
    if (!lyricsPanel) ylpRemoveSuggestDot(); // 上一部影片的建議圓點先收起來，確認是音樂再出現
    const previousTitle = ylpLastVideoTitle;
    let titleChecks = 0;
    ylpLyricsState = 'searching';
    ylpStopTap(); // 換歌時結束打點，避免空白鍵一直被攔截
    
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
    
    ylpStopSync();
    ylpLoadOffset(newVideoId);
    ylpKaraokeRender(true);
    ylpCcRender(true);
    
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
        
        // 不再自動跳出歌詞：只有按工具列上的外掛圖示時才顯示。
        // 例外：歌詞面板本來就開著時，換下一首會自動找新歌的歌詞。
        const shouldAutoShow = keepLyricsOpen;
        
        if (shouldAutoShow) {
          setTimeout(() => {
            detectAndShowLyrics();
          }, 1000);
        } else if (smartAutoShow) {
          // 音樂影片：出現小圓點，點了才打開歌詞（純音樂除外）
          ylpCheckMusicForDot(newVideoId, title, channelName, isMusicVideo);
        } else {
          ylpRemoveSuggestDot();
        }
      }
    }, 500);
    
    setTimeout(() => clearInterval(checkTitle), 20000); // 網路慢時多等一下
  }
}

let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    if (!/[?&]v=/.test(location.search)) ylpRemoveSuggestDot(); // 離開影片頁時收起建議圓點
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
  
  // 點工具列上的外掛圖示（打開設定視窗）時：歌詞面板還沒開就打開
  if (request.action === 'ylpShowIfClosed') {
    if (ylpDotMode) ylpExitDot(true);
    else if (!lyricsPanel && /[?&]v=/.test(location.search)) detectAndShowLyrics();
    sendResponse({ success: true, opened: true });
  }

  if (request.action === 'detectSong') {
    detectAndShowLyrics();
    sendResponse({ success: true });
  }
  
  if (request.action === 'updateAutoShow') {
    autoShowLyrics = request.enabled === true; // 原版寫成不存在的變數，切換後要重新整理才會生效
    console.log('🔄 Auto-show updated:', autoShowLyrics);
    sendResponse({ success: true });
    if (window.analytics) {
      window.analytics.trackAutoDisplayToggle(request.enabled);
    }
  }

  if (request.action === 'updateSmartAutoShow') {
    smartAutoShow = request.enabled;
    if (!smartAutoShow) ylpRemoveSuggestDot();
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


// 背景程式：安裝時設定預設值，並負責向 Google 翻譯送出翻譯請求
// （中文版已移除原本的使用數據追蹤，不會再把使用紀錄傳到外部伺服器）
'use strict';

importScripts('library-core.js');

// 安裝包裡附的歌詞（bundled-lyrics.json，由「打包給朋友.bat」放入）：安裝或更新時匯入歌詞庫
async function ylpImportBundled() {
  let text;
  try {
    const r = await fetch(chrome.runtime.getURL('bundled-lyrics.json'));
    if (!r.ok) return;
    text = await r.text();
  } catch (e) { return; } // 沒有附歌詞
  try {
    const { songs, exported } = ylpLibParseFile(text, 'bundled-lyrics.json');
    const mark = exported + ':' + songs.length;
    const prev = (await chrome.storage.local.get('ylpBundledMark')).ylpBundledMark;
    if (prev === mark) return; // 這份已經匯入過
    const stats = await ylpLibMerge(songs, 'bundled');
    await chrome.storage.local.set({ ylpBundledMark: mark });
    console.log('[歌詞庫] 安裝包歌詞：' + ylpLibStatsText(stats));
  } catch (e) {
    console.warn('[歌詞庫] 安裝包歌詞讀取失敗：', e.message);
  }
}
chrome.runtime.onStartup.addListener(() => { ylpImportBundled(); });

chrome.runtime.onInstalled.addListener((details) => {
  ylpImportBundled();
  if (details.reason !== 'install') return;
  chrome.storage.sync.set({
    autoShowLyrics: false,  // 所有影片都自動顯示：預設關
    smartAutoShow: true,    // 只在音樂影片自動顯示：預設開
    darkMode: true,
    autoScroll: true,
    pauseSeconds: 4,
    translate: true,
    targetLang: 'zh-TW',
    karaokeWipe: true,
    useYouTubeCaptions: true,
    miniTransparency: 0,
  });
});

const ALLOWED_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'th', 'vi', 'id']);
const MAX_URL_Q = 1800; // 每次請求的文字長度上限（編碼後）

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 歌詞面板上的「📚 歌詞庫」：開新分頁顯示歌詞庫
  if (request && request.action === 'ylpOpenLibrary' && sender.id === chrome.runtime.id) {
    chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
    sendResponse({ ok: true });
    return;
  }
  if (!request || request.action !== 'ylpTranslate') {
    sendResponse({ success: true });
    return;
  }

  // 只接受本外掛在 YouTube 頁面上發出的請求
  const url = (sender.tab && sender.tab.url) || '';
  if (sender.id !== chrome.runtime.id || !/^https:\/\/([a-z]+\.)?youtube\.com\//.test(url)) {
    sendResponse({ ok: false, error: '來源不符' });
    return;
  }
  const texts = Array.isArray(request.texts)
    ? request.texts.filter((t) => typeof t === 'string').map((t) => t.slice(0, 500)).slice(0, 300)
    : [];
  const target = ALLOWED_LANGS.has(request.target) ? request.target : 'zh-TW';

  translateAll(texts, target)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // 非同步回覆
});

async function translateAll(texts, target) {
  // 多句用換行接起來一次送出，減少請求次數
  const out = [];
  let chunk = [];
  let size = 0;
  const flush = async () => {
    if (!chunk.length) return;
    out.push(...(await translateChunk(chunk, target)));
    chunk = [];
    size = 0;
  };
  for (const t of texts) {
    const len = encodeURIComponent(t + '\n').length;
    if (size + len > MAX_URL_Q) await flush();
    chunk.push(t);
    size += len;
  }
  await flush();
  return out;
}

async function translateChunk(lines, target) {
  const joined = await gtx(lines.join('\n'), target);
  const parts = joined.split('\n');
  if (parts.length === lines.length) return parts;
  // 換行對不上時，改成一句一句翻
  const res = [];
  for (const l of lines) res.push((await gtx(l, target)).replace(/\n/g, ' '));
  return res;
}

async function gtx(text, target) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t' +
    '&tl=' + encodeURIComponent(target) +
    '&q=' + encodeURIComponent(text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('回應格式不符');
    return data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
  } finally {
    clearTimeout(timer);
  }
}

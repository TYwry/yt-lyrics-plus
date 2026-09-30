// 在 YouTube 網頁本身的環境執行（world: MAIN），負責兩件事：
// 1. 讀取影片有哪些字幕（CC）可以用
// 2. 記下 YouTube 播放器自己下載的字幕內容，交給外掛當作同步歌詞
// 這裡只轉交字幕，不會讀取或傳送任何其他資料。
(() => {
  'use strict';
  if (window.__ylpBridge) return;
  window.__ylpBridge = true;

  const post = (data) => window.postMessage({ source: 'ylp-page', ...data }, location.origin);

  const report = (url, text) => {
    try {
      if (!url || !text || !String(url).includes('/api/timedtext')) return;
      const u = new URL(url, location.origin);
      post({ type: 'timedtext', videoId: u.searchParams.get('v') || '', lang: u.searchParams.get('lang') || '', text: String(text).slice(0, 2000000) });
    } catch (e) { /* 忽略 */ }
  };

  // 攔截播放器下載字幕的請求（只讀取回應內容，不修改）
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url && url.includes('/api/timedtext')) {
        p.then((res) => res.clone().text().then((t) => report(url, t))).catch(() => {});
      }
    } catch (e) { /* 忽略 */ }
    return p;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url && String(url).includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          try { report(String(url), this.responseType === '' || this.responseType === 'text' ? this.responseText : ''); } catch (e) { /* 忽略 */ }
        });
      }
    } catch (e) { /* 忽略 */ }
    return origOpen.apply(this, arguments);
  };

  const player = () => document.getElementById('movie_player');

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ylp-content') return;
    const { type, id } = e.data;
    const p = player();
    try {
      if (type === 'getTracks') {
        const resp = p && p.getPlayerResponse ? p.getPlayerResponse() : null;
        const list = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        let current = null;
        try { current = p.getOption('captions', 'track'); } catch (err) { /* 字幕模組還沒載入 */ }
        post({
          type: 'tracks', id,
          videoId: resp?.videoDetails?.videoId || '',
          captionsOn: !!(current && current.languageCode),
          tracks: list.map((t) => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode,
            kind: t.kind || '',
            vssId: t.vssId || '',
            name: t.name?.simpleText || (t.name?.runs || []).map((r) => r.text).join('') || '',
          })),
        });
      } else if (type === 'enableTrack') {
        p.loadModule && p.loadModule('captions');
        p.setOption('captions', 'track', { languageCode: e.data.languageCode });
        post({ type: 'ok', id });
      } else if (type === 'disableCaptions') {
        p.setOption('captions', 'track', {});
        post({ type: 'ok', id });
      }
    } catch (err) {
      post({ type: 'error', id, message: String(err && err.message || err) });
    }
  });
})();

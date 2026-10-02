// 歌詞庫頁面：列出、搜尋、編輯、刪除、匯出、匯入本機歌詞
'use strict';

let ylpEntries = [];
const ylpSelected = new Set();
let ylpEditing = null;

const $ = (id) => document.getElementById(id);

function ylpMsg(text, type) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = 'msg' + (type ? ' ' + type : '');
}

function ylpDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function ylpOffsetLabel(v) {
  if (Math.abs(v) < 0.05) return '—';
  return (v > 0 ? '提早 ' : '延後 ') + Math.abs(v).toFixed(1) + ' 秒';
}

const YLP_SOURCE_LABEL = { mine: '自己做的', imported: '匯入', bundled: '安裝包附的' };

function el(tag, props, children) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children || []) if (c != null) e.append(c);
  return e;
}

function ylpFiltered() {
  const q = $('search').value.trim().toLowerCase();
  const list = q
    ? ylpEntries.filter((e) => [e.song, e.artist, e.title, e.videoId].some((v) => String(v || '').toLowerCase().includes(q)))
    : ylpEntries.slice();
  return list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

function ylpRender() {
  const list = ylpFiltered();
  const tbody = $('list');
  tbody.textContent = '';
  $('count').textContent = `共 ${ylpEntries.length} 首歌` + (ylpSelected.size ? `，已勾選 ${ylpSelected.size} 首` : '');
  const empty = $('empty');
  if (!list.length) {
    empty.hidden = false;
    empty.textContent = ylpEntries.length
      ? '找不到符合的歌。'
      : '還沒有任何歌詞。在 YouTube 的歌詞面板按 ✎ 自己製作同步歌詞，或按上方「📂 匯入」朋友傳來的歌詞庫檔案。';
  } else {
    empty.hidden = true;
  }
  for (const e of list) {
    const editing = ylpEditing === e.videoId;
    const cb = el('input', { type: 'checkbox' });
    cb.checked = ylpSelected.has(e.videoId);
    cb.addEventListener('change', () => {
      if (cb.checked) ylpSelected.add(e.videoId); else ylpSelected.delete(e.videoId);
      ylpUpdateButtons();
      $('count').textContent = `共 ${ylpEntries.length} 首歌` + (ylpSelected.size ? `，已勾選 ${ylpSelected.size} 首` : '');
    });

    let songCell;
    let songIn, artistIn;
    if (editing) {
      songIn = el('input', { type: 'text', maxlength: '200', id: 'ylp-edit-song' });
      songIn.value = e.song;
      artistIn = el('input', { type: 'text', maxlength: '200', id: 'ylp-edit-artist' });
      artistIn.value = e.artist;
      songCell = el('td', { class: 'song' }, [
        el('label', { class: 'edit-label', for: 'ylp-edit-song', text: '歌名' }), songIn,
        el('label', { class: 'edit-label', for: 'ylp-edit-artist', text: '歌手' }), artistIn,
      ]);
      const onKey = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) saveEdit(); else if (ev.key === 'Escape') { ylpEditing = null; ylpRender(); } };
      songIn.addEventListener('keydown', onKey);
      artistIn.addEventListener('keydown', onKey);
      setTimeout(() => songIn.focus(), 0);
    } else {
      songCell = el('td', { class: 'song' }, [
        e.song || '（沒有歌名）',
        el('div', { class: 'artist', text: e.artist || '（沒有歌手）' }),
      ]);
    }

    const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(e.videoId);
    const videoCell = el('td', { class: 'video hide-sm' }, [
      el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: '▶ 開啟影片' }),
      el('div', { class: 'vt', title: e.title || e.videoId, text: e.title || e.videoId }),
    ]);

    async function saveEdit() {
      const song = songIn.value.trim();
      if (!song) { ylpMsg('歌名不能空白。', 'err'); songIn.focus(); return; }
      const key = 'ylpLocal:' + e.videoId;
      const cur = (await chrome.storage.local.get(key))[key];
      if (!cur) { ylpMsg('這首歌已經被刪除了。', 'err'); await ylpLoad(); return; }
      cur.song = song;
      cur.artist = artistIn.value.trim();
      await chrome.storage.local.set({ [key]: cur }); // 只改名稱，不改更新時間（避免被當成新版本）
      ylpEditing = null;
      ylpMsg('已儲存。', 'ok');
      await ylpLoad();
    }

    const actions = editing
      ? [
        el('button', { class: 'small primary', text: '儲存', onclick: saveEdit }),
        el('button', { class: 'small', text: '取消', onclick: () => { ylpEditing = null; ylpRender(); } }),
      ]
      : [
        el('button', { class: 'small', text: '改名稱', onclick: () => { ylpEditing = e.videoId; ylpRender(); } }),
        el('button', { class: 'small', text: '匯出', onclick: () => ylpExport([e]) }),
        el('button', { class: 'small danger', text: '刪除', onclick: () => ylpDelete([e]) }),
      ];

    const src = el('span', { class: 'chip' + (e.source === 'mine' ? ' mine' : ''), text: YLP_SOURCE_LABEL[e.source] || '自己做的' });
    tbody.append(el('tr', null, [
      el('td', null, [cb]),
      songCell,
      videoCell,
      el('td', { class: 'num hide-sm', text: e.lineCount + ' 句' }),
      el('td', { class: 'num', text: ylpOffsetLabel(e.offset) }),
      el('td', { class: 'hide-sm' }, [src]),
      el('td', { class: 'num hide-sm', text: ylpDate(e.updated) }),
      el('td', null, [el('div', { class: 'actions' }, actions)]),
    ]));
  }
  const visible = list.map((e) => e.videoId);
  $('checkAll').checked = visible.length > 0 && visible.every((id) => ylpSelected.has(id));
  ylpUpdateButtons();
}

function ylpUpdateButtons() {
  $('exportSelBtn').disabled = ylpSelected.size === 0;
  $('deleteSelBtn').disabled = ylpSelected.size === 0;
  $('exportAllBtn').disabled = ylpEntries.length === 0;
}

async function ylpLoad() {
  ylpEntries = await ylpLibLoadAll();
  const ids = new Set(ylpEntries.map((e) => e.videoId));
  for (const id of [...ylpSelected]) if (!ids.has(id)) ylpSelected.delete(id);
  ylpRender();
}

function ylpExport(entries) {
  if (!entries.length) return;
  const text = ylpLibBuildExport(entries);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `yt-lyrics-library-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  ylpMsg(`已匯出 ${entries.length} 首歌到瀏覽器的下載資料夾（${name}）。把這個檔案傳給朋友，朋友在歌詞庫按「匯入」即可。`, 'ok');
}

async function ylpDelete(entries) {
  if (!entries.length) return;
  const label = entries.length === 1 ? `「${entries[0].song || entries[0].videoId}」` : `這 ${entries.length} 首歌`;
  if (!confirm(`確定要刪除${label}的歌詞嗎？刪除後無法復原。`)) return;
  const keys = [];
  for (const e of entries) keys.push('ylpLocal:' + e.videoId, 'ylpOffset:' + e.videoId, 'lyrics_' + e.videoId);
  await chrome.storage.local.remove(keys);
  for (const e of entries) ylpSelected.delete(e.videoId);
  ylpMsg(`已刪除 ${entries.length} 首。`, 'ok');
  await ylpLoad();
}

async function ylpImportFiles(files) {
  const songs = [];
  const errors = [];
  for (const f of files) {
    if (f.size > YLP_LIB_MAX_FILE) { errors.push(`${f.name}：檔案太大`); continue; }
    try {
      const parsed = ylpLibParseFile(await f.text(), f.name);
      if (!parsed.songs.length) errors.push(`${f.name}：裡面沒有可用的歌詞`);
      songs.push(...parsed.songs);
    } catch (e) {
      errors.push(`${f.name}：${e.message}`);
    }
  }
  let text = '';
  if (songs.length) {
    try {
      const stats = await ylpLibMerge(songs, 'imported');
      text = '匯入完成：' + ylpLibStatsText(stats) + '。';
    } catch (e) {
      const full = String(e && e.message || e).includes('QUOTA');
      errors.push(full ? '儲存空間已滿，請先刪除一些不用的歌再匯入。' : String(e && e.message || e));
    }
  }
  if (errors.length) text += (text ? ' ' : '') + '有問題的檔案：' + errors.join('；');
  ylpMsg(text || '沒有匯入任何歌詞。', errors.length && !songs.length ? 'err' : 'ok');
  await ylpLoad();
}

$('search').addEventListener('input', ylpRender);
$('checkAll').addEventListener('change', () => {
  const visible = ylpFiltered().map((e) => e.videoId);
  if ($('checkAll').checked) visible.forEach((id) => ylpSelected.add(id));
  else visible.forEach((id) => ylpSelected.delete(id));
  ylpRender();
});
$('importBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async () => {
  const files = [...$('fileInput').files];
  $('fileInput').value = '';
  if (files.length) await ylpImportFiles(files);
});
$('exportAllBtn').addEventListener('click', () => ylpExport(ylpEntries));
$('exportSelBtn').addEventListener('click', () => ylpExport(ylpEntries.filter((e) => ylpSelected.has(e.videoId))));
$('deleteSelBtn').addEventListener('click', () => ylpDelete(ylpEntries.filter((e) => ylpSelected.has(e.videoId))));

// 可以直接把檔案拖進頁面匯入
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer && e.dataTransfer.files || [])];
  if (files.length) ylpImportFiles(files);
});

// 其他分頁新增或修改歌詞時自動更新清單
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('ylpLocal:') || k.startsWith('ylpOffset:')) && !ylpEditing) ylpLoad();
});

chrome.storage.sync.get({ darkMode: true }, (s) => {
  document.body.classList.toggle('dark', s.darkMode !== false);
});
ylpLoad();

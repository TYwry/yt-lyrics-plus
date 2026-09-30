// 歌詞庫共用功能：匯出、匯入、合併（歌詞庫頁面與背景程式共用）
// 歌詞存在 chrome.storage.local：
//   ylpLocal:<影片ID>  = { lrc, artist, song, title, source, created, updated }
//   ylpOffset:<影片ID> = 字幕時間微調（秒，正數＝字幕提早）
// source：mine＝自己做的、imported＝從檔案匯入、bundled＝安裝包附的
'use strict';

var YLP_LIB_FORMAT = 'ylp-library';
var YLP_LIB_MAX_FILE = 10 * 1024 * 1024; // 匯入檔案上限 10 MB
var YLP_LIB_MAX_SONGS = 5000;
var YLP_LIB_MAX_LRC = 200 * 1024;         // 每首歌詞上限 200 KB

function ylpLibIsVideoId(id) { return /^[\w-]{11}$/.test(String(id || '')); }

function ylpLibText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 200);
}

// LRC 時間標記解析成 [{ time, text }]（支援一行多個時間、[offset:]）
function ylpLibParseLrc(lrc) {
  const src = String(lrc || '');
  const lines = [];
  const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/im.exec(src);
  const shift = off ? Number(off[1]) / 1000 : 0;
  for (const raw of src.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) {
      const time = parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')) - shift;
      if (Number.isFinite(time)) lines.push({ time: Math.max(0, time), text });
    }
  }
  // 只有時間沒有文字的行＝上一句的結束時間
  lines.sort((a, b) => a.time - b.time || (a.text ? 1 : -1));
  const out = [];
  for (const l of lines) {
    if (l.text) { out.push({ time: l.time, text: l.text }); continue; }
    const prev = out[out.length - 1];
    if (prev && prev.end === undefined && l.time > prev.time) prev.end = l.time;
  }
  return out;
}

function ylpLibFormatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

function ylpLibLinesToLrc(lines) {
  const out = [];
  lines.forEach((l, i) => {
    out.push(`[${ylpLibFormatTime(Math.max(0, l.time))}]${l.text}`);
    const next = lines[i + 1];
    if (Number.isFinite(l.end) && l.end > l.time && (!next || next.time - l.end > 0.05)) out.push(`[${ylpLibFormatTime(Math.max(0, l.end))}]`);
  });
  return out.join('\n');
}

// 把字幕時間微調直接算進歌詞時間（匯出用，對方拿到的就是調好的時間）
function ylpLibBakeOffset(lrc, offset) {
  const off = Number(offset) || 0;
  const lines = ylpLibParseLrc(lrc);
  if (!lines.length) return '';
  return ylpLibLinesToLrc(Math.abs(off) < 0.05 ? lines
    : lines.map((l) => ({ time: l.time - off, text: l.text, end: Number.isFinite(l.end) ? l.end - off : undefined })));
}

// 讀出全部歌詞：[{ videoId, lrc, artist, song, title, source, created, updated, offset, lineCount }]
async function ylpLibLoadAll() {
  const all = await chrome.storage.local.get(null);
  const out = [];
  for (const [k, d] of Object.entries(all)) {
    if (!k.startsWith('ylpLocal:') || !d || typeof d.lrc !== 'string') continue;
    const videoId = k.slice(9);
    const offset = Number(all['ylpOffset:' + videoId]) || 0;
    out.push({
      videoId,
      lrc: d.lrc,
      artist: d.artist || '',
      song: d.song || '',
      title: d.title || '',
      source: d.source || 'mine',
      created: Number(d.created) || Number(d.updated) || 0,
      updated: Number(d.updated) || 0,
      offset,
      lineCount: ylpLibParseLrc(d.lrc).length,
    });
  }
  return out;
}

// 產生匯出檔內容（JSON）
function ylpLibBuildExport(entries) {
  return JSON.stringify({
    format: YLP_LIB_FORMAT,
    version: 1,
    exported: Date.now(),
    songs: entries.map((e) => ({
      videoId: e.videoId,
      song: e.song,
      artist: e.artist,
      title: e.title,
      updated: e.updated || Date.now(),
      lrc: ylpLibBakeOffset(e.lrc, e.offset),
    })).filter((s) => s.lrc),
  }, null, 1);
}

// 解析匯入的檔案（歌詞庫 .json 或單首 .lrc）→ { songs: [...], exported }
function ylpLibParseFile(text, fileName) {
  const t = String(text || '').replace(/^﻿/, '');
  if (t.length > YLP_LIB_MAX_FILE) throw new Error('檔案太大');
  if (/^\s*\{/.test(t)) {
    let data;
    try { data = JSON.parse(t); } catch (e) { throw new Error('檔案格式不正確'); }
    if (!data || data.format !== YLP_LIB_FORMAT || !Array.isArray(data.songs)) throw new Error('這不是 YT 歌詞的歌詞庫檔案');
    return { songs: data.songs.slice(0, YLP_LIB_MAX_SONGS).map(ylpLibCleanSong).filter(Boolean), exported: Number(data.exported) || 0 };
  }
  // 單首 .lrc：需要有 [yt:影片ID] 才知道是哪部影片
  const id = (/^\s*\[yt:([\w-]{11})\]/m.exec(t) || [])[1];
  if (!id) throw new Error('這個 .lrc 檔沒有記錄是哪一部影片（缺少 [yt:影片ID]），請在那部影片的 ✎ 編輯畫面匯入');
  const tag = (name) => ylpLibText((new RegExp('^\\s*\\[' + name + ':([^\\]]*)\\]', 'mi').exec(t) || [])[1]);
  const song = ylpLibCleanSong({ videoId: id, song: tag('ti') || String(fileName || '').replace(/\.[^.]+$/, ''), artist: tag('ar'), title: '', lrc: t, updated: Date.now() });
  return { songs: song ? [song] : [], exported: 0 };
}

function ylpLibCleanSong(s) {
  if (!s || !ylpLibIsVideoId(s.videoId) || typeof s.lrc !== 'string' || s.lrc.length > YLP_LIB_MAX_LRC) return null;
  const lines = ylpLibParseLrc(s.lrc);
  if (lines.length < 2) return null;
  return {
    videoId: s.videoId,
    song: ylpLibText(s.song),
    artist: ylpLibText(s.artist),
    title: ylpLibText(s.title, 300),
    updated: Math.min(Number(s.updated) || 0, Date.now()),
    lrc: ylpLibLinesToLrc(lines),
  };
}

// 合併進歌詞庫。source：imported 或 bundled
// 規則：沒有的直接加入；已經有的，只有對方比較新才更新；自己做的（mine）一律不覆蓋
async function ylpLibMerge(songs, source) {
  const stats = { added: 0, updated: 0, skippedOld: 0, skippedMine: 0 };
  if (!songs.length) return stats;
  const keys = songs.map((s) => 'ylpLocal:' + s.videoId);
  const existing = await chrome.storage.local.get(keys);
  const toSet = {};
  const clearOffset = [];
  const clearCache = [];
  for (const s of songs) {
    const key = 'ylpLocal:' + s.videoId;
    const cur = existing[key] || toSet[key];
    if (cur) {
      if ((cur.source || 'mine') === 'mine') { stats.skippedMine++; continue; }
      if ((Number(cur.updated) || 0) >= s.updated) { stats.skippedOld++; continue; }
      stats.updated++;
    } else {
      stats.added++;
    }
    const now = Date.now();
    toSet[key] = {
      lrc: s.lrc, artist: s.artist, song: s.song, title: s.title,
      source, created: (cur && Number(cur.created)) || now, updated: s.updated || now,
    };
    // 匯入的歌詞已經包含對方調好的時間，原本的微調要清掉，避免重複計算
    clearOffset.push('ylpOffset:' + s.videoId);
    clearCache.push('lyrics_' + s.videoId);
  }
  if (Object.keys(toSet).length) {
    await chrome.storage.local.set(toSet);
    await chrome.storage.local.remove(clearOffset.concat(clearCache));
  }
  return stats;
}

function ylpLibStatsText(st) {
  const parts = [];
  if (st.added) parts.push(`新增 ${st.added} 首`);
  if (st.updated) parts.push(`更新 ${st.updated} 首`);
  if (st.skippedOld) parts.push(`${st.skippedOld} 首已經是最新的`);
  if (st.skippedMine) parts.push(`${st.skippedMine} 首你自己做過，沒有覆蓋`);
  return parts.length ? parts.join('、') : '沒有可匯入的歌詞';
}

// 歌詞面板的主題顏色（設定視窗與 YouTube 頁面共用）
// stops：背景顏色（由左上到右下）；text：文字顏色；accent：目前這一句與按鈕的顏色
var YLP_THEMES = {
  dark:    { name: '深夜黑（預設）', stops: ['#1c1c1e', '#1c1c1e'], angle: 180, text: '#f5f5f7', accent: '#0A84FF' },
  aurora:  { name: '極光',           stops: ['#0f2027', '#203a43', '#2c5364'], angle: 135, text: '#eafffb', accent: '#5ee7df' },
  dusk:    { name: '暮色紫',         stops: ['#41295a', '#2f0743'], angle: 135, text: '#fbeaff', accent: '#ff9a8b' },
  ocean:   { name: '深海藍',         stops: ['#1e3c72', '#2a5298'], angle: 135, text: '#eef4ff', accent: '#7fd3ff' },
  forest:  { name: '森林',           stops: ['#134e3a', '#0b2e22'], angle: 160, text: '#eafff3', accent: '#b8f26b' },
};

var YLP_THEME_DEFAULTS = {
  theme: 'dark',
  customBg1: '#232526',
  customBg2: '#414345',
  customText: '#ffffff',
  customAccent: '#f72585',
  panelTransparency: 0,
  // 卡拉OK字幕顏色
  karaokeTheme: 'auto',
  karaokeText: '#ffffff',
  karaokeFill: '#5ec8ff',
  karaokeTr: '#ffe58a',
  // 影片上的字幕（類似 CC）
  ccSubs: false,
  ccSize: 'm',
};

// 卡拉OK字幕的配色：text＝還沒唱到的字、fill＝填色動畫（唱過的字）、tr＝翻譯
var YLP_KARAOKE_THEMES = {
  auto:    { name: '跟隨面板主題' },
  classic: { name: '經典藍', text: '#ffffff', fill: '#5ec8ff', tr: '#ffe58a' },
  sakura:  { name: '櫻花粉', text: '#ffffff', fill: '#ff6fae', tr: '#ffd1e6' },
  gold:    { name: '金色',   text: '#ffffff', fill: '#ffc93c', tr: '#fff1b8' },
  neon:    { name: '螢光綠', text: '#ffffff', fill: '#39ff88', tr: '#c8ffe0' },
  fire:    { name: '火焰',   text: '#fff4e0', fill: '#ff5a36', tr: '#ffd166' },
  violet:  { name: '紫羅蘭', text: '#f3e8ff', fill: '#b983ff', tr: '#ffd6f5' },
};

// 依設定取得卡拉OK配色；panelAccent＝目前面板主題的強調色（「跟隨面板主題」用）
function ylpResolveKaraokeTheme(s, panelAccent) {
  s = s || {};
  const d = YLP_THEME_DEFAULTS;
  if (s.karaokeTheme === 'custom') {
    return {
      name: '自訂',
      text: ylpIsHex(s.karaokeText) ? s.karaokeText : d.karaokeText,
      fill: ylpIsHex(s.karaokeFill) ? s.karaokeFill : d.karaokeFill,
      tr: ylpIsHex(s.karaokeTr) ? s.karaokeTr : d.karaokeTr,
    };
  }
  const t = YLP_KARAOKE_THEMES[s.karaokeTheme];
  if (t && t.fill) return t;
  // 跟隨面板主題：用面板的強調色填色；太暗的顏色在影片上看不清楚，改用亮藍色
  const a = ylpIsHex(panelAccent) && ylpLuminance(panelAccent) > 0.2 ? panelAccent : d.karaokeFill;
  return { name: YLP_KARAOKE_THEMES.auto.name, text: '#ffffff', fill: a, tr: '#ffe58a' };
}

function ylpHexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ylpRgba(hex, a) {
  const [r, g, b] = ylpHexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

// 相對亮度（0＝黑、1＝白），用來判斷該配深色還是淺色文字
function ylpLuminance(hex) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const [r, g, b] = ylpHexToRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ylpIsHex(v) { return /^#[0-9a-f]{6}$/i.test(String(v || '')); }

// 依設定取得主題（自訂主題用使用者選的顏色）
function ylpResolveTheme(s) {
  s = s || {};
  if (s.theme === 'custom') {
    const bg1 = ylpIsHex(s.customBg1) ? s.customBg1 : YLP_THEME_DEFAULTS.customBg1;
    const bg2 = ylpIsHex(s.customBg2) ? s.customBg2 : bg1;
    return {
      name: '自訂',
      stops: [bg1, bg2],
      angle: 135,
      text: ylpIsHex(s.customText) ? s.customText : YLP_THEME_DEFAULTS.customText,
      accent: ylpIsHex(s.customAccent) ? s.customAccent : YLP_THEME_DEFAULTS.customAccent,
    };
  }
  return YLP_THEMES[s.theme] || YLP_THEMES.dark;
}

// 主題是不是淺色（背景亮）
function ylpThemeIsLight(theme) {
  const avg = theme.stops.reduce((sum, c) => sum + ylpLuminance(c), 0) / theme.stops.length;
  return avg > 0.4;
}

// 背景 CSS；alpha＝不透明度（0～1）
function ylpThemeBackground(theme, alpha) {
  const stops = theme.stops.map((c) => ylpRgba(c, alpha));
  return `linear-gradient(${theme.angle || 135}deg, ${stops.join(', ')})`;
}

if (typeof window !== 'undefined') {
  window.YLP_THEMES = YLP_THEMES;
  window.YLP_KARAOKE_THEMES = YLP_KARAOKE_THEMES;
}

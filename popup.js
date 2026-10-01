console.log('🎵 Popup loaded');

let autoShowEnabled = true;
let darkModeEnabled = true;
let smartAutoShowEnabled = true;
let currentLanguage = 'zh';

// === 3-STEP TUTORIAL SYSTEM ===

const TUTORIAL_SEQUENCE = [
  {
    id: 'showLyricsNow',
    target: '#showLyricsBtn',
    textKey: 'tutorialShowLyricsNow'
  },
  {
    id: 'autoShow',
    target: '#autoShowRow',
    textKey: 'tutorialAutoShow'
  },
  {
    id: 'smartAutoShow',
    target: '#smartAutoShowRow',
    textKey: 'tutorialSmartAutoShow'
  }
];

class SequentialTutorial {
  constructor() {
    this.spotlight = document.getElementById('tutorialSpotlight');
    this.tooltip = document.getElementById('tutorialTooltip');
    this.tooltipText = document.getElementById('tutorialText');
    this.button = document.getElementById('tutorialButton');
    this.progress = document.getElementById('tutorialProgress');
    this.skip = document.getElementById('tutorialSkip');
    
    this.currentStep = 0;
    this.isActive = false;
    this.storageKey = 'tutorial_completed';
    
    this.setupEvents();
  }

  setupEvents() {
    this.button.addEventListener('click', () => this.nextStep());
    this.skip.addEventListener('click', () => this.skipTour());
    
    // Click spotlight to advance
    this.spotlight.addEventListener('click', () => this.nextStep());
  }

  async hasCompleted() {
    try {
      const result = await chrome.storage.local.get([this.storageKey]);
      return result[this.storageKey] === true;
    } catch (error) {
      console.error('Tutorial check error:', error);
      return false;
    }
  }

  async markCompleted() {
    try {
      await chrome.storage.local.set({ [this.storageKey]: true });
      console.log('✅ Tutorial marked as completed');
    } catch (error) {
      console.error('Tutorial save error:', error);
    }
  }

  async start(lang = 'en') {
    const completed = await this.hasCompleted();
    if (completed) {
      console.log('✅ Tutorial already completed');
      return;
    }

    console.log('🎓 Starting tutorial...');
    this.currentStep = 0;
    this.isActive = true;
    this.showStep(lang);
  }

  showStep(lang) {
    if (this.currentStep >= TUTORIAL_SEQUENCE.length) {
      this.complete();
      return;
    }

    const step = TUTORIAL_SEQUENCE[this.currentStep];
    const target = document.querySelector(step.target);
    
    if (!target) {
      console.log('❌ Target not found:', step.target);
      this.nextStep();
      return;
    }

    console.log(`📍 Tutorial step ${this.currentStep + 1}/${TUTORIAL_SEQUENCE.length}`);

    // Update progress
    this.progress.textContent = `${this.currentStep + 1}/${TUTORIAL_SEQUENCE.length}`;
    
    // Update text
    const text = t(step.textKey, lang);
    this.tooltipText.textContent = text;
    
    // Update button text
    const isLast = this.currentStep === TUTORIAL_SEQUENCE.length - 1;
    this.button.textContent = isLast ? t('tutorialGotIt', lang) : t('tutorialNext', lang);
    
    // Get target position relative to viewport
    const rect = target.getBoundingClientRect();
    
    // Position spotlight - use viewport coordinates since we're absolute
    this.spotlight.style.top = rect.top + 'px';
    this.spotlight.style.left = rect.left + 'px';
    this.spotlight.style.width = rect.width + 'px';
    this.spotlight.style.height = rect.height + 'px';
    this.spotlight.style.display = 'block';
    this.spotlight.style.opacity = '1';
    
    console.log(`Spotlight positioned at: top=${rect.top}, left=${rect.left}, width=${rect.width}, height=${rect.height}`);
    
    // Position tooltip below target
    const tooltipHeight = 140;
    let tooltipTop = rect.bottom + 12;
    let tooltipLeft = Math.max(16, Math.min(
      rect.left + (rect.width / 2) - 140,
      340 - 280 - 16
    ));
    
    // If tooltip goes off bottom, position above
    const popupHeight = document.body.offsetHeight;
    if (tooltipTop + tooltipHeight > popupHeight) {
      tooltipTop = rect.top - tooltipHeight - 12;
    }
    
    this.tooltip.style.top = tooltipTop + 'px';
    this.tooltip.style.left = tooltipLeft + 'px';
    
    // Show tooltip with delay
    setTimeout(() => {
      this.tooltip.classList.add('active');
    }, 100);
  }

  nextStep() {
    this.tooltip.classList.remove('active');
    
    setTimeout(() => {
      this.currentStep++;
      
      if (this.currentStep < TUTORIAL_SEQUENCE.length) {
        this.showStep(currentLanguage);
      } else {
        this.complete();
      }
    }, 300);
  }

  skipTour() {
    console.log('⏭️ Tutorial skipped');
    this.tooltip.classList.remove('active');
    
    setTimeout(() => {
      this.spotlight.style.display = 'none';
      this.spotlight.style.opacity = '0';
      this.isActive = false;
      this.markCompleted();
    }, 300);
  }

  complete() {
    console.log('✅ Tutorial completed!');
    this.tooltip.classList.remove('active');
    
    setTimeout(() => {
      this.spotlight.style.display = 'none';
      this.spotlight.style.opacity = '0';
      this.isActive = false;
      this.markCompleted();
    }, 300);
  }

  cleanup() {
    if (this.isActive) {
      this.skipTour();
    }
  }
}

const tutorial = new SequentialTutorial();

window.addEventListener('beforeunload', () => {
  tutorial.cleanup();
});

// === TRANSLATION SYSTEM ===

function applyTranslations(lang) {
  currentLanguage = lang;
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    const translation = t(key, lang);
    if (translation) {
      element.textContent = translation;
    }
  });
  console.log('🌍 UI translated to:', lang);
}

// 介面固定為繁體中文
applyTranslations('zh');

// === SETTINGS LOAD ===

chrome.storage.sync.get(['smartAutoShow'], (result) => {
  smartAutoShowEnabled = result.smartAutoShow !== false;
  console.log('🎵 Loaded smartAutoShow:', smartAutoShowEnabled);
  updateSmartAutoToggleUI();
});

if (window.analytics) {
  window.analytics.trackPageView('/popup', 'Extension Popup');
}

chrome.storage.sync.get(['autoShowLyrics', 'darkMode'], (result) => {
  autoShowEnabled = result.autoShowLyrics !== false;
  darkModeEnabled = result.darkMode !== false;
  console.log('🎵 Loaded settings - Auto:', autoShowEnabled, '| Dark:', darkModeEnabled);
  updateToggleUI();
});

// === START TUTORIAL ===
setTimeout(async () => {
  console.log('🎓 Attempting to start tutorial...');
  await tutorial.start(currentLanguage);
}, 800);

// === TOGGLE HANDLERS ===

document.getElementById('autoToggle').addEventListener('click', function() {
  autoShowEnabled = !autoShowEnabled;
  console.log('🎵 Auto-show toggled:', autoShowEnabled);
  
  updateToggleUI();
  
  chrome.storage.sync.set({ autoShowLyrics: autoShowEnabled }, () => {
    console.log('💾 Auto-show saved:', autoShowEnabled);
    
    chrome.runtime.sendMessage({
      action: 'trackEvent',
      eventName: 'setting_changed',
      params: {
        setting_name: 'auto_display',
        setting_value: autoShowEnabled ? 'on' : 'off',
        changed_from: 'popup',
      }
    });
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'updateAutoShow',
          enabled: autoShowEnabled
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.log('Could not notify content script');
          }
        });
      }
    });
  });
});

document.getElementById('smartAutoToggle').addEventListener('click', function() {
  smartAutoShowEnabled = !smartAutoShowEnabled;
  console.log('🎵 Smart auto-show toggled:', smartAutoShowEnabled);
  
  updateSmartAutoToggleUI();
  
  chrome.storage.sync.set({ smartAutoShow: smartAutoShowEnabled }, () => {
    console.log('💾 Smart auto-show saved:', smartAutoShowEnabled);
    
    chrome.runtime.sendMessage({
      action: 'trackEvent',
      eventName: 'setting_changed',
      params: {
        setting_name: 'smart_auto_show',
        setting_value: smartAutoShowEnabled ? 'on' : 'off',
        changed_from: 'popup',
      }
    });
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'updateSmartAutoShow',
          enabled: smartAutoShowEnabled
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.log('Could not notify content script');
          }
        });
      }
    });
  });
});

document.getElementById('darkToggle').addEventListener('click', function() {
  darkModeEnabled = !darkModeEnabled;
  console.log('🌙 Dark mode toggled:', darkModeEnabled);
  
  updateToggleUI();
  
  chrome.storage.sync.set({ darkMode: darkModeEnabled }, () => {
    console.log('💾 Dark mode saved:', darkModeEnabled);
    
    chrome.runtime.sendMessage({
      action: 'trackEvent',
      eventName: 'setting_changed',
      params: {
        setting_name: 'theme',
        setting_value: darkModeEnabled ? 'dark' : 'light',
        changed_from: 'popup',
      }
    });
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'updateDarkMode',
          enabled: darkModeEnabled
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.log('Could not notify content script');
          }
        });
      }
    });
  });
});

document.getElementById('refreshBtn').addEventListener('click', async function() {
  const btn = this;
  const statusContainer = document.getElementById('statusContainer');
  
  btn.disabled = true;
  btn.classList.add('spinning');
  
  showStatus('🔄 ' + t('refreshingExtension', currentLanguage), 'warning');
  
  chrome.runtime.sendMessage({
    action: 'trackEvent',
    eventName: 'popup_action',
    params: {
      action_type: 'refresh_clicked',
    }
  });
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('youtube.com/watch')) {
      showStatus('⚠️ ' + t('pleaseOpenYouTubeVideo', currentLanguage), 'warning');
      setTimeout(() => statusContainer.innerHTML = '', 2000);
      btn.disabled = false;
      btn.classList.remove('spinning');
      return;
    }
    
    chrome.tabs.sendMessage(tab.id, { action: 'refreshExtension' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('⚠️ Content script not loaded, reloading tab...');
        
        chrome.tabs.reload(tab.id, {}, () => {
          setTimeout(() => {
            showStatus('✅ ' + t('tabRefreshed', currentLanguage), 'success');
            btn.disabled = false;
            btn.classList.remove('spinning');
            setTimeout(() => statusContainer.innerHTML = '', 3000);
          }, 1000);
        });
      } else {
        showStatus('✅ ' + t('extensionRefreshed', currentLanguage), 'success');
        btn.disabled = false;
        btn.classList.remove('spinning');
        setTimeout(() => statusContainer.innerHTML = '', 2000);
      }
    });
    
  } catch (error) {
    showStatus('❌ ' + t('refreshFailed', currentLanguage) + ': ' + error.message, 'error');
    btn.disabled = false;
    btn.classList.remove('spinning');
    setTimeout(() => statusContainer.innerHTML = '', 2000);
  }
});

function updateToggleUI() {
  const autoToggle = document.getElementById('autoToggle');
  const darkToggle = document.getElementById('darkToggle');
  updateSmartAutoToggleUI();
  
  if (autoShowEnabled) {
    autoToggle.classList.add('active');
  } else {
    autoToggle.classList.remove('active');
  }
  
  if (darkModeEnabled) {
    darkToggle.classList.add('active');
    document.body.classList.add('dark-mode');
  } else {
    darkToggle.classList.remove('active');
    document.body.classList.remove('dark-mode');
  }
}

function updateSmartAutoToggleUI() {
  const smartAutoToggle = document.getElementById('smartAutoToggle');
  if (smartAutoToggle) {
    if (smartAutoShowEnabled) {
      smartAutoToggle.classList.add('active');
    } else {
      smartAutoToggle.classList.remove('active');
    }
  }
}

document.getElementById('showLyricsBtn').addEventListener('click', async () => {
  const statusContainer = document.getElementById('statusContainer');
  const btn = document.getElementById('showLyricsBtn');
  
  btn.disabled = true;
  btn.textContent = '⏳ ' + t('searching', currentLanguage);
  showStatus('🤖 ' + t('aiAnalyzingTitle', currentLanguage), 'warning');
  
  chrome.runtime.sendMessage({
    action: 'trackEvent',
    eventName: 'popup_action',
    params: {
      action_type: 'show_lyrics_clicked',
    }
  });
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('youtube.com/watch')) {
      showStatus('❌ ' + t('pleaseOpenYouTubeVideo', currentLanguage), 'error');
      btn.textContent = '🔍 ' + t('showLyricsNow', currentLanguage);
      btn.disabled = false;
      setTimeout(() => statusContainer.innerHTML = '', 2000);
      return;
    }
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['themes.js', 'content.js']
      });
      console.log('✅ Content script injected');
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
      console.log('Content script may already be loaded:', e.message);
    }
    
    let attempt = 0;
    const maxAttempts = 3;
    let success = false;
    
    while (attempt < maxAttempts && !success) {
      attempt++;
      console.log(`Attempt ${attempt}/${maxAttempts}`);
      
      try {
        const response = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, { action: 'detectSong' }, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          });
        });
        
        if (response && response.success) {
          showStatus('✅ ' + t('lyricsPanelOpened', currentLanguage), 'success');
          success = true;
        } else {
          showStatus('❌ ' + t('couldNotDetectSong', currentLanguage), 'error');
          success = true;
        }
      } catch (error) {
        console.log(`Attempt ${attempt} failed:`, error.message);
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          showStatus('❌ ' + t('pleaseRefreshAndTryAgain', currentLanguage), 'error');
        }
      }
    }
    
    btn.textContent = '🔍 ' + t('showLyricsNow', currentLanguage);
    btn.disabled = false;
    setTimeout(() => statusContainer.innerHTML = '', 3000);
    
  } catch (error) {
    showStatus('❌ ' + error.message, 'error');
    btn.textContent = '🔍 ' + t('showLyricsNow', currentLanguage);
    btn.disabled = false;
    setTimeout(() => statusContainer.innerHTML = '', 2000);
  }
});

function showStatus(message, type = 'success') {
  const statusContainer = document.getElementById('statusContainer');
  statusContainer.innerHTML = `
    <div class="status-card ${type}">
      <div class="status-text"></div>
    </div>
  `;
  statusContainer.querySelector('.status-text').textContent = message; // 用純文字顯示，避免插入網頁程式碼
}

// === 捲動與翻譯設定 ===
const YLP_DEFAULTS = { autoScroll: true, pauseSeconds: 4, translate: true, targetLang: 'zh-TW', karaokeWipe: true, useYouTubeCaptions: true, miniTransparency: 0, tapKey: 'Enter', undoKey: 'Backspace', ...YLP_THEME_DEFAULTS };

chrome.storage.sync.get(YLP_DEFAULTS, (s) => {
  document.getElementById('autoScrollToggle').classList.toggle('active', s.autoScroll !== false);
  document.getElementById('translateToggle').classList.toggle('active', s.translate !== false);
  document.getElementById('karaokeWipeToggle').classList.toggle('active', s.karaokeWipe !== false);
  document.getElementById('ytCaptionsToggle').classList.toggle('active', s.useYouTubeCaptions !== false);
  document.getElementById('miniTransparency').value = s.miniTransparency;
  document.getElementById('miniTransparencyValue').textContent = s.miniTransparency + '%';
  document.getElementById('pauseSeconds').value = s.pauseSeconds;
  document.getElementById('targetLangSelect').value = s.targetLang;
});

for (const [id, key] of [['autoScrollToggle', 'autoScroll'], ['translateToggle', 'translate'], ['karaokeWipeToggle', 'karaokeWipe'], ['ytCaptionsToggle', 'useYouTubeCaptions']]) {
  document.getElementById(id).addEventListener('click', function () {
    const on = !this.classList.contains('active');
    this.classList.toggle('active', on);
    chrome.storage.sync.set({ [key]: on });
  });
}

document.getElementById('pauseSeconds').addEventListener('change', function () {
  const n = Math.min(60, Math.max(0, parseInt(this.value, 10) || 0));
  this.value = n;
  chrome.storage.sync.set({ pauseSeconds: n });
});

document.getElementById('miniTransparency').addEventListener('input', function () {
  const n = Math.min(90, Math.max(0, parseInt(this.value, 10) || 0));
  document.getElementById('miniTransparencyValue').textContent = n + '%';
  // 拖動中：只即時預覽目前分頁，不寫入設定
  ylpPreview({ miniTransparency: n });
});
// 放開滑桿時才儲存（Chrome 同步設定每分鐘最多寫入 120 次，拖動時一直寫會被擋下，導致設定失效）
document.getElementById('miniTransparency').addEventListener('change', function () {
  const n = Math.min(90, Math.max(0, parseInt(this.value, 10) || 0));
  chrome.storage.sync.set({ miniTransparency: n });
});

document.getElementById('targetLangSelect').addEventListener('change', function () {
  chrome.storage.sync.set({ targetLang: this.value });
});

// 翻譯開關也能從歌詞面板的「譯」按鈕切換，這裡同步顯示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'translate' in changes) {
    document.getElementById('translateToggle').classList.toggle('active', changes.translate.newValue !== false);
  }
});


// === 外觀：主題、自訂顏色、背景透明度 ===
let ylpPopupSettings = { ...YLP_DEFAULTS };

// 即時預覽到目前分頁（不寫入設定）
function ylpPreview(values) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'ylpPreview', values }, () => void chrome.runtime.lastError);
  });
}

function ylpRenderThemeGrid() {
  const grid = document.getElementById('themeGrid');
  grid.textContent = '';
  const entries = Object.entries(YLP_THEMES).concat([['custom', ylpResolveTheme({ ...ylpPopupSettings, theme: 'custom' })]]);
  for (const [key, th] of entries) {
    const b = document.createElement('button');
    b.className = 'theme-swatch' + (ylpPopupSettings.theme === key ? ' selected' : '');
    b.style.background = ylpThemeBackground(th, 1);
    b.style.color = th.text;
    b.title = key === 'custom' ? '自訂' : th.name;
    b.textContent = key === 'custom' ? '自訂' : th.name.replace('（預設）', '');
    b.addEventListener('click', () => ylpSelectTheme(key));
    grid.appendChild(b);
  }
  const cur = ylpPopupSettings.theme === 'custom' ? '自訂' : (YLP_THEMES[ylpPopupSettings.theme] || YLP_THEMES.dark).name;
  document.getElementById('themeName').textContent = '目前：' + cur;
  document.getElementById('customThemeRow').style.display = ylpPopupSettings.theme === 'custom' ? '' : 'none';
}

function ylpSelectTheme(key) {
  ylpPopupSettings.theme = key;
  const light = ylpThemeIsLight(ylpResolveTheme(ylpPopupSettings));
  // 淺色主題時，設定視窗與輸入框也跟著用淺色
  chrome.storage.sync.set({ theme: key, darkMode: !light });
  darkModeEnabled = !light;
  updateToggleUI();
  ylpRenderThemeGrid();
  ylpRenderKaraokeGrid();
}

chrome.storage.sync.get(YLP_DEFAULTS, (s) => {
  ylpPopupSettings = { ...YLP_DEFAULTS, ...s };
  // 已移除的主題（例如舊版的拼色主題）改回預設
  if (ylpPopupSettings.theme !== 'custom' && !YLP_THEMES[ylpPopupSettings.theme]) ylpPopupSettings.theme = 'dark';
  for (const id of ['customBg1', 'customBg2', 'customText', 'customAccent']) document.getElementById(id).value = ylpPopupSettings[id];
  document.getElementById('panelTransparency').value = ylpPopupSettings.panelTransparency;
  document.getElementById('panelTransparencyValue').textContent = ylpPopupSettings.panelTransparency + '%';
  document.getElementById('tapKeyBtn').textContent = ylpPopupKeyLabel(ylpPopupSettings.tapKey);
  document.getElementById('undoKeyBtn').textContent = ylpPopupKeyLabel(ylpPopupSettings.undoKey);
  ylpRenderThemeGrid();
  for (const id of ['karaokeText', 'karaokeFill', 'karaokeTr']) document.getElementById(id).value = ylpPopupSettings[id];
  document.getElementById('ccToggle').classList.toggle('active', !!ylpPopupSettings.ccSubs);
  document.getElementById('ccSizeSelect').value = ['s', 'm', 'l'].includes(ylpPopupSettings.ccSize) ? ylpPopupSettings.ccSize : 'm';
  ylpRenderKaraokeGrid();
});

// === 卡拉OK與影片字幕 ===
function ylpRenderKaraokeGrid() {
  const grid = document.getElementById('karaokeGrid');
  grid.textContent = '';
  const panelAccent = ylpResolveTheme(ylpPopupSettings).accent;
  let selected = ylpPopupSettings.karaokeTheme;
  if (selected !== 'custom' && !YLP_KARAOKE_THEMES[selected]) selected = 'auto';
  const keys = Object.keys(YLP_KARAOKE_THEMES).concat(['custom']);
  for (const key of keys) {
    const k = ylpResolveKaraokeTheme({ ...ylpPopupSettings, karaokeTheme: key }, panelAccent);
    const b = document.createElement('button');
    b.className = 'theme-swatch k-swatch' + (selected === key ? ' selected' : '');
    b.title = k.name;
    const sample = document.createElement('span');
    sample.className = 'k-sample';
    const done = document.createElement('span');
    done.style.color = k.fill;
    done.textContent = '卡拉';
    const rest = document.createElement('span');
    rest.style.color = k.text;
    rest.textContent = 'OK';
    sample.append(done, rest);
    const name = document.createElement('span');
    name.className = 'k-name';
    name.textContent = key === 'auto' ? '跟隨面板' : k.name;
    b.append(sample, name);
    b.addEventListener('click', () => {
      ylpPopupSettings.karaokeTheme = key;
      chrome.storage.sync.set({ karaokeTheme: key });
      ylpRenderKaraokeGrid();
    });
    grid.appendChild(b);
  }
  document.getElementById('karaokeThemeName').textContent = '目前：' + (selected === 'custom' ? '自訂' : YLP_KARAOKE_THEMES[selected].name);
  document.getElementById('karaokeCustomRow').style.display = selected === 'custom' ? '' : 'none';
}

for (const id of ['karaokeText', 'karaokeFill', 'karaokeTr']) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => {           // 拖動調色盤時即時預覽
    ylpPopupSettings[id] = el.value;
    ylpPreview({ [id]: el.value, karaokeTheme: 'custom' });
    ylpRenderKaraokeGrid();
  });
  el.addEventListener('change', () => {          // 確定後才儲存
    ylpPopupSettings[id] = el.value;
    chrome.storage.sync.set({ [id]: el.value, karaokeTheme: 'custom' });
  });
}

document.getElementById('ccToggle').addEventListener('click', function () {
  const on = !this.classList.contains('active');
  this.classList.toggle('active', on);
  ylpPopupSettings.ccSubs = on;
  chrome.storage.sync.set({ ccSubs: on });
});
document.getElementById('ccSizeSelect').addEventListener('change', function () {
  chrome.storage.sync.set({ ccSize: this.value });
});
// 「CC」按鈕也能在歌詞面板切換，這裡同步顯示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'ccSubs' in changes) {
    ylpPopupSettings.ccSubs = !!changes.ccSubs.newValue;
    document.getElementById('ccToggle').classList.toggle('active', ylpPopupSettings.ccSubs);
  }
});

for (const id of ['customBg1', 'customBg2', 'customText', 'customAccent']) {
  const el = document.getElementById(id);
  el.addEventListener('input', () => {           // 拖動調色盤時即時預覽
    ylpPopupSettings[id] = el.value;
    ylpPreview({ [id]: el.value, theme: 'custom' });
    ylpRenderThemeGrid();
    ylpRenderKaraokeGrid();
  });
  el.addEventListener('change', () => {          // 確定後才儲存
    ylpPopupSettings[id] = el.value;
    const light = ylpThemeIsLight(ylpResolveTheme(ylpPopupSettings));
    chrome.storage.sync.set({ [id]: el.value, darkMode: !light });
  });
}

const ylpPanelRange = document.getElementById('panelTransparency');
ylpPanelRange.addEventListener('input', () => {
  const n = Math.min(90, Math.max(0, parseInt(ylpPanelRange.value, 10) || 0));
  document.getElementById('panelTransparencyValue').textContent = n + '%';
  ylpPreview({ panelTransparency: n });
});
ylpPanelRange.addEventListener('change', () => {
  const n = Math.min(90, Math.max(0, parseInt(ylpPanelRange.value, 10) || 0));
  chrome.storage.sync.set({ panelTransparency: n });
});

// === 打點按鍵 ===
function ylpPopupKeyLabel(code) {
  const map = { Enter: 'Enter', NumpadEnter: '數字鍵 Enter', Space: '空白鍵', Backspace: 'Backspace', Tab: 'Tab',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Delete: 'Delete' };
  if (map[code]) return map[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return '數字鍵 ' + code.slice(6);
  return code || '?';
}

let ylpWaitingKeyBtn = null;
for (const id of ['tapKeyBtn', 'undoKeyBtn']) {
  const b = document.getElementById(id);
  b.addEventListener('click', () => {
    if (ylpWaitingKeyBtn) ylpWaitingKeyBtn.classList.remove('waiting');
    ylpWaitingKeyBtn = b;
    b.classList.add('waiting');
    b.textContent = '請按一個鍵…';
  });
}
document.addEventListener('keydown', (e) => {
  if (!ylpWaitingKeyBtn) return;
  e.preventDefault();
  const b = ylpWaitingKeyBtn;
  const key = b.dataset.key;
  const other = key === 'tapKey' ? 'undoKey' : 'tapKey';
  const reset = () => { b.classList.remove('waiting'); b.textContent = ylpPopupKeyLabel(ylpPopupSettings[key]); ylpWaitingKeyBtn = null; };
  if (e.code === 'Escape') { reset(); return; }                         // Esc＝取消設定
  if (e.code === ylpPopupSettings[other]) { b.textContent = '跟另一個鍵重複'; setTimeout(reset, 1200); return; }
  ylpPopupSettings[key] = e.code;
  chrome.storage.sync.set({ [key]: e.code });
  reset();
});

// === 歌詞庫 ===
document.getElementById('openLibraryBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
  window.close();
});

// === 點外掛圖示時顯示歌詞 ===
// 打開這個設定視窗的同時，如果目前分頁是 YouTube 影片、而且歌詞面板還沒開，就把歌詞面板打開
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab || !/^https:\/\/(www\.|m\.)?youtube\.com\/watch/.test(tab.url || '')) return;
  chrome.tabs.sendMessage(tab.id, { action: 'ylpShowIfClosed' }, () => void chrome.runtime.lastError);
});

// === 小圓點透明度（預設跟隨縮小列透明度） ===
const ylpDotState = { follow: true, own: 0, mini: 0 };
function ylpRenderDotRow() {
  const val = ylpDotState.follow ? ylpDotState.mini : ylpDotState.own;
  document.getElementById('dotFollowToggle').classList.toggle('active', ylpDotState.follow);
  const r = document.getElementById('dotTransparency');
  r.disabled = ylpDotState.follow;
  r.value = val;
  document.getElementById('dotTransparencyValue').textContent = val + '%' + (ylpDotState.follow ? '（跟隨縮小列）' : '');
}
chrome.storage.sync.get({ dotFollowBar: true, dotTransparency: 0, miniTransparency: 0 }, (s) => {
  ylpDotState.follow = s.dotFollowBar !== false;
  ylpDotState.own = Math.min(90, Math.max(0, Number(s.dotTransparency) || 0));
  ylpDotState.mini = Math.min(90, Math.max(0, Number(s.miniTransparency) || 0));
  ylpRenderDotRow();
});
document.getElementById('dotFollowToggle').addEventListener('click', () => {
  ylpDotState.follow = !ylpDotState.follow;
  // 改成獨立設定時，從目前縮小列的數值開始調
  if (!ylpDotState.follow) ylpDotState.own = ylpDotState.mini;
  ylpRenderDotRow();
  chrome.storage.sync.set({ dotFollowBar: ylpDotState.follow, dotTransparency: ylpDotState.own });
});
const ylpDotRange = document.getElementById('dotTransparency');
ylpDotRange.addEventListener('input', () => {
  ylpDotState.own = Math.min(90, Math.max(0, parseInt(ylpDotRange.value, 10) || 0));
  ylpRenderDotRow();
  ylpPreview({ dotTransparency: ylpDotState.own, dotFollowBar: false }); // 拖動中只預覽
});
ylpDotRange.addEventListener('change', () => {
  chrome.storage.sync.set({ dotTransparency: ylpDotState.own });
});
// 縮小列透明度改變時，跟隨模式的顯示也一起更新
document.getElementById('miniTransparency').addEventListener('input', function () {
  ylpDotState.mini = Math.min(90, Math.max(0, parseInt(this.value, 10) || 0));
  if (ylpDotState.follow) ylpRenderDotRow();
});

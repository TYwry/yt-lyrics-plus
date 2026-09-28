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
        files: ['content.js']
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
      <div class="status-text">${message}</div>
    </div>
  `;
}

// === 捲動與翻譯設定 ===
const YLP_DEFAULTS = { autoScroll: true, pauseSeconds: 4, translate: true, targetLang: 'zh-TW' };

chrome.storage.sync.get(YLP_DEFAULTS, (s) => {
  document.getElementById('autoScrollToggle').classList.toggle('active', s.autoScroll !== false);
  document.getElementById('translateToggle').classList.toggle('active', s.translate !== false);
  document.getElementById('pauseSeconds').value = s.pauseSeconds;
  document.getElementById('targetLangSelect').value = s.targetLang;
});

for (const [id, key] of [['autoScrollToggle', 'autoScroll'], ['translateToggle', 'translate']]) {
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

document.getElementById('targetLangSelect').addEventListener('change', function () {
  chrome.storage.sync.set({ targetLang: this.value });
});

// 翻譯開關也能從歌詞面板的「譯」按鈕切換，這裡同步顯示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'translate' in changes) {
    document.getElementById('translateToggle').classList.toggle('active', changes.translate.newValue !== false);
  }
});

// 介面文字（繁體中文）
const LOCALES = {
  zh: {
    name: '繁體中文',
    translations: {
      searching: '搜尋中...',
      refreshingExtension: '正在重新載入外掛...',
      pleaseOpenYouTubeVideo: '請先開啟一部 YouTube 影片！',
      tabRefreshed: '分頁已重新整理！',
      extensionRefreshed: '外掛已重新載入！',
      refreshFailed: '重新載入失敗',
      aiAnalyzingTitle: '正在分析影片標題...',
      lyricsPanelOpened: '歌詞面板已開啟！',
      couldNotDetectSong: '無法辨識這首歌',
      pleaseRefreshAndTryAgain: '請重新整理頁面後再試一次',
      showLyricsNow: '立即顯示歌詞',
      tutorialShowLyricsNow: '隨時點這裡，就能在目前的 YouTube 影片顯示歌詞',
      tutorialAutoShow: '開啟後，每部 YouTube 影片都會自動顯示歌詞',
      tutorialSmartAutoShow: '推薦：只在音樂影片自動顯示歌詞，比較不打擾',
      tutorialGotIt: '知道了',
      tutorialNext: '下一步',
      tutorialSkipTour: '略過導覽'
    }
  }
};

function t(key) {
  return LOCALES.zh.translations[key] || key;
}

if (typeof window !== 'undefined') {
  window.LOCALES = LOCALES;
  window.t = t;
}

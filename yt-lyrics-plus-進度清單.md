# YT 歌詞（中文版）進度清單

> 整理日期：2026-11-20　｜　目前版本：**v1.3.17**（manifest.json，尚未存檔上傳）　｜　最後一次存檔：2026-11-20 02:02（v1.3.16，說明「haha」）
> 改版規則（TY 確認）：TY 每按一次 save.bat 存檔，下一次修改就跳一號；存檔前的多輪修改併在同一號
> 2026-11-19 起專案位置改為 `D:\Claude\extensions\yt-lyrics-plus\`（見 `D:\Claude\資料夾地圖.md`）；下面寫到的舊位置只是過去紀錄
> 專案位置：`D:\Claude\YT\yt-lyrics-plus\`（原本在 `D:\Claude\yt-lyrics-plus\`，TY 已移到 YT 資料夾）
> GitHub：`TYwry/yt-lyrics-plus`（**不公開 private**），分支 `main`

---

## ⚠️ 搬移資料夾後要先注意的事

1. **外掛 ID 會變**：這個外掛是用「載入未封裝項目」裝的，`manifest.json` 裡沒有固定 ID 用的 `key`，Chrome 會依資料夾路徑決定外掛 ID。資料夾從 `D:\Claude\yt-lyrics-plus` 搬到 `D:\Claude\YT\yt-lyrics-plus` 後，Chrome 會把它當成新的外掛：
   - 舊位置的外掛會顯示錯誤或消失，要到 `chrome://extensions` 用「載入未封裝項目」重新選新資料夾。
   - **歌詞庫（自己打點的歌詞）、每首歌的時間微調、面板大小、設定都存在舊 ID 底下，新 ID 看不到。**
2. **救回歌詞庫的方法**：資料夾裡有一份備份 `yt-lyrics-library-20261002-1220.json`（2026-10-02 匯出，約 6 KB）。重新載入外掛後，到「我的歌詞庫」按「📂 匯入」選這個檔即可。
   - 如果 10/02 之後還有新打點的歌：舊外掛還沒移除前，先把舊位置的資料夾暫時搬回去、在舊外掛的歌詞庫按「⬆ 全部匯出」，再匯入新外掛。（是否這樣做由 TY 決定）
3. 設定（主題、翻譯語言等）存在 Chrome 同步設定，換 ID 後會回到預設值，需要重新調一次。

---

## 一、已完成的部分

### 版本紀錄（依 git 存檔紀錄）
| 版本 | 內容 |
|---|---|
| 初始版本 | 從商店版「YT Lyrics」1.0.9 改成中文版，移除原本的使用數據追蹤 |
| v1.1.0 | 字幕時間微調、影片字幕模式（CC）、卡拉OK配色、可調整面板大小、給朋友的安裝包 |
| v1.3.1 | 「我的歌詞庫」與分享（匯出／匯入）、打點記錄每句開始與結束、改成按外掛圖示才顯示歌詞 |
| v1.3.2 | 找歌詞時的載入動畫、打點可以從中間某一句重打 |
| v1.3.3 | 縮成一個小圓點 |
| v1.3.4 | 小圓點透明度可調 |
| v1.3.14 | 音樂偵測小圓點、微調間距、右鍵折疊、打點直接儲存等 |
| v1.3.15 | 同上一批，再加除錯修正（見下） |
| v1.3.16 | 新增「只顯示翻譯」字幕顯示方式；拿掉「縮成一排」，只留縮成小圓點；找到歌詞與調過時間的歌自動收進歌詞庫（2026-11-20 02:02 存檔） |
| **v1.3.17** | 「中」按鈕用 YouTube 中文字幕當翻譯；原文簡體一律轉繁體；搜尋不再給看過的歌詞；英文不翻譯開關；打點時 CC 只顯示正在打的句子；設定改成小視窗＋設定分頁、拿掉新手引導（見下） |

### v1.3.17 這一版的內容（2026-11-20，尚未存檔上傳）
- 「中」按鈕（TY 2026-11-20 要求）：用 YouTube 上傳者做的中文字幕當翻譯（繁中優先，簡中轉繁），依時間（±2 秒，含微調）對到歌詞，取代 Google 翻譯；記在 `ylpZhSub:<影片ID>`，再按一次改回；最多等 8 秒
- 原文一律不出現簡體（TY 要求）：加入 OpenCC（`vendor/opencc-cn2t.js`，opencc-js 1.4.2，npm 下載、sha1 與官方一致，約 1.1 MB，cn→twp）
  - 顯示歌詞時轉繁（displayLyrics）；存進歌詞庫、匯入、匯出、補收快取都轉繁；歌詞庫既有的簡體在背景程式啟動與打開歌詞庫頁時轉一次（`ylpLibConvertAllToTrad`）
  - 有日文假名或韓文的歌詞整份不轉
- 搜尋不再給看過的歌詞：每部影片記住顯示過的歌詞（比對內容，去掉時間標點、簡轉繁）；🔍 搜尋、重新搜尋、手動搜尋時跳過（`ylpSeen`、`_skipSeen`）
- 設定「英文歌詞不翻譯」：`skipEnglish`（預設關），整句只有拉丁字母的不翻（`ylpSkipLine`）
- 打點時 CC 影片字幕不播舊歌詞，只在按住時顯示正在打的那一句
- 從 CC 字幕找歌詞時找原文：依影片標題的文字判斷語言（韓文字→ko、假名→ja、漢字→zh、英文字母→en，括號內不算），找不到再照原本順序（`ylpTitleLang`）
- 設定改版：點圖示的小視窗只有外觀（主題、自訂顏色、歌詞背景透明度）＋「⚙ 詳細設定」按鈕；完整設定在分頁 `popup.html?page=settings`（同一份程式，用 body.settings-page 切換），最上方是我的歌詞庫；「立即顯示歌詞」按鈕藏起來；新手引導不再啟動
- 需要 TY 測試：「中」按鈕（有簡中字幕的外語 MV）、簡體中文歌是否顯示成繁體、重新搜尋是否跳過看過的、英文不翻譯、打點時 CC、設定分頁

### v1.3.16 這一版的內容（2026-11-20 02:02 已存檔）
- 設定新增「字幕顯示方式」：原文＋翻譯（預設）／只顯示翻譯；歌詞面板、卡拉OK、CC 影片字幕都適用，改了立刻生效
  - 這句沒有譯文（同語言、翻譯失敗）或按「譯」關掉翻譯時，仍顯示原文
  - 新設定：`lyricsDisplay: 'both' | 'translation'`（放在 themes.js 的預設值）
- 標題列拿掉「−」縮成一排按鈕（按鈕藏起來、內部邏輯保留給卡拉OK用）；面板右鍵改成縮成小圓點
- 離開卡拉OK時，面板自動展開回完整歌詞（以前會停在縮小列）
- 設定拿掉「縮小列透明度」與小圓點的「跟隨縮小列透明度」；以前開著跟隨的人，自動把縮小列數值搬給小圓點
- 調過時間的歌自動收進歌詞庫：網路找到的同步歌詞按過 + / −，停手 1.5 秒後存成新來源 `tuned`（調過時間），微調值仍存在 `ylpOffset:<影片ID>`，匯出時算進時間
  - 已在歌詞庫的歌再調時間：更新 `updated`，重新匯出時朋友會收到新版
  - 以前調過、還沒收的歌：背景程式啟動／更新時、打開歌詞庫頁、打開那部影片時，從歌詞快取 `lyrics_<影片ID>` 補收（快取已被清掉的只能等打開影片時補）
  - `tuned` 跟 `mine` 一樣，匯入朋友的歌詞庫時不會被覆蓋；微調歸零不會把歌從歌詞庫移除
  - 動到的檔案：content.js、library-core.js（`ylpLibAdoptTuned`、`ylpLibIsOwn`）、library.js、background.js、README.md
- 找到同步歌詞就收進歌詞庫（TY 2026-11-20 要求）：新來源 `found`（網路找到的）
  - displayLyrics 時呼叫 `ylpCollectToLibrary`：網路結果存成 found；用別部影片的歌詞不另存；本機歌詞不重存
  - found 調過時間 → 升級成 tuned；以前快取裡的同步歌詞由 `ylpLibAdoptCached`（取代 ylpLibAdoptTuned）補收
  - 重新搜尋時跳過 found（避免找錯歌卡死）；重新搜尋／手動搜尋找到不同歌詞時換掉非 mine 的那首並把微調歸零
  - 匯入時 found 一律換成匯入的版本；mine、tuned 不覆蓋
  - 純文字歌詞不收
- 需要 TY 測試：只顯示翻譯三個地方的顯示、右鍵縮成圓點、卡拉OK進出後面板狀態、找到歌詞後歌詞庫出現「網路找到的」、調時間後變「調過時間」、重新搜尋能換掉找錯的歌

### v1.3.15 這一版的內容
- 偵測到音樂影片時右上角出現建議小圓點，點一下打開歌詞、右鍵關掉；純音樂不顯示
- 設定視窗新增「偵測到音樂時顯示小圓點」開關
- 時間微調範圍擴大到 ±30 秒，新增間距下拉選單（0.2／0.5／1／2／3／5／10 秒），選擇會記住
- 面板上按右鍵可折疊／展開（輸入框、編輯與打點畫面除外；Shift＋右鍵叫出原本選單），折疊時按鈕顯示 ⤢
- 打點打完最後一句或按「完成並儲存」直接儲存並顯示提示
- 找不到歌詞畫面新增「🔄 重新自動搜尋」
- 搜尋逾時 8 秒，手動搜尋會中止進行中的自動搜尋；載入畫面顯示搜尋進度
- 標題解析支援「歌手 -【歌名】」「【歌手】歌名」，自動移除【MV】【官方完整版】；中英並列歌手名拆成兩種寫法
- 面板預設寬度 400px
- README、README-FIRST 已更新
- 除錯修正：預告片、遊戲實況等標題含 official／live 的非音樂影片不再誤跳小圓點
- 除錯修正：所有輸入框拿掉框內提示字，用途改寫在旁邊
- 不再使用「打包給朋友.bat」，分享改用 GitHub 權限＋Releases 下載
- publish-release.bat：發布失敗時才顯示原因

> 這一版已經做過除錯與資安檢查（提交說明中有「除錯修正」兩項），並已用 save.bat 存檔上傳（2026-10-02）。

### 功能現況總覽
- **顯示方式**：不會自動跳出面板，按外掛圖示打開；偵測到音樂時右上角出現建議小圓點
- **音樂判斷**（`ylpCheckMusicForDot`）：YouTube 分類＝Music／說明欄有音樂區塊／標題關鍵字（MV、官方、OST、主題曲、翻唱、cover、feat…），並排除 trailer、gameplay、直播、實況等非音樂字；`ylpIsInstrumental` 過濾純音樂（instrumental、鋼琴版、lo-fi、伴奏、助眠、10 hours… 以及鋼琴／Lo-fi 頻道）
- **標題列**：`− ±0 + [間距▾]` 🔍 ✎ 🎤 CC 譯 ● −/⤢ ×
- **同步**：逐格更新、二分搜尋、只在換句時重畫；LRC 支援一行多個時間、`[offset:]`、結束標記
- **卡拉OK**：全螢幕、依結束時間填色、可選配色、無動畫模式、左上角微調
- **CC 影片字幕**：顯示在播放器中下方，大小 s/m/l，唱完收起
- **搜尋順序**：本機歌詞 → 同歌名＋歌手的本機歌詞（別的影片）→ 快取 → LRCLIB／Lyrics.ovh → YouTube CC → 純文字
- **打點（✎）**：按住＝開始、放開＝結束；可從任一句重打；打完自動存
- **歌詞庫頁**：列表、搜尋、改名、刪除、匯出 json、匯入（只新增或更新較新的，不覆蓋自己做的）、安裝包附的 `bundled-lyrics.json` 自動匯入
- **翻譯**：背景程式呼叫 Google 翻譯，只接受來自 YouTube 頁面的請求，限制語言清單與字數

---

## 二、目前的檔案狀態（`D:\Claude\YT\yt-lyrics-plus\`）

| 檔案 | 用途 |
|---|---|
| `manifest.json` | MV3，version 1.3.15，最低 Chrome 111；權限 activeTab／scripting／storage；連線 youtube、lrclib.net、api.lyrics.ovh、translate.googleapis.com |
| `content.js` | 主程式（約 186 KB、4,749 行） |
| `page-bridge.js` | 在 YouTube 網頁內執行：讀 CC 字幕、攔 timedtext、回傳影片分類 |
| `themes.js` | 面板主題、卡拉OK配色、主題預設值 |
| `background.js` | 安裝預設值、Google 翻譯、開歌詞庫分頁、匯入 bundled-lyrics.json |
| `library.html` / `library.js` / `library-core.js` | 歌詞庫頁與共用的解析／匯出／合併 |
| `popup.html` / `popup.js` / `locales.js` | 設定視窗 |
| `icon16/32/48/128.png` | 圖示 |
| `README.md`、`README-FIRST.txt` | 說明（已更新到 v1.3.15） |
| `open-install-page.bat` | 朋友安裝小幫手 |
| `save.bat` | 存檔並上傳 GitHub（會用 `.commit-message.txt` 當說明，用完自動刪） |
| `publish-release.bat` | 打包 zip 發布到 GitHub Releases |
| `yt-lyrics-library-20261002-1220.json` | 歌詞庫備份（不上傳 GitHub） |
| `.gitignore`、`.gitattributes`、`.git/` | 版本控制 |

**跟舊交接清單相比，這次搬移後資料夾裡沒有的東西**：`打包給朋友.bat`（v1.3.15 已決定不用）、`setup-github.bat`（已用過）、`1.0.9_0/` 原版參考、舊的 zip 檔。若需要原版參考，要看舊位置是否還在。

---

## 三、目前的變數與設定

### 同步設定（chrome.storage.sync，預設值）
| 鍵 | 預設 | 說明 |
|---|---|---|
| `autoShowLyrics` | false | 所有影片自動顯示（介面已隱藏不用） |
| `smartAutoShow` | true | 偵測到音樂時顯示小圓點 |
| `darkMode` | true | 深色 |
| `autoScroll` | true | 自動捲動 |
| `pauseSeconds` | 4 | 手動捲動後暫停自動捲動秒數 |
| `translate` | true | 翻譯 |
| `targetLang` | 'zh-TW' | 翻譯語言（允許 zh-TW、zh-CN、en、ja、ko、es、fr、de、th、vi、id） |
| `karaokeWipe` | true | 卡拉OK填色動畫 |
| `useYouTubeCaptions` | true | 可用 YouTube CC 當歌詞來源 |
| `miniTransparency` | 0 | 縮小列透明度 |
| `tapKey` / `undoKey` | 'Enter' / 'Backspace' | 打點按鍵 |
| `offsetStep` | 0.2 | 微調間距（秒） |
| `theme` | 'dark' | 面板主題（dark/aurora/dusk/ocean/forest/custom） |
| `customBg1` / `customBg2` / `customText` / `customAccent` | #232526 / #414345 / #ffffff / #f72585 | 自訂主題顏色 |
| `panelTransparency` | 0 | 面板透明度 |
| `karaokeTheme` | 'auto' | 卡拉OK配色（auto＝跟隨面板、classic、sakura…） |
| `karaokeText` / `karaokeFill` / `karaokeTr` | #ffffff / #5ec8ff / #ffe58a | 卡拉OK自訂顏色 |
| `ccSubs` / `ccSize` | false / 'm' | 影片字幕模式與大小 |
| `dotFollowBar` / `dotTransparency` | true / 0 | 小圓點透明度跟隨縮小列，或獨立設定 |

### 本機資料（chrome.storage.local）
- `ylpLocal:<影片ID>` ＝ `{ lrc, artist, song, title, source, created, updated }`；source：mine（自己做）／imported（匯入）／bundled（安裝包）
- `ylpOffset:<影片ID>` ＝ 時間微調秒數（正數＝字幕提早）
- `lyrics_<id>` 歌詞快取＋`lyrics_metadata`（最多 200 筆，可信度門檻 0.7）
- `ylpPanelSize` 面板大小、`ylpBundledMark` 安裝包歌詞已匯入標記

### 程式中的重要常數
- 搜尋逾時：LRCLIB 8 秒、Lyrics.ovh 6 秒
- 歌詞庫匯入上限：檔案 10 MB、5,000 首、每首 200 KB
- 翻譯：每次最多 300 句、每句 500 字、網址長度上限 1800

---

## 四、待辦與待確認

### 搬移後立刻要做
- [ ] 到 `chrome://extensions` 重新「載入未封裝項目」，選 `D:\Claude\YT\yt-lyrics-plus`，確認外掛正常
- [ ] 匯入歌詞庫備份 `yt-lyrics-library-20261002-1220.json`（或先從舊外掛匯出最新的）
- [ ] 重新調整設定（主題、翻譯語言等）
- [ ] 確認 `save.bat` 在新位置還能存檔上傳（.git 有一起搬過來，應該正常）

### 發現的小落差（尚未修改，等 TY 決定）
- [ ] **publish-release.bat 沒有附歌詞庫的功能**：v1.3.15 的說明與 README 寫「附歌詞庫進安裝包的功能移到 publish-release.bat」，但目前這支 bat 打包時沒有放入 `bundled-lyrics.json`，也沒有詢問要不要附歌詞庫
- [ ] **save.bat 提示文字過時**：沒有 .git 時會叫人「雙擊 setup-github.bat」，但這支檔案已不在資料夾裡
- [ ] **README 檔案說明表還列著 setup-github.bat**
- [ ] `popup.js` 的預設值清單少了 `offsetStep`（不影響功能，content.js 有）
- [ ] 不確定 v1.3.15 是否已用 publish-release.bat 發布到 GitHub Releases（只確定程式碼已存檔上傳）

### 需要 TY 實際測試
- [ ] 小圓點在真實 YouTube 上的音樂判斷是否準確
- [ ] 【】格式的標題實際能否在 LRCLIB 找到歌詞
- [ ] CC 影片字幕的位置
- [ ] 卡拉OK微調時不會暫停影片

### 之前提過、還沒做的點子
- [ ] 按住 ＋／− 可以連續調整時間（已提議未做）

---

## 五、TY 對這個專案的規則與決定
- 全程繁體中文；複雜任務先提計畫等 TY 說 OK；小改直接做
- Claude 不刪除 TY 的任何東西，需要刪除時只列建議由 TY 自己刪
- README、更新日誌（`.commit-message.txt`）只在 TY 說「開始做 GitHub 的發佈」時才整理
- 不用每次都寫交接清單，TY 要求時才寫
- 完整除錯與資安檢查等 TY 要求時才做
- 輸入框不放範例字，用途寫在框外
- GitHub 維持不公開（改自別人的外掛，沒有授權聲明，不可公開散布）；分享給朋友改用加 GitHub 權限＋Releases 下載，不再用 zip 私下傳
- 每次改版 manifest 版本號 +1（下一版為 v1.3.18），改完請 TY 在擴充功能頁按「重新載入」並重新整理 YouTube 分頁
- 想讓朋友之間能互相分享自己打點的同步歌詞（歌詞庫匯出／匯入）

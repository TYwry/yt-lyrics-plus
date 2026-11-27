@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem 這是打包者用的：把外掛打包成 zip 發布到 GitHub 的 Releases，一般使用者不需要執行
rem 想在安裝包附上歌詞：把歌詞庫匯出的檔案改名成 bundled-lyrics.json 放在這個資料夾，再執行本檔

for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" manifest.json') do set VER=%%~v
if "%VER%"=="" ( echo 讀不到 manifest.json 的版本號。& pause & exit /b 1 )

set "OUT=yt-lyrics-plus.zip"
set "STAGE=%TEMP%\ylp-pack-%RANDOM%"
mkdir "%STAGE%\YT-Lyrics" || ( echo 無法建立暫存資料夾。& pause & exit /b 1 )
for %%f in (manifest.json content.js page-bridge.js themes.js background.js library-core.js library.html library.js locales.js popup.html popup.js icon16.png icon32.png icon48.png icon128.png README-FIRST.txt open-install-page.bat) do (
  if not exist "%%f" ( echo 缺少檔案：%%f & rmdir /s /q "%STAGE%" & pause & exit /b 1 )
  copy /y "%%f" "%STAGE%\YT-Lyrics\" >nul
)
rem 簡繁轉換元件（manifest.json 會載入，少了外掛會打不開）
mkdir "%STAGE%\YT-Lyrics\vendor"
for %%f in (vendor\opencc-cn2t.js vendor\OPENCC-LICENSE.txt) do (
  if not exist "%%f" ( echo 缺少檔案：%%f & rmdir /s /q "%STAGE%" & pause & exit /b 1 )
  copy /y "%%f" "%STAGE%\YT-Lyrics\vendor\" >nul
)
if exist "bundled-lyrics.json" (
  copy /y "bundled-lyrics.json" "%STAGE%\YT-Lyrics\" >nul
  echo 已附上歌詞庫 bundled-lyrics.json
) else (
  echo 這次沒有附歌詞庫：資料夾裡沒有 bundled-lyrics.json
)
if exist "%OUT%" del "%OUT%"
powershell -NoProfile -Command "Compress-Archive -Path (Join-Path $env:STAGE 'YT-Lyrics') -DestinationPath $env:OUT -Force"
rmdir /s /q "%STAGE%"
if not exist "%OUT%" ( echo 打包失敗。& pause & exit /b 1 )

echo 正在發布 v%VER% ...
gh release create v%VER% "%OUT%" --title "v%VER%" --notes "YT 歌詞（中文版） v%VER%"
if errorlevel 1 (
  del "%OUT%"
  echo.
  echo 發布失敗：GitHub 上可能已經有 v%VER% 這個版本，或是網路、登入有問題。
  pause
  exit /b 1
)
del "%OUT%"
echo.
echo 已發布 v%VER%。
pause

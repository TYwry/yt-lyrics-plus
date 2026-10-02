@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem 打包後發布到 GitHub 的 Releases（儲存庫是不公開的話，只有有權限的人下載得到）

for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" manifest.json') do set VER=%%~v
if "%VER%"=="" ( echo 讀不到 manifest.json 的版本號。& pause & exit /b 1 )

set "OUT=yt-lyrics-plus.zip"
set "STAGE=%TEMP%\ylp-pack-%RANDOM%"
mkdir "%STAGE%\YT-Lyrics" || ( echo 無法建立暫存資料夾。& pause & exit /b 1 )
for %%f in (manifest.json content.js page-bridge.js themes.js background.js library-core.js library.html library.js locales.js popup.html popup.js icon16.png icon32.png icon48.png icon128.png README-FIRST.txt open-install-page.bat) do (
  if not exist "%%f" ( echo 缺少檔案：%%f & rmdir /s /q "%STAGE%" & pause & exit /b 1 )
  copy /y "%%f" "%STAGE%\YT-Lyrics\" >nul
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

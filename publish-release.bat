@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" manifest.json') do set VER=%%~v
if "%VER%"=="" ( echo 讀不到 manifest.json 的版本號。& pause & exit /b 1 )

echo 正在打包 v%VER% ...
if exist yt-lyrics-plus.zip del yt-lyrics-plus.zip
powershell -NoProfile -Command "Compress-Archive -Path manifest.json,content.js,background.js,locales.js,popup.html,popup.js,icon16.png,icon48.png,icon128.png,README.md -DestinationPath yt-lyrics-plus.zip -Force"
if not exist yt-lyrics-plus.zip ( echo 打包失敗。& pause & exit /b 1 )

gh release create v%VER% yt-lyrics-plus.zip --title "v%VER%" --notes "YT Lyrics Plus v%VER%"
del yt-lyrics-plus.zip
echo.
echo 已發布 v%VER%。下次發布前記得先把 manifest.json 的 version 改大。
pause

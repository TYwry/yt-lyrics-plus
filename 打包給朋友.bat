@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem 把外掛需要的檔案打包成 YT-Lyrics-v版本.zip，給朋友解壓縮後安裝

for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" manifest.json') do set VER=%%~v
if "%VER%"=="" ( echo 讀不到 manifest.json 的版本號。& pause & exit /b 1 )

set "OUT=YT-Lyrics-v%VER%.zip"
set "STAGE=%TEMP%\ylp-pack-%RANDOM%"
mkdir "%STAGE%\YT-Lyrics" || ( echo 無法建立暫存資料夾。& pause & exit /b 1 )

for %%f in (manifest.json content.js page-bridge.js themes.js background.js locales.js popup.html popup.js icon16.png icon32.png icon48.png icon128.png README-FIRST.txt open-install-page.bat) do (
  if not exist "%%f" ( echo 缺少檔案：%%f & rmdir /s /q "%STAGE%" & pause & exit /b 1 )
  copy /y "%%f" "%STAGE%\YT-Lyrics\" >nul
)

if exist "%OUT%" del "%OUT%"
powershell -NoProfile -Command "Compress-Archive -Path (Join-Path $env:STAGE 'YT-Lyrics') -DestinationPath $env:OUT -Force"
rmdir /s /q "%STAGE%"
if not exist "%OUT%" ( echo 打包失敗。& pause & exit /b 1 )

echo.
echo 完成！已產生 %OUT%
echo 把這個檔案傳給朋友（LINE、雲端硬碟都可以），請他解壓縮後照裡面的 README-FIRST.txt 安裝。
echo ※ 下次改版前記得先把 manifest.json 的 version 改大，朋友才分得出新舊版。
pause

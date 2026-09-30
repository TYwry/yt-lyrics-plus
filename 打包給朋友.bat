@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem 把外掛需要的檔案打包成 YT-Lyrics-v版本.zip，給朋友解壓縮後安裝
rem 如果下載資料夾裡有「歌詞庫」匯出的檔案，會問你要不要一起放進去

for /f "tokens=2 delims=:, " %%v in ('findstr /c:"\"version\"" manifest.json') do set VER=%%~v
if "%VER%"=="" ( echo 讀不到 manifest.json 的版本號。& pause & exit /b 1 )

set "OUT=YT-Lyrics-v%VER%.zip"
set "STAGE=%TEMP%\ylp-pack-%RANDOM%"
set "PROJ=%CD%"
mkdir "%STAGE%\YT-Lyrics" || ( echo 無法建立暫存資料夾。& pause & exit /b 1 )

for %%f in (manifest.json content.js page-bridge.js themes.js background.js library-core.js library.html library.js locales.js popup.html popup.js icon16.png icon32.png icon48.png icon128.png README-FIRST.txt open-install-page.bat) do (
  if not exist "%%f" ( echo 缺少檔案：%%f & rmdir /s /q "%STAGE%" & pause & exit /b 1 )
  copy /y "%%f" "%STAGE%\YT-Lyrics\" >nul
)

echo 正在尋找最新的歌詞庫檔（yt-lyrics-library-*.json）...
powershell -NoProfile -Command "$p = @($env:PROJ); try { $d = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path; if ($d) { $p += $d } } catch {}; $f = Get-ChildItem -LiteralPath $p -Filter 'yt-lyrics-library-*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $env:STAGE 'candidate.json'); Write-Host ('  ' + $f.FullName); Write-Host ('  ' + $f.LastWriteTime.ToString('yyyy/MM/dd HH:mm')) }"
if exist "%STAGE%\candidate.json" (
  echo.
  choice /c YN /m "要把這個歌詞庫放進安裝包，讓朋友安裝後自動拿到這些歌嗎"
  if errorlevel 2 (
    echo 這次不附歌詞。
  ) else (
    move /y "%STAGE%\candidate.json" "%STAGE%\YT-Lyrics\bundled-lyrics.json" >nul
    echo 已放入歌詞庫。
  )
) else (
  echo 沒有找到歌詞庫檔，這次不附歌詞。（要附的話，先在「我的歌詞庫」按「全部匯出」）
)
if exist "%STAGE%\candidate.json" del "%STAGE%\candidate.json"

if exist "%OUT%" del "%OUT%"
powershell -NoProfile -Command "Compress-Archive -Path (Join-Path $env:STAGE 'YT-Lyrics') -DestinationPath $env:OUT -Force"
rmdir /s /q "%STAGE%"
if not exist "%OUT%" ( echo 打包失敗。& pause & exit /b 1 )

echo.
echo 完成！已產生 %OUT%
echo 把這個檔案傳給朋友（LINE、雲端硬碟都可以），請他解壓縮後照裡面的 README-FIRST.txt 安裝。
echo ※ 下次改版前記得先把 manifest.json 的 version 改大，朋友才分得出新舊版。
pause

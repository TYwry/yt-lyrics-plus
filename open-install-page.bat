@echo off
chcp 65001 >nul
setlocal
rem 把這個資料夾的位置複製到剪貼簿，並打開 Chrome 的擴充功能頁面（不會修改電腦的任何設定）
set "YLP_DIR=%~dp0"
if "%YLP_DIR:~-1%"=="\" set "YLP_DIR=%YLP_DIR:~0,-1%"
powershell -NoProfile -Command "Set-Clipboard -Value $env:YLP_DIR" >nul 2>&1

echo.
echo  已經把這個資料夾的位置複製好了：
echo    %YLP_DIR%
echo.
echo  接下來在 Chrome 的擴充功能頁面：
echo    1. 打開右上角的「開發人員模式」
echo    2. 按左上角的「載入未封裝項目」
echo    3. 在選擇資料夾視窗最上面的位址列按 Ctrl+V，再按 Enter，最後按「選擇資料夾」
echo.
start "" chrome "chrome://extensions/" 2>nul
if errorlevel 1 (
  echo  找不到 Chrome，請自己打開 Chrome，在網址列輸入 chrome://extensions 再按 Enter。
  echo.
)
pause

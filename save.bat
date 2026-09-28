@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist ".git" ( echo 還沒連結 GitHub，請先雙擊 setup-github.bat。& pause & exit /b 1 )

git add -A
call :safety || exit /b 1
git diff --cached --quiet && ( echo 沒有需要存檔的變更。& pause & exit /b 0 )

if exist ".commit-message.txt" (
  git reset -q -- .commit-message.txt 2>nul
  git commit -F ".commit-message.txt" && del ".commit-message.txt"
) else (
  set /p MSG=請輸入這次修改的說明：
  call git commit -m "%%MSG%%"
)
git push
echo.
echo 已存檔並上傳到 GitHub。
pause
exit /b 0

:safety
git diff --cached --name-only | findstr /i /r "config\.json history\.json \.env \.log$ \.key$ \.pem$ secret password credential apikey api_key" >nul
if %errorlevel%==0 (
  echo [安全檢查] 發現可能含有金鑰或個人資料的檔案，已中止上傳：
  git diff --cached --name-only | findstr /i /r "config\.json history\.json \.env \.log$ \.key$ \.pem$ secret password credential apikey api_key"
  git reset -q
  pause
  exit /b 1
)
exit /b 0

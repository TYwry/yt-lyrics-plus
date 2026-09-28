@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set REPO=yt-lyrics-plus

echo === YT Lyrics Plus：第一次連結 GitHub ===
where git >nul 2>&1 || (
  echo 正在安裝 Git...
  winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
)
where gh >nul 2>&1 || (
  echo 正在安裝 GitHub CLI...
  winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
)
where git >nul 2>&1 || ( echo 剛安裝完 Git，請關閉這個視窗後再雙擊一次本檔案。& pause & exit /b 1 )
where gh >nul 2>&1 || ( echo 剛安裝完 GitHub CLI，請關閉這個視窗後再雙擊一次本檔案。& pause & exit /b 1 )

gh auth status >nul 2>&1 || gh auth login --web -h github.com
gh auth setup-git

if not exist ".git" git init -b main
git add -A
call :safety || exit /b 1
git commit -m "初始版本" || echo （沒有新的變更）
if exist ".commit-message.txt" del ".commit-message.txt"
gh repo create %REPO% --private --source . --push
echo.
echo 完成！之後修改完請雙擊 save.bat 存檔上傳。
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

@echo off
rem Double-click on Windows: start the city and open it in the browser.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo Claude War Room City is running. Close this window to stop it.
node server.js --open
pause

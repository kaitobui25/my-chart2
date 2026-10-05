@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [L2Chart Excel] Node.js/npm is not installed or not available in PATH.
  echo Install Node.js 20+ and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vite.cmd" (
  echo [L2Chart Excel] Installing npm dependencies...
  call npm install
  if errorlevel 1 goto :error
)

set "CERT_DIR=%USERPROFILE%\.office-addin-dev-certs"
if not exist "%CERT_DIR%\localhost.crt" goto :install_cert
if not exist "%CERT_DIR%\localhost.key" goto :install_cert
goto :start

:install_cert
echo [L2Chart Excel] Installing trusted localhost certificate...
call npx office-addin-dev-certs install
if errorlevel 1 goto :error

:start
echo [L2Chart Excel] Starting Excel add-in at https://localhost:3000
echo Keep this window open while using the chart in Excel.
echo.
call npm run excel:dev
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [L2Chart Excel] Startup failed. See the error above.
pause
exit /b 1

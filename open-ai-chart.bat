@echo off
setlocal
cd /d "%~dp0"
node scripts\run-assistant.mjs
if errorlevel 1 pause

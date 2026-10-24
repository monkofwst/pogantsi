@echo off
cd /d "%~dp0"
start "" http://localhost:8765
py -3 -m http.server 8765 2>nul || python -m http.server 8765
pause

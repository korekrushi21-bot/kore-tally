@echo off
cd /d "C:\kore tally\tally-overdue-reminder\backend"
:loop
"C:\Program Files\nodejs\node.exe" server.js
timeout /t 5 /nobreak >nul
goto loop

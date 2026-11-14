@echo off
rem Runs one morning scan of all F&O stocks into the dashboard's database.
rem Used by the "Upstox Morning Scan" Windows scheduled task (weekdays 9:00).
rem Results appear in the dashboard's "Morning scan" panel; a one-line summary
rem is appended to backend\logs\scan.log. No Upstox login is needed.
cd /d "%~dp0backend"
".venv\Scripts\python.exe" -m app.scan_cli

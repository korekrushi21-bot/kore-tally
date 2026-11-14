' Launches the Overdue Reminders server with no visible console window, and
' keeps it running (run-forever.bat restarts node automatically if it exits
' or crashes). A copy of this file in the Windows Startup folder makes it
' start automatically whenever you log in - see ../README.md.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\kore tally\tally-overdue-reminder\backend\run-forever.bat""", 0, False

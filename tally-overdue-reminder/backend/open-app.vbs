' Desktop shortcut target: opens the Overdue Reminders app in the browser,
' starting the server first (hidden, via run-hidden.vbs) if it isn't running.
Option Explicit
Dim shell, http, ok, i
Set shell = CreateObject("WScript.Shell")

Function ServerUp()
  On Error Resume Next
  Dim req
  Set req = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  req.setTimeouts 1000, 1000, 2000, 2000
  req.open "GET", "http://localhost:4000/manifest.webmanifest", False
  req.send
  ServerUp = (Err.Number = 0 And req.status = 200)
  On Error GoTo 0
End Function

If Not ServerUp() Then
  shell.Run "wscript.exe ""C:\kore tally\tally-overdue-reminder\backend\run-hidden.vbs""", 0, False
  For i = 1 To 20
    WScript.Sleep 1000
    If ServerUp() Then Exit For
  Next
End If

shell.Run "http://localhost:4000/"

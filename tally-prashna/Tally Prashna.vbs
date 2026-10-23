' Double-click to open Tally Prashna as a desktop window.
' Starts the local server hidden (if it isn't already running), then opens
' Microsoft Edge in "app" mode - its own window with no tabs or address bar.
Option Explicit
Dim shell, fso, appDir, url, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:4100"

Function ServerUp()
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", url & "/index.html", False
  http.Send
  ServerUp = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function

If Not ServerUp() Then
  shell.CurrentDirectory = appDir
  shell.Run "cmd /c node server.js > server.log 2>&1", 0, False
  For i = 1 To 20
    WScript.Sleep 500
    If ServerUp() Then Exit For
  Next
End If

shell.Run "msedge --app=" & url & " --window-size=1100,760", 1, False

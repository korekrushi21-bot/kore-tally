# Creates a "JARVIS AI" shortcut on your Desktop that starts everything (Ollama + backend + app window).
$root = Split-Path $PSScriptRoot
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'JARVIS AI.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = Join-Path $root 'JARVIS.cmd'
$s.WorkingDirectory = $root
$s.WindowStyle = 7   # minimized console
$ico = Join-Path $root 'mobile\assets\icon.png'
$s.Description = 'Start JARVIS AI'
$s.Save()
Write-Host "Created $lnk"

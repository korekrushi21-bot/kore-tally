# One-click launcher: starts Ollama (if needed), the JARVIS backend, then opens the app in its own window.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$backend = "$root\backend"
$port = 8787
$url = "http://localhost:$port/"

function Test-Url($u) { try { (Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2).StatusCode -lt 500 } catch { $false } }

if (-not (Test-Path "$backend\.env")) { Write-Host 'backend\.env is missing. Copy backend\.env.example to backend\.env and fill JWT_SECRET and APP_ACCESS_CODE.' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
if (-not (Test-Path "$backend\web\index.html")) { Write-Host 'Desktop app not built yet. Run scripts\build-desktop.ps1 first.' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

# 1) Local AI (Ollama) - optional; JARVIS still works for maths/weather/notes without it
if (-not (Test-Url 'http://localhost:11434/api/tags')) {
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host 'Starting Ollama...'
    Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
  } else { Write-Host 'Ollama not installed: local AI chat disabled (see README).' -ForegroundColor Yellow }
}

# 2) Backend
if (-not (Test-Url "${url}admin/")) {
  Write-Host 'Starting JARVIS backend...'
  Set-Location $backend
  if (Test-Path "$backend\dist\src\index.js") { $args = @('dist\src\index.js') } elseif (Test-Path "$backend\dist\index.js") { $args = @('dist\index.js') } else { Write-Host 'Backend not built. Run scripts\build-desktop.ps1' -ForegroundColor Red; Read-Host 'Press Enter'; exit 1 }
  Start-Process node -ArgumentList ($args | ForEach-Object { '"' + (Join-Path $backend $_) + '"' }) -WorkingDirectory $backend -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\jarvis-backend.log" -RedirectStandardError "$env:TEMP\jarvis-backend.err"
  for ($i = 0; $i -lt 30 -and -not (Test-Url "${url}admin/"); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Url "${url}admin/")) { Write-Host "Backend did not start. See $env:TEMP\jarvis-backend.err" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
}

# 3) App window (Edge/Chrome app mode: own window, working voice input)
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Start-Process $edge -ArgumentList "--app=$url" } else { Start-Process $url }

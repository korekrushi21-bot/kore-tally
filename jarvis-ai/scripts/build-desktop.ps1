# Builds the desktop app: Expo web export -> backend/web, then compiles the backend.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Set-Location "$root\mobile"
Write-Host '== Exporting web app ==' -ForegroundColor Cyan
if (Test-Path "$root\backend\web") { Remove-Item "$root\backend\web" -Recurse -Force }
npx expo export --platform web --output-dir "$root\backend\web"
if ($LASTEXITCODE -ne 0) { throw 'web export failed' }
Set-Location "$root\backend"
Write-Host '== Building backend ==' -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw 'backend build failed' }
Write-Host 'Done. Start it with JARVIS.cmd (double-click) or scripts\start-jarvis.ps1' -ForegroundColor Green

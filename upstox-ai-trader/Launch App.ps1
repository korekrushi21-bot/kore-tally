# Starts the Upstox AI Smart Trader backend + dashboard (if not already running)
# and opens the dashboard in your default browser. Double-click this file, or
# the "Upstox AI Smart Trader" shortcut, to use the app.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Test-PortOpen($port) {
    try {
        $conn = Test-NetConnection -ComputerName "127.0.0.1" -Port $port -WarningAction SilentlyContinue -InformationLevel Quiet
        return $conn
    } catch {
        return $false
    }
}

if (-not (Test-PortOpen 8010)) {
    Write-Host "Starting backend on :8010..."
    # Start-Process -ArgumentList does NOT auto-quote array elements containing
    # spaces (this repo path does: "kore tally") — build one pre-quoted string
    # instead, which Win32 CreateProcess parses correctly.
    $uvicornArgs = "app.main:app --app-dir `"$root\backend`" --host 127.0.0.1 --port 8010"
    Start-Process -WindowStyle Minimized -FilePath "$root\backend\.venv\Scripts\uvicorn.exe" `
        -ArgumentList $uvicornArgs `
        -WorkingDirectory "$root\backend"
} else {
    Write-Host "Backend already running on :8010"
}

if (-not (Test-PortOpen 5180)) {
    Write-Host "Starting dashboard on :5180..."
    Start-Process -WindowStyle Minimized -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm run dev" `
        -WorkingDirectory "$root\dashboard"
} else {
    Write-Host "Dashboard already running on :5180"
}

Write-Host "Waiting for the dashboard to come up..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-PortOpen 5180) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}

Start-Process "http://localhost:5180"

if (-not $ready) {
    Write-Host "Dashboard didn't respond within 15s - it may still be starting. Refresh the browser tab in a moment."
    Start-Sleep -Seconds 3
}

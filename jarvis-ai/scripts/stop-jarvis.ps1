# Stops the JARVIS backend (leaves Ollama running).
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'jarvis-ai' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped node pid $($_.ProcessId)" }

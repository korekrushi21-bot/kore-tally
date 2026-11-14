# Registers (or removes) a Windows scheduled task that runs the cleaner automatically.
# YOU run this yourself:   powershell -ExecutionPolicy Bypass -File schedule.ps1
# Remove it again:         powershell -ExecutionPolicy Bypass -File schedule.ps1 -Remove
param([switch]$Remove)

$name = "PC Cleaner (auto)"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    "Removed task '$name'."
    return
}

$py = (Get-Command pythonw.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot "cleaner.py"
$action = New-ScheduledTaskAction -Execute $py -Argument "`"$script`" --clean --quiet"
# Runs once a week (Sunday 1 PM), or at next start if the PC was off then.
# Not daily: browser caches just rebuild, so cleaning them too often slows browsing.
$triggers = @(New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 1pm)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
"Scheduled '$name': runs every Sunday 1 PM. Log: $env:LOCALAPPDATA\pc-cleaner\log.txt"

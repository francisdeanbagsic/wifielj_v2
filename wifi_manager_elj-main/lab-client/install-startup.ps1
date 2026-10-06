# Run once as Administrator to start the lab client at Windows logon.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
  Write-Error "Node.js is not installed or not in PATH."
  exit 1
}

$taskName = "ELabAnnouncementClient"
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$scriptDir\client.js`"" -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Scheduled task '$taskName' created. Copy .env from .env.example and set LAB_MAC / SERVER_URL."

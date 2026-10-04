<#
.SYNOPSIS
  OPTIONAL, NOT RUN AUTOMATICALLY. Registers a per-user Scheduled Task that
  starts the proxy at logon, non-interactively.

.DESCRIPTION
  Creating a Scheduled Task is an administrator-visible system change, so this
  script is never invoked by Setup/Start/Test-Proxy.ps1 - only run it yourself,
  deliberately, after you've confirmed everything works by hand.

  Prerequisite: run this only AFTER Start-Proxy.ps1 has completed interactive
  sign-in successfully at least once (a working msal-cache.json must already
  exist under %USERPROFILE%\.config\opencode-m365\). The task runs with
  -NoInteractive, so if the cache ever goes stale it will fail loudly in its
  log instead of popping an invisible browser under a logon-trigger session -
  re-run Start-Proxy.ps1 by hand to refresh it, then the task resumes working.

.PARAMETER Port
  Port the scheduled instance listens on. Default 4141.

.EXAMPLE
  pwsh scripts\windows\Install-ScheduledTask.ps1
.EXAMPLE
  # Check status / logs:
  Get-ScheduledTask -TaskName "M365CopilotProxy"
  Get-Content .local\logs\proxy-*.log -Tail 40

.EXAMPLE
  # Disable without removing:
  Disable-ScheduledTask -TaskName "M365CopilotProxy"

.EXAMPLE
  # Remove entirely:
  Unregister-ScheduledTask -TaskName "M365CopilotProxy" -Confirm:$false
#>
[CmdletBinding()]
param(
    [int]$Port = 4141
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$StartScript = Join-Path $RepoRoot "scripts\windows\Start-Proxy.ps1"
$TaskName = "M365CopilotProxy"

Write-Host "[install-task] This will register a per-user logon Scheduled Task named '$TaskName'." -ForegroundColor Yellow
Write-Host "[install-task] It runs: powershell.exe -NoProfile -File `"$StartScript`" -Port $Port -NoInteractive"
Write-Host "[install-task] Re-run with -Confirm or inspect before proceeding; this script does NOT run itself on import." -ForegroundColor Yellow

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -File `"$StartScript`" -Port $Port -NoInteractive"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force

Write-Host "[install-task] Registered '$TaskName'. It will start at your next logon (or run it now with: Start-ScheduledTask -TaskName '$TaskName')." -ForegroundColor Green
Write-Host "[install-task] Disable:  Disable-ScheduledTask -TaskName '$TaskName'"
Write-Host "[install-task] Remove:   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"

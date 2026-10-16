<#
.SYNOPSIS
  Stop the m365-copilot-proxy started by Start-Proxy.ps1.
.EXAMPLE
  pwsh scripts\windows\Stop-Proxy.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$PidFile = Join-Path $RepoRoot ".local\run\proxy.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "[stop-proxy] FAIL: no $PidFile  -  is the proxy running (did Start-Proxy.ps1 launch it)?" -ForegroundColor Red
    exit 1
}

$targetPid = [int](Get-Content $PidFile -Raw).Trim()
$proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "[stop-proxy] PID $targetPid is not running; clearing stale PID file." -ForegroundColor Yellow
    Remove-Item $PidFile -Force
    exit 0
}

# Stop-Process on $targetPid alone only kills the launcher powershell.exe window;
# node.exe (the actual listener) is its CHILD, and Windows does not kill child
# processes when a parent is stopped. taskkill /T walks the whole process tree.
taskkill /PID $targetPid /T /F | Out-Null
Remove-Item $PidFile -Force
Write-Host "[stop-proxy] stopped PID $targetPid (and its process tree)"

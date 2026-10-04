<#
.SYNOPSIS
  Start the m365-copilot-proxy in a visible, persistent PowerShell window.

.DESCRIPTION
  Launches packages\proxy\bin\m365-proxy.mjs in a NEW visible window (so a real
  browser can pop up for interactive sign-in) bound to a loopback address by
  default. Logs go to a git-ignored local directory; no credentials are ever
  written to disk by this script.

.PARAMETER Port
  TCP port to listen on. Default 4141 (the repo's own default; see README.md).

.PARAMETER BindHost
  Address to bind. Default 127.0.0.1 (loopback-only). Use -BindHost :: for the
  IPv6 loopback, or override if you specifically need non-loopback exposure
  (not recommended  -  this proxy does not authenticate incoming requests).

.PARAMETER NoInteractive
  Do not set M365_ENABLE_INTERACTIVE_APPROVAL=1. Use this once a secrets.json
  (automated login) or a working MSAL cache already exists, or on a headless
  host where no browser should ever pop up.

.EXAMPLE
  pwsh scripts\windows\Start-Proxy.ps1
.EXAMPLE
  pwsh scripts\windows\Start-Proxy.ps1 -Port 4143
#>
[CmdletBinding()]
param(
    [int]$Port = 4141,
    [string]$BindHost = "127.0.0.1",
    [switch]$NoInteractive
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $RepoRoot

$ServerEntry = Join-Path $RepoRoot "packages\proxy\.output\server\index.mjs"
if (-not (Test-Path $ServerEntry)) {
    Write-Host "[start-proxy] FAIL: $ServerEntry not found. Run scripts\windows\Setup-Proxy.ps1 first." -ForegroundColor Red
    exit 1
}

$RunDir = Join-Path $RepoRoot ".local\run"
$LogDir = Join-Path $RepoRoot ".local\logs"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$PidFile = Join-Path $RunDir "proxy.pid"
$PortFile = Join-Path $RunDir "proxy.port"
$HostFile = Join-Path $RunDir "proxy.host"

if (Test-Path $PidFile) {
    $existingPid = [int](Get-Content $PidFile -Raw).Trim()
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[start-proxy] FAIL: a proxy is already running (PID $existingPid). Run Stop-Proxy.ps1 first, or use -Port to run a second instance manually." -ForegroundColor Red
        exit 1
    } else {
        Remove-Item $PidFile -Force
    }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "proxy-$stamp.log"

$interactive = -not $NoInteractive
if ($interactive) {
    Write-Host "[start-proxy] M365_ENABLE_INTERACTIVE_APPROVAL=1  -  a visible browser window will open for sign-in if no cached/automated credentials work." -ForegroundColor Yellow
}

# Build the child command. Env vars are set INSIDE the child process only  - 
# never written to this script, the log file, or disk anywhere.
$childLines = @(
    "`$env:PORT = '$Port'",
    "`$env:HOST = '$BindHost'",
    "`$env:NITRO_HOST = '$BindHost'"
)
if ($interactive) { $childLines += "`$env:M365_ENABLE_INTERACTIVE_APPROVAL = '1'" }
$childLines += "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"
$childLines += "Set-Location '$RepoRoot'"
$childLines += "Write-Host '[proxy] starting on ${BindHost}:${Port} (log: $LogFile)'"
$childLines += "node '$ServerEntry' *>&1 | Tee-Object -FilePath '$LogFile'"
$childCommand = $childLines -join "; "

$proc = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoExit", "-NoProfile", "-Command", $childCommand) `
    -PassThru -WindowStyle Normal

Start-Sleep -Milliseconds 500
if ($proc.HasExited) {
    Write-Host "[start-proxy] FAIL: proxy window exited immediately. Check $LogFile" -ForegroundColor Red
    exit 1
}

Set-Content -Path $PidFile -Value $proc.Id -NoNewline
Set-Content -Path $PortFile -Value $Port -NoNewline
Set-Content -Path $HostFile -Value $BindHost -NoNewline

Write-Host "[start-proxy] launched PID $($proc.Id), listening target ${BindHost}:${Port}"
Write-Host "[start-proxy] log file: $LogFile"
if ($interactive) {
    Write-Host "[start-proxy] If a browser window opens, complete SSO/MFA by hand in it, then return here." -ForegroundColor Yellow
}
Write-Host "[start-proxy] Next: scripts\windows\Test-Proxy.ps1   (stop with scripts\windows\Stop-Proxy.ps1)"

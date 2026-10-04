<#
.SYNOPSIS
  Idempotent Windows-native setup for m365-copilot-proxy: toolchain, deps, build,
  and the Chromium build Playwright needs for login.

.DESCRIPTION
  Safe to re-run. Each step only does work if it isn't already done:
    - verifies Node >= 22
    - activates the repo's pinned pnpm (via Corepack if available, else `npx pnpm@<pinned>`)
    - `pnpm install --frozen-lockfile` (never rewrites the lockfile)
    - `pnpm build`
    - installs the Chromium build matching the installed playwright-core version

.EXAMPLE
  pwsh scripts\windows\Setup-Proxy.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $RepoRoot

function Write-Step($msg) { Write-Host "[setup] $msg" -ForegroundColor Cyan }
function Write-Fail($msg) { Write-Host "[setup] FAIL: $msg" -ForegroundColor Red }

# --- Node version ---
Write-Step "Checking Node.js version..."
$nodeVersion = (node --version) -replace "^v", ""
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 22) {
    Write-Fail "Node $nodeVersion found; this repo requires Node 22+. Install a newer Node and re-run."
    exit 1
}
Write-Host "[setup] Node $nodeVersion OK"

# --- pnpm (pinned version from package.json's packageManager field) ---
Write-Step "Resolving pinned pnpm version from package.json..."
$pkg = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$pinnedPm = $pkg.packageManager
if (-not $pinnedPm -or $pinnedPm -notmatch "^pnpm@") {
    Write-Fail "package.json has no pnpm packageManager pin; refusing to guess a version."
    exit 1
}
$pnpmVersion = $pinnedPm.Split("@")[1]
Write-Host "[setup] repo pins $pinnedPm"

$pnpmCmd = $null
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    $installed = (pnpm --version)
    if ($installed -eq $pnpmVersion) {
        $pnpmCmd = "pnpm"
        Write-Host "[setup] pnpm $installed already active on PATH"
    } else {
        Write-Host "[setup] pnpm $installed on PATH differs from pinned $pnpmVersion; will use npx for this pin"
    }
}
if (-not $pnpmCmd) {
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        try {
            corepack enable 2>$null
            corepack prepare "pnpm@$pnpmVersion" --activate 2>$null
            if (Get-Command pnpm -ErrorAction SilentlyContinue) {
                $pnpmCmd = "pnpm"
                Write-Host "[setup] activated pnpm $pnpmVersion via Corepack"
            }
        } catch {
            Write-Host "[setup] Corepack activation needs admin rights (writing shims under Program Files); falling back to npx" -ForegroundColor Yellow
        }
    }
}
if (-not $pnpmCmd) {
    Write-Host "[setup] using 'npx pnpm@$pnpmVersion' (no admin rights required)"
    $pnpmCmd = "npx --yes pnpm@$pnpmVersion"
}

function Invoke-Pnpm([string]$Args) {
    $full = "$pnpmCmd $Args"
    Write-Host "[setup] > $full"
    $p = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", $full) -NoNewWindow -Wait -PassThru
    if ($p.ExitCode -ne 0) {
        Write-Fail "'$full' exited with code $($p.ExitCode)"
        exit $p.ExitCode
    }
}

# --- Install (lockfile-respecting) ---
Write-Step "Installing dependencies (--frozen-lockfile, never rewrites pnpm-lock.yaml)..."
Invoke-Pnpm "install --frozen-lockfile"

# --- Build ---
Write-Step "Building all workspace packages..."
Invoke-Pnpm "build"

if (-not (Test-Path (Join-Path $RepoRoot "packages\proxy\.output\server\index.mjs"))) {
    Write-Fail "Build did not produce packages\proxy\.output\server\index.mjs"
    exit 1
}

# --- Playwright Chromium ---
Write-Step "Installing Chromium matching the installed playwright-core..."
$pwPkgPath = Join-Path $RepoRoot "packages\core\node_modules\playwright\package.json"
if (Test-Path $pwPkgPath) {
    $pwVersion = (Get-Content $pwPkgPath -Raw | ConvertFrom-Json).version
    Write-Host "[setup] installed playwright version: $pwVersion"
    Invoke-Pnpm "--filter @m365-copilot/core exec playwright install chromium"
} else {
    Write-Host "[setup] no local playwright package found under packages\core\node_modules; trying pnpm dlx fallback" -ForegroundColor Yellow
    Invoke-Pnpm "dlx playwright@$pwVersion install chromium"
}

Write-Host ""
Write-Host "[setup] Done. Next: scripts\windows\Start-Proxy.ps1" -ForegroundColor Green

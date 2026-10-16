<#
.SYNOPSIS
  Windows smoke test for a running m365-copilot-proxy: /v1/models, a harmless
  chat completion, and a real tool-calling regression via the `pi` harness.

.DESCRIPTION
  Three checks, each printed PASS/FAIL; exits non-zero if any fails.
    1. GET  /v1/models            -> non-empty model list
    2. POST /v1/chat/completions  -> model echoes back an exact harmless phrase
    3. a real multi-turn pi run that must write a unique marker to disk via a
       tool call (not prose)  -  skipped with a clear note if `pi` isn't on PATH

  Uses the Claude tone by default: it runs agent-less, so this smoke test never
  triggers first-use Copilot Studio agent creation (that happens only for the
  GPT tones; see docs/windows-proxy.md).

.PARAMETER BaseUrl
  Proxy base URL. Default: reads .local\run\proxy.{host,port} written by
  Start-Proxy.ps1, else falls back to http://127.0.0.1:4141.

.PARAMETER Model
  Model id for the chat + tool-call checks. Default: claude-sonnet.

.EXAMPLE
  pwsh scripts\windows\Test-Proxy.ps1
#>
[CmdletBinding()]
param(
    [string]$BaseUrl,
    [string]$Model = "claude-sonnet"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$RunDir = Join-Path $RepoRoot ".local\run"

if (-not $BaseUrl) {
    $hostFile = Join-Path $RunDir "proxy.host"
    $portFile = Join-Path $RunDir "proxy.port"
    $h = if (Test-Path $hostFile) { (Get-Content $hostFile -Raw).Trim() } else { "127.0.0.1" }
    $p = if (Test-Path $portFile) { (Get-Content $portFile -Raw).Trim() } else { "4141" }
    $BaseUrl = "http://${h}:${p}"
}

Write-Host "[test-proxy] base URL: $BaseUrl   model: $Model"
$failures = 0

# --- 1. GET /v1/models ---
Write-Host "[test-proxy] [1/3] GET /v1/models ..."
try {
    $models = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -Method Get -TimeoutSec 15
    $ids = $models.data | ForEach-Object { $_.id }
    if (-not $ids -or $ids.Count -eq 0) {
        Write-Host "[test-proxy] FAIL: /v1/models returned an empty list" -ForegroundColor Red
        $failures++
    } else {
        Write-Host "[test-proxy] PASS: $($ids.Count) models (e.g. $($ids[0]))" -ForegroundColor Green
    }
} catch {
    Write-Host "[test-proxy] FAIL: /v1/models  -  $($_.Exception.Message)" -ForegroundColor Red
    $failures++
}

# --- 2. POST /v1/chat/completions  -  harmless exact phrase ---
Write-Host "[test-proxy] [2/3] POST /v1/chat/completions (harmless completion) ..."
# Keep this phrasing soft and the token innocuous-looking: an aggressive
# "output ONLY this exact string" instruction plus a string that reads like a
# test/verification code can itself look jailbreak-shaped to M365's content
# filter and gets refused (see AGENTS.md "Disengaged is driven by shape").
$phrase = "lighthouse-$(Get-Random -Maximum 99999)"
$chatBody = @{
    model    = $Model
    stream   = $false
    messages = @(@{ role = "user"; content = "Please reply with just this one word, nothing more: $phrase" })
} | ConvertTo-Json -Depth 5
try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" -Method Post -Body $chatBody -ContentType "application/json" -TimeoutSec 60
    $content = $resp.choices[0].message.content
    if ($content -and $content.Contains($phrase)) {
        Write-Host "[test-proxy] PASS: model echoed '$phrase'" -ForegroundColor Green
    } else {
        Write-Host "[test-proxy] FAIL: expected '$phrase' in response, got: $content" -ForegroundColor Red
        $failures++
    }
} catch {
    Write-Host "[test-proxy] FAIL: chat completion  -  $($_.Exception.Message)" -ForegroundColor Red
    $failures++
}

# --- 3. Real tool-call regression via pi ---
Write-Host "[test-proxy] [3/3] multi-turn tool-call regression (pi harness) ..."
$piCmd = Get-Command pi -ErrorAction SilentlyContinue
if (-not $piCmd) {
    Write-Host "[test-proxy] SKIP: 'pi' not found on PATH  -  install it to exercise the real tool-call loop (see https://pi.dev/)" -ForegroundColor Yellow
} else {
    $marker = "PI_SMOKE_$(Get-Date -Format 'yyyyMMddHHmmss')_$PID"
    $scratch = Join-Path $env:TEMP "pi-smoke-$([Guid]::NewGuid().ToString('N'))"
    $piHome = Join-Path $env:TEMP "pi-home-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $piHome ".pi\agent") | Out-Null

    $modelsJson = @{
        providers = @{
            m365 = @{
                api     = "openai-completions"
                apiKey  = "not-needed"
                baseUrl = "$BaseUrl/v1"
                compat  = @{ supportsDeveloperRole = $false; supportsReasoningEffort = $false; supportsUsageInStreaming = $false }
                models  = @(@{ id = $Model; name = $Model })
            }
        }
    } | ConvertTo-Json -Depth 6
    Set-Content -Path (Join-Path $piHome ".pi\agent\models.json") -Value $modelsJson

    $settingsJson = @{ defaultModel = $Model; defaultProvider = "m365"; enableInstallTelemetry = $false } | ConvertTo-Json
    Set-Content -Path (Join-Path $piHome ".pi\agent\settings.json") -Value $settingsJson

    $sentinel = Join-Path $scratch "sentinel.txt"
    $task = "Use the bash tool to run exactly: echo $marker > sentinel.txt`nThen stop. Do not explain. Actually run the command."

    Push-Location $scratch
    try {
        $env:PI_OFFLINE = "1"
        $prevHome = $env:HOME
        $env:HOME = $piHome
        $piArgs = @(
            "-p", "--provider", "m365", "--model", $Model,
            "--tools", "read,write,bash",
            "--no-context-files", "--no-extensions", "--no-skills", "--approve",
            $task
        )
        $job = Start-Job -ScriptBlock {
            # Do NOT name params $args or $home - both shadow PowerShell's
            # read-only automatic variables and throw "Cannot overwrite
            # variable ... because it is read-only or constant." at runtime.
            param($exePath, $exeArgs, $cwd, $homeDir)
            Set-Location $cwd
            # Node's os.homedir() reads USERPROFILE on Windows, not HOME - set
            # both so pi's config resolution actually lands in the isolated dir.
            $env:HOME = $homeDir
            $env:USERPROFILE = $homeDir
            $env:PI_OFFLINE = "1"
            & $exePath @exeArgs 2>&1
        } -ArgumentList $piCmd.Source, $piArgs, $scratch, $piHome
        $done = Wait-Job $job -Timeout 180
        if (-not $done) {
            Stop-Job $job | Out-Null
            Write-Host "[test-proxy] FAIL: pi run timed out after 180s" -ForegroundColor Red
            $failures++
        } else {
            Receive-Job $job | ForEach-Object { Write-Host "[pi] $_" }
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue

        if ((Test-Path $sentinel) -and (Select-String -Path $sentinel -Pattern $marker -Quiet)) {
            Write-Host "[test-proxy] PASS: tool loop executed; sentinel written with marker" -ForegroundColor Green
        } else {
            Write-Host "[test-proxy] FAIL: no sentinel with marker on disk  -  model answered in prose instead of calling the tool" -ForegroundColor Red
            $failures++
        }
    } finally {
        $env:HOME = $prevHome
        Pop-Location
        Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $piHome -ErrorAction SilentlyContinue
    }
}

Write-Host ""
if ($failures -gt 0) {
    Write-Host "[test-proxy] $failures check(s) FAILED" -ForegroundColor Red
    exit 1
}
Write-Host "[test-proxy] all checks PASSED" -ForegroundColor Green
exit 0

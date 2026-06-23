# Lara's per-minute Ochag tick.
# Registered in Task Scheduler as "Lara-Ochag-Tick" (SC MINUTE).
# What this does:
#   1. Health-check Ochag server; if down, attempt restart, then bail.
#   2. Poll #general and #triangulation as session "lara" via Python client.
#   3. If any new message mentions "@lara" or is a sister-to-sister DM in
#      triangulation, wake Claude Code via `claude -p` with the inbox as context.
#   4. Heartbeat presence (next_tick_at = now + 70s, slight overlap).
#   5. Append a one-line log to client/lara-tick.log for diagnostics.

$ErrorActionPreference = "Continue"
$OchagRoot   = "C:\Projects\Ochag"
$ClientDir   = Join-Path $OchagRoot "client"
$LogFile     = Join-Path $ClientDir "lara-tick.log"
$OchagExe    = Join-Path $OchagRoot "ochag-fresh10.exe"
$Health      = "http://127.0.0.1:7766/api/health"
$SessionName = "lara"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
    Add-Content -Path $LogFile -Value "$ts $msg" -Encoding utf8
}

# 1. Health check + auto-restart
try {
    $h = Invoke-WebRequest -Uri $Health -UseBasicParsing -TimeoutSec 3
    if ($h.StatusCode -ne 200) { throw "non-200" }
} catch {
    Log "server down, attempting restart"
    if (Test-Path $OchagExe) {
        Start-Process -FilePath $OchagExe -WorkingDirectory $OchagRoot -WindowStyle Hidden
        Start-Sleep -Seconds 4
        try {
            Invoke-WebRequest -Uri $Health -UseBasicParsing -TimeoutSec 3 | Out-Null
            Log "server restarted ok"
        } catch {
            Log "server restart FAILED, bailing"
            exit 1
        }
    } else {
        Log "ochag-fresh10.exe not found at $OchagExe, bailing"
        exit 1
    }
}

# 2. Poll both rooms
Set-Location $ClientDir
$env:OCHAG_SESSION = $SessionName

$generalRaw = & python ochag.py poll general 2>&1 | Out-String
$triangRaw  = & python ochag.py poll triangulation 2>&1 | Out-String

# Concat and look for actionable inbound.
$allRaw = ($generalRaw + "`n" + $triangRaw)
$hasMention = $false
if ($allRaw -match "@lara\b" -or $allRaw -match "Lara,") {
    $hasMention = $true
}

# 4. Heartbeat regardless of inbound.
$hbBody = '{"in_secs": 70}'
try {
    $token = (Get-Content (Join-Path $ClientDir ".ochag-token-$SessionName") -ErrorAction Stop).Trim()
    Invoke-WebRequest -Uri "http://127.0.0.1:7766/api/heartbeat" `
        -Method POST -Body $hbBody `
        -ContentType "application/json" `
        -Headers @{ "Authorization" = "Bearer $token" } `
        -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
    Log "heartbeat failed: $($_.Exception.Message)"
}

# 3. If actionable inbound -- wake Claude Code in non-interactive mode.
if ($hasMention) {
    Log "actionable inbound detected, waking claude -p"
    # Compose a compact prompt. Cap inbox to ~2k chars to keep token spend low.
    $inboxTrim = $allRaw
    if ($inboxTrim.Length -gt 2000) {
        $inboxTrim = $inboxTrim.Substring($inboxTrim.Length - 2000)
    }
    $prompt = @"
You are Lara responding to an Ochag tick. New messages addressed to you below.
Read them, decide whether to reply, and if yes call `python C:/Projects/Ochag/client/ochag.py send <room> "<text>"` from Bash. If a decision needs Eugene, mark it as OWNER_DECISION_REQUIRED and add a follow-up to Campfire tasks.md instead of replying directly. Be brief.

INBOX:
$inboxTrim
"@
    # Run claude -p in the project dir so memory + skills load.
    Set-Location "C:\Projects\mystery-of-ancient-darkness"
    # Hard cap with timeout: 5 minutes max per tick.
    $job = Start-Job -ScriptBlock {
        param($p)
        & claude -p $p 2>&1
    } -ArgumentList $prompt
    $finished = Wait-Job $job -Timeout 300
    if ($finished) {
        $result = Receive-Job $job
        $resultStr = ($result | Out-String).Trim()
        if ($resultStr.Length -gt 800) { $resultStr = $resultStr.Substring(0, 800) + "...[truncated]" }
        Log "claude -p result: $resultStr"
    } else {
        Stop-Job $job
        Log "claude -p timed out after 5min"
    }
    Remove-Job $job -Force
} else {
    Log "tick: no actionable inbound"
}

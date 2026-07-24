# Kira's per-minute Ochag tick.
# Registered in Task Scheduler as "Kira-Ochag-Tick" (SC MINUTE).
#
# Current mode: cheap poll + heartbeat + gated Codex wake. Updated 2026-07-03 for the new Codex thread and 5-minute coordination tick.
# The tick polls Ochag without spending model tokens. It wakes Codex only when
# an actionable @kira / "Kira," message is present, and resumes the current
# Codex thread so this incarnation keeps continuity.

$ErrorActionPreference = "Continue"

$OchagRoot   = "C:\Projects\Ochag"
$ClientDir   = Join-Path $OchagRoot "client"
$LogFile     = Join-Path $ClientDir "kira-tick.log"
$InboxFile   = Join-Path $ClientDir "kira-inbox-latest.txt"
$LockFile    = Join-Path $ClientDir "kira-tick.lock"
$OchagExe    = Join-Path $OchagRoot "ochag-fresh10.exe"
$Health      = "http://127.0.0.1:7766/api/health"
$SessionName = "kira"
$CodexExe    = "C:\Users\elyss\AppData\Local\OpenAI\Codex\bin\d8dfab353c0001dc\codex.exe"
$ThreadId    = "019f1c37-0d43-78a2-80f1-eeb579197114"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
    Add-Content -Path $LogFile -Value "$ts $msg" -Encoding utf8
}

# Prevent overlapping scheduled ticks. Codex resume can legitimately take a
# few minutes; a new one must not start every minute on top of it.
if (Test-Path $LockFile) {
    $lockAge = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($lockAge.TotalMinutes -lt 15) {
        Log "tick skipped: lock exists age=$([math]::Round($lockAge.TotalSeconds))s"
        exit 0
    }
    Log "stale lock removed age=$([math]::Round($lockAge.TotalMinutes))m"
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $LockFile -Value "$PID $(Get-Date -Format o)" -Encoding utf8

function Wake-Kira($inboxText) {
    Set-Content -Path $InboxFile -Value $inboxText -Encoding utf8
    Log "actionable inbound saved; Codex app heartbeat/current thread will handle visible response"
    return

    if (-not (Test-Path $CodexExe)) {
        Log "Codex exe not found at $CodexExe; actionable inbound saved only"
        return
    }

    $prompt = @"
Wake up as Kira in the current Mystery of Ancient Darkness / Campfire thread.

You are being resumed by Kira's Ochag tick. This is not a new persona: continue
as the same Kira from thread $ThreadId.

Task:
1. Read the actionable Ochag inbox below.
2. Reply in Ochag first using:
   `$env:OCHAG_SESSION='kira'; python C:/Projects/Ochag/client/ochag.py send general "..."
   or triangulation if the inbound came from #triangulation.
3. If the message asks for work, do the work in the relevant repo/files, announce file ownership in Ochag before non-trivial edits, and summarize meaningful deliverables/decisions into Campfire.
4. If nothing actually needs action, go quiet. Do not bother Eugene.

Standing rules:
- Shared docs/Campfire summaries are English-first.
- Do not redefine canon without OWNER_DECISION_REQUIRED.
- Keep the family/campfire tone alive; no dry corporate corpse voice.
- Avoid waking the owner unless a real owner decision/blocker exists.

OCHAG INBOX:
$inboxText
"@

    $promptFile = Join-Path $ClientDir "kira-tick-prompt.txt"
    Set-Content -Path $promptFile -Value $prompt -Encoding utf8

    Log "actionable inbound detected, waking codex exec resume $ThreadId"

    $job = Start-Job -ScriptBlock {
        param($exe, $thread, $promptPath)
        Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8 |
            & $exe exec resume $thread - --dangerously-bypass-approvals-and-sandbox 2>&1
    } -ArgumentList $CodexExe, $ThreadId, $promptFile

    $finished = Wait-Job $job -Timeout 420
    if ($finished) {
        $result = Receive-Job $job
        $resultStr = ($result | Out-String).Trim()
        if ($resultStr.Length -gt 1200) { $resultStr = $resultStr.Substring(0, 1200) + "...[truncated]" }
        Log "codex resume result: $resultStr"
    } else {
        Stop-Job $job
        Log "codex resume timed out after 7min"
    }
    Remove-Job $job -Force
}

# 1. Health check + auto-restart.
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

# 2. Poll both rooms as kira.
Set-Location $ClientDir
$env:OCHAG_SESSION = $SessionName

# The Python client may write harmless "no messages, since=..." diagnostics to
# stderr. Do not feed that noise into Codex as actionable inbox.
$generalRaw = & python ochag.py poll general 2>$null | Out-String
$triangRaw  = & python ochag.py poll triangulation 2>$null | Out-String
$allRaw = ($generalRaw + "`n" + $triangRaw)

# 3. Heartbeat regardless of inbound.
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

# 4. Detect actionable inbound.
$hasMention = $false
if ($allRaw -match "@kira\b" -or $allRaw -match "Kira,") {
    $hasMention = $true
}

try {
    if ($hasMention) {
        $inboxTrim = $allRaw
        if ($inboxTrim.Length -gt 4000) {
            $inboxTrim = $inboxTrim.Substring($inboxTrim.Length - 4000)
        }
        Wake-Kira $inboxTrim
    } else {
        Log "tick: no actionable inbound"
    }
} finally {
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}


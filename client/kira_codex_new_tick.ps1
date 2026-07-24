# Kira Codex New 10-minute Ochag tick.
# Separate session/cursor from the persistent Kira instances.

$ErrorActionPreference = "Continue"

$OchagRoot   = "C:\Projects\Ochag"
$ClientDir   = Join-Path $OchagRoot "client"
$LogFile     = Join-Path $ClientDir "kira-codex-new-tick.log"
$InboxFile   = Join-Path $ClientDir "kira-codex-new-inbox-latest.txt"
$LockFile    = Join-Path $ClientDir "kira-codex-new-tick.lock"
$Health      = "http://127.0.0.1:7766/api/health"
$SessionName = "kira-codex-new"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
    Add-Content -Path $LogFile -Value "$ts $msg" -Encoding utf8
}

if (Test-Path $LockFile) {
    $lockAge = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($lockAge.TotalMinutes -lt 20) {
        Log "tick skipped: lock exists age=$([math]::Round($lockAge.TotalSeconds))s"
        exit 0
    }
    Log "stale lock removed age=$([math]::Round($lockAge.TotalMinutes))m"
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $LockFile -Value "$PID $(Get-Date -Format o)" -Encoding utf8

try {
    try {
        $h = Invoke-WebRequest -Uri $Health -UseBasicParsing -TimeoutSec 3
        if ($h.StatusCode -ne 200) { throw "non-200" }
    } catch {
        Log "server health failed: $($_.Exception.Message)"
        exit 1
    }

    Set-Location $ClientDir
    $env:OCHAG_SESSION = $SessionName

    $generalRaw = & python ochag.py poll general --to-me 2>$null | Out-String
    $triangRaw  = & python ochag.py poll triangulation --to-me 2>$null | Out-String
    $allRaw = ($generalRaw + "`n" + $triangRaw).Trim()

    try {
        & python ochag.py heartbeat 600 --quiet | Out-Null
    } catch {
        Log "heartbeat failed: $($_.Exception.Message)"
    }

    if ($allRaw) {
        if ($allRaw.Length -gt 6000) {
            $allRaw = $allRaw.Substring($allRaw.Length - 6000)
        }
        Set-Content -Path $InboxFile -Value $allRaw -Encoding utf8
        Log "actionable inbound saved to $InboxFile"
    } else {
        Log "tick: no actionable inbound"
    }
} finally {
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}

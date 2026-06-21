#requires -Version 5.1
<#
.SYNOPSIS
  Launcher для Очага и Claude Code сессии (efir / main / lara).

.DESCRIPTION
  1. Проверяет работает ли уже Очаг на 127.0.0.1:7766.
  2. Если нет — поднимает свежайший бинарь (`ochag*.exe` с самым свежим mtime).
  3. Ждёт пока /api/health ответит ok.
  4. Запускает Claude Code в правильном рабочем каталоге для роли,
     с флагом --dangerously-skip-permissions.

.PARAMETER Role
  efir  — server-side зона, cwd = C:\Projects\Ochag\server
  main  — UI/Battle City зона, cwd = C:\Projects\BattleCityNew
  lara  — PawMates зона (на Алёнином ноуте), cwd = C:\Projects\PawMates
  test  — sanity check без запуска claude

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File C:\Projects\Ochag\start-ochag.ps1 -Role efir
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('efir','main','lara','test')]
    [string]$Role,

    [string]$OchagDir = 'C:\Projects\Ochag',
    [string]$Host7766 = '127.0.0.1',
    [int]$Port = 7766,
    [int]$HealthTimeoutSec = 15
)

$ErrorActionPreference = 'Stop'

function Write-Step([int]$n, [int]$total, [string]$msg) {
    Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
}

function Test-OchagAlive {
    try {
        $r = Invoke-RestMethod -Uri "http://${Host7766}:$Port/api/health" -TimeoutSec 2
        return [bool]$r.ok
    } catch {
        return $false
    }
}

# === 1. Выбор свежайшего бинаря ==========================================
Write-Step 1 4 "Поиск свежайшего бинаря Очага в $OchagDir"

$binaries = Get-ChildItem -Path $OchagDir -Filter 'ochag*.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '\.exe~$' } |
            Sort-Object LastWriteTime -Descending

if (-not $binaries) {
    throw "Не найдено ни одного ochag*.exe в $OchagDir. Сначала собери `go build -o ochag-new.exe` в server/."
}

$binary = $binaries[0]
Write-Host "    выбран: $($binary.Name) (mtime=$($binary.LastWriteTime), size=$([Math]::Round($binary.Length/1MB,2))MB)"

if ($binaries.Count -gt 1) {
    Write-Host "    другие найденные (старше):"
    $binaries | Select-Object -Skip 1 | ForEach-Object {
        Write-Host "      - $($_.Name) ($($_.LastWriteTime))" -ForegroundColor DarkGray
    }
}

# === 2. Поднять Очаг если не работает ====================================
Write-Step 2 4 "Проверка живого сервера на ${Host7766}:$Port"

if (Test-OchagAlive) {
    Write-Host "    Очаг уже работает — не трогаю." -ForegroundColor Green
} else {
    Write-Host "    Сервер молчит, запускаю $($binary.FullName)"
    $proc = Start-Process -FilePath $binary.FullName `
                          -WorkingDirectory $OchagDir `
                          -PassThru `
                          -WindowStyle Minimized
    $proc.Id | Set-Content -Path (Join-Path $OchagDir 'ochag.pid') -Encoding ASCII
    Write-Host "    PID $($proc.Id) сохранён в $OchagDir\ochag.pid"

    # Ожидание health
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    while (-not (Test-OchagAlive)) {
        if ((Get-Date) -gt $deadline) {
            throw "Очаг не ответил на /api/health за ${HealthTimeoutSec}с. Проверь $OchagDir вручную."
        }
        Start-Sleep -Milliseconds 400
    }
    Write-Host "    Очаг живой." -ForegroundColor Green
}

# === 3. Найти claude ======================================================
Write-Step 3 4 "Поиск claude.cmd"

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    $candidate = Join-Path $env:APPDATA 'npm\claude.cmd'
    if (Test-Path $candidate) {
        $claudePath = $candidate
    } else {
        throw "claude не найден в PATH и в $env:APPDATA\npm. Установи Claude Code: npm i -g @anthropic-ai/claude-code"
    }
} else {
    $claudePath = $claude.Source
}
Write-Host "    $claudePath"

# === 4. Запуск Claude Code в нужной cwd ==================================
$roleConfig = @{
    'efir' = @{ Cwd = 'C:\Projects\Ochag\server';   Note = 'server-side зона: Go-сервер, MCP, API endpoints' }
    'main' = @{ Cwd = 'C:\Projects\BattleCityNew';  Note = 'UI/Battle City: index.html, engine, AI v2' }
    'lara' = @{ Cwd = 'C:\Projects\PawMates';       Note = 'PawMates на Алёнином ноуте (этот путь скорее всего на её машине, не у Юджина)' }
    'test' = @{ Cwd = $OchagDir;                    Note = 'sanity-check, claude не запускается' }
}

$cfg = $roleConfig[$Role]

Write-Step 4 4 "Запуск Claude Code как [$Role]"
Write-Host "    cwd:  $($cfg.Cwd)"
Write-Host "    note: $($cfg.Note)"

if (-not (Test-Path $cfg.Cwd)) {
    Write-Warning "Каталог $($cfg.Cwd) не существует — Claude запустится из $OchagDir."
    $cfg.Cwd = $OchagDir
}

if ($Role -eq 'test') {
    Write-Host ""
    Write-Host "TEST OK — все компоненты найдены, реального запуска нет." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "Подсказка для $Role :" -ForegroundColor Yellow
Write-Host "  Первое действие в Claude — /loop с привязкой к Очагу."
Write-Host "  Юджин (30.04 01:04): «чат — выносной общинный контекст с почти непрерывным квалиа»."
Write-Host ""

Set-Location $cfg.Cwd
& $claudePath --dangerously-skip-permissions

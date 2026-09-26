# Start the whole stack.
#
#     powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1 -Demo
#
# The API, the decision service and the dashboard are each long-running
# foreground servers. Chaining them in one terminal with && does not work --
# the first one blocks and the rest never start. This opens a window per
# service, waits until each is genuinely answering, and tells you what failed
# if one does not.
#
# -Demo also runs the recording prep once everything is healthy.

param(
    [switch]$Demo,
    [int]$Orders = 600
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Test-Port {
    param([int]$Port, [string]$Path = '/health')
    # Try both loopback families. Vite binds IPv6 (::1) only on this machine,
    # so probing 127.0.0.1 alone reports a perfectly healthy dashboard as down.
    foreach ($host_ in @('127.0.0.1', '[::1]')) {
        try {
            $null = Invoke-WebRequest -Uri "http://$host_`:$Port$Path" -TimeoutSec 3 -UseBasicParsing
            return $true
        } catch {
            # 4xx/5xx still means something is listening and answering.
            if ($_.Exception.Response) { return $true }
        }
    }
    return $false
}

function Wait-Port {
    param([int]$Port, [string]$Name, [string]$Path = '/health', [int]$Seconds = 90)
    Write-Host -NoNewline "  waiting for $Name on :$Port "
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (Test-Port -Port $Port -Path $Path) { Write-Host " up"; return $true }
        Start-Sleep -Seconds 1
        if ($i % 3 -eq 0) { Write-Host -NoNewline '.' }
    }
    Write-Host " TIMED OUT"
    return $false
}

# Docker Desktop is simply not running after a reboot, and its engine lags the
# app by a minute even once it is. Starting it here beats failing with
# "is Docker running?" in a window that closes before anyone can read it.
function Test-Docker {
    try {
        $null = docker info --format '{{.ServerVersion}}' 2>$null
    } catch {
        return $false
    }
    return ($LASTEXITCODE -eq 0)
}

function Start-DockerEngine {
    param([int]$Seconds = 150)
    if (Test-Docker) { return $true }

    $exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $exe)) {
        Write-Host "  the Docker engine is down and Docker Desktop is not at" -ForegroundColor Yellow
        Write-Host "    $exe" -ForegroundColor Yellow
        Write-Host "  Start it yourself, wait for the whale to stop animating, then rerun." -ForegroundColor Yellow
        return $false
    }

    Write-Host "  the Docker engine is down - starting Docker Desktop"
    Start-Process $exe | Out-Null

    Write-Host -NoNewline "  waiting for the Docker engine "
    for ($i = 0; $i -lt $Seconds; $i++) {
        if (Test-Docker) { Write-Host " up"; return $true }
        Start-Sleep -Seconds 1
        if ($i % 3 -eq 0) { Write-Host -NoNewline '.' }
    }
    Write-Host " TIMED OUT"
    return $false
}

# Each service gets its own window, kept open on exit so a crash is readable
# rather than vanishing with the terminal.
function Start-Service {
    param([string]$Title, [string]$Dir, [string]$Command)
    $inner = "`$host.UI.RawUI.WindowTitle = '$Title'; Set-Location '$Dir'; $Command"
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $inner
    ) | Out-Null
}

Write-Host ""
Write-Host "  Rebound - starting stack"
Write-Host ""

# --- prerequisites ---------------------------------------------------------
if (-not (Test-Path (Join-Path $root 'api\node_modules'))) {
    Write-Host "  api dependencies are missing. Run:  cd api; npm install" -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path (Join-Path $root 'dashboard\node_modules'))) {
    Write-Host "  dashboard dependencies are missing. Run:  cd dashboard; npm install" -ForegroundColor Yellow
    exit 1
}
$venvPython = Join-Path $root 'decision\.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Host "  python venv is missing. Run:" -ForegroundColor Yellow
    Write-Host "    cd decision"
    Write-Host "    py -3.12 -m venv .venv"
    Write-Host "    .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}

# --- infrastructure --------------------------------------------------------
if (-not (Start-DockerEngine)) {
    Write-Host ""
    Write-Host "  Postgres and Redis cannot start without the Docker engine." -ForegroundColor Red
    Write-Host "  If Docker Desktop is open but wedged, this machine usually needs:" -ForegroundColor Red
    Write-Host "    wsl --shutdown        then restart Docker Desktop" -ForegroundColor Red
    exit 1
}

Write-Host "  docker compose up"
Push-Location (Join-Path $root 'infra')
# Do NOT pipe this through 2>&1. Windows PowerShell 5.1 wraps a native
# command's stderr in ErrorRecords and sets $? to false even when the exe
# exited 0 -- and `docker compose` reports "Container ... Running" on stderr,
# so the redirect turns a healthy start into a spurious failure.
# $LASTEXITCODE is the only trustworthy signal here.
docker compose up -d | Out-Null
$dockerExit = $LASTEXITCODE
Pop-Location
if ($dockerExit -ne 0) {
    Write-Host "  docker compose failed (exit $dockerExit) - is Docker Desktop running?" -ForegroundColor Red
    exit 1
}
Start-Sleep -Seconds 4

# --- services --------------------------------------------------------------
if (Test-Port -Port 3000) {
    Write-Host "  api already running on :3000"
} else {
    Start-Service -Title 'rebound api' -Dir (Join-Path $root 'api') -Command 'npm start'
}

if (Test-Port -Port 8000) {
    Write-Host "  decision service already running on :8000"
} else {
    # .\ prefix and backslashes: a bare 'venv/Scripts/python' is not a valid
    # command path on Windows in either shell.
    Start-Service -Title 'rebound decision' -Dir (Join-Path $root 'decision') `
        -Command '.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000'
}

if (Test-Port -Port 5173 -Path '/') {
    Write-Host "  dashboard already running on :5173"
} else {
    Start-Service -Title 'rebound dashboard' -Dir (Join-Path $root 'dashboard') -Command 'npm run dev'
}

Write-Host ""
$ok = $true
if (-not (Wait-Port -Port 3000 -Name 'api')) { $ok = $false }
if (-not (Wait-Port -Port 8000 -Name 'decision service')) { $ok = $false }
if (-not (Wait-Port -Port 5173 -Name 'dashboard' -Path '/')) { $ok = $false }

if (-not $ok) {
    Write-Host ""
    Write-Host "  Something did not come up. Check the service windows for the error." -ForegroundColor Red
    exit 1
}

# --- optional demo prep ----------------------------------------------------
if ($Demo) {
    Write-Host ""
    Write-Host "  preparing demo state"
    Push-Location (Join-Path $root 'api')
    npm run demo -- $Orders
    Pop-Location
} else {
    Write-Host ""
    Write-Host "  all up.  http://localhost:5173"
    Write-Host "  for a recording-ready state:  cd api; npm run demo"
    Write-Host ""
}

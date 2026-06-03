<#
  Sets up MongoDB (single-node replica set) + Redis locally on Windows,
  WITHOUT Docker. Run this in an ELEVATED PowerShell (Run as Administrator).

  What it does:
    1. Installs MongoDB and a Redis-compatible server via Chocolatey (if missing).
    2. Reconfigures the MongoDB service to run as replica set "rs0"
       (required for the multi-document transactions used by the wallet).
    3. Initiates the replica set.
    4. Starts Redis.

  After it finishes, your existing .env values work as-is:
    MONGO_URI=mongodb://127.0.0.1:27017/htss_club?replicaSet=rs0
    REDIS_URL=redis://127.0.0.1:6379
#>

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run this script in an ELEVATED PowerShell (Run as Administrator).'
  }
}

Assert-Admin

if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  throw 'Chocolatey not found. Install from https://chocolatey.org/install'
}

Write-Host '== Installing MongoDB + Redis (skips if already present) ==' -ForegroundColor Cyan
choco install mongodb -y
# redis-64 is the maintained Windows Redis package on Chocolatey.
choco install redis-64 -y

# Refresh PATH for this session so mongod/mongosh are reachable.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

# ── Locate mongod.cfg ────────────────────────────────────────────
$cfgCandidates = @(
  'C:\Program Files\MongoDB\Server\*\bin\mongod.cfg',
  'C:\ProgramData\chocolatey\lib\mongodb\tools\*\bin\mongod.cfg'
)
$cfg = $null
foreach ($pattern in $cfgCandidates) {
  $found = Get-ChildItem $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $cfg = $found.FullName; break }
}

if ($cfg) {
  Write-Host "== Enabling replica set in $cfg ==" -ForegroundColor Cyan
  $content = Get-Content $cfg -Raw
  if ($content -notmatch 'replSetName') {
    if ($content -match '(?m)^#?replication:') {
      $content = $content -replace '(?m)^#?replication:.*', "replication:`n  replSetName: rs0"
    } else {
      $content = $content.TrimEnd() + "`r`nreplication:`r`n  replSetName: rs0`r`n"
    }
    Set-Content $cfg $content -Encoding UTF8
    Write-Host 'Added replication.replSetName = rs0' -ForegroundColor Green
  } else {
    Write-Host 'Replica set already configured.' -ForegroundColor Green
  }

  Write-Host '== Restarting MongoDB service ==' -ForegroundColor Cyan
  $svc = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
  if ($svc) {
    Restart-Service MongoDB
    Start-Sleep -Seconds 5
  } else {
    Write-Warning 'MongoDB service not found; start mongod manually with --replSet rs0.'
  }

  Write-Host '== Initiating replica set rs0 ==' -ForegroundColor Cyan
  $mongosh = Get-Command mongosh -ErrorAction SilentlyContinue
  if ($mongosh) {
    & mongosh --quiet --eval "try { rs.status() } catch (e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]}) }"
  } else {
    Write-Warning 'mongosh not on PATH. Open a new terminal and run: mongosh --eval "rs.initiate()"'
  }
} else {
  Write-Warning 'Could not locate mongod.cfg. Configure replica set manually.'
}

# ── Redis ────────────────────────────────────────────────────────
Write-Host '== Starting Redis service ==' -ForegroundColor Cyan
$redisSvc = Get-Service -Name 'Redis' -ErrorAction SilentlyContinue
if ($redisSvc) {
  Start-Service Redis -ErrorAction SilentlyContinue
  Write-Host 'Redis service started.' -ForegroundColor Green
} else {
  Write-Warning 'Redis service not found; you may need to start redis-server manually.'
}

Write-Host ''
Write-Host 'Done. Verify with:' -ForegroundColor Cyan
Write-Host '  mongosh --eval "rs.status().ok"'
Write-Host '  redis-cli ping'
Write-Host 'Then run: npm run start:dev'

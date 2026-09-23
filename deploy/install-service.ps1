<#
    Install the Dhishaai Admin Portal as a Windows service.

    Uses NSSM when it is on PATH, because a real service is what you want:
    it starts before anyone logs in, restarts on failure with backoff, and is
    managed from services.msc like anything else.

    With no NSSM it falls back to a Scheduled Task set to run at boot under
    SYSTEM, which needs nothing installed and covers the same ground.

    Run from an elevated PowerShell:
        .\deploy\install-service.ps1 -Port 4000
        .\deploy\install-service.ps1 -Port 4000 -TrustProxy -SecureCookies -Hsts
#>
[CmdletBinding()]
param(
    [int]    $Port          = 4000,
    [string] $ServiceName   = 'DhishaaiAdmin',
    [switch] $TrustProxy,       # behind IIS/nginx/Caddy terminating TLS
    [switch] $SecureCookies,    # force the Secure flag on session cookies
    [switch] $Hsts,             # send Strict-Transport-Security over HTTPS
    [string] $Secret = ''       # DHISHAAI_SECRET; generated if left empty
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as Administrator).'
}

$AppDir = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $AppDir 'server.js'
if (-not (Test-Path $Server)) { throw "server.js not found under $AppDir" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe is not on PATH. Install Node.js 22.5+ first.' }

$nodeVersion = (& $node --version).TrimStart('v')
$major = [int]($nodeVersion -split '\.')[0]
$minor = [int]($nodeVersion -split '\.')[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
    throw "Node $nodeVersion is too old. This app needs 22.5 or newer for node:sqlite."
}
Write-Host "Node $nodeVersion at $node" -ForegroundColor Green

# A key kept in the service environment rather than beside the database.
if (-not $Secret) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Write-Host 'Generated a DHISHAAI_SECRET for encrypting stored credentials.' -ForegroundColor Yellow
}

$envPairs = [ordered]@{
    PORT             = "$Port"
    NODE_ENV         = 'production'
    DHISHAAI_SECRET  = $Secret
}
if ($TrustProxy)    { $envPairs['TRUST_PROXY']    = '1' }
if ($SecureCookies) { $envPairs['SECURE_COOKIES'] = '1' }
if ($Hsts)          { $envPairs['HSTS']           = '1' }

$secretFile = Join-Path $AppDir 'deploy\SECRET.txt'
"DHISHAAI_SECRET=$Secret" | Set-Content -Path $secretFile -Encoding ascii
Write-Host "Secret written to $secretFile — store it in your password manager, then delete the file." -ForegroundColor Yellow

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source

if ($nssm) {
    # ---------------------------------------------------------- NSSM service
    Write-Host "Installing service '$ServiceName' via NSSM..." -ForegroundColor Cyan
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        & $nssm stop   $ServiceName confirm | Out-Null
        & $nssm remove $ServiceName confirm | Out-Null
    }
    & $nssm install $ServiceName $node $Server
    & $nssm set $ServiceName AppDirectory $AppDir
    & $nssm set $ServiceName DisplayName  'Dhishaai Admin Portal'
    & $nssm set $ServiceName Description  'Student, fee and lifecycle management portal.'
    & $nssm set $ServiceName Start        SERVICE_AUTO_START

    # Restart on failure, backing off so a crash loop cannot peg the machine.
    & $nssm set $ServiceName AppExit Default Restart
    & $nssm set $ServiceName AppRestartDelay 5000
    & $nssm set $ServiceName AppThrottle     10000

    $logDir = Join-Path $AppDir 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    & $nssm set $ServiceName AppStdout (Join-Path $logDir 'service.log')
    & $nssm set $ServiceName AppStderr (Join-Path $logDir 'service-error.log')
    & $nssm set $ServiceName AppRotateFiles 1
    & $nssm set $ServiceName AppRotateBytes 10485760

    $envBlock = ($envPairs.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`r`n"
    & $nssm set $ServiceName AppEnvironmentExtra $envBlock

    & $nssm start $ServiceName
    Write-Host "Service '$ServiceName' installed and started." -ForegroundColor Green
}
else {
    # ------------------------------------------------- Scheduled Task fallback
    Write-Host 'NSSM not found — installing a Scheduled Task instead.' -ForegroundColor Yellow
    Write-Host '  (For a proper service: choco install nssm, then re-run this.)' -ForegroundColor DarkGray

    # The task runs a launcher so the environment is set in one place.
    $launcher = Join-Path $AppDir 'deploy\run-portal.cmd'
    $lines = @('@echo off', "cd /d `"$AppDir`"")
    foreach ($k in $envPairs.Keys) { $lines += "set $k=$($envPairs[$k])" }
    $lines += "`"$node`" `"$Server`" >> `"$AppDir\logs\service.log`" 2>&1"
    New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'logs') | Out-Null
    $lines | Set-Content -Path $launcher -Encoding ascii

    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue

    $action   = New-ScheduledTaskAction -Execute $launcher
    $trigger  = New-ScheduledTaskTrigger -AtStartup
    $principal= New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
                    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'Dhishaai Admin Portal' | Out-Null

    Start-ScheduledTask -TaskName $ServiceName
    Write-Host "Scheduled Task '$ServiceName' registered and started." -ForegroundColor Green
}

Start-Sleep -Seconds 3
try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 10
    Write-Host "Portal responding on http://localhost:$Port/ (HTTP $($r.StatusCode))" -ForegroundColor Green
} catch {
    Write-Host "Not responding yet on port $Port. Check logs\service-error.log" -ForegroundColor Red
}

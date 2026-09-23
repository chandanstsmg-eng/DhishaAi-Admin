<#
    Lock down the data directory.

    The database holds every student record, and the key file next to it is what
    makes the stored mail credential readable. By default a folder under a user
    profile is readable by anyone who can log into the machine — on a shared
    office server that is a wider audience than it sounds.

    This strips inherited access and leaves SYSTEM and Administrators only,
    which is what the service runs as.

    Run from an elevated PowerShell:
        .\deploy\harden-permissions.ps1
        .\deploy\harden-permissions.ps1 -AlsoAllow 'DOMAIN\ITAdmins'
#>
[CmdletBinding()]
param(
    [string[]] $AlsoAllow = @()
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as Administrator).'
}

$AppDir  = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $AppDir 'data'
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

Write-Host "Securing $DataDir" -ForegroundColor Cyan

# /inheritance:r drops everything inherited from the parent folder, so the
# grants below are the complete list rather than additions to it.
& icacls $DataDir /inheritance:r                       | Out-Null
& icacls $DataDir /grant:r 'SYSTEM:(OI)(CI)F'          | Out-Null
& icacls $DataDir /grant:r 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
foreach ($who in $AlsoAllow) {
    & icacls $DataDir /grant:r "${who}:(OI)(CI)M"      | Out-Null
    Write-Host "  also granted: $who" -ForegroundColor DarkGray
}

# The key file is the single most sensitive thing here — no inheritance at all.
$key = Join-Path $DataDir '.secret-key'
if (Test-Path $key) {
    & icacls $key /inheritance:r                        | Out-Null
    & icacls $key /grant:r 'SYSTEM:F'                   | Out-Null
    & icacls $key /grant:r 'BUILTIN\Administrators:F'   | Out-Null
    Write-Host '  .secret-key locked to SYSTEM + Administrators' -ForegroundColor DarkGray
}

# Hide the deploy secret dump if it is still lying around from install.
$secretFile = Join-Path $AppDir 'deploy\SECRET.txt'
if (Test-Path $secretFile) {
    Write-Host ''
    Write-Host "  deploy\SECRET.txt still exists. Save it to your password manager" -ForegroundColor Yellow
    Write-Host '  and delete it — it is the key to every stored credential.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Effective permissions:' -ForegroundColor Cyan
& icacls $DataDir

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green

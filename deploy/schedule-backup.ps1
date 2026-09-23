<#
    Register a daily backup as a Scheduled Task, and optionally copy each one
    off the machine.

    `npm run backup` already keeps the last 20 copies next to the database.
    That covers a bad import or a mistaken delete; it does nothing for the disk
    dying or the server being encrypted, because the copies are on the same
    volume as the original. -OffsiteDir is what makes it a real backup: a file
    share, a mapped drive, a synced folder — anywhere with a different failure
    mode from this machine.

    Run from an elevated PowerShell:
        .\deploy\schedule-backup.ps1 -At 02:00
        .\deploy\schedule-backup.ps1 -At 02:00 -OffsiteDir '\\fileserver\backups\dhishaai'
#>
[CmdletBinding()]
param(
    [string] $At          = '02:00',
    [string] $TaskName    = 'DhishaaiAdminBackup',
    [string] $OffsiteDir  = '',
    [int]    $KeepOffsite = 30
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as Administrator).'
}

$AppDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe is not on PATH.' }

# The script the task runs: take the backup, then copy it away and prune.
$runner = Join-Path $AppDir 'deploy\run-backup.ps1'
$runnerBody = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$AppDir'
& '$node' 'src\backup.js'

`$offsite = '$OffsiteDir'
if (`$offsite) {
    if (-not (Test-Path `$offsite)) { New-Item -ItemType Directory -Force -Path `$offsite | Out-Null }
    `$src = Join-Path '$AppDir' 'data\backups'
    `$newest = Get-ChildItem `$src -Filter '*.db' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (`$newest) {
        Copy-Item `$newest.FullName -Destination `$offsite -Force
        Write-Output "Copied `$(`$newest.Name) to `$offsite"
    }
    # The key file is what makes an encrypted credential readable again —
    # a backup without it restores the data but not the mailbox.
    `$key = Join-Path '$AppDir' 'data\.secret-key'
    if (Test-Path `$key) { Copy-Item `$key -Destination (Join-Path `$offsite '.secret-key') -Force }

    Get-ChildItem `$offsite -Filter '*.db' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $KeepOffsite |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
"@
$runnerBody | Set-Content -Path $runner -Encoding utf8

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
               -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Daily backup of the Dhishaai admin database.' | Out-Null

Write-Host "Daily backup scheduled at $At (task '$TaskName')." -ForegroundColor Green
if ($OffsiteDir) { Write-Host "Offsite copy -> $OffsiteDir (keeping $KeepOffsite)" -ForegroundColor Green }
else { Write-Host 'No -OffsiteDir given: copies stay on this machine only.' -ForegroundColor Yellow }

Write-Host 'Running once now to prove it works...' -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Last result: $($info.LastTaskResult) (0 = success)" -ForegroundColor `
    $(if ($info.LastTaskResult -eq 0) { 'Green' } else { 'Red' })

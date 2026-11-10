# Launch the SMART Disk Analyzer on Windows.
#
# Windows only lets administrators read raw disk data, so this script elevates
# itself, and it locates node.exe on its own - neither node nor smartctl has to
# be on PATH for the dashboard to work.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File bin\run-windows.ps1
#   bin\run-windows.cmd                 (same thing, double-clickable)
#   bin\run-windows.cmd -Port 8080 -NoBrowser

[CmdletBinding()]
param(
  [int]$Port = 7373,
  [switch]$NoBrowser,
  # For tests and CI: run without asking for elevation.
  [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Find-NodeExe {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Add-SmartctlToPath {
  $bin = Join-Path $env:ProgramFiles 'smartmontools\bin'
  if (-not (Test-Path -LiteralPath $bin)) { return $false }
  $parts = @($env:PATH -split ';' | Where-Object { $_ })
  if ($parts -contains $bin) { return $true }
  $env:PATH = $bin + ';' + $env:PATH
  return $true
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$node = Find-NodeExe
if (-not $node) {
  Write-Host 'node.exe was not found.' -ForegroundColor Red
  Write-Host 'Install Node.js 18.13 or newer (winget install OpenJS.NodeJS.LTS) and run this again.'
  exit 1
}

$smartctlOnPath = Add-SmartctlToPath
if (-not $smartctlOnPath) {
  Write-Host 'smartmontools was not found in "C:\Program Files\smartmontools" - installing it is the next step:' -ForegroundColor Yellow
  Write-Host '  winget install smartmontools'
}

if (-not $NoElevate -and -not (Test-Elevated)) {
  Write-Host 'Windows only lets administrators read raw disk data - asking for elevation...' -ForegroundColor Cyan
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Port', $Port)
  if ($NoBrowser) { $arguments += '-NoBrowser' }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
  return
}

$serverArgs = @((Join-Path $root 'server\index.js'), '--port', $Port)
if ($NoBrowser) { $serverArgs += '--no-browser' }

Write-Host ("Starting {0} (elevated: {1})" -f (Split-Path -Leaf $node), (Test-Elevated))
Push-Location $root
try {
  & $node @serverArgs
} finally {
  Pop-Location
}

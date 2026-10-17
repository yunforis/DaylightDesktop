#requires -Version 5.1
param([Parameter(Mandatory = $true)][string]$Endpoint,
      [Parameter(Mandatory = $true)][string]$CancelPath)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$entry = Join-Path $PSScriptRoot 'daylight.mjs'
$logBase = [IO.Path]::ChangeExtension($CancelPath, 'watchdog')
$arguments = '"{0}" --watchdog "{1}" "{2}"' -f $entry, $Endpoint, $CancelPath
# This process survives npm/cmd forcibly ending the foreground process on Ctrl+C.
$null = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$logBase.stdout.log" -RedirectStandardError "$logBase.stderr.log" -PassThru

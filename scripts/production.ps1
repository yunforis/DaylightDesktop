#requires -Version 5.1
<#
.SYNOPSIS
Start, stop, or inspect Daylight production API, Worker and Scheduler on Windows.
.DESCRIPTION
Use -WithDependencies to manage the saved local PostgreSQL, Redis and RabbitMQ
Compose stack together with all three roles. Existing data volumes are retained.
.EXAMPLE
& .\scripts\production.ps1 -Action Start
.EXAMPLE
& .\scripts\production.ps1 -Action Status
.EXAMPLE
& .\scripts\production.ps1 -Action Stop -Roles scheduler,worker,api
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action,
    [ValidateSet('api', 'worker', 'scheduler')]
    [string[]]$Roles = @('api', 'worker', 'scheduler'),
    [string]$EnvironmentFile = 'data/runtime/environment.json',
    [string]$RuntimeDirectory = 'data/runtime/roles',
    [ValidateRange(5, 300)]
    [int]$TimeoutSeconds = 60,
    [switch]$WithDependencies,
    [string]$StartupCancelPath,
    [ValidateRange(0, 600)]
    [int]$LockWaitSeconds = 0,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This launcher is for Windows. Use the Compose or systemd deployment on Linux.'
}
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$wrapperPath = Join-Path $PSScriptRoot 'production-role.mjs'
if ($WithDependencies -and @($Roles | Sort-Object -Unique).Count -ne 3) {
    throw '-WithDependencies requires all three roles. Omit -Roles, or omit -WithDependencies for an individual role.'
}

function Resolve-RepositoryPath([string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $repositoryRoot $Value))
}

$runtimePath = Resolve-RepositoryPath $RuntimeDirectory
$environmentPath = Resolve-RepositoryPath $EnvironmentFile
$dependenciesPath = Join-Path $repositoryRoot 'data/runtime/dependencies.env'
$composePath = Join-Path $repositoryRoot 'deploy/compose.dependencies.yml'

function Assert-StartupActive {
    if ($StartupCancelPath -and (Test-Path -LiteralPath $StartupCancelPath)) {
        throw 'Startup was cancelled. Any roles already started remain tracked for shutdown.'
    }
}

function Test-DockerEngine([string]$DockerPath) {
    $probe = [Diagnostics.Process]::new()
    $probe.StartInfo.FileName = $DockerPath
    $probe.StartInfo.Arguments = 'info --format "{{.ServerVersion}}"'
    $probe.StartInfo.UseShellExecute = $false
    $probe.StartInfo.CreateNoWindow = $true
    $probe.StartInfo.RedirectStandardOutput = $true
    $probe.StartInfo.RedirectStandardError = $true
    try {
        $null = $probe.Start()
        $stdout = $probe.StandardOutput.ReadToEndAsync()
        $stderr = $probe.StandardError.ReadToEndAsync()
        if (!$probe.WaitForExit(5000)) {
            $probe.Kill()
            $probe.WaitForExit()
            return $false
        }
        return $probe.ExitCode -eq 0
    } finally { $probe.Dispose() }
}

function Get-ReadyDocker([bool]$StartDesktop) {
    if (!(Test-Path -LiteralPath $dependenciesPath -PathType Leaf)) {
        throw 'Missing data/runtime/dependencies.env. Complete the initial production setup and data migration in README.md first.'
    }
    $docker = Get-Command docker.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (Test-DockerEngine $docker.Source) { return $docker.Source }
    if (!$StartDesktop) {
        throw 'Docker is unavailable. Application roles are stopped or shown above, but dependency container state could not be verified. Start Docker Desktop and retry.'
    }
    $desktopCandidates = @()
    foreach ($base in @($env:ProgramFiles, $env:ProgramW6432, $env:LOCALAPPDATA)) {
        if ($base) { $desktopCandidates += Join-Path $base 'Docker/Docker/Docker Desktop.exe' }
    }
    $desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (!$desktop) { throw 'Docker is unavailable and Docker Desktop was not found. Start your Docker engine and retry npm run up.' }
    Write-Host 'Starting Docker Desktop; waiting for the Docker engine (up to 180 seconds)...'
    $null = Start-Process -FilePath $desktop -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    do {
        Assert-StartupActive
        if (Test-DockerEngine $docker.Source) { return $docker.Source }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Docker did not become available. Check Docker Desktop / WSL2, then retry npm run up.'
}

function Invoke-Dependencies([string]$DockerPath, [string[]]$ComposeArguments) {
    & $DockerPath compose --env-file $dependenciesPath -p daylight-services -f $composePath @ComposeArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency container operation failed (exit $LASTEXITCODE). Inspect Docker Desktop and retry; existing data volumes were retained."
    }
}

function Get-MetadataPath([string]$Role) { return Join-Path $runtimePath "$Role.json" }
function Get-ControlPath([string]$Role) { return Join-Path $runtimePath "$Role.stop.json" }

function Write-JsonAtomically([string]$Path, [object]$Value) {
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporaryPath, ($Value | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
}

function Read-Metadata([string]$Role) {
    $metadataPath = Get-MetadataPath $Role
    if (!(Test-Path -LiteralPath $metadataPath -PathType Leaf)) { return $null }
    try {
        $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $launchGuid = [guid]::Empty
        $startTicks = [long]0
        if ($metadata.role -ne $Role -or $metadata.repositoryRoot -ne $repositoryRoot -or
            $metadata.wrapperPath -ne $wrapperPath -or [int]$metadata.processId -le 0 -or
            ![guid]::TryParse([string]$metadata.launchId, [ref]$launchGuid) -or
            ![long]::TryParse([string]$metadata.startTicks, [ref]$startTicks) -or
            [int]$metadata.port -lt 1 -or [int]$metadata.port -gt 65535) {
            throw 'Invalid metadata'
        }
        return $metadata
    } catch {
        throw "Invalid $Role process metadata at $metadataPath. Inspect it before continuing; no process was stopped."
    }
}

function Find-ManagedProcess([object]$Metadata) {
    if ($null -eq $Metadata) { return $null }
    $candidate = Get-Process -Id ([int]$Metadata.processId) -ErrorAction SilentlyContinue
    if ($null -eq $candidate) { return $null }
    try {
        # Windows can reuse a PID after the original role has exited. A different
        # creation time proves this is an obsolete record, not a role to stop.
        if ($candidate.StartTime.ToUniversalTime().Ticks -ne [long]$Metadata.startTicks) { return $null }
        $native = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Metadata.processId)"
        if ($candidate.HasExited) { return $null }
        $matchesIdentity = $null -ne $native -and
            $native.ExecutablePath -eq $Metadata.nodePath -and
            $null -ne $native.CommandLine -and
            $native.CommandLine.Contains($wrapperPath) -and
            $native.CommandLine.Contains("--launch-id $($Metadata.launchId)") -and
            $native.CommandLine.Contains("--role $($Metadata.role)")
    } catch {
        if ($candidate.HasExited) { return $null }
        throw "Cannot verify $($Metadata.role) PID $($Metadata.processId); leaving it running."
    }
    if (!$matchesIdentity) {
        throw "PID $($Metadata.processId) does not match this launcher's $($Metadata.role) record; leaving it running."
    }
    return $candidate
}

function Remove-StoppedRoleRecords([string]$Role) {
    # Start/Stop hold the runtime lock. Call only after the recorded launch has
    # exited (including PID reuse), so a live role never loses its stop record.
    foreach ($recordPath in @((Get-ControlPath $Role), (Get-MetadataPath $Role))) {
        if (Test-Path -LiteralPath $recordPath -PathType Leaf) { Remove-Item -LiteralPath $recordPath -Force }
    }
}

function Test-RoleReady([string]$Role, [int]$Port) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health/ready" -UseBasicParsing -TimeoutSec 6
        $body = $response.Content | ConvertFrom-Json
        return $response.StatusCode -eq 200 -and $body.ok -eq $true -and $body.role -eq $Role
    } catch { return $false }
}

function Get-RoleStatus([string]$Role) {
    $metadata = Read-Metadata $Role
    $managed = Find-ManagedProcess $metadata
    $state = 'stopped'
    if ($null -ne $managed) {
        $state = 'running; not ready'
        if (Test-RoleReady $Role ([int]$metadata.port)) { $state = 'ready' }
    }
    return [pscustomobject]@{
        Role = $Role
        State = $state
        ProcessId = $(if ($null -ne $managed) { $metadata.processId } else { $null })
        Port = $(if ($null -ne $metadata) { $metadata.port } else { $null })
        Stdout = $(if ($null -ne $metadata) { $metadata.stdout } else { $null })
        Stderr = $(if ($null -ne $metadata) { $metadata.stderr } else { $null })
    }
}

function Read-ProductionEnvironment {
    if (!(Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
        throw "Missing production environment file: $environmentPath. See docs/windows-production.md."
    }
    try { $parsed = Get-Content -LiteralPath $environmentPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'The production environment file is not valid JSON; its contents were not printed.' }
    if ($null -eq $parsed -or $parsed -isnot [pscustomobject]) { throw 'The environment file must contain one JSON object.' }
    $configuration = @{}
    foreach ($property in $parsed.PSObject.Properties) {
        if ($property.Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $property.Value -isnot [string]) {
            throw 'Environment entries must have valid variable names and string values.'
        }
        $configuration[$property.Name] = $property.Value
    }
    foreach ($name in @('DAYLIGHT_DATA_DIR', 'DAYLIGHT_DATABASE_URL', 'DAYLIGHT_REDIS_URL', 'DAYLIGHT_AMQP_URL',
            'DAYLIGHT_JWT_SECRET', 'DAYLIGHT_OSS_PROVIDER', 'DAYLIGHT_OSS_BUCKET', 'DAYLIGHT_OSS_ACCESS_KEY', 'DAYLIGHT_OSS_SECRET_KEY')) {
        if (!$configuration.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($configuration[$name])) {
            throw "Missing required environment variable: $name"
        }
    }
    if ($configuration.DAYLIGHT_JWT_SECRET.Length -lt 32) { throw 'DAYLIGHT_JWT_SECRET must contain at least 32 characters.' }
    if ($configuration['DAYLIGHT_REQUIRE_AUTH'] -eq '0' -or $configuration['DAYLIGHT_ALLOW_LOCAL_DEMO_LOGIN'] -eq '1') {
        throw 'Production requires authentication and disables demo login.'
    }
    $configuration.DAYLIGHT_DATA_DIR = Resolve-RepositoryPath $configuration.DAYLIGHT_DATA_DIR
    $configuration.DAYLIGHT_RUNTIME = 'production'
    $configuration.NODE_ENV = 'production'
    if (!$configuration.ContainsKey('TZ')) { $configuration.TZ = 'Asia/Shanghai' }
    if (!$configuration.ContainsKey('HOST')) { $configuration.HOST = '127.0.0.1' }
    if (!$configuration.ContainsKey('DAYLIGHT_AUTO_PROXY')) { $configuration.DAYLIGHT_AUTO_PROXY = '0' }
    return $configuration
}

function Get-RolePort([string]$Role, [hashtable]$Configuration) {
    $variable = switch ($Role) { 'api' { 'PORT' }; 'worker' { 'DAYLIGHT_WORKER_HEALTH_PORT' }; 'scheduler' { 'DAYLIGHT_SCHEDULER_HEALTH_PORT' } }
    $defaultPort = switch ($Role) { 'api' { 3000 }; 'worker' { 3001 }; 'scheduler' { 3002 } }
    $portValue = [int]0
    if ($Configuration.ContainsKey($variable)) {
        if (![int]::TryParse($Configuration[$variable], [ref]$portValue) -or $portValue -lt 1 -or $portValue -gt 65535) {
            throw "Invalid port in $variable."
        }
        return $portValue
    }
    return $defaultPort
}

function Test-PortAvailable([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $Port)
    try { $listener.Start(); return $true }
    catch { return $false }
    finally { $listener.Stop() }
}

function Start-Role([string]$Role, [hashtable]$Configuration, [string]$NodePath) {
    $metadata = Read-Metadata $Role
    $managed = Find-ManagedProcess $metadata
    if ($null -ne $managed) {
        if (!(Test-RoleReady $Role ([int]$metadata.port))) {
            throw "$Role is already running but is not ready. Inspect its saved logs and dependencies before restarting."
        }
        Write-Host "$Role is already ready (PID $($metadata.processId), port $($metadata.port))."
        return
    }
    $rolePort = Get-RolePort $Role $Configuration
    if (!(Test-PortAvailable $rolePort)) { throw "Port $rolePort for $Role is already in use. No process was stopped." }
    $launchId = [guid]::NewGuid().ToString()
    $controlPath = Get-ControlPath $Role
    if (Test-Path -LiteralPath $controlPath) { Remove-Item -LiteralPath $controlPath -Force }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $runtimePath "$Role-$stamp.stdout.log"
    $stderr = Join-Path $runtimePath "$Role-$stamp.stderr.log"
    $childEnvironment = @{}
    foreach ($key in $Configuration.Keys) { $childEnvironment[$key] = $Configuration[$key] }
    if ($Role -eq 'api') { $childEnvironment.PORT = [string]$rolePort }
    else { $childEnvironment.DAYLIGHT_HEALTH_PORT = [string]$rolePort }
    # Start-Process on Windows PowerShell 5.1 inherits the process environment.
    # Save and restore touched keys; credentials never become command arguments.
    $savedEnvironment = @{}
    $clearNames = @('NODE_ENV', 'PORT', 'HOST', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
    foreach ($key in [Environment]::GetEnvironmentVariables('Process').Keys) {
        if ([string]$key -like 'DAYLIGHT_*') { $clearNames += [string]$key }
    }
    $touchedNames = @($clearNames + @($childEnvironment.Keys) | Sort-Object -Unique)
    try {
        foreach ($key in $touchedNames) {
            $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $null, 'Process')
        }
        foreach ($key in $childEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $childEnvironment[$key], 'Process') }
        # Windows file names cannot contain double quotes. Quote absolute paths
        # so repositories and user directories containing spaces work as well.
        $arguments = '"{0}" --role {1} --launch-id {2} --control-path "{3}"' -f $wrapperPath, $Role, $launchId, $controlPath
        $child = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $repositoryRoot `
            -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    } finally {
        foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    }
    try {
        $metadata = [ordered]@{
            role = $Role; repositoryRoot = $repositoryRoot; wrapperPath = $wrapperPath
            processId = $child.Id; startTicks = [string]$child.StartTime.ToUniversalTime().Ticks
            launchId = $launchId; nodePath = $NodePath; port = $rolePort
            startedAt = [DateTime]::UtcNow.ToString('o'); stdout = $stdout; stderr = $stderr
        }
        Write-JsonAtomically (Get-MetadataPath $Role) $metadata
    } catch {
        # This handle was just created by this call, so it cannot name another
        # project's process even if writing the management record failed.
        if (!$child.HasExited) { $child.Kill() }
        throw "Could not save $Role process metadata; this launch was stopped."
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Assert-StartupActive
        if ($child.HasExited) { throw "$Role exited during startup. Inspect $stderr (no logs were printed automatically)." }
        if (Test-RoleReady $Role $rolePort) {
            Write-Host "$Role is ready (PID $($child.Id), port $rolePort)."
            return
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Role did not become ready within $TimeoutSeconds seconds. It remains tracked; inspect $stderr and use -Action Status or Stop."
}

function Stop-Role([string]$Role) {
    $metadata = Read-Metadata $Role
    $managed = Find-ManagedProcess $metadata
    if ($null -eq $managed) {
        Remove-StoppedRoleRecords $Role
        Write-Host "$Role is already stopped."
        return
    }
    Write-JsonAtomically (Get-ControlPath $Role) @{ launchId = $metadata.launchId }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($managed.HasExited) {
            Remove-StoppedRoleRecords $Role
            Write-Host "$Role stopped."
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$Force) {
        throw "$Role has not exited after $TimeoutSeconds seconds. It remains running. Inspect its logs, or explicitly use -Force to terminate this verified process."
    }
    $verified = Find-ManagedProcess $metadata
    if ($null -ne $verified) {
        $verified.Kill()
        if (!$verified.WaitForExit(10000)) { throw "$Role has not exited after forced termination; its process record was retained." }
    }
    Remove-StoppedRoleRecords $Role
    Write-Host "$Role was forcibly terminated after its drain timeout."
}

if ($Action -eq 'Status') {
    $statuses = @($Roles | ForEach-Object { Get-RoleStatus $_ })
    if ($WithDependencies) {
        $statuses | Format-Table Role, State, ProcessId, Port -AutoSize
        $dockerPath = Get-ReadyDocker $false
        Invoke-Dependencies $dockerPath @('ps', '--all')
    } else { $statuses }
    return
}

$null = [IO.Directory]::CreateDirectory($runtimePath)
$lockPath = Join-Path $runtimePath 'launcher.lock'
$lockDeadline = [DateTime]::UtcNow.AddSeconds($LockWaitSeconds)
do {
    try { $operationLock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None'); break }
    catch {
        if ([DateTime]::UtcNow -ge $lockDeadline) { throw 'Another production launcher operation is active for this runtime directory. Wait for it to finish.' }
        Start-Sleep -Milliseconds 250
    }
} while ($true)
try {
    if ($Action -eq 'Start') {
        Assert-StartupActive
        if (!$WithDependencies -and !(Test-Path -LiteralPath (Join-Path $repositoryRoot 'dist/index.html') -PathType Leaf)) {
            throw 'Missing dist/index.html. Run npm run build before starting production roles.'
        }
        $configuration = Read-ProductionEnvironment
        $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $nodePath = $nodeCommand.Source
        $nodeVersion = & $nodePath --version
        if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Daylight requires Node.js >= 22.' }
        $allPorts = @('api', 'worker', 'scheduler' | ForEach-Object { Get-RolePort $_ $configuration })
        if (@($allPorts | Sort-Object -Unique).Count -ne 3) { throw 'API, Worker and Scheduler must use distinct ports.' }
        if ($WithDependencies) {
            $vitePath = Join-Path $repositoryRoot 'node_modules/vite/bin/vite.js'
            if (!(Test-Path -LiteralPath $vitePath -PathType Leaf)) { throw 'Missing npm dependencies. Run npm ci before npm run up.' }
            if (!(Test-Path -LiteralPath (Join-Path $repositoryRoot 'dist/index.html') -PathType Leaf)) {
                Write-Host 'Building the missing production frontend...'
                Push-Location $repositoryRoot
                try {
                    & $nodePath $vitePath build
                    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed. No application roles were started.' }
                } finally { Pop-Location }
            }
            Assert-StartupActive
            $dockerPath = Get-ReadyDocker $true
            Invoke-Dependencies $dockerPath @('config', '--quiet')
            Write-Host 'Starting PostgreSQL, Redis and RabbitMQ; waiting for healthy containers...'
            Invoke-Dependencies $dockerPath @('up', '-d', '--wait', '--wait-timeout', '300')
            Assert-StartupActive
        }
        $null = [IO.Directory]::CreateDirectory($configuration.DAYLIGHT_DATA_DIR)
        foreach ($role in @('worker', 'api', 'scheduler')) {
            Assert-StartupActive
            if ($Roles -contains $role) { Start-Role $role $configuration $nodePath }
        }
        if ($WithDependencies) {
            $apiPort = Get-RolePort 'api' $configuration
            Write-Host "Daylight is ready: http://127.0.0.1:$apiPort/app"
        }
    } else {
        foreach ($role in @('scheduler', 'worker', 'api')) {
            if ($Roles -contains $role) { Stop-Role $role }
        }
        if ($WithDependencies) {
            # Keep dependencies available if any role failed to drain above.
            $dockerPath = Get-ReadyDocker $false
            Write-Host 'Stopping PostgreSQL, Redis and RabbitMQ (data volumes are retained)...'
            Invoke-Dependencies $dockerPath @('stop', '--timeout', '60')
            Write-Host 'Daylight and its dependency containers are stopped. Existing data is retained.'
        }
    }
} finally { $operationLock.Dispose() }

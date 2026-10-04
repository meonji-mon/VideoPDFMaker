$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/VideoPDFMaker-$version-Setup-x64.exe").Path
$portable = (Resolve-Path "dist/VideoPDFMaker-$version-Portable-x64.exe").Path
$testRoot = Join-Path $env:RUNNER_TEMP ('videopdf-install-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $testRoot 'installed app'
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Assert-X64Application([string]$Executable) {
    $bytes = [IO.File]::ReadAllBytes($Executable)
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    if ([BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664) {
        throw "Application is not Windows x64: $Executable"
    }
}

function Assert-Starts([string]$Executable, [string]$Profile) {
    $process = Start-Process -FilePath $Executable -ArgumentList "--user-data-dir=`"$Profile`"" -PassThru
    $ownedIds = [Collections.Generic.HashSet[int]]::new()
    [void]$ownedIds.Add($process.Id)
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        $window = $null
        do {
            Start-Sleep -Milliseconds 250
            foreach ($child in Get-CimInstance Win32_Process) {
                if ($ownedIds.Contains([int]$child.ParentProcessId)) { [void]$ownedIds.Add([int]$child.ProcessId) }
            }
            # Portable launchers display the app in a child process, not the NSIS stub.
            $window = Get-Process -Id @($ownedIds) -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        } until ($null -ne $window -or [DateTime]::UtcNow -gt $deadline)
        if ($null -eq $window) { throw "Application did not create its main window: $Executable" }
        return @{ executable = [IO.Path]::GetFileName($Executable); window = $window.MainWindowTitle; running = $true }
    } finally {
        # Stop only this disposable test instance and its child processes.
        foreach ($id in $ownedIds) {
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) { taskkill /PID $id /T /F 2>$null | Out-Null }
        }
    }
}

# NSIS /D must be the final argument; it consumes the remaining path including spaces.
$setup = Start-Process -FilePath $installer -ArgumentList "/S /currentuser /D=$installDirectory" -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer failed with exit code $($setup.ExitCode)" }
$installed = Join-Path $installDirectory 'Video PDF Maker.exe'
if (-not (Test-Path $installed)) { throw 'Installer did not write the application executable' }
Assert-X64Application $installed
$installedStartup = Assert-Starts $installed (Join-Path $testRoot 'installed-profile')
$portableStartup = Assert-Starts $portable (Join-Path $testRoot 'portable-profile')
$signature = (Get-AuthenticodeSignature $installer).Status.ToString()
@{
    version = $version
    platform = 'Windows x64'
    installerExitCode = $setup.ExitCode
    installedStartup = $installedStartup
    portableStartup = $portableStartup
    authenticode = $signature
} | ConvertTo-Json -Depth 5 | Set-Content 'dist/windows-verification.json' -Encoding utf8

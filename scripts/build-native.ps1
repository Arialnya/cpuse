param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64',
    [switch]$FrameworkDependent
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $projectRoot 'native\Cpuse.Windows\Cpuse.Windows.csproj'
$packages = Join-Path $projectRoot 'native\.packages'
$output = Join-Path $projectRoot 'lib\native'
& dotnet publish $project -c $Configuration -r $Runtime --self-contained (-not $FrameworkDependent.IsPresent) -p:RestorePackagesPath=$packages -o $output
if ($LASTEXITCODE -ne 0) { throw 'Native backend build failed.' }
Write-Host "Native backend: $output\cpuse-windows.exe"

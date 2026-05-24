#
# Builds a Windows installer (.exe) for Yamlet by publishing a self-contained
# win-x64 build and compiling it with Inno Setup.
# Output: artifacts/packages/yamlet_<version>_win-x64_setup.exe
#
# Env overrides: CONFIGURATION (Release), RID (win-x64), VERSION.
param(
    [string]$Configuration = $env:CONFIGURATION,
    [string]$Rid = $env:RID,
    [string]$Version = $env:VERSION
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Configuration)) { $Configuration = "Release" }
if ([string]::IsNullOrWhiteSpace($Rid)) { $Rid = "win-x64" }
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = "0.0.0-dev" }

if ($Rid -ne "win-x64") {
    throw "Unsupported Windows RID: $Rid. This script packages win-x64."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $repoRoot

$appProject = "src/Yamlet.App/Yamlet.App.csproj"
$publishDir = Join-Path $repoRoot "artifacts\publish\$Rid"
$packageDir = Join-Path $repoRoot "artifacts\pkg\yamlet-windows"
$packageRoot = Join-Path $packageDir "Yamlet"
$packageOutDir = Join-Path $repoRoot "artifacts\packages"

# ── Publish a self-contained build ────────────────────────────────────────
dotnet restore Yamlet.slnx
dotnet publish $appProject -c $Configuration -r $Rid --self-contained true -o $publishDir `
    -p:Version=$Version -p:InformationalVersion=$Version

# ── Stage the publish output ──────────────────────────────────────────────
Remove-Item -Recurse -Force $packageDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $packageRoot, $packageOutDir | Out-Null
Copy-Item (Join-Path $publishDir "*") $packageRoot -Recurse -Force

# ── Compile the installer via Inno Setup ──────────────────────────────────
# Inno Setup 6 is pre-installed on GitHub Actions windows-latest runners.
$isccExe = $null
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($null -ne $iscc) {
    $isccExe = $iscc.Source
} else {
    foreach ($candidate in @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe"
    )) {
        if (Test-Path $candidate) { $isccExe = $candidate; break }
    }
}
if ($null -eq $isccExe) {
    throw "Inno Setup compiler (ISCC.exe) not found. Install Inno Setup 6 from https://jrsoftware.org/isinfo.php"
}

$issScript = Join-Path $scriptDir "..\packaging\windows\yamlet.iss"
& $isccExe `
    "/DAppVersion=$Version" `
    "/DSourceDir=$packageRoot" `
    "/DRepoRoot=$repoRoot" `
    $issScript

if ($LASTEXITCODE -ne 0) {
    throw "ISCC.exe exited with code $LASTEXITCODE."
}

$installerFile = Join-Path $packageOutDir "yamlet_${Version}_win-x64_setup.exe"
if (-not (Test-Path $installerFile)) {
    throw "Installer was not produced at: $installerFile"
}

Write-Host "Built Windows installer:"
Write-Host $installerFile

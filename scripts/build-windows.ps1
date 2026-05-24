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
function New-MsixPackage {
    param(
        [string]$PackageDir,
        [string]$Version,
        [string]$PackageOutDir
    )

    # MSIX requires a numeric X.X.X.X version; strip any pre-release suffix.
    $numericVersion = $Version -replace '-.*$', ''
    $parts = $numericVersion -split "\."
    while ($parts.Count -lt 4) { $parts += '0' }
    $msixVersion = ($parts[0..3] | ForEach-Object { [int]$_ }) -join "."

    # Stage the manifest with the resolved version into the package root.
    $manifestSource = Join-Path $scriptDir "..\packaging\windows\AppxManifest.xml"
    if (-not (Test-Path $manifestSource)) { throw "AppxManifest.xml not found at: $manifestSource" }
    $manifestTarget = Join-Path $PackageDir "AppxManifest.xml"
    $manifest = [System.IO.File]::ReadAllText($manifestSource, [System.Text.Encoding]::UTF8)
    $rx = [System.Text.RegularExpressions.Regex]::new('(<Identity\b[^>]*\bVersion=")[^"]*(")')
    $manifest = $rx.Replace($manifest, "`${1}$msixVersion`${2}", 1)
    [System.IO.File]::WriteAllText($manifestTarget, $manifest, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Manifest staged with version: $msixVersion"

    # Stage tile assets and verify the required set is present.
    $assetsSource = Join-Path $scriptDir "..\packaging\windows\Assets"
    $required = @(
        "square44x44logo.png", "square71x71logo.png", "square150x150logo.png",
        "wide310x150logo.png", "square310x310logo.png", "StoreLogo.png", "SplashScreen.png"
    )
    foreach ($img in $required) {
        if (-not (Test-Path (Join-Path $assetsSource $img))) {
            throw "Missing required MSIX asset: $img in $assetsSource"
        }
    }
    Copy-Item $assetsSource (Join-Path $PackageDir "Assets") -Recurse -Force

    # Locate MakeAppx.exe (ships with the Windows SDK, present on windows-latest).
    $makeappx = $null
    $cmd = Get-Command makeappx.exe -ErrorAction SilentlyContinue
    if ($null -ne $cmd) {
        $makeappx = $cmd.Source
    } else {
        foreach ($pattern in @(
            "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe",
            "C:\Program Files\Windows Kits\10\bin\*\x64\makeappx.exe",
            "C:\Program Files (x86)\Windows Kits\11\bin\*\x64\makeappx.exe",
            "C:\Program Files\Windows Kits\11\bin\*\x64\makeappx.exe"
        )) {
            $hit = @(Get-Item $pattern -ErrorAction SilentlyContinue | Sort-Object -Descending)
            if ($hit.Count -gt 0) { $makeappx = $hit[0].FullName; break }
        }
    }
    if ($null -eq $makeappx) {
        throw "MakeAppx.exe not found. Install the Windows SDK with the 'App Packager' component."
    }

    $msixPath = Join-Path $PackageOutDir "yamlet_${msixVersion}_win-x64.msix"
    & $makeappx pack /d $PackageDir /p $msixPath /o 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx.exe failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path $msixPath)) { throw "MSIX package was not created at: $msixPath" }
    return $msixPath
}

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

# ── Create the MSIX package ───────────────────────────────────────────────
# Done after the installer so the .exe is built from the clean publish output,
# before the AppxManifest/Assets are staged into the package directory.
Write-Host ""
Write-Host "Creating MSIX package..."
$msixFile = New-MsixPackage -PackageDir $packageRoot -Version $Version -PackageOutDir $packageOutDir
Write-Host "Built MSIX package:"
Write-Host $msixFile

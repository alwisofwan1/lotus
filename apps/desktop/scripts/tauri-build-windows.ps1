#Requires -Version 5.1
<#
.SYNOPSIS
Run the Tauri production build with the MSVC + Windows SDK environment active.

.DESCRIPTION
Normal terminals (including Cursor) do not load vcvars, so Rust cannot find link.exe.
This script uses vswhere to locate Visual Studio or Build Tools, enters the VS Developer
Shell, then runs the same command as "bun run tauri:build".

Prerequisites: VS 2017+ or Build Tools with "Desktop development with C++", WebView2,
Rust MSVC toolchain, Bun.
#>
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    Write-Error @"
vswhere.exe not found. Install Visual Studio Build Tools (or Visual Studio) and select
the "Desktop development with C++" workload.
https://visualstudio.microsoft.com/visual-cpp-build-tools/
"@
}

function Get-VsInstallationPath {
    param([string[]]$VsWhereArgs)
    $output = & $vswhere @VsWhereArgs 2>$null
    if ($null -eq $output) {
        return ""
    }
    $line = ($output | Where-Object { $_ } | Select-Object -First 1)
    if ($null -eq $line) {
        return ""
    }
    return $line.ToString().Trim()
}

# vswhere defaults omit Build Tools; "-products *" is unreliable across versions. Try explicit
# product IDs and fallbacks (Build Tools 2019/2022 report under Microsoft.VisualStudio.Product.BuildTools).
$candidates = @(
    @("-latest", "-products", "Microsoft.VisualStudio.Product.BuildTools", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath", "-format", "value"),
    @("-latest", "-products", "Microsoft.VisualStudio.Product.BuildTools", "-property", "installationPath", "-format", "value"),
    @("-latest", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath", "-format", "value"),
    @("-latest", "-property", "installationPath", "-format", "value")
)
$installPath = ""
foreach ($args in $candidates) {
    $candidate = Get-VsInstallationPath -VsWhereArgs $args
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        continue
    }
    $testVcvars = Join-Path $candidate "VC\Auxiliary\Build\vcvars64.bat"
    if (Test-Path $testVcvars) {
        $installPath = $candidate
        break
    }
}
if ([string]::IsNullOrWhiteSpace($installPath)) {
    $fallbackRoots = @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Professional",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\BuildTools",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community"
    )
    foreach ($root in $fallbackRoots) {
        $testVcvars = Join-Path $root "VC\Auxiliary\Build\vcvars64.bat"
        if (Test-Path $testVcvars) {
            $installPath = $root
            Write-Warning "vswhere returned no path; using fallback: $installPath"
            break
        }
    }
}
if ([string]::IsNullOrWhiteSpace($installPath)) {
    Write-Error @"
No Visual Studio or Build Tools installation with C++ tools was found (or vcvars64.bat is missing).

Install "Build Tools for Visual Studio" and select the workload "Desktop development with C++",
then run Visual Studio Installer and verify an instance appears under the Installed tab.

Diagnostics (optional):
  & `"$vswhere`" -latest -products Microsoft.VisualStudio.Product.BuildTools -property installationPath -format value
  & `"$vswhere`" -latest -property installationPath -format value
"@
}

$vcvars = Join-Path $installPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
    Write-Error "vcvars64.bat not found at: $vcvars"
}

$kitsInclude = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Include"
if (-not (Test-Path $kitsInclude)) {
    Write-Warning @"
Windows 10/11 SDK (Include) not found under Program Files (x86)\Windows Kits\10.
If the linker fails with LNK1181 / kernel32.lib, open Visual Studio Installer, Modify your
Build Tools, and enable the Windows 10 SDK (or Windows 11 SDK) workload component.
"@
}

# Use one cmd.exe session with vcvars so LIB/INCLUDE (Windows SDK, kernel32.lib) apply to
# the whole chain. Enter-VsDevShell + bun run can drop linker library paths for children.
$dir = $repoRoot.Path
Write-Host "Loading MSVC + Windows SDK (vcvars64): $installPath" -ForegroundColor Green
Write-Host "Building Tauri app in: $dir" -ForegroundColor Green

$inner = "call `"$vcvars`" && cd /d `"$dir`" && bun run tauri:build:exec"
cmd.exe /c $inner
exit $LASTEXITCODE

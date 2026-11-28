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

. (Join-Path $PSScriptRoot "windows-msvc.ps1")

# Use one cmd.exe session with vcvars so LIB/INCLUDE (Windows SDK, kernel32.lib) apply to
# the whole chain. Enter-VsDevShell + bun run can drop linker library paths for children.
$dir = $repoRoot.Path
Write-Host "Loading MSVC + Windows SDK (vcvars64): $installPath" -ForegroundColor Green
Write-Host "Building Tauri app in: $dir" -ForegroundColor Green

$inner = "call `"$vcvars`" && cd /d `"$dir`" && bun run tauri:build:exec"
cmd.exe /c $inner
exit $LASTEXITCODE

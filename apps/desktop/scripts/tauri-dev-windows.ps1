#Requires -Version 5.1
<#
.SYNOPSIS
Run `tauri dev` on Windows with the MSVC + Windows SDK environment active.

.DESCRIPTION
`bun run tauri:dev` does not work from a plain Windows terminal, for three reasons this script
takes care of:

1. Cargo cannot find link.exe unless vcvars64.bat is loaded (windows-msvc.ps1 finds it).
2. tauri.dev.conf.json's beforeDevCommand is `PORT=3001 npm run dev`, POSIX syntax that cmd.exe
   cannot run.
3. tauri.dev.conf.json's window list is the macOS one (transparent, vibrancy) and replaces
   tauri.windows.conf.json's: the window comes up transparent, so it looks like nothing opened.

tauri.dev.windows.conf.json, merged last, fixes 2 and 3.

Run it from a clone on the Windows filesystem. A clone inside WSL (\\wsl.localhost\...) has Linux
node_modules and builds far too slowly over the 9P share.
#>
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if ($repoRoot.Path -like "\\wsl*") {
    Write-Error "Run this from a clone on the Windows filesystem, not from a WSL share ($($repoRoot.Path))."
}

. (Join-Path $PSScriptRoot "windows-msvc.ps1")

$dir = $repoRoot.Path
Write-Host "Loading MSVC + Windows SDK (vcvars64): $installPath" -ForegroundColor Green
Write-Host "Starting Lotus Dev in: $dir" -ForegroundColor Green

# Same steps as `tauri:dev`, in one cmd.exe session so vcvars applies to the whole chain.
$steps = @(
    "bun run clean:rust-temp",
    "bun run mcp:bundle",
    "bun scripts/build-host-bundle.mjs",
    "bun scripts/build-sessiond.mjs",
    "bun x tauri dev --config src-tauri/tauri.dev.conf.json --config src-tauri/tauri.dev.windows.conf.json"
) -join " && "
$inner = "call `"$vcvars`" && cd /d `"$dir`" && $steps"
cmd.exe /c $inner
exit $LASTEXITCODE

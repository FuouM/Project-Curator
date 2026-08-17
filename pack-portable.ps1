# Assemble a minimal self-contained portable folder from the release build outputs
# Only packs what cannot be fetched in-UI: exes, ONNX runtime DLLs, app-root marker,
# and plugin bundles. Models/ffmpeg/aria2 are downloaded from Settings when needed.
param(
    [switch]$SkipService    # Reuse the existing release binaries without rebuilding
)

$Root = $PSScriptRoot
$RelDir = "$Root\target\release"
$OutDir = "$Root\portable"

# 1. Load local Rust toolchain
. "$Root\env.ps1"

# 2. Stop a running service so its exe isn't locked
$procs = Get-Process curator-service -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "Stopping running curator-service..." -ForegroundColor Yellow
    $procs | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# 3. Build release binaries if requested or missing
$dashExe = "$RelDir\curator-dashboard.exe"
$svcExe  = "$RelDir\curator-service.exe"
if (-not $SkipService -or -not (Test-Path $dashExe) -or -not (Test-Path $svcExe)) {
    Write-Host "Building release binaries..." -ForegroundColor Cyan
    cargo build -p curator-service --release
    if ($LASTEXITCODE -ne 0) { Write-Host "Service build failed!" -ForegroundColor Red; exit 1 }
    Push-Location "$Root\curator-dashboard"
    try {
        npm run tauri build -- --release --no-bundle
        if ($LASTEXITCODE -ne 0) { Write-Host "Dashboard build failed!" -ForegroundColor Red; exit 1 }
    }
    finally { Pop-Location }
}
else {
    Write-Host "Reusing existing release binaries." -ForegroundColor DarkGray
}

# 4. Stage the portable tree
Write-Host "Staging portable folder: $OutDir" -ForegroundColor Cyan
if (Test-Path $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }

New-Item -ItemType Directory -Path $OutDir | Out-Null

# Exes + runtime DLLs + app-root marker (needed for data-dir resolution)
Copy-Item $dashExe $OutDir
Copy-Item $svcExe  $OutDir
Copy-Item "$Root\onnxruntime.dll" $OutDir
Copy-Item "$Root\DirectML.dll"    $OutDir
Copy-Item "$Root\model_manifest.json" $OutDir

# 5. Plugins: manifest + JS bundles + support lib + per-plugin assets (no node_modules/src)
New-Item -ItemType Directory -Path "$OutDir\plugins" | Out-Null
Copy-Item "$Root\plugins\lib" "$OutDir\plugins\lib" -Recurse
$excluded = @('node_modules', 'src', '.gitignore', '.prettierignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'global.d.ts', 'plugin-types.d.ts', 'build.js', 'watch.js', 'README.md')
Get-ChildItem "$Root\plugins" -Directory | Where-Object { $_.Name -ne 'lib' } | ForEach-Object {
    $plugin = $_
    $dest = "$OutDir\plugins\$($plugin.Name)"
    New-Item -ItemType Directory -Path $dest | Out-Null
    Copy-Item (Join-Path $plugin.FullName '*') $dest -Recurse -Exclude $excluded
}

# 6. Scripts: model convert/quantize tools + env setup (no dev venv)
New-Item -ItemType Directory -Path "$OutDir\scripts" | Out-Null
Get-ChildItem "$Root\scripts" -File | ForEach-Object {
    Copy-Item $_.FullName "$OutDir\scripts"
}

# 7. Report size
$size = (Get-ChildItem $OutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "Portable pack ready: $OutDir" -ForegroundColor Green
Write-Host ("Total size: {0:N1} MB" -f ($size / 1MB))
Write-Host "Models, ffmpeg, and aria2 are downloaded in-UI via Settings on first use." -ForegroundColor DarkGray
Write-Host "Run scripts\setup-python-env.ps1 to build a Python env for model convert/quantize." -ForegroundColor DarkGray
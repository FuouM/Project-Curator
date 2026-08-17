# Build a release bundle of Project Curator (daemon + desktop app)
param(
    [switch]$SkipService,   # Skip rebuilding curator-service
    [switch]$NoBundle       # Build only, skip installer bundling
)

# 1. Load local Rust toolchain
. "$PSScriptRoot\env.ps1"

# 2. Stop any running service process so the exe isn't locked during build
$procs = Get-Process curator-service -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "Stopping running curator-service..." -ForegroundColor Yellow
    $procs | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# 3. Build curator-service daemon (release)
if (-not $SkipService) {
    Write-Host "Building curator-service (release)..." -ForegroundColor Cyan
    cargo build -p curator-service --release
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Service build failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "Service build OK." -ForegroundColor Green
}

# 4. Bundle the Tauri app (runs `npm run build` for the frontend automatically)
Write-Host "Bundling Tauri app (release)..." -ForegroundColor Cyan
Push-Location "$PSScriptRoot\curator-dashboard"
try {
    if ($NoBundle) {
        npm run tauri build -- --release --no-bundle
    }
    else {
        npm run tauri build -- --release
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tauri build failed!" -ForegroundColor Red
        exit 1
    }
}
finally {
    Pop-Location
    sccache --stop-server 2>&1 | Out-Null
}

Write-Host "Release build complete." -ForegroundColor Green

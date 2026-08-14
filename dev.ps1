# Launch Project Curator in dev mode
. "$PSScriptRoot\env.ps1"

# Stop any running service process so the exe isn't locked
$procs = Get-Process curator-service -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "Stopping running curator-service..." -ForegroundColor Yellow
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 1
}

# 1. Regenerate TypeScript protobuf stubs to stay in sync with proto definitions
Write-Host "Generating Protobuf stubs for dashboard..." -ForegroundColor Cyan
Push-Location "$PSScriptRoot\curator-dashboard"
try {
    npm run gen
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Protobuf code generation failed!" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

# 2. Build curator-service daemon and curator-dashboard
Write-Host "Building curator-service and curator-dashboard..." -ForegroundColor Cyan
cargo build -p curator-service -p curator-dashboard --no-default-features
if ($LASTEXITCODE -ne 0) {
    Write-Host "Workspace build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "Workspace build OK." -ForegroundColor Green

# 3. Launch Tauri dev server
$prevDir = $PWD.Path
Set-Location "$PSScriptRoot\curator-dashboard"
try {
    npm run tauri dev
} finally {
    # Stop curator-service when dev session exits
    $procs = Get-Process curator-service -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Stopping curator-service..." -ForegroundColor Yellow
        $procs | Stop-Process -Force
    }

    # Stop sccache server daemon cleanly if running
    Write-Host "Stopping sccache server..." -ForegroundColor Yellow
    sccache --stop-server 2>&1 | Out-Null

    Set-Location $prevDir
}


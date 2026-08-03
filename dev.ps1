# Launch Project Curator in dev mode
. "$PSScriptRoot\env.ps1"

# Stop any running service process so the exe isn't locked
$procs = Get-Process curator-service -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "Stopping running curator-service..." -ForegroundColor Yellow
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 1
}

# Build the service first so it's always fresh
Write-Host "Building curator-service..." -ForegroundColor Cyan
cargo build --manifest-path "$PSScriptRoot\curator-service\Cargo.toml"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Service build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "Service build OK." -ForegroundColor Green

$prevDir = $PWD.Path
Set-Location "$PSScriptRoot\curator-dashboard"
try {
    npm run tauri dev
} finally {
    # Kill the service when the app stops
    $procs = Get-Process curator-service -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Stopping curator-service..." -ForegroundColor Yellow
        $procs | Stop-Process -Force
    }
    Set-Location $prevDir
}

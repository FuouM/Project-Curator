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

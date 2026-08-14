param(
    [switch]$ForceGen,      # Force regenerating protobuf stubs
    [switch]$SkipService,   # Skip compiling curator-service
    [switch]$FrontendOnly,  # Alias for -SkipService
    [switch]$Release        # Run in release mode
)

# Launch Project Curator in dev mode
. "$PSScriptRoot\env.ps1"

# Stop any running service process so the exe isn't locked during build
$procs = Get-Process curator-service -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "Stopping running curator-service..." -ForegroundColor Yellow
    $procs | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# 1. Regenerate TypeScript protobuf stubs only if .proto definitions changed
$protoDir = "$PSScriptRoot\curator-proto\proto"
$genDir = "$PSScriptRoot\curator-dashboard\src\gen"

$needGen = $ForceGen.IsPresent
if (-not $needGen) {
    $protoFiles = Get-ChildItem -Path $protoDir -Filter "*.proto" -ErrorAction SilentlyContinue
    $genFiles = Get-ChildItem -Path $genDir -Filter "*.ts" -ErrorAction SilentlyContinue
    
    if (-not $genFiles -or $genFiles.Count -eq 0) {
        $needGen = $true
    } elseif ($protoFiles -and $protoFiles.Count -gt 0) {
        $latestProto = ($protoFiles | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
        $latestGen = ($genFiles | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
        if ($latestProto -and $latestGen -and ($latestProto - $latestGen).TotalSeconds -gt 2) {
            $needGen = $true
        }
    }
}

if ($needGen) {
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
} else {
    Write-Host "Protobuf stubs are up to date." -ForegroundColor DarkGray
}

# 2. Build curator-service daemon
if (-not ($SkipService -or $FrontendOnly)) {
    Write-Host "Building curator-service..." -ForegroundColor Cyan
    if ($Release) {
        cargo build -p curator-service --release
    } else {
        cargo build -p curator-service
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Service build failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "Service build OK." -ForegroundColor Green
}

# 3. Launch Tauri dev server
$prevDir = $PWD.Path
Set-Location "$PSScriptRoot\curator-dashboard"
try {
    if ($Release) {
        npm run tauri dev -- --release
    } else {
        npm run tauri dev
    }
} finally {
    # Stop curator-service when dev session exits
    $procs = Get-Process curator-service -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "Stopping curator-service..." -ForegroundColor Yellow
        $procs | Stop-Process -Force
    }

    # Stop sccache server cleanly so no background process lingers
    Write-Host "Stopping sccache server..." -ForegroundColor Yellow
    sccache --stop-server 2>&1 | Out-Null

    Set-Location $prevDir
}


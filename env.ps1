# Local Rust Environment Setup for Project Curator
$RootPath = $PSScriptRoot

$env:RUSTUP_HOME = "$RootPath\.rust\.rustup"
$env:CARGO_HOME = "$RootPath\.rust\.cargo"

$BinPath = "$RootPath\.rust\.cargo\bin"
if ($env:PATH -notlike "*$BinPath*") {
    $env:PATH = "$BinPath;" + $env:PATH
}

$env:RUSTC_WRAPPER = "$BinPath\sccache.exe"
$env:SCCACHE_DIR = "$RootPath\.rust\.sccache"
$env:SCCACHE_CONF = "$RootPath\.rust\sccache.toml"

Write-Host "Project-Curator local Rust environment loaded." -ForegroundColor Green
Write-Host "RUSTUP_HOME:        $env:RUSTUP_HOME"
Write-Host "CARGO_HOME:         $env:CARGO_HOME"
Write-Host "SCCACHE_DIR:        $env:SCCACHE_DIR"
Write-Host "SCCACHE_CONF:       $env:SCCACHE_CONF"
Write-Host "RUSTC_WRAPPER:      $env:RUSTC_WRAPPER"

Write-Host "rustc version:"
rustc --version

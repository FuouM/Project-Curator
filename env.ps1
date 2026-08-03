# Local Rust Environment Setup for Project Curator
$RootPath = $PSScriptRoot

$env:RUSTUP_HOME = "$RootPath\.rust\.rustup"
$env:CARGO_HOME = "$RootPath\.rust\.cargo"

$BinPath = "$RootPath\.rust\.cargo\bin"
if ($env:PATH -notlike "*$BinPath*") {
    $env:PATH = "$BinPath;" + $env:PATH
}

Write-Host "Project-Curator local Rust environment loaded." -ForegroundColor Green
Write-Host "RUSTUP_HOME: $env:RUSTUP_HOME"
Write-Host "CARGO_HOME:  $env:CARGO_HOME"
Write-Host "rustc version:"
rustc --version

# Create local directories
$RootPath = $PSScriptRoot
New-Item -ItemType Directory -Force -Path "$RootPath\.rust"
New-Item -ItemType Directory -Force -Path "$RootPath\.rust\.rustup"
New-Item -ItemType Directory -Force -Path "$RootPath\.rust\.cargo"

# Set temporary environment variables for installation
$env:RUSTUP_HOME = "$RootPath\.rust\.rustup"
$env:CARGO_HOME = "$RootPath\.rust\.cargo"

Write-Host "Downloading rustup-init.exe..."
curl.exe -L -o "$RootPath\.rust\rustup-init.exe" https://win.rustup.rs/x86_64

if (Test-Path "$RootPath\.rust\rustup-init.exe") {
    Write-Host "Installing Rust locally..."
    Start-Process -FilePath "$RootPath\.rust\rustup-init.exe" -ArgumentList "-y", "--no-modify-path", "--default-toolchain", "stable" -NoNewWindow -Wait
    Write-Host "Rust installation completed."
}
else {
    Write-Error "Failed to download rustup-init.exe"
}

# Create local directories
New-Item -ItemType Directory -Force -Path ".rust"
New-Item -ItemType Directory -Force -Path ".rust\.rustup"
New-Item -ItemType Directory -Force -Path ".rust\.cargo"

# Set temporary environment variables for installation
$env:RUSTUP_HOME = ".rust\.rustup"
$env:CARGO_HOME = ".rust\.cargo"

Write-Host "Downloading rustup-init.exe..."
curl.exe -L -o ".rust\rustup-init.exe" https://win.rustup.rs/x86_64

if (Test-Path ".rust\rustup-init.exe") {
    Write-Host "Installing Rust locally..."
    Start-Process -FilePath ".rust\rustup-init.exe" -ArgumentList "-y", "--no-modify-path", "--default-toolchain", "stable" -NoNewWindow -Wait
    Write-Host "Rust installation completed."
} else {
    Write-Error "Failed to download rustup-init.exe"
}

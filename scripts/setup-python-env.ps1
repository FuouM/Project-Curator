$ErrorActionPreference = "Stop"
$venvDir = Join-Path $PSScriptRoot "venv"

if (Test-Path $venvDir) {
    Write-Host "Quantize venv already exists at $venvDir"
    exit 0
}

Write-Host "Checking for Python 3.10..."
$hasPython310 = $false
$pythonCmd = ""

# Check if py launcher has Python 3.10
if (Get-Command "py" -ErrorAction SilentlyContinue) {
    $prevPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & py -3.10 --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        $hasPython310 = $true
        $pythonCmd = "py"
    }
    $ErrorActionPreference = $prevPreference
}

# Check if default python is 3.10
if (-not $hasPython310 -and (Get-Command "python" -ErrorAction SilentlyContinue)) {
    $version = & python --version 2>&1
    if ($version -match "3\.10") {
        $hasPython310 = $true
        $pythonCmd = "python"
    }
}

if (-not $hasPython310) {
    Write-Error "Python 3.10 is required but was not found on this machine. Please install Python 3.10."
    exit 1
}

Write-Host "Creating Python venv for quantization..."
if ($pythonCmd -eq "py") {
    & py -3.10 -m venv $venvDir
} else {
    & python -m venv $venvDir
}

Write-Host "Installing dependencies..."
& "$venvDir\Scripts\pip.exe" install onnxruntime onnx numpy

Write-Host "Quantize environment ready."

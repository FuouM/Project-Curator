$ErrorActionPreference = "Stop"
$venvDir = Join-Path $PSScriptRoot "venv"
$requirements = Join-Path $PSScriptRoot "requirements.txt"

if (-not (Test-Path $requirements)) {
    Write-Error "requirements.txt not found at $requirements"
    exit 1
}

# Reuse an existing venv if present. Otherwise locate Python 3.10 to create it.
$venvPython = Join-Path $venvDir "Scripts\python.exe"
if (Test-Path $venvPython) {
    Write-Host "Reusing existing venv at $venvDir"
} else {
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

    Write-Host "Creating Python venv for model conversion/quantization..."
    if ($pythonCmd -eq "py") {
        & py -3.10 -m venv $venvDir
    } else {
        & python -m venv $venvDir
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create venv at $venvDir"
        exit 1
    }
}

if (-not (Test-Path $venvPython)) {
    Write-Error "venv python not found at $venvPython"
    exit 1
}

Write-Host "Upgrading pip..."
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to upgrade pip"
    exit 1
}

Write-Host "Installing dependencies from requirements.txt..."
& $venvPython -m pip install -r $requirements
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install dependencies"
    exit 1
}

Write-Host "Model conversion/quantization environment ready."

$Version = "1.20.1" # Wait, let's use 1.20.1 or 1.23.1. The error said expected >= 1.16? No, expected >= 1.23.x. Wait, does 1.23.x exist? No, wait!
# Let's check if 1.20.1 exists. Yes, 1.20.1 exists.
# Wait, let's use 1.20.1.
# Oh, the error says: expected >= 1.23.x? Wait, no, let's use 1.20.1 first, or wait, let's use the latest 1.20.1 which has 1.20.1.
# Wait, let's look at the error message: "expected version >= '1.23.x'" or similar.
# Let's use 1.20.1! Wait, if 1.20.1 is less than 1.23, it might still fail. Let's use 1.20.1 first or check if we can download 1.20.1.
# Wait, let's look at the version of onnxruntime on github. We saw it's at v1.27.1!
# So yes, 1.27.1 is >= 1.23.x. Let's use 1.27.1!
$Version = "1.27.1"
$Url = "https://github.com/microsoft/onnxruntime/releases/download/v$Version/onnxruntime-win-x64-$Version.zip"
$ZipPath = ".\onnxruntime.zip"
$ExtractPath = ".\onnxruntime_extracted"

Write-Host "Downloading ONNX Runtime v$Version..."
curl.exe -L -o $ZipPath $Url

Write-Host "Extracting onnxruntime.dll..."
Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force

Copy-Item -Path "$ExtractPath\onnxruntime-win-x64-$Version\lib\onnxruntime.dll" -Destination ".\onnxruntime.dll" -Force

# Clean up
Remove-Item -Path $ZipPath -Force
Remove-Item -Path $ExtractPath -Recurse -Force
Write-Host "ONNX Runtime DLL v$Version setup successfully!"

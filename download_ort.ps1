$Version = "1.24.4"
$Url = "https://www.nuget.org/api/v2/package/Microsoft.ML.OnnxRuntime.DirectML/$Version"
$ZipPath = ".\onnxruntime.zip"
$ExtractPath = ".\onnxruntime_extracted"

Write-Host "Downloading ONNX Runtime (DirectML) v$Version..."
curl.exe -L -o $ZipPath $Url

Write-Host "Extracting dynamic libraries..."
Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force

Copy-Item -Path "$ExtractPath\runtimes\win-x64\native\onnxruntime.dll" -Destination ".\onnxruntime.dll" -Force

# Clean up
Remove-Item -Path $ZipPath -Force
Remove-Item -Path $ExtractPath -Recurse -Force
Write-Host "ONNX Runtime with DirectML setup successfully!"

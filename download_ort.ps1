$OrtVersion = "1.24.4"
$DirectMLVersion = "1.15.4"
$ProjectRoot = "."

# --- ONNX Runtime (DirectML) ---
$OrtUrl = "https://www.nuget.org/api/v2/package/Microsoft.ML.OnnxRuntime.DirectML/$OrtVersion"
$OrtZip = "$ProjectRoot\onnxruntime.zip"
$OrtExtract = "$ProjectRoot\onnxruntime_extracted"

Write-Host "Downloading ONNX Runtime (DirectML) v$OrtVersion..."
curl.exe -L -o $OrtZip $OrtUrl

Write-Host "Extracting onnxruntime.dll..."
Expand-Archive -Path $OrtZip -DestinationPath $OrtExtract -Force
Copy-Item -Path "$OrtExtract\runtimes\win-x64\native\onnxruntime.dll" -Destination "$ProjectRoot\onnxruntime.dll" -Force

Remove-Item -Path $OrtZip -Force
Remove-Item -Path $OrtExtract -Recurse -Force

Write-Host "ONNX Runtime installed: $ProjectRoot\onnxruntime.dll"

# --- DirectML ---
$DmlUrl = "https://www.nuget.org/api/v2/package/Microsoft.AI.DirectML/$DirectMLVersion"
$DmlZip = "$ProjectRoot\directml.zip"
$DmlExtract = "$ProjectRoot\directml_extracted"

Write-Host ""
Write-Host "Downloading DirectML v$DirectMLVersion..."
curl.exe -L -o $DmlZip $DmlUrl

Write-Host "Extracting DirectML.dll..."
Expand-Archive -Path $DmlZip -DestinationPath $DmlExtract -Force
Copy-Item -Path "$DmlExtract\bin\x64-win\DirectML.dll" -Destination "$ProjectRoot\DirectML.dll" -Force

Remove-Item -Path $DmlZip -Force
Remove-Item -Path $DmlExtract -Recurse -Force

Write-Host "DirectML installed: $ProjectRoot\DirectML.dll"
Write-Host ""
Write-Host "Setup complete! Both ONNX Runtime and DirectML are ready for GPU inference."

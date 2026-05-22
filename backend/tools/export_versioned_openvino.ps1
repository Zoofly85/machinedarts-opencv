param(
    [Parameter(Mandatory = $true)]
    [string]$ModelPt,

    [Parameter(Mandatory = $true)]
    [string]$DataYaml,

    [Parameter(Mandatory = $true)]
    [string]$VersionTag,

    [int]$ImgH = 736,
    [int]$ImgW = 1280,

    [switch]$SkipFp,
    [switch]$SkipInt8,

    [int]$SubsetSize = 300,

    [string]$Split = "val"
)

$ErrorActionPreference = "Stop"

function Run-Step([string]$Command) {
    Write-Host ">> $Command"
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE"
    }
}

$modelPath = (Resolve-Path $ModelPt).Path
$dataYamlPath = (Resolve-Path $DataYaml).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$modelsTipDir = Join-Path $repoRoot "models\\tip"

$modelStem = [System.IO.Path]::GetFileNameWithoutExtension($modelPath)
$fpOutDir = Join-Path $modelsTipDir "${modelStem}_${VersionTag}_fp_openvino_model"
$int8OutDir = Join-Path $modelsTipDir "${modelStem}_${VersionTag}_int8_rect_openvino_model"

Push-Location $repoRoot
try {
    if (-not $SkipFp) {
        $rawExportDir = Join-Path (Split-Path $modelPath -Parent) "${modelStem}_openvino_model"
        if (Test-Path $rawExportDir) {
            Remove-Item -Recurse -Force $rawExportDir
        }

        Run-Step "python -c `"from ultralytics import YOLO; YOLO(r'$modelPath').export(format='openvino', imgsz=($ImgH, $ImgW))`""

        if (-not (Test-Path $rawExportDir)) {
            throw "Expected Ultralytics export directory not found: $rawExportDir"
        }

        if (Test-Path $fpOutDir) {
            Remove-Item -Recurse -Force $fpOutDir
        }
        Move-Item $rawExportDir $fpOutDir
        Write-Host "FP model saved: $fpOutDir"
    }

    if (-not $SkipInt8) {
        $fpXml = Join-Path $fpOutDir "${modelStem}.xml"
        if (-not (Test-Path $fpXml)) {
            throw "FP model XML not found for INT8 quantization: $fpXml"
        }
        if (Test-Path $int8OutDir) {
            Remove-Item -Recurse -Force $int8OutDir
        }
        Run-Step "python backend/tools/quantize_openvino_rect_int8.py --model-xml `"$fpXml`" --data-yaml `"$dataYamlPath`" --output-dir `"$int8OutDir`" --img-h $ImgH --img-w $ImgW --subset-size $SubsetSize --split $Split"
        Write-Host "INT8 model saved: $int8OutDir"
    }

    Write-Host ""
    Write-Host "Done."
    Write-Host "FP : $fpOutDir"
    Write-Host "INT8: $int8OutDir"
}
finally {
    Pop-Location
}

param(
    [Parameter(Mandatory = $true)]
    [string]$PythonExe,

    [Parameter(Mandatory = $true)]
    [string]$Dataset,

    [Parameter(Mandatory = $true)]
    [string]$VersionTag,

    [string]$Device = "CPU",

    [string[]]$Models = @(
        "y26-p-n-736-1280-07022026_ov2025_4_1_fp_openvino_model",
        "y26-p-n-736-1280-07022026_ov2025_4_1_int8_rect_openvino_model",
        "y26-p-n-736-1280-07022026_ov2026_0_0_fp_openvino_model",
        "y26-p-n-736-1280-07022026_ov2026_0_0_int8_rect_openvino_model"
    )
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$pythonPath = (Resolve-Path $PythonExe).Path
$outputPath = Join-Path $repoRoot "backend\data\benchmark_capture\$Dataset\ov_runtime_$VersionTag.json"

$quotedModels = ($Models | ForEach-Object { "`"$_`"" }) -join " "
$command = "`"$pythonPath`" backend/tools/benchmark_tip_models.py --dataset `"$Dataset`" --models $quotedModels --modes full_frame --device `"$Device`" --output `"$outputPath`""

Push-Location $repoRoot
try {
    Write-Host ">> $command"
    Invoke-Expression $command
    if ($LASTEXITCODE -ne 0) {
        throw "Benchmark command failed with exit code $LASTEXITCODE"
    }
    Write-Host ""
    Write-Host "Benchmark written to: $outputPath"
}
finally {
    Pop-Location
}

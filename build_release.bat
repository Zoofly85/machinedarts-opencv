@echo off
setlocal enabledelayedexpansion

REM Machine Darts end-to-end release build helper (Windows)
REM - Builds backend EXE (PyInstaller)
REM - Builds frontend assets (Vite)
REM - Builds Tauri installer when src-tauri is present
REM Set MACHINE_DARTS_BACKEND_BUILDER=nuitka to compile backend with Nuitka instead of PyInstaller.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "BACKEND_DIR=%ROOT%\backend"
set "FRONTEND_DIR=%ROOT%\frontend"
set "BACKEND_EXE=%BACKEND_DIR%\dist\darts-backend\darts-backend.exe"
set "BACKEND_DIST_DIR=%BACKEND_DIR%\dist\darts-backend"
set "BACKEND_WORKPATH=%BACKEND_DIR%\build\pyi_work"
set "NATIVE_KEY_DIR=%BACKEND_DIR%\native_key"
set "RELEASE_DIR=%ROOT%\build\release"
set "SECURE_MODELS_DIR=%ROOT%\build\secure-models\models"
set "TAURI_BUNDLE_DIR=%FRONTEND_DIR%\src-tauri\target\release\bundle"
set "TAURI_RELEASE_DIR=%FRONTEND_DIR%\src-tauri\target\release"
set "FLAVOR=%~1"
if "%FLAVOR%"=="" set "FLAVOR=home"
set "UPDATER_UPLOAD_DIR=%ROOT%\build\updater\%FLAVOR%"
set "FRONTEND_BUILD_CMD=npm run build:%FLAVOR%"
set "TAURI_BUILD_CMD=npm run tauri:build:%FLAVOR%"
set "MACHINE_DARTS_UPDATER_MANIFEST_NAME=latest-windows.json"
set "SIGNING_KEY_FILE=%USERPROFILE%\.tauri\machine-darts-updater.key"
set "UPDATER_PUBKEY_FILE=%USERPROFILE%\.tauri\machine-darts-updater.pubkey"

if /I "%FLAVOR%"=="home" goto flavor_ok
if /I "%FLAVOR%"=="opencv" goto flavor_ok
if /I "%FLAVOR%"=="club-board" goto flavor_ok
if /I "%FLAVOR%"=="club-master" goto flavor_ok
echo [ERROR] Invalid flavor '%FLAVOR%'. Use: home ^| opencv ^| club-board ^| club-master
exit /b 1
:flavor_ok

echo ======================================================
echo Machine Darts Release Build
echo Root: %ROOT%
echo Flavor: %FLAVOR%
echo ======================================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
  set "PY=python"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
  set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
) else (
  where py >nul 2>nul
  if %errorlevel% neq 0 (
    echo [ERROR] Python not found in PATH.
    exit /b 1
  )
  set "PY=py -3"
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] npm not found in PATH.
  exit /b 1
)

where npx >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] npx not found in PATH.
  exit /b 1
)

if not defined TAURI_SIGNING_PRIVATE_KEY (
  if exist "%SIGNING_KEY_FILE%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$k = Get-Content -Raw '%SIGNING_KEY_FILE%'; " ^
      "[Environment]::SetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY', $k, 'Process')"
    if %errorlevel% equ 0 (
      echo [OK] Loaded TAURI_SIGNING_PRIVATE_KEY from %SIGNING_KEY_FILE%
    ) else (
      echo [WARN] Failed to load TAURI_SIGNING_PRIVATE_KEY from %SIGNING_KEY_FILE%
    )
  ) else (
    echo [WARN] TAURI_SIGNING_PRIVATE_KEY not set and key file not found: %SIGNING_KEY_FILE%
  )
)

if exist "%UPDATER_PUBKEY_FILE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$k = (Get-Content -Raw '%UPDATER_PUBKEY_FILE%').Trim(); " ^
    "[Environment]::SetEnvironmentVariable('MACHINE_DARTS_TAURI_UPDATER_PUBKEY', $k, 'Process'); " ^
    "[Environment]::SetEnvironmentVariable('TAURI_UPDATER_PUBKEY', $k, 'Process')"
  if %errorlevel% equ 0 (
    echo [OK] Loaded MACHINE_DARTS_TAURI_UPDATER_PUBKEY from %UPDATER_PUBKEY_FILE%
  ) else (
    echo [WARN] Failed to load MACHINE_DARTS_TAURI_UPDATER_PUBKEY from %UPDATER_PUBKEY_FILE%
  )
) else (
  echo [WARN] MACHINE_DARTS_TAURI_UPDATER_PUBKEY not set and pubkey file not found: %UPDATER_PUBKEY_FILE%
)

if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

if not exist "%BACKEND_DIR%\run_api.py" (
  echo [ERROR] Backend entry not found: %BACKEND_DIR%\run_api.py
  exit /b 1
)

if not exist "%FRONTEND_DIR%\package.json" (
  echo [ERROR] Frontend package.json not found: %FRONTEND_DIR%\package.json
  exit /b 1
)

echo [prep] Stopping stale app/backend processes and cleaning old build output...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue'; " ^
  "Get-Process -Name 'darts-backend','Machine Darts','msedgewebview2' | Stop-Process -Force; " ^
  "Start-Sleep -Milliseconds 600; " ^
  "$targets = @('%BACKEND_DIST_DIR%','%BACKEND_WORKPATH%'); " ^
  "foreach ($t in $targets) { " ^
  "  if (-not (Test-Path $t)) { continue } " ^
  "  for ($i=0; $i -lt 6; $i++) { " ^
  "    try { attrib -R -H -S ($t + '\*') /S /D 2>$null; Remove-Item -Path $t -Recurse -Force -ErrorAction Stop; break } " ^
  "    catch { Start-Sleep -Milliseconds 500 } " ^
  "  } " ^
  "} " ^
  "$tauriBundle = '%TAURI_BUNDLE_DIR%'; " ^
  "if (Test-Path $tauriBundle) { " ^
  "  for ($i=0; $i -lt 4; $i++) { " ^
  "    try { Remove-Item -Path $tauriBundle -Recurse -Force -ErrorAction Stop; break } " ^
  "    catch { Start-Sleep -Milliseconds 400 } " ^
  "  } " ^
  "} "

echo [1/4] Building backend EXE...
pushd "%BACKEND_DIR%"
if /I "%MACHINE_DARTS_BACKEND_BUILDER%"=="nuitka" (
  echo [INFO] Backend builder: Nuitka
  call %PY% "%BACKEND_DIR%\tools\build_backend_nuitka.py" --backend-dir "%BACKEND_DIR%" --output-dir "%BACKEND_DIST_DIR%" --work-dir "%BACKEND_DIR%\build\nuitka_work"
  if %errorlevel% neq 0 (
    echo [ERROR] Nuitka backend build failed.
    popd
    exit /b 1
  )
) else (
  echo [INFO] Backend builder: PyInstaller
  call %PY% -m pip install --disable-pip-version-check pyinstaller >nul
  if %errorlevel% neq 0 (
    echo [ERROR] Failed installing/checking pyinstaller.
    popd
    exit /b 1
  )

  if not exist "%BACKEND_DIR%\darts-backend.spec" (
    echo [ERROR] Spec file not found: %BACKEND_DIR%\darts-backend.spec
    popd
    exit /b 1
  )

  if exist "%BACKEND_WORKPATH%" rmdir /s /q "%BACKEND_WORKPATH%" >nul 2>nul
  mkdir "%BACKEND_WORKPATH%" >nul 2>nul

  call %PY% -m PyInstaller "%BACKEND_DIR%\darts-backend.spec" --noconfirm --workpath "%BACKEND_WORKPATH%"
  if %errorlevel% neq 0 (
    echo [WARN] First PyInstaller attempt failed. Retrying once after short delay...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2"
    if exist "%BACKEND_WORKPATH%" rmdir /s /q "%BACKEND_WORKPATH%" >nul 2>nul
    mkdir "%BACKEND_WORKPATH%" >nul 2>nul
    call %PY% -m PyInstaller "%BACKEND_DIR%\darts-backend.spec" --noconfirm --workpath "%BACKEND_WORKPATH%"
  )
  if %errorlevel% neq 0 (
    echo [ERROR] Backend build failed.
    popd
    exit /b 1
  )
)
popd

if not exist "%BACKEND_EXE%" (
  echo [ERROR] Backend EXE not found: %BACKEND_EXE%
  exit /b 1
)

set "BACKEND_INTERNAL_DIR=%BACKEND_DIST_DIR%\_internal"
if exist "%BACKEND_INTERNAL_DIR%" (
  echo [INFO] Cleaning stale OpenVINO dist-info folders in backend bundle...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$internal = '%BACKEND_INTERNAL_DIR%'; " ^
    "$dirs = Get-ChildItem -Path $internal -Directory -Filter 'openvino-*.dist-info' -ErrorAction SilentlyContinue; " ^
    "if ($dirs.Count -gt 1) { " ^
    "  $parsed = @(); $unknown = @(); " ^
    "  foreach ($d in $dirs) { " ^
    "    $m = [regex]::Match($d.Name, '^openvino-(\d+)\.(\d+)\.(\d+)\.dist-info$'); " ^
    "    if ($m.Success) { " ^
    "      $parsed += [pscustomobject]@{ Dir=$d; Major=[int]$m.Groups[1].Value; Minor=[int]$m.Groups[2].Value; Patch=[int]$m.Groups[3].Value }; " ^
    "    } else { $unknown += $d } " ^
    "  } " ^
    "  if ($parsed.Count -gt 0) { " ^
    "    $keep = $parsed | Sort-Object Major,Minor,Patch -Descending | Select-Object -First 1; " ^
    "    foreach ($d in $dirs) { if ($d.FullName -ne $keep.Dir.FullName) { Remove-Item -Path $d.FullName -Recurse -Force -ErrorAction SilentlyContinue } } " ^
    "  } else { " ^
    "    $keep = $dirs | Sort-Object Name -Descending | Select-Object -First 1; " ^
    "    foreach ($d in $dirs) { if ($d.FullName -ne $keep.FullName) { Remove-Item -Path $d.FullName -Recurse -Force -ErrorAction SilentlyContinue } } " ^
    "  } " ^
    "}"
)
echo [OK] Backend EXE: %BACKEND_EXE%
if exist "%NATIVE_KEY_DIR%" (
  if not exist "%BACKEND_DIST_DIR%\native_key" mkdir "%BACKEND_DIST_DIR%\native_key" >nul 2>nul
  copy /y "%NATIVE_KEY_DIR%\*.dll" "%BACKEND_DIST_DIR%\native_key\" >nul 2>nul
  copy /y "%NATIVE_KEY_DIR%\*.so" "%BACKEND_DIST_DIR%\native_key\" >nul 2>nul
  copy /y "%NATIVE_KEY_DIR%\*.dylib" "%BACKEND_DIST_DIR%\native_key\" >nul 2>nul
  echo [OK] Included native model-key helper files when present.
)
set "FFMPEG_SRC="
if defined MACHINE_DARTS_FFMPEG_PATH (
  if exist "%MACHINE_DARTS_FFMPEG_PATH%" set "FFMPEG_SRC=%MACHINE_DARTS_FFMPEG_PATH%"
)
if not defined FFMPEG_SRC (
  for /f "delims=" %%F in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue; if ($cmd) { $cmd.Source }"') do set "FFMPEG_SRC=%%F"
)
if defined FFMPEG_SRC (
  if not exist "%BACKEND_DIST_DIR%\tools" mkdir "%BACKEND_DIST_DIR%\tools" >nul 2>nul
  copy /y "%FFMPEG_SRC%" "%BACKEND_DIST_DIR%\tools\ffmpeg.exe" >nul
  if errorlevel 1 (
    echo [WARN] Failed to include ffmpeg from: %FFMPEG_SRC%
  ) else (
    echo [OK] Included ffmpeg for H.264 replay MP4s: %FFMPEG_SRC%
  )
) else (
  echo [WARN] ffmpeg not found. Replay MP4s may fall back to non-H.264 on customer machines.
  echo        Set MACHINE_DARTS_FFMPEG_PATH to a static ffmpeg.exe before building.
)
set "FIREBASE_CREDS_SRC=%BACKEND_DIR%\data\firebase_credentials.json"
set "FIREBASE_CREDS_DST_DIR=%BACKEND_DIST_DIR%\backend\data"
if exist "%FIREBASE_CREDS_SRC%" (
  if not exist "%FIREBASE_CREDS_DST_DIR%" mkdir "%FIREBASE_CREDS_DST_DIR%" >nul 2>nul
  copy /y "%FIREBASE_CREDS_SRC%" "%FIREBASE_CREDS_DST_DIR%\firebase_credentials.json" >nul
  if errorlevel 1 (
    echo [WARN] Failed to copy firebase credentials into backend bundle.
  ) else (
    echo [OK] Included firebase credentials in backend bundle.
  )
) else (
  echo [WARN] firebase_credentials.json not found at: %FIREBASE_CREDS_SRC%
  echo        Auto-upload from installer builds will be disabled.
)
echo.

echo [2/4] Building frontend assets...
pushd "%FRONTEND_DIR%"
call npm install
if %errorlevel% neq 0 (
  echo [ERROR] npm install failed.
  popd
  exit /b 1
)

call %FRONTEND_BUILD_CMD%
if %errorlevel% neq 0 (
  echo [ERROR] Frontend build failed.
  popd
  exit /b 1
)
popd
echo [OK] Frontend build complete.
echo.

echo [secure] Staging encrypted models only...
call %PY% "%BACKEND_DIR%\tools\stage_secure_models.py" --models-root "%ROOT%\models" --output-root "%SECURE_MODELS_DIR%" --force
if %errorlevel% neq 0 (
  echo [ERROR] Secure model staging failed. Encrypt calibration and tip models first.
  exit /b 1
)
set "MACHINE_DARTS_SECURE_MODELS_RESOURCE=../../build/secure-models/models"
echo [OK] Secure models staged at: %SECURE_MODELS_DIR%
echo.

echo [3/4] Preparing portable release folder...
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%\backend" >nul 2>nul
mkdir "%RELEASE_DIR%\frontend" >nul 2>nul
mkdir "%RELEASE_DIR%\voice_packs" >nul 2>nul

if exist "%RELEASE_DIR%\backend\darts-backend" rmdir /s /q "%RELEASE_DIR%\backend\darts-backend" >nul 2>nul
xcopy "%BACKEND_DIST_DIR%\*" "%RELEASE_DIR%\backend\darts-backend\" /e /i /y >nul
if exist "%FRONTEND_DIR%\dist" xcopy "%FRONTEND_DIR%\dist\*" "%RELEASE_DIR%\frontend\" /e /i /y >nul
if exist "%SECURE_MODELS_DIR%" xcopy "%SECURE_MODELS_DIR%\*" "%RELEASE_DIR%\models\" /e /i /y >nul
if exist "%RELEASE_DIR%\models" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$bad = Get-ChildItem -Path '%RELEASE_DIR%\models' -Recurse -File -Include '*.pt','*.onnx','*.xml','*.bin' -ErrorAction SilentlyContinue; " ^
    "if ($bad) { Write-Host '[ERROR] Raw model files found in release models folder:'; $bad | ForEach-Object { Write-Host ('  ' + $_.FullName) }; exit 1 }"
  if errorlevel 1 (
    echo [ERROR] Release packaging must contain encrypted model files only.
    exit /b 1
  )
)
if exist "%ROOT%\voice_packs" xcopy "%ROOT%\voice_packs\*" "%RELEASE_DIR%\voice_packs\" /e /i /y >nul

echo [OK] Portable files staged at: %RELEASE_DIR%
echo.

echo [4/4] Building Tauri installer (if configured)...
if exist "%FRONTEND_DIR%\src-tauri\tauri.conf.json" (
  where cargo >nul 2>nul
  if %errorlevel% neq 0 (
    echo [ERROR] cargo not found in PATH. Install Rust via rustup, then restart terminal.
    exit /b 1
  )
  where rustc >nul 2>nul
  if %errorlevel% neq 0 (
    echo [ERROR] rustc not found in PATH. Install Rust via rustup, then restart terminal.
    exit /b 1
  )
  pushd "%FRONTEND_DIR%"
  call %TAURI_BUILD_CMD%
  if errorlevel 1 (
    echo [ERROR] Tauri build failed.
    popd
    exit /b 1
  )
  popd
  if exist "%TAURI_BUNDLE_DIR%" (
    echo [OK] Tauri bundle output:
    echo      %TAURI_BUNDLE_DIR%
  ) else if exist "%TAURI_RELEASE_DIR%\nsis" (
    echo [OK] Tauri output detected:
    echo      %TAURI_RELEASE_DIR%\nsis
  ) else if exist "%TAURI_RELEASE_DIR%\wix" (
    echo [OK] Tauri output detected:
    echo      %TAURI_RELEASE_DIR%\wix
  ) else (
    echo [ERROR] Tauri output folder not found after build.
    echo        Checked:
    echo        - %TAURI_BUNDLE_DIR%
    echo        - %TAURI_RELEASE_DIR%\nsis
    echo        - %TAURI_RELEASE_DIR%\wix
    exit /b 1
  )
) else (
  echo [WARN] Tauri config not found: %FRONTEND_DIR%\src-tauri\tauri.conf.json
  echo        Skipped installer build.
)
echo.

if exist "%TAURI_BUNDLE_DIR%\nsis" (
  echo [5/5] Preparing updater upload package...
  if exist "%UPDATER_UPLOAD_DIR%" rmdir /s /q "%UPDATER_UPLOAD_DIR%" >nul 2>nul
  mkdir "%UPDATER_UPLOAD_DIR%" >nul 2>nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; " ^
    "$nsisDir='%TAURI_BUNDLE_DIR%\nsis'; $bundleDir='%TAURI_BUNDLE_DIR%'; $outDir='%UPDATER_UPLOAD_DIR%'; $manifestName='latest-windows.json'; " ^
    "$installer = Get-ChildItem -Path $nsisDir -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; " ^
    "if (-not $installer) { Write-Host '[WARN] No NSIS installer found for updater package.'; exit 0 }; " ^
    "$releaseInstallerName = ($installer.Name -replace '\s+', '.'); " ^
    "$releaseInstallerPath = Join-Path $outDir $releaseInstallerName; " ^
    "$sigPath = $installer.FullName + '.sig'; " ^
    "$latestCandidates = @((Join-Path $nsisDir 'latest.json'), (Join-Path $bundleDir 'latest.json')); " ^
    "$latestPath = $latestCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1; " ^
    "Copy-Item -LiteralPath $installer.FullName -Destination $releaseInstallerPath -Force; " ^
    "if (Test-Path $sigPath) { Copy-Item -LiteralPath $sigPath -Destination ($releaseInstallerPath + '.sig') -Force } else { Write-Host '[WARN] Missing updater signature file (.sig).'; }; " ^
    "if ($latestPath) { " ^
    "  Copy-Item -LiteralPath $latestPath -Destination (Join-Path $outDir $manifestName) -Force; " ^
    "  Copy-Item -LiteralPath $latestPath -Destination (Join-Path $outDir 'latest.json') -Force; " ^
    "} else { " ^
    "  if (-not (Test-Path $sigPath)) { Write-Host '[WARN] Missing latest.json updater manifest.'; } " ^
    "  else { " ^
    "    $cfg = Get-Content '%FRONTEND_DIR%\src-tauri\tauri.%FLAVOR%.conf.json' -Raw | ConvertFrom-Json; " ^
    "    $version = [string]$cfg.version; " ^
    "    $sig = (Get-Content ($releaseInstallerPath + '.sig') -Raw).Trim(); " ^
    "    $downloadUrl = 'https://github.com/Zoofly85/machine-darts-updater/releases/latest/download/' + [Uri]::EscapeDataString($releaseInstallerName); " ^
    "    $manifest = [ordered]@{ " ^
    "      version = $version; " ^
    "      notes = 'Machine Darts update ' + $version; " ^
    "      pub_date = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); " ^
    "      platforms = [ordered]@{ " ^
    "        'windows-x86_64' = [ordered]@{ signature = $sig; url = $downloadUrl } " ^
    "      } " ^
    "    }; " ^
    "    $latestOut = Join-Path $outDir $manifestName; " ^
    "    $json = $manifest | ConvertTo-Json -Depth 8; " ^
    "    $enc = New-Object System.Text.UTF8Encoding($false); " ^
    "    [IO.File]::WriteAllText($latestOut, $json, $enc); " ^
    "    [IO.File]::WriteAllText((Join-Path $outDir 'latest.json'), $json, $enc); " ^
    "    Write-Host ('[OK] Generated latest.json manifest: ' + $latestOut); " ^
    "  } " ^
    "} " ^
    "Write-Host ('[OK] Updater upload folder: ' + $outDir);"
  if errorlevel 1 (
    echo [WARN] Failed to prepare updater upload folder.
  )
  echo.
)

echo ======================================================
echo Release build finished.
echo - Backend EXE: %BACKEND_EXE%
echo - Portable stage: %RELEASE_DIR%
if exist "%UPDATER_UPLOAD_DIR%" echo - Updater upload pack: %UPDATER_UPLOAD_DIR%
echo ======================================================
exit /b 0

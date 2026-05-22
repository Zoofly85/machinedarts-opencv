# Model Encryption

Machine Darts can load OpenVINO tip models from encrypted folders. This protects
the `.xml` and `.bin` files from casual copying while keeping inference local and
offline.

This is not perfect DRM. A model that runs on a user's machine can eventually be
extracted by a determined reverse engineer. The goal is to stop normal file-copy
reuse and prepare the app for per-install license keys later.

## How it Works

An encrypted model folder contains:

```text
model-name_openvino_model_encrypted/
  model.xml.enc
  model.bin.enc
  metadata.yaml
  encrypted_model.json
```

At startup the backend:

1. Reads the model key from `MACHINE_DARTS_MODEL_KEY`, `MACHINE_DARTS_MODEL_KEY_FILE`,
   or the local key file.
2. Decrypts `.xml.enc` and `.bin.enc` in memory.
3. Loads and compiles the OpenVINO model from memory.

The decrypted model is not written to disk by the app.

Plain `.xml/.bin` model folders still work.

## Key Locations

Default development key file:

```text
backend/data/settings/model_key.txt
```

Frozen Windows build:

```text
%APPDATA%\DartDetector\settings\model_key.txt
```

Frozen Linux build:

```text
~/.local/share/DartDetector/settings/model_key.txt
```

The key file is intentionally ignored by git.

## Create an Encrypted Model

Windows PowerShell:

```powershell
python backend\tools\encrypt_openvino_model.py --model-dir "models\tip\1280-11n-p-30042026_openvino_model" --generate-key
```

Linux:

```bash
python3 backend/tools/encrypt_openvino_model.py --model-dir "models/tip/1280-11n-p-30042026_openvino_model" --generate-key
```

This creates:

```text
models/tip/1280-11n-p-30042026_openvino_model_encrypted
```

To encrypt another model with the existing key, omit `--generate-key`:

```powershell
python backend\tools\encrypt_openvino_model.py --model-dir "models\tip\another_openvino_model"
```

## Use an Environment Key

Instead of a key file:

Windows PowerShell:

```powershell
$env:MACHINE_DARTS_MODEL_KEY="mdk1:..."
python backend\run_api.py
```

Linux:

```bash
export MACHINE_DARTS_MODEL_KEY="mdk1:..."
python3 backend/run_api.py
```

This is the path we can later connect to online license activation.

## Native Key Helper

For automatic offline builds without shipping `model_key.txt`, generate a native
helper library from the local key:

```powershell
python backend\tools\generate_native_model_key_helper.py --force --compile
```

On Windows this creates:

```text
backend/native_key/model_key_helper.dll
```

On Linux this creates:

```text
backend/native_key/libmodel_key_helper.so
```

The generated C source and compiled library are ignored by git because they
contain the model key material. Build the helper separately on each target OS.
The release scripts copy `.dll`, `.so`, or `.dylib` files from
`backend/native_key` into the backend bundle when present.

If `--compile` fails, install a C compiler:

Windows:

```text
Visual Studio Build Tools with C++ tools, or LLVM/clang
```

Linux:

```bash
sudo apt install build-essential
```

## Secure Release Staging

Release scripts now stage only encrypted model folders into:

```text
build/secure-models/models
```

Then the portable release and Tauri installer use that secure model folder
instead of the repo `models` folder. That keeps plain `.xml`, `.bin`, `.pt`, and
`.onnx` files out of release artifacts.

You can run the staging manually:

```powershell
python backend\tools\stage_secure_models.py --models-root models --output-root build\secure-models\models --force
```

The app currently supports encrypted tip and calibration OpenVINO models.

## Nuitka Backend

PyInstaller remains the default release builder. To build the backend with
Nuitka instead, install Nuitka first:

```powershell
python -m pip install nuitka ordered-set zstandard
```

Then run the release script with:

```powershell
$env:MACHINE_DARTS_BACKEND_BUILDER="nuitka"
.\build_release.bat home
```

Linux:

```bash
python3 -m pip install nuitka ordered-set zstandard
MACHINE_DARTS_BACKEND_BUILDER=nuitka ./build_release.sh home
```

Nuitka builds should be tested per OS because native packaging depends on the
local Python, compiler, OpenVINO, and system libraries.

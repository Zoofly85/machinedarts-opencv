# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

# OpenVINO needs bundled runtime/frontend DLLs (not just Python modules),
# otherwise read_model(.xml) fails in frozen builds with "Available frontends: jax pytorch".
hiddenimports = []
hiddenimports += collect_submodules("openvino")
hiddenimports += collect_submodules("cryptography")

datas = []
datas += collect_data_files("openvino", include_py_files=True)

binaries = []
binaries += collect_dynamic_libs("openvino")

a = Analysis(
    ["run_api.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Runtime app uses OpenVINO exported models; these training/export stacks
        # should not be bundled into end-user installers.
        "torch",
        "torchvision",
        "torchaudio",
        "ultralytics",
        "ultralytics_thop",
        "tensorflow",
        "keras",
        "tf_keras",
        "tensorboard",
        "tensorflow_estimator",
        "onnx",
        "onnxruntime",
        "onnxruntime_directml",
        "nncf",
        "h5py",
        "matplotlib",
        "pandas",
        "scipy",
        "sklearn",
        "sympy",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="darts-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="darts-backend",
)

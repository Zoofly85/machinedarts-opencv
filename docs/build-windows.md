# Windows Build (Home / Club Board / Club Master)

This guide is for Windows builds using `build_release.bat`.

## 1) Install build prerequisites

- Python 3.10+ with `pip` in `PATH`
- Node.js 20+ (includes `npm` and `npx`)
- Rust toolchain (`cargo`, `rustc`) via rustup
- Microsoft C++ Build Tools (for Rust/Python native dependencies)
- WebView2 Runtime (required by Tauri app runtime)

Quick checks in `cmd` or PowerShell:

```powershell
python --version
pip --version
node --version
npm --version
npx --version
cargo --version
rustc --version
```

If Rust is missing:

```powershell
winget install Rustlang.Rustup
```

## 2) Optional: configure updater signing

`build_release.bat` will auto-load keys from:

- `%USERPROFILE%\.tauri\machine-darts-updater.key`
- `%USERPROFILE%\.tauri\machine-darts-updater.pubkey`

Or you can set env vars explicitly:

- `TAURI_SIGNING_PRIVATE_KEY`
- `MACHINE_DARTS_TAURI_UPDATER_PUBKEY`

## 3) Build

From repo root:

```bat
build_release.bat home
```

Other flavors:

```bat
build_release.bat club-board
build_release.bat club-master
```

## 4) Outputs

- Portable stage: `build\release`
- Tauri bundles: `frontend\src-tauri\target\release\bundle`
  - NSIS installer artifacts (when enabled by Tauri config)

## Notes

- Windows and Linux runtime dependencies are separate.
- Python dependencies are shared via `backend/requirements.txt`.
- OS-level GPU/runtime setup is platform-specific and should be documented per OS.

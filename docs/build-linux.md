# Linux Build (Home / Club Board / Club Master)

This guide is for Ubuntu/Debian Linux builds using `build_release.sh`.

## 1) Install build prerequisites (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install -y \
  python3 python3-pip python3-venv \
  build-essential pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  libssl-dev
```

Install Node.js 20+ (required by Vite 7):

```bash
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Install Rust:

```bash
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

## 2) Optional: enable Intel iGPU inference (OpenVINO GPU plugin)

If you want OpenVINO GPU inference on Linux, install Intel runtime packages:

```bash
sudo apt install -y intel-opencl-icd clinfo
sudo usermod -aG video,render "$USER"
```

Then **log out and back in** (group change will not apply until next login), and verify:

```bash
clinfo | grep -Ei "platform name|device name|intel"
python3 - <<'PY'
from openvino import Core
print(Core().available_devices)
PY
```

Expected for GPU-ready system: output includes `GPU` (for example `['CPU', 'GPU']`).

## 3) Build

From repo root:

```bash
chmod +x ./build_release.sh
./build_release.sh home
```

Other flavors:

```bash
./build_release.sh club-board
./build_release.sh club-master
```

## 4) Outputs

- Portable stage: `build/release-linux`
- Tauri bundles: `frontend/src-tauri/target/release/bundle`
  - `.deb`
  - `.AppImage`

## Notes

- Linux script defaults to unsigned Tauri builds (`MACHINE_DARTS_TAURI_ALLOW_UNSIGNED=1`).
- To force signed/updater builds on Linux, set:
  - `MACHINE_DARTS_TAURI_UPDATER_PUBKEY`
  - `TAURI_SIGNING_PRIVATE_KEY`
  - and run with `MACHINE_DARTS_TAURI_ALLOW_UNSIGNED=0`.
- The Linux installer bundle does **not** automatically install system GPU runtime packages or user-group membership.
  - `intel-opencl-icd` and `video/render` group access must be configured on the target machine.
  - If not configured, app still works on CPU inference.

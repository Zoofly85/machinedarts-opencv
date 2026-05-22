#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLAVOR="${1:-home}"

case "${FLAVOR}" in
  home|opencv|club-board|club-master) ;;
  *)
    echo "[ERROR] Invalid flavor '${FLAVOR}'. Use: home | opencv | club-board | club-master"
    exit 1
    ;;
esac

BACKEND_DIR="${ROOT_DIR}/backend"
FRONTEND_DIR="${ROOT_DIR}/frontend"
BACKEND_DIST_DIR="${BACKEND_DIR}/dist/darts-backend"
BACKEND_BIN="${BACKEND_DIST_DIR}/darts-backend"
BACKEND_WORKPATH="${BACKEND_DIR}/build/pyi_work"
NATIVE_KEY_DIR="${BACKEND_DIR}/native_key"
RELEASE_DIR="${ROOT_DIR}/build/release-linux"
SECURE_MODELS_DIR="${ROOT_DIR}/build/secure-models/models"
TAURI_BUNDLE_DIR="${FRONTEND_DIR}/src-tauri/target/release/bundle"
TAURI_RELEASE_DIR="${FRONTEND_DIR}/src-tauri/target/release"
MACHINE_DARTS_UPDATER_MANIFEST_NAME="${MACHINE_DARTS_UPDATER_MANIFEST_NAME:-latest-linux.json}"
UPDATER_UPLOAD_DIR="${ROOT_DIR}/build/updater/${FLAVOR}"

echo "======================================================"
echo "Machine Darts Linux Release Build"
echo "Root: ${ROOT_DIR}"
echo "Flavor: ${FLAVOR}"
echo "======================================================"
echo

command -v python3 >/dev/null 2>&1 || { echo "[ERROR] python3 not found"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "[ERROR] npm not found"; exit 1; }
if [[ "${MACHINE_DARTS_SKIP_TAURI:-0}" != "1" ]]; then
  command -v cargo >/dev/null 2>&1 || { echo "[ERROR] cargo not found"; exit 1; }
  command -v rustc >/dev/null 2>&1 || { echo "[ERROR] rustc not found"; exit 1; }
fi

if [[ ! -f "${BACKEND_DIR}/run_api.py" ]]; then
  echo "[ERROR] Backend entry not found: ${BACKEND_DIR}/run_api.py"
  exit 1
fi
if [[ ! -f "${FRONTEND_DIR}/package.json" ]]; then
  echo "[ERROR] Frontend package.json not found: ${FRONTEND_DIR}/package.json"
  exit 1
fi

echo "[prep] Stopping stale backend process and cleaning old output..."
pkill -f "darts-backend" >/dev/null 2>&1 || true
rm -rf "${BACKEND_DIST_DIR}" "${BACKEND_WORKPATH}" "${RELEASE_DIR}" "${TAURI_BUNDLE_DIR}"
mkdir -p "${BACKEND_WORKPATH}"

echo "[1/4] Building backend binary..."
pushd "${BACKEND_DIR}" >/dev/null
if [[ "${MACHINE_DARTS_BACKEND_BUILDER:-pyinstaller}" == "nuitka" ]]; then
  echo "[INFO] Backend builder: Nuitka"
  python3 "${BACKEND_DIR}/tools/build_backend_nuitka.py" --backend-dir "${BACKEND_DIR}" --output-dir "${BACKEND_DIST_DIR}" --work-dir "${BACKEND_DIR}/build/nuitka_work"
else
  echo "[INFO] Backend builder: PyInstaller"
  python3 -m pip install --disable-pip-version-check pyinstaller >/dev/null
  python3 -m PyInstaller "${BACKEND_DIR}/darts-backend.spec" --noconfirm --workpath "${BACKEND_WORKPATH}"
fi
popd >/dev/null

if [[ ! -f "${BACKEND_BIN}" ]]; then
  echo "[ERROR] Backend binary not found: ${BACKEND_BIN}"
  exit 1
fi
echo "[OK] Backend binary: ${BACKEND_BIN}"

if [[ ! -f "${NATIVE_KEY_DIR}/generated_model_key_helper.c" && -z "${MACHINE_DARTS_MODEL_KEY:-}" && -z "${MACHINE_DARTS_MODEL_KEY_FILE:-}" ]]; then
  echo "[ERROR] Encrypted model key helper is missing: ${NATIVE_KEY_DIR}/generated_model_key_helper.c"
  echo "        Copy backend/native_key from the trusted Windows build machine,"
  echo "        or set MACHINE_DARTS_MODEL_KEY / MACHINE_DARTS_MODEL_KEY_FILE before building."
  echo "        Without this, the Linux installer will build but encrypted models will not load."
  exit 1
fi

if [[ -f "${NATIVE_KEY_DIR}/generated_model_key_helper.c" ]]; then
  if [[ "${OSTYPE:-}" == "linux"* || "$(uname -s 2>/dev/null || true)" == "Linux" ]]; then
    if command -v gcc >/dev/null 2>&1; then
      gcc -shared -fPIC -O2 \
        -o "${NATIVE_KEY_DIR}/libmodel_key_helper.so" \
        "${NATIVE_KEY_DIR}/generated_model_key_helper.c"
      echo "[OK] Built Linux native model-key helper."
    else
      echo "[ERROR] gcc not found; cannot build Linux native model-key helper."
      echo "        Install gcc or set MACHINE_DARTS_MODEL_KEY / MACHINE_DARTS_MODEL_KEY_FILE for this build."
      exit 1
    fi
  fi
fi
if [[ -d "${NATIVE_KEY_DIR}" ]]; then
  mkdir -p "${BACKEND_DIST_DIR}/native_key"
  find "${NATIVE_KEY_DIR}" -maxdepth 1 -type f \( -name '*.so' -o -name '*.dll' -o -name '*.dylib' \) -exec cp -f {} "${BACKEND_DIST_DIR}/native_key/" \;
  echo "[OK] Included native model-key helper files when present."
fi
FFMPEG_SRC="${MACHINE_DARTS_FFMPEG_PATH:-}"
if [[ -z "${FFMPEG_SRC}" ]]; then
  FFMPEG_SRC="$(command -v ffmpeg || true)"
fi
if [[ -n "${FFMPEG_SRC}" && -f "${FFMPEG_SRC}" ]]; then
  mkdir -p "${BACKEND_DIST_DIR}/tools"
  cp -f "${FFMPEG_SRC}" "${BACKEND_DIST_DIR}/tools/ffmpeg"
  chmod +x "${BACKEND_DIST_DIR}/tools/ffmpeg"
  echo "[OK] Included ffmpeg for H.264 replay MP4s: ${FFMPEG_SRC}"
else
  echo "[WARN] ffmpeg not found. Replay MP4s may fall back to non-H.264 on customer machines."
  echo "       Set MACHINE_DARTS_FFMPEG_PATH to a static ffmpeg binary before building."
fi

FIREBASE_CREDS_SRC="${BACKEND_DIR}/data/firebase_credentials.json"
FIREBASE_CREDS_DST_DIR="${BACKEND_DIST_DIR}/backend/data"
if [[ -f "${FIREBASE_CREDS_SRC}" ]]; then
  mkdir -p "${FIREBASE_CREDS_DST_DIR}"
  cp -f "${FIREBASE_CREDS_SRC}" "${FIREBASE_CREDS_DST_DIR}/firebase_credentials.json"
  echo "[OK] Included firebase credentials in backend bundle."
else
  echo "[WARN] firebase_credentials.json not found at: ${FIREBASE_CREDS_SRC}"
fi
echo

echo "[2/4] Building frontend assets..."
pushd "${FRONTEND_DIR}" >/dev/null
npm install
npm run "build:${FLAVOR}"
popd >/dev/null
echo "[OK] Frontend build complete."
echo

echo "[secure] Staging encrypted models only..."
python3 "${BACKEND_DIR}/tools/stage_secure_models.py" --models-root "${ROOT_DIR}/models" --output-root "${SECURE_MODELS_DIR}" --force
export MACHINE_DARTS_SECURE_MODELS_RESOURCE="../../build/secure-models/models"
echo "[OK] Secure models staged at: ${SECURE_MODELS_DIR}"
echo

echo "[3/4] Preparing portable release folder..."
mkdir -p "${RELEASE_DIR}/backend" "${RELEASE_DIR}/frontend" "${RELEASE_DIR}/voice_packs"
cp -a "${BACKEND_DIST_DIR}" "${RELEASE_DIR}/backend/"
if [[ -d "${FRONTEND_DIR}/dist" ]]; then
  cp -a "${FRONTEND_DIR}/dist/." "${RELEASE_DIR}/frontend/"
fi
if [[ -d "${SECURE_MODELS_DIR}" ]]; then
  mkdir -p "${RELEASE_DIR}/models"
  cp -a "${SECURE_MODELS_DIR}/." "${RELEASE_DIR}/models/"
fi
if [[ -d "${ROOT_DIR}/voice_packs" ]]; then
  cp -a "${ROOT_DIR}/voice_packs/." "${RELEASE_DIR}/voice_packs/"
fi
echo "[OK] Portable files staged at: ${RELEASE_DIR}"
echo

if [[ "${MACHINE_DARTS_SKIP_TAURI:-0}" == "1" ]]; then
  echo "[4/4] Skipping Tauri Linux bundles (MACHINE_DARTS_SKIP_TAURI=1)."
  echo "[OK] Headless release files are ready at: ${RELEASE_DIR}"
  exit 0
fi

echo "[4/4] Building Tauri Linux bundles..."
pushd "${FRONTEND_DIR}" >/dev/null
export MACHINE_DARTS_TAURI_BUNDLES="${MACHINE_DARTS_TAURI_BUNDLES:-deb,appimage}"
export MACHINE_DARTS_TAURI_ALLOW_UNSIGNED="${MACHINE_DARTS_TAURI_ALLOW_UNSIGNED:-1}"
export MACHINE_DARTS_UPDATER_MANIFEST_NAME
npm run "tauri:build:${FLAVOR}"
popd >/dev/null

if [[ -d "${TAURI_BUNDLE_DIR}" ]]; then
  echo "[OK] Tauri bundle output:"
  echo "     ${TAURI_BUNDLE_DIR}"
else
  echo "[ERROR] Tauri bundle folder not found after build."
  exit 1
fi
echo

echo "[5/5] Preparing updater upload package..."
DEB_FILE="$(find "${TAURI_BUNDLE_DIR}/deb" -maxdepth 1 -type f -name '*.deb' | head -n 1 || true)"
if [[ -z "${DEB_FILE}" ]]; then
  echo "[WARN] No .deb bundle found; skipping updater package step."
else
  mkdir -p "${UPDATER_UPLOAD_DIR}"
  cp -f "${DEB_FILE}" "${UPDATER_UPLOAD_DIR}/"
  SIG_FILE="${DEB_FILE}.sig"
  if [[ -f "${SIG_FILE}" ]]; then
    cp -f "${SIG_FILE}" "${UPDATER_UPLOAD_DIR}/"
    VERSION="$(
      python3 - <<'PY' "${FRONTEND_DIR}" "${FLAVOR}"
import json
import pathlib
import sys

frontend_dir = pathlib.Path(sys.argv[1])
flavor = sys.argv[2]
cfg_path = frontend_dir / "src-tauri" / f"tauri.{flavor}.conf.json"
try:
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    print(str(cfg.get("version", "0.0.0")))
except Exception:
    print("0.0.0")
PY
    )"

    python3 - <<'PY' "${UPDATER_UPLOAD_DIR}" "${DEB_FILE}" "${VERSION}" "${MACHINE_DARTS_UPDATER_MANIFEST_NAME}"
import json
import pathlib
import sys
from datetime import datetime, timezone
from urllib.parse import quote

out_dir = pathlib.Path(sys.argv[1])
deb_file = pathlib.Path(sys.argv[2])
version = str(sys.argv[3] or "0.0.0")
manifest_name = str(sys.argv[4] or "latest-linux.json")
sig_file = pathlib.Path(str(deb_file) + ".sig")

signature = sig_file.read_text(encoding="utf-8").strip()
deb_name = deb_file.name
manifest = {
    "version": version,
    "notes": f"Machine Darts update {version}",
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "linux-x86_64": {
            "signature": signature,
            "url": "https://github.com/Zoofly85/machine-darts-updater/releases/latest/download/" + quote(deb_name),
        }
    },
}
manifest_json = json.dumps(manifest, indent=2) + "\n"
(out_dir / manifest_name).write_text(manifest_json, encoding="utf-8")
# Compatibility alias for older clients/tools.
(out_dir / "latest.json").write_text(manifest_json, encoding="utf-8")
print(out_dir / manifest_name)
PY
    echo "[OK] Updater package ready at: ${UPDATER_UPLOAD_DIR}"
    echo "     - $(basename "${DEB_FILE}")"
    echo "     - $(basename "${SIG_FILE}")"
    echo "     - latest.json"
  else
    echo "[WARN] Missing .sig file for ${DEB_FILE}; copied .deb only."
    echo "       Sign the bundle to generate updater artifacts."
  fi
fi
echo

echo "======================================================"
echo "Linux release build finished."
echo "- Backend binary: ${BACKEND_BIN}"
echo "- Portable stage: ${RELEASE_DIR}"
echo "======================================================"

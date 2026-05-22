#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="${ROOT_DIR}/frontend"
RELEASE_DIR="${ROOT_DIR}/build/release-linux"
OUT_DIR="${ROOT_DIR}/build/headless"
PKG_ROOT="${OUT_DIR}/pkg"
INSTALL_DIR="/opt/machine-darts-headless"
SERVICE_NAME="machine-darts-headless"

VERSION="$(
  python3 - <<'PY' "${FRONTEND_DIR}"
import json
import pathlib
import sys

frontend_dir = pathlib.Path(sys.argv[1])
for rel in ("src-tauri/tauri.home.conf.json", "package.json"):
    path = frontend_dir / rel
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        version = str(payload.get("version") or "").strip()
        if version:
            print(version)
            raise SystemExit(0)
    except SystemExit:
        raise
    except Exception:
        pass
print("0.0.0")
PY
)"

ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "${ARCH}" in
  aarch64) ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
esac

if [[ ! -d "${RELEASE_DIR}/backend/darts-backend" ]]; then
  echo "[ERROR] Missing staged backend at ${RELEASE_DIR}/backend/darts-backend"
  echo "        Run ./build_release.sh home first, then rerun this script."
  exit 1
fi
if [[ ! -f "${RELEASE_DIR}/frontend/index.html" ]]; then
  echo "[ERROR] Missing staged frontend at ${RELEASE_DIR}/frontend"
  echo "        Run ./build_release.sh home first, then rerun this script."
  exit 1
fi
if [[ ! -d "${RELEASE_DIR}/models" ]]; then
  echo "[ERROR] Missing staged secure models at ${RELEASE_DIR}/models"
  echo "        Run ./build_release.sh home first, then rerun this script."
  exit 1
fi

echo "======================================================"
echo "Machine Darts Pi Headless Package"
echo "Root: ${ROOT_DIR}"
echo "Version: ${VERSION}"
echo "Arch: ${ARCH}"
echo "======================================================"
echo

rm -rf "${PKG_ROOT}"
mkdir -p \
  "${PKG_ROOT}/DEBIAN" \
  "${PKG_ROOT}${INSTALL_DIR}" \
  "${PKG_ROOT}/etc/systemd/system" \
  "${PKG_ROOT}/usr/bin"

cp -a "${RELEASE_DIR}/backend" "${PKG_ROOT}${INSTALL_DIR}/"
cp -a "${RELEASE_DIR}/frontend" "${PKG_ROOT}${INSTALL_DIR}/"
cp -a "${RELEASE_DIR}/models" "${PKG_ROOT}${INSTALL_DIR}/"
if [[ -d "${RELEASE_DIR}/voice_packs" ]]; then
  cp -a "${RELEASE_DIR}/voice_packs" "${PKG_ROOT}${INSTALL_DIR}/"
fi

cat > "${PKG_ROOT}/usr/bin/machine-darts-headless" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/machine-darts-headless
exec /opt/machine-darts-headless/backend/darts-backend/darts-backend --host 0.0.0.0 --port "${MACHINE_DARTS_PORT:-8000}" "$@"
EOF
chmod 0755 "${PKG_ROOT}/usr/bin/machine-darts-headless"

cat > "${PKG_ROOT}/etc/systemd/system/${SERVICE_NAME}.service" <<'EOF'
[Unit]
Description=Machine Darts Headless Backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/machine-darts-headless
Environment=MACHINE_DARTS_SCORING_CAMERA_COUNT=2
Environment=MACHINE_DARTS_CAMERA_SLOT_COUNT=3
Environment=MACHINE_DARTS_CONTROL_FRONTEND_DIR=/opt/machine-darts-headless/frontend
Environment=MACHINE_DARTS_PORT=8000
Environment=MACHINE_DARTS_CALLER_BROWSER_PLAYBACK=1
Environment=MACHINE_DARTS_CALLER_LOCAL_PLAYBACK=0
ExecStart=/usr/bin/machine-darts-headless
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > "${PKG_ROOT}/DEBIAN/control" <<EOF
Package: machine-darts-headless
Version: ${VERSION}
Section: games
Priority: optional
Architecture: ${ARCH}
Maintainer: Machine Darts <support@machine-darts.local>
Depends: systemd, ffmpeg
Conflicts: machine-darts-home
Description: Machine Darts Pi headless backend
 Starts Machine Darts automatically on boot and serves the web UI on port 8000.
EOF

cat > "${PKG_ROOT}/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -e
chmod +x /usr/bin/machine-darts-headless || true
systemctl daemon-reload || true
systemctl enable machine-darts-headless.service || true
systemctl restart machine-darts-headless.service || true
cat <<'MSG'

Machine Darts Headless installed.
Open the UI from a tablet/PC at:
  http://<pi-ip>:8000
or, if mDNS is available:
  http://raspberrypi.local:8000

Service commands:
  sudo systemctl status machine-darts-headless
  sudo systemctl restart machine-darts-headless
  sudo journalctl -u machine-darts-headless -f

MSG
EOF
chmod 0755 "${PKG_ROOT}/DEBIAN/postinst"

cat > "${PKG_ROOT}/DEBIAN/prerm" <<'EOF'
#!/usr/bin/env bash
set -e
if [[ "${1:-}" = "remove" || "${1:-}" = "deconfigure" ]]; then
  systemctl stop machine-darts-headless.service || true
  systemctl disable machine-darts-headless.service || true
fi
EOF
chmod 0755 "${PKG_ROOT}/DEBIAN/prerm"

cat > "${PKG_ROOT}/DEBIAN/postrm" <<'EOF'
#!/usr/bin/env bash
set -e
systemctl daemon-reload || true
EOF
chmod 0755 "${PKG_ROOT}/DEBIAN/postrm"

find "${PKG_ROOT}${INSTALL_DIR}/backend/darts-backend" -type f -name "darts-backend" -exec chmod +x {} \;
find "${PKG_ROOT}${INSTALL_DIR}/backend/darts-backend/tools" -type f -name "ffmpeg" -exec chmod +x {} \; 2>/dev/null || true

PACKAGE_PATH="${OUT_DIR}/machine-darts-headless_${VERSION}_${ARCH}.deb"
dpkg-deb --build "${PKG_ROOT}" "${PACKAGE_PATH}"

echo
echo "[OK] Headless installer built:"
echo "     ${PACKAGE_PATH}"

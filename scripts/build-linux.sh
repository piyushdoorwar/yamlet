#!/usr/bin/env bash
#
# Builds a Debian (.deb) package for Yamlet by publishing a self-contained
# linux build and assembling it under /opt/yamlet with a launcher, desktop
# entry and icon. Output: artifacts/packages/yamlet_<version>_<arch>.deb
#
# Env overrides: CONFIGURATION (Release), RID (linux-x64|linux-arm64), VERSION.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

APP_PROJECT="src/Yamlet.App/Yamlet.App.csproj"
CONFIGURATION="${CONFIGURATION:-Release}"
RID="${RID:-linux-x64}"
PUBLISH_DIR="artifacts/publish/${RID}"
PACKAGE_ROOT="artifacts/pkg/yamlet-deb"
DEB_DIR="artifacts/packages"
VERSION="${VERSION:-0.0.0-dev}"

case "${RID}" in
  linux-x64) DEB_ARCH="amd64" ;;
  linux-arm64) DEB_ARCH="arm64" ;;
  *)
    echo "Unsupported RID for .deb packaging: ${RID}" >&2
    exit 1
    ;;
esac

DEB_FILE="${DEB_DIR}/yamlet_${VERSION}_${DEB_ARCH}.deb"
TMP_DEB_FILE="${DEB_DIR}/.yamlet_${VERSION}_${DEB_ARCH}.deb.tmp"

# ── Publish a self-contained build ────────────────────────────────────────
dotnet restore Yamlet.slnx
dotnet publish "${APP_PROJECT}" -c "${CONFIGURATION}" -r "${RID}" --self-contained true \
  -o "${PUBLISH_DIR}" -p:Version="${VERSION}" -p:InformationalVersion="${VERSION}"

# ── Assemble the package tree ─────────────────────────────────────────────
rm -rf "${PACKAGE_ROOT}" "${DEB_DIR}"
mkdir -p \
  "${PACKAGE_ROOT}/DEBIAN" \
  "${PACKAGE_ROOT}/opt/yamlet" \
  "${PACKAGE_ROOT}/usr/bin" \
  "${PACKAGE_ROOT}/usr/share/applications" \
  "${PACKAGE_ROOT}/usr/share/icons/hicolor/scalable/apps" \
  "${DEB_DIR}"

cp -R "${PUBLISH_DIR}/." "${PACKAGE_ROOT}/opt/yamlet/"
cp "packaging/yamlet.svg" "${PACKAGE_ROOT}/usr/share/icons/hicolor/scalable/apps/yamlet.svg"

# Launcher that runs the published app with its bundled libraries on the path.
cat > "${PACKAGE_ROOT}/opt/yamlet/yamlet" <<'LAUNCHER'
#!/bin/sh
set -eu
APP_DIR="/opt/yamlet"
export LD_LIBRARY_PATH="${APP_DIR}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
exec "${APP_DIR}/Yamlet.App" "$@"
LAUNCHER

ln -s /opt/yamlet/yamlet "${PACKAGE_ROOT}/usr/bin/yamlet"

cat > "${PACKAGE_ROOT}/DEBIAN/control" <<CONTROL
Package: yamlet
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${DEB_ARCH}
Maintainer: Piyush Doorwar <piyushdoorwar4u@gmail.com>
Depends: libfontconfig1, libx11-6, libxcb1, libice6, libsm6, libgl1, libstdc++6, zlib1g
Description: Yamlet — local-first YAML API client
 A dark-mode desktop API client for Git-friendly, YAML-based API collections.
 Browse collections and requests in a sidebar, edit and send HTTP requests,
 and view responses — everything persists as plain YAML on disk.
 .
 Built with .NET and Avalonia UI. This package ships a self-contained build,
 so no separate .NET runtime is required.
CONTROL

cat > "${PACKAGE_ROOT}/usr/share/applications/yamlet.desktop" <<DESKTOP
[Desktop Entry]
Name=Yamlet
Comment=Local-first YAML API client
Exec=/opt/yamlet/yamlet %U
Icon=yamlet
Terminal=false
Type=Application
StartupWMClass=Yamlet.App
Categories=Development;Utility;
DESKTOP

cat > "${PACKAGE_ROOT}/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
POSTINST

cat > "${PACKAGE_ROOT}/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
POSTRM

chmod 755 "${PACKAGE_ROOT}/DEBIAN"
chmod +x "${PACKAGE_ROOT}/DEBIAN/postinst"
chmod +x "${PACKAGE_ROOT}/DEBIAN/postrm"
chmod +x "${PACKAGE_ROOT}/opt/yamlet/Yamlet.App"
chmod +x "${PACKAGE_ROOT}/opt/yamlet/yamlet"

# ── Build and validate the .deb ───────────────────────────────────────────
rm -f "${TMP_DEB_FILE}" "${DEB_FILE}"
dpkg-deb --root-owner-group -Zgzip --build "${PACKAGE_ROOT}" "${TMP_DEB_FILE}"

if ! ar t "${TMP_DEB_FILE}" | grep -q '^data\.tar'; then
  echo "Package validation failed: ${TMP_DEB_FILE} does not contain data.tar" >&2
  exit 1
fi

mv "${TMP_DEB_FILE}" "${DEB_FILE}"

echo "Built Debian package:"
find "${DEB_DIR}" -type f -name '*.deb' -print

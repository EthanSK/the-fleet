#!/usr/bin/env bash
#
# Builds "The Fleet.app" from this repository's desktop package.
#
# Repeatable and self-contained: SwiftPM compiles the app, the icon is exported
# from its canonical transparent PNG, the bundle is assembled and signed (ad-hoc unless
# CODE_SIGN_IDENTITY names a real identity). It does not install the app, write
# to ~/Library, start or restart The Fleet's service, or change any setting.
# Copying the result to /Applications is a separate, manual step.
#
#   desktop/Scripts/package-app.sh
#
# Environment (all optional):
#   THE_FLEET_APP_BUILD_DIR       where the .app goes (default desktop/build.noindex)
#   THE_FLEET_SWIFT_SCRATCH_PATH  SwiftPM scratch (default desktop/.build.noindex)
#   CONFIGURATION                 release (default) or debug
#   CODE_SIGN_IDENTITY            "-" for ad-hoc (default), or a codesigning identity

set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"
BUILD_DIR="${THE_FLEET_APP_BUILD_DIR:-${DESKTOP_DIR}/build.noindex}"
SCRATCH_PATH="${THE_FLEET_SWIFT_SCRATCH_PATH:-${DESKTOP_DIR}/.build.noindex}"
CONFIGURATION="${CONFIGURATION:-release}"
CODE_SIGN_IDENTITY="${CODE_SIGN_IDENTITY:--}"
APP_DIR="${BUILD_DIR}/The Fleet.app"

log() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "The desktop app builds on macOS only."
for tool in swift iconutil codesign plutil ditto python3; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required (install Xcode or its command line tools)."
done
[[ "${CONFIGURATION}" == "release" || "${CONFIGURATION}" == "debug" ]] || fail "CONFIGURATION must be release or debug."
if [[ "${CODE_SIGN_IDENTITY}" != "-" ]] && ! security find-identity -v -p codesigning | grep -Fq "\"${CODE_SIGN_IDENTITY}\""; then
  fail "Signing identity not found: ${CODE_SIGN_IDENTITY}. List yours with: security find-identity -v -p codesigning"
fi

# The app shares the core's version: they ship from one repository.
VERSION="$(plutil -extract version raw -o - "${REPO_ROOT}/package.json")"
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "package.json has no numeric version."

log "Building (${CONFIGURATION})"
swift build --package-path "${DESKTOP_DIR}" --scratch-path "${SCRATCH_PATH}" -c "${CONFIGURATION}" --product TheFleet
swift build --package-path "${DESKTOP_DIR}" --scratch-path "${SCRATCH_PATH}" -c "${CONFIGURATION}" --product fleet-app-icon
BIN_PATH="$(swift build --package-path "${DESKTOP_DIR}" --scratch-path "${SCRATCH_PATH}" -c "${CONFIGURATION}" --show-bin-path)"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/the-fleet-package.XXXXXX")"
trap 'rm -rf -- "${WORK_DIR}"' EXIT

log "Exporting the ship icon"
"${BIN_PATH}/fleet-app-icon" "${DESKTOP_DIR}/Resources/FleetShips.png" "${WORK_DIR}/AppIcon.iconset"
iconutil -c icns "${WORK_DIR}/AppIcon.iconset" -o "${WORK_DIR}/AppIcon.icns"

log "Assembling The Fleet.app ${VERSION}"
mkdir -p "${BUILD_DIR}"
rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${BIN_PATH}/TheFleet" "${APP_DIR}/Contents/MacOS/TheFleet"
cp "${WORK_DIR}/AppIcon.icns" "${APP_DIR}/Contents/Resources/AppIcon.icns"
cp "${DESKTOP_DIR}/Resources/Info.plist" "${APP_DIR}/Contents/Info.plist"
cp "${REPO_ROOT}/LICENSE" "${APP_DIR}/Contents/Resources/LICENSE"
plutil -replace CFBundleShortVersionString -string "${VERSION}" "${APP_DIR}/Contents/Info.plist"
plutil -replace CFBundleVersion -string "${VERSION}" "${APP_DIR}/Contents/Info.plist"
plutil -lint "${APP_DIR}/Contents/Info.plist" >/dev/null
printf 'APPL????' > "${APP_DIR}/Contents/PkgInfo"

log "Signing ($([[ "${CODE_SIGN_IDENTITY}" == "-" ]] && printf 'ad-hoc' || printf '%s' "${CODE_SIGN_IDENTITY}"))"
codesign --force --sign "${CODE_SIGN_IDENTITY}" "${APP_DIR}"
codesign --verify --strict "${APP_DIR}"

# A single verified artifact can return through The Fleet without losing the
# executable mode or the app bundle's directory structure.
ARCHIVE_PATH="${APP_DIR}.zip"
rm -f "${ARCHIVE_PATH}"
ditto -c -k --keepParent "${APP_DIR}" "${ARCHIVE_PATH}"
# Keep the scope and complete license beside the app in the distributable.
# This leaves the signed bundle itself unchanged.
python3 - "${ARCHIVE_PATH}" "${REPO_ROOT}" <<'PY'
from pathlib import Path
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1], 'a', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in ('LICENSE', 'LICENSING.md'):
        archive.write(Path(sys.argv[2]) / name, name)
PY

log "Done: ${APP_DIR} (${VERSION})"
log "Archive: ${ARCHIVE_PATH}"
cat <<EOF

Nothing was installed or started. The app is a client of the shared The Fleet
service: it finds the service's folder and command through the login service
(the-fleet service install), an installed the-fleet command, or its Settings.
Runtime needs on this Mac: Node 22.18+, Python 3 and SSH, with The Fleet
installed from its source folder (npm ci && npm link).
EOF

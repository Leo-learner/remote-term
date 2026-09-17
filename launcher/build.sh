#!/bin/bash
# Build RemoteTerm.app (menu bar shell + bundled agent) and install it to ~/Applications.
#   bash launcher/build.sh            build, sign and install (stops a running RemoteTerm: sessions end)
#   bash launcher/build.sh --check    build and sign in a temporary folder only
# The agent is copied into the bundle so it does not run code from the TCC-protected Desktop.
# Signing with an Apple Development identity keeps the Full Disk Access grant across rebuilds.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/RemoteTerm.app"
SUPPORT="$HOME/Library/Application Support/RemoteTerm"

npm --prefix agent install --omit=dev --no-audit --no-fund >/dev/null

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 launcher/RemoteTerm.swift -o "$APP/Contents/MacOS/RemoteTerm"
cp launcher/Info.plist "$APP/Contents/Info.plist"
rsync -a --exclude package-lock.json --exclude '*.test.js' agent shared "$APP/Contents/Resources/"

IDENTITY="${CODESIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')}"
IDENTITY="${IDENTITY:--}"
# Native code inside the bundle (node-pty's module and its spawn helper) is signed first.
find "$APP/Contents/Resources" -type f \( -name '*.node' -o -name 'spawn-helper' \) -exec codesign --force --sign "$IDENTITY" {} \;
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
echo "built and signed with: $([ "$IDENTITY" = "-" ] && echo ad-hoc || echo "$IDENTITY" | sed -E 's/\(.*\)//')"

if [ "${1:-}" = "--check" ]; then
  exit 0
fi

mkdir -p "$SUPPORT"
NODE="$(command -v node)"
printf '{\n  "node": "%s"\n}\n' "$NODE" > "$SUPPORT/launcher.json"

pkill -x RemoteTerm 2>/dev/null || true
pkill -f "RemoteTerm.app/Contents/Resources/agent/index.js" 2>/dev/null || true
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/RemoteTerm.app"
ditto "$APP" "$HOME/Applications/RemoteTerm.app"

echo "installed ~/Applications/RemoteTerm.app (node: $NODE)"
echo "start it with: open ~/Applications/RemoteTerm.app"

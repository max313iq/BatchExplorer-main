#!/bin/bash
set -e

echo "=== BatchExplorer Full Auto - Desktop App Builder ==="
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "[1/4] Building shared packages..."
cd "$ROOT_DIR"
npm run build

echo ""
echo "[2/4] Building web bundle..."
cd "$ROOT_DIR/web"
npx webpack --env prod

echo ""
echo "[3/4] Copying app files..."
mkdir -p "$SCRIPT_DIR/app/resources"
cp -r "$ROOT_DIR/web/lib-umd/"* "$SCRIPT_DIR/app/"
cp -r "$ROOT_DIR/web/resources/"* "$SCRIPT_DIR/app/resources/"

echo ""
echo "[4/4] Installing Electron and packaging..."
cd "$SCRIPT_DIR"
npm install

echo ""
echo "=== Build complete! ==="
echo ""
echo "To run in dev mode:  cd electron-auto-app && npx electron ."
echo ""
echo "To package for your platform:"
echo "  Linux:    cd electron-auto-app && npx electron-builder --linux"
echo "  Windows:  cd electron-auto-app && npx electron-builder --win"
echo "  macOS:    cd electron-auto-app && npx electron-builder --mac"
echo ""
echo "Output will be in: electron-auto-app/release/"

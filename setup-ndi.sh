#!/bin/bash
# setup-ndi.sh — Prepare grandiose native addon with NDI SDK
# Run this after npm install to set up the NDI SDK files
# and patch grandiose so electron-builder doesn't re-run the broken ndi.js

set -e

NDI_SDK="/Library/NDI SDK for Apple"
GRANDIOSE="node_modules/grandiose"

echo "=== NDI SDK Setup ==="

# Check NDI SDK is installed
if [ ! -d "$NDI_SDK" ]; then
  echo "❌ NDI SDK not found at: $NDI_SDK"
  echo "   Download from: https://ndi.video/sdk/"
  exit 1
fi

echo "✅ Found NDI SDK at: $NDI_SDK"

# Create directory structure
mkdir -p "$GRANDIOSE/ndi/include"
mkdir -p "$GRANDIOSE/ndi/lib/mac-a64"
mkdir -p "$GRANDIOSE/ndi/lib/mac-x64"

# Copy headers and dylibs
cp "$NDI_SDK/include/"*.h "$GRANDIOSE/ndi/include/"
cp "$NDI_SDK/lib/macOS/"*.dylib "$GRANDIOSE/ndi/lib/mac-a64/"
cp "$NDI_SDK/lib/macOS/"*.dylib "$GRANDIOSE/ndi/lib/mac-x64/"

echo "✅ Copied NDI SDK headers and dylibs"

# Patch grandiose package.json to skip ndi.js on rebuild
# Replace "node ndi.js && node-gyp rebuild" with just "node-gyp rebuild"
if grep -q "node ndi.js" "$GRANDIOSE/package.json"; then
  sed -i '' 's/"install": "node ndi.js && node-gyp rebuild"/"install": "node-gyp rebuild"/' "$GRANDIOSE/package.json"
  echo "✅ Patched grandiose to skip ndi.js download"
else
  echo "✅ grandiose already patched (no ndi.js in install script)"
fi

echo ""
echo "Now run:"
echo "  npx @electron/rebuild     # for local dev"
echo "  npm run build              # for distribution"

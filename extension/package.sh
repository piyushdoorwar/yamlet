#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
zip="dist/yamlet-interceptor-$version.zip"
mkdir -p dist
rm -f "$zip"
cd extension
zip -q -r "../$zip" manifest.json background.js bridge.js confirm.html confirm.js popup.html popup.css popup.js icons fonts
cd ..
unzip -tq "$zip"

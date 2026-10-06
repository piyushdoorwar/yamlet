#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/yamlet-interceptor-0.1.0.zip
cd extension
zip -q -r ../dist/yamlet-interceptor-0.1.0.zip manifest.json background.js popup.html popup.css popup.js icons fonts
cd ..
unzip -tq dist/yamlet-interceptor-0.1.0.zip

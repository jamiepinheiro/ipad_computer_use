#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# != 1 ]]; then
  echo "Usage: bash ipad_app/scripts/install.sh DEVICE_ID" >&2
  exit 2
fi
xcrun devicectl device install app --device "$1" build/Build/Products/Debug-iphoneos/ipad_computer_use.app

#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
composer="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"
"$composer" ipad_computer_use/app_icon.icon --export-image \
  --output-file Broadcast/broadcast_icon.png --platform iOS \
  --rendition Default --width 180 --height 180 --scale 1

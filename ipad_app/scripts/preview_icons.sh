#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
composer="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"
if [[ ! -x "$composer" ]]; then
  printf '%s\n' 'Icon Composer is required. Select an Xcode installation that includes it.' >&2
  exit 1
fi
mkdir -p build/icon_previews
for rendition in Default Dark TintedLight TintedDark; do
  case "$rendition" in
    Default) name=default ;;
    Dark) name=dark ;;
    TintedLight) name=tinted_light ;;
    TintedDark) name=tinted_dark ;;
  esac
  "$composer" ipad_computer_use/app_icon.icon --export-image \
    --output-file "build/icon_previews/$name.png" --platform iOS \
    --rendition "$rendition" --width 512 --height 512 --scale 1
done

#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ARDUINO_DIRECTORIES_DATA="$PWD/.tools/arduino-data"
export ARDUINO_DIRECTORIES_DOWNLOADS="$PWD/.tools/downloads"
export ARDUINO_DIRECTORIES_USER="$PWD/.tools/sketchbook"
export ARDUINO_BUILD_CACHE_PATH="$PWD/build/arduino-cache"
if [[ -x .tools/arduino-cli ]]; then
  exec .tools/arduino-cli "$@"
fi
exec arduino-cli "$@"

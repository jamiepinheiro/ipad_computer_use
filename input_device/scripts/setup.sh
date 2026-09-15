#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/arduino.sh core update-index --additional-urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
bash scripts/arduino.sh core install rp2040:rp2040@6.1.0 --additional-urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json

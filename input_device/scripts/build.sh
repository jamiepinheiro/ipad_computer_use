#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
secret="${INPUT_DEVICE_SECRET:-}"
if [[ -z "$secret" ]]; then
  secret="$(node -e 'process.stdout.write(require("../control_server/config").readInputDeviceSecret())')"
fi
escaped="${secret//\\/\\\\}"
escaped="${escaped//\"/\\\"}"
printf '#pragma once\n#define INPUT_DEVICE_SECRET "%s"\n' "$escaped" > firmware/input_tool/GeneratedSecret.h
bash scripts/arduino.sh compile --libraries "$PWD/libraries" --fqbn rp2040:rp2040:seeed_xiao_rp2040:flash=2097152_65536 --output-dir build/firmware firmware/input_tool

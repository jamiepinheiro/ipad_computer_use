#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# != 1 ]]; then
  echo "Usage: bash input_device/scripts/flash.sh SERIAL_PORT" >&2
  exit 2
fi
bash scripts/arduino.sh upload --port "$1" --fqbn rp2040:rp2040:seeed_xiao_rp2040:flash=2097152_65536 --input-dir build/firmware firmware/input_tool

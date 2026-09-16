#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build_iphone
xcrun swiftc -parse-as-library ipad_computer_use/calibration_click_policy.swift \
  test/calibration_click_policy_harness.swift -o build_iphone/calibration_click_policy_harness
build_iphone/calibration_click_policy_harness

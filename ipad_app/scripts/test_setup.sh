#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
xcrun swiftc -parse-as-library -target arm64-apple-macosx14.0 \
  ipad_computer_use/DongleClient.swift ipad_computer_use/SharedConfiguration.swift \
  ipad_computer_use/SetupStatus.swift test/SetupStatusHarness.swift -o build/setup-status-harness
build/setup-status-harness

#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
xcrun swiftc -parse-as-library -target arm64-apple-macosx14.0 \
  ipad_computer_use/DongleClient.swift ipad_computer_use/RelayConnection.swift \
  Broadcast/FrameCapture.swift test/FrameHarness.swift -o build/frame-harness
build/frame-harness

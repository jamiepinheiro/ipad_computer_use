#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
xcrun swiftc -parse-as-library -target arm64-apple-macosx14.0 \
  ipad_computer_use/start_session_intent.swift test/session_launch_harness.swift \
  -o build/session_launch_harness
build/session_launch_harness

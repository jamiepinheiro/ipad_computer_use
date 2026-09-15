#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
xcrun swiftc -parse-as-library -target arm64-apple-macosx14.0 \
  ipad_computer_use/DongleClient.swift ipad_computer_use/RelayConnection.swift \
  test/RelayHarness.swift -o build/relay-harness
RELAY_NATIVE_TEST="$PWD/build/relay-harness" node --test ../control_server/test/*.test.js

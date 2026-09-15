#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Distribution configuration is separate from development signing.
if [[ -f ../.local/app_store.env ]]; then source ../.local/app_store.env; fi
: "${APP_STORE_TEAM_ID:?Set APP_STORE_TEAM_ID to your paid developer team ID}"
: "${KEY_RELAY_BUNDLE_ID:?Set KEY_RELAY_BUNDLE_ID to your registered app identifier}"
xcodebuild -project ipad_computer_use.xcodeproj -scheme ipad_computer_use \
  -configuration Release -destination generic/platform=iOS \
  -archivePath build/app_store/ipad_computer_use.xcarchive -derivedDataPath build \
  DEVELOPMENT_TEAM="$APP_STORE_TEAM_ID" KEY_RELAY_BUNDLE_ID="$KEY_RELAY_BUNDLE_ID" \
  SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD=NO SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD=NO \
  "$@" archive

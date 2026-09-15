# App Store release

## Build

The app and both extensions target iPad (`TARGETED_DEVICE_FAMILY = 2`).
Mac-designed-for-iPad and Vision-designed-for-iPad build support are disabled.
Also verify availability for those platforms in App Store Connect before release.

```sh
APP_STORE_TEAM_ID=YOUR_PAID_TEAM_ID KEY_RELAY_BUNDLE_ID=org.example.yourapp \
  bash ipad_app/scripts/archive.sh -allowProvisioningUpdates
```

The archive is created at `ipad_app/build/app_store/ipad_computer_use.xcarchive`.
Release builds enable Live Activity push and the production APNs entitlement.
The control server also needs APNs credentials for the release bundle identifier;
see [Live Activity setup](../../control_server/LIVE_ACTIVITY.md). Signing alone
does not enable delivery from the server.
The archive alone is not an App Store distribution export or upload. Automatic
distribution signing needs an authenticated developer account and App Store
profiles for the app, `.broadcast`, and `.session` identifiers. A distribution
certificate by itself is insufficient.

Keep development and distribution signing values in separate ignored files.
For local distribution builds, save `APP_STORE_TEAM_ID` and
`KEY_RELAY_BUNDLE_ID` in `.local/app_store.env`. Environment variables take
precedence over values in that file. Keep App Store record IDs and account
notes in `.local/` as well. Different bundle identifiers produce separate
installations and do not automatically migrate app data.

## Review and testing

- Paste `review_notes.txt` into App Review Information after completing the review-access arrangements.
- Paste `testflight_test_notes.txt` into the TestFlight testing information.
- Supply a pre-flashed XIAO RP2040, or agree a suitable hardware review arrangement with Apple.
- Supply the review server address, network access instructions, and controller instructions. Do not rely on a developer's private tailnet being accessible to Apple.
- Capture an end-to-end demonstration video using non-sensitive test content.

## Submission checklist

- Authenticate the paid developer team and export/validate the distribution build.
- Create/select the App Store Connect app with the matching bundle identifier.
- Confirm app name, version/build, category, age rating, countries, pricing, and release timing.
- Supply support and privacy-policy URLs, copyright, and reviewer contact details.
- Complete App Privacy and encryption/export-compliance questions accurately.
- Supply iPad screenshots of actual app use; do not use development error screenshots.
- Explain prominently in the listing that custom flashed hardware and a separately configured control server are required.
- Verify the Release build on hardware, including first launch and keychain configuration under the distribution team.
- Review the ReplayKit picker button-hierarchy compatibility workaround against Apple's public-API requirements before submission; do not claim guaranteed App Review acceptance.
- Upload, wait for processing, select the build, and submit for review.

`PrivacyInfo.xcprivacy` declares the app-local UserDefaults API usage and is
bundled in the app and broadcast extension. It does not replace App Store privacy
labels or a privacy policy. Screen content, input commands, and a persistent
installation identifier are sent to the configured control server. Disclosure
and retention statements must reflect the actual released service arrangement.

No submission or public release is performed by the archive script.

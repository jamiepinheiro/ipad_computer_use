# iPad app

The native client for the control server. It owns user consent, ReplayKit screen
capture, session lifecycle, the native calibration surface, and the optional
session Live Activity. It forwards encoded input to the attached input tool over
USB networking. It does not contain an agent or run the control server.

## Layout

- `ipad_computer_use/`: SwiftUI app, settings, session/status client, HTTP input-tool client.
- `Broadcast/`: ReplayKit extension, fresh-frame capture, background input transport.
- `SessionWidget/`: session Live Activity presentation.
- `ipad_computer_use.xcodeproj/`: all three build targets.
- `scripts/`, `test/`: build/install commands and Swift integration harnesses.

The app talks to the other components only through their documented HTTP and
WebSocket protocols. The diagnostics test harness runs against a simulated
input device and server, not the real iPad.

## Build and install

Use macOS with full Xcode and its command-line tools. The project targets iPad,
with a deployment target of iPadOS 17; physical testing has used iPadOS 26 on an
M-series iPad. Support on older iPadOS versions is not physically verified.

From the repository root:

```sh
cp ipad_app/.signing.env.example ipad_app/.signing.env
```

Set DEVELOPMENT_TEAM and KEY_RELAY_BUNDLE_ID to your team and unique app ID.
The broadcast and widget identifiers derive from the app ID. This ignored file
is local only; no personal team/account is embedded in the project. Existing
installations must keep their original identifiers to preserve app/keychain data.

```sh
bash ipad_app/scripts/build.sh -allowProvisioningUpdates
xcrun devicectl list devices
bash ipad_app/scripts/install.sh YOUR_IPAD_DEVICE_ID
```

Pair and trust the device, enable Developer Mode, and keep it unlocked during
installation. The app needs a valid Apple provisioning profile; this repository
does not provide credentials or pre-signed binaries. No Xcode UI is required to
run these commands. Build output is in this component's ignored `build/` folder.

## Session flow

First launch presents three required setup steps: attach the input tool, enter
and verify the control server URL, then run pointer calibration. The input check
requires a valid status response (`running`, `state`, and `hidReady`) and HID
readiness, regardless of the firmware's display name. Firmware does not advertise
a version, so this is not an exact version or full command-compatibility check.
Calibration starts after Apple's screen-sharing confirmation. Setup completion
is saved only after calibration succeeds; closing or stopping it allows retry.
Existing installations without a saved setup-completion flag also see this flow,
with their existing server address prefilled.

1. Attach the XIAO input tool and keep the iPad's internet/Wi-Fi connection.
2. Edit the control server address directly under its status row on the main page.
3. Tap Start Session, then confirm Start Broadcast in Apple's prompt.
4. Complete pointer calibration if needed. Use any iPad app during the session.
5. End Session to revoke new commands and request key/button release.

Recalibrate Pointer is also on the main page. Without an active session, it opens
screen-sharing confirmation first. Saving a different server during a session
requires ending that session through the explicit End Session and Save button.

The broadcast extension initiates `WS /device`; the iPad does not expose an
incoming server. Screenshots use the latest fresh ReplayKit frame, scaled to at
most 1280 pixels across. Protected content may not be capturable. Input targets
the foreground app; the transport does not know which field/button receives it.

Native calibration connects to port 8766 in local ws development, or `/native`
on the same wss origin in a TLS deployment. Retain the /device path in the saved
server address. The input tool remains reachable at http://172.31.254.1.

## Live Activity

One activity is created per session. The broadcast extension attempts updates
for Session active and Sending input, and ends it during cleanup. Disabled Live
Activities do not block sessions. Tapping the activity opens the app; there is
no unverified background Stop intent. It is not an always-visible overlay, and
is not an authoritative emergency stop indicator.

The foreground app updates the activity using confirmed control-server status.
On the development iPad, the broadcast extension reports no matching activity,
so its background update/end attempts are not reliable. After 20 seconds without
an update, the activity says Open app for current status rather than claiming
the session is still starting or active. Reliable suspended-app updates need
ActivityKit push notifications through APNs. The transport is implemented but
requires a paid-team push-enabled build and APNs credentials. See
[Live Activity push setup](../control_server/LIVE_ACTIVITY.md). Personal Team
builds retain the foreground-only behavior.
Background dismissal and narrow-layout visual verification are still pending.
The control server's device-status response includes `liveActivityUpdating` to
report whether the extension finds and updates its matching activity.

## Control Center and Shortcuts

On iPadOS 18 or later, open Control Center, enter edit mode, choose Add a Control,
and search for iPad Computer Use. Add its Start Session control. The app cannot
add controls to Control Center on your behalf.

Tapping the control opens the app, checks connections, and opens Apple's broadcast
confirmation. Confirm Start Broadcast to begin screen sharing. An already-active
session is reused; repeated taps do not create duplicate sessions. Missing
connection settings expand the main-page editor instead. Incomplete onboarding
must be finished first. The same Start Session action is
available in Shortcuts.

The foreground intent is included in both app and widget targets. It hands a
one-shot request to the app; no hardware input or screen capture starts in the
widget extension. The request remains pending until the foreground view checks
connections. Test the handoff with `bash ipad_app/scripts/test_session_launch.sh`.

## App icon

Automatic retries check only unhealthy connections; healthy rows stay steady.
During a session, server telemetry still updates quietly so session state stays
current. Pointer calibration shares the server status request but has its own
loading indicator. The refresh button checks all connections immediately.
Connection rows show a spinner while checks are in progress. The refresh button
immediately restarts checking, including during retry backoff. Failed server
checks back off from 4 to 30 seconds; a successful check restores the 2-second
status interval. Checks pause while the app is not active.

The public app name is iPad Computer Use. The existing bundle identifier,
keychain service, and URL scheme remain unchanged to preserve installed app
data and links.

The app uses a layered Icon Composer document for light, dark, and tinted
appearances. See [icon editing and previews](ICONS.md).

## Tests

```sh
bash ipad_app/scripts/test_relay.sh
bash ipad_app/scripts/test_frames.sh
bash ipad_app/scripts/test_setup.sh
```

These require macOS Swift tooling. The relay harness connects to temporary
loopback servers and verifies session authorization, forwarding, cancellation,
and confirmed input release. No user account or physical USB input is used.

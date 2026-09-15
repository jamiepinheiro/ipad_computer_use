# Live Activity push updates

The control server sends ActivityKit updates through Apple Push Notification
service (APNs). It needs a paid Apple Developer team: a Personal Team cannot sign
the Push Notifications entitlement. Normal development builds keep push disabled.

## Apple setup

1. Use an explicit app identifier with Push Notifications enabled in your paid
   developer team. It must match the iPad app's bundle identifier.
2. Create an APNs authentication key in that team's Certificates, Identifiers &
   Profiles portal. Keep the downloaded `.p8` outside the source tree. Record its
   Key ID and Team ID. Never share the key contents in a chat or commit it.
3. Set the paid team and bundle ID in `ipad_app/.signing.env`, then build:

```sh
LIVE_ACTIVITY_PUSH_ENABLED=YES bash ipad_app/scripts/build.sh -allowProvisioningUpdates
```

Debug builds use the development entitlement and sandbox APNs. Release defaults
to production; the actual provisioning profile's entitlement must match. The
app reports its environment when registering each activity's token.

## Control server setup

```sh
cp control_server/apns.example.json control_server/.state/apns.json
chmod 600 control_server/.state/apns.json
```

Replace the placeholders in that private file, restrict the `.p8` file to its
owner, and restart the control server. Alternatively supply `APNS_KEY_PATH`,
`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, and `APNS_ENVIRONMENT` to the server
process. APNs credentials are never sent to the iPad. Token registration happens
at `POST /session/live-activity` for the matching active device/session.

For a TLS deployment, route `/session/live-activity` alongside the existing
device/session endpoints. Do not log request bodies.

## Behavior and verification

Start a new session in the push-enabled app. The app requests a Live Activity
push token and registers it for the matching device/session. Token rotations are
registered automatically; foreground checks retry registration and refresh it
every minute. The widget extension does not send pushes or own credentials.

The `/device-status/<deviceID>` response includes
`liveActivityPush`: configured, registered, lastAcceptedAt, and error. An accepted
APNs request is not proof that the device displayed it; verify on the physical
iPad while the app is in the background, including input and end-session states.

Updates are coalesced to at most one per second, with low-priority freshness
updates every minute and a three-minute stale deadline. Very short input bursts
may be coalesced away. Apple can throttle delivery; a Live Activity is not an
authoritative emergency-stop indicator. Confirmed shutdown ends and dismisses
the activity; an unconfirmed shutdown leaves a warning for an hour.

Delivery failures back off to 60 seconds and never block input. Invalid device
tokens stop retrying. Tokens are held only in server memory. A server restart
invalidates sessions and registrations, so begin a new session. Abrupt crashes
cannot guarantee a final push; the stale deadline prevents indefinitely claiming
fresh status. No screenshots or keystroke contents are sent to Apple, only the
short session status.

Run `npm test --workspace control_server` for mocked APNs lifecycle tests.
Real delivery still requires Apple credentials and a correctly signed device
build. See [Apple's ActivityKit push guide](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications).

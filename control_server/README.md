# Control server

Routes ordered actions and screenshot requests to one permitted iPad session.
The iPad maintains an outbound WebSocket; requests complete only after its reply.
The server requires no USB access or Apple SDK. Node.js 20+ is required.

## Start

From the repository root, run `npm ci`, then:

```sh
npm run start:background --workspace control_server
npm run calibration:background --workspace control_server
npm run mcp:background --workspace control_server
```

For foreground service managers use `npm start --workspace control_server` and
`npm run calibration --workspace control_server` and
`npm run mcp --workspace control_server` as managed processes.
Logs, PIDs, captured frames, and calibration profiles live in
`.state/` inside this component. `CONTROL_SERVER_STATE_DIR` overrides that path;
both processes must use the same directory and configuration.
The input-device secret also lives there by default and is embedded into the
firmware by `input_device/scripts/build.sh`.

| Environment | Default |
| --- | --- |
| `PORT` | `8765` |
| `HOST` | `0.0.0.0` |
| `CALIBRATION_PORT` | `8766` |
| `MCP_HOST` | `127.0.0.1` |
| `MCP_PORT` | `8780` |
| `CONTROL_SERVER_STATE_DIR` | Component-local `.state/` |
| `INPUT_DEVICE_SECRET` | Generated in `.state/input_device_secret` |

The server is **single-device**, not general multi-client pub-sub. New clients
cannot displace an active device. Session permits are single-use and expire if
not claimed within two minutes. Server restart invalidates every session.

## Computer-use client

Run these on the server host after starting a session in the iPad app:

```sh
node control_server/client.js status
node control_server/client.js screen
node control_server/client.js send 'hello{ENTER}'
node control_server/client.js move 20 -10
node control_server/client.js click
node control_server/client.js scroll 3
node control_server/client.js actions control_server/examples/input_actions.json
node control_server/client.js computer_use control_server/examples/computer_use_actions.json
node control_server/client.js stop
```

`stop` cancels the current command; **End Session** in the app revokes the whole
session. Text goes to the focused app. Mouse movement is relative HID counts.
Screenshots are independent of actions and return a fresh captured frame.

The controller API is loopback-only and rejects browser origins. App-facing
routes have no app-layer password, so run them only on a trusted network or
behind a private transport such as Tailscale. [Wire protocol](PROTOCOL.md)

## Boundaries

- `server.js`, `sessions.js`: device connection, session permits, command/screen routing.
- `config.js`: shared private state directory and input-device secret management.
- `calibration/`: native-surface telemetry, calibration worker, validated profiles.
- `client.js`: CLI adapter for the HTTP computer-use API.
- `test/`: protocol-level tests using simulated clients and optional Swift harness.
- `ipad_input_device`: declared dependency supplying the low-level codec. No imports into another component's private source paths.

The server has two action layers. `POST /computer-use/actions` is the intended
MCP/agent-facing shape: type text, press key chords, and use screenshot-oriented
coordinates. The server compiles those actions into the input records that the
iPad forwards to the attached tool.

## MCP adapter

The no-auth MCP adapter listens on `http://127.0.0.1:8780/mcp` by default and
is intended for a private local transport such as OpenAI Secure MCP Tunnel. Keep
it loopback-only for public networks; only bind it to a Tailscale address when
the tailnet ACLs are the authentication boundary. The adapter exposes:

- `status`: reads connection/session/calibration state.
- `get_screen`: returns a fresh JPEG screenshot from the active broadcast.
- `issue_actions`: forwards high-level keyboard and pointer actions to
  `/computer-use/actions`.

Start it with:

```sh
npm run mcp:background --workspace control_server
```

Then point the tunnel client at:

```text
http://127.0.0.1:8780/mcp
```

For a Tailscale-native driver that can reach the host directly, run the same MCP
service on the tailnet IP instead:

```sh
MCP_HOST=100.x.y.z MCP_ALLOW_TAILNET=1 npm run mcp --workspace control_server
```

Use this MCP URL:

```text
http://100.x.y.z:8780/mcp
```

Do not publish that listener with Tailscale Funnel or a public reverse proxy.
There is no OAuth or bearer token in this mode; the private network is the
security boundary.

The MCP adapter calls the loopback controller API directly. It does not access
RP2040 hardware or iOS APIs directly. Absolute-looking
actions such as `move_to` and coordinate `click` are available through
`issue_actions`, but they need a known pointer origin. Calibration maps relative
HID counts to screen movement; it does not let the server observe the current
pointer location in arbitrary apps.

### MCP action shapes

The tool is deliberately strict so agents do not guess. `issue_actions` takes
one top-level object with an `actions` array. Key chords use a `press` action
whose `keys` value is an object, never an array:

```json
{
  "actions": [
    {"type": "press", "keys": {"key": "space", "modifiers": ["cmd"]}},
    {"type": "type_text", "text": "notes"},
    {"type": "press", "keys": {"key": "enter"}}
  ]
}
```

Pointer actions use screenshot coordinates from the latest `get_screen` result.
Include both `coordinateSpace` and the observed current `pointer` position when
sending absolute coordinates. The pointer below is an example; use the actual
position visible on your screenshot, not a guessed center:

```json
{
  "coordinateSpace": {"width": 1280, "height": 960},
  "pointer": {"x": 400, "y": 300},
  "actions": [
    {"type": "move_to", "x": 640, "y": 480},
    {"type": "click", "x": 640, "y": 480},
    {"type": "scroll", "dy": 80},
    {"type": "wait", "ms": 500}
  ]
}
```

`scroll.dy` is signed USB wheel units, not pixels or a target coordinate.
On the tested iPad, **positive scrolls down and negative scrolls up**. Settings
can reverse the direction. Small values such as 3 may barely move the content.
Move over the intended scrollable pane, try 80, wait for the animation, and call
`get_screen` separately to verify movement. At a boundary, repeating the same
sign will not help; check the opposite sign and the hovered pane. A `completed`
response confirms input execution, not that the app visibly scrolled.

Physical-device verification through MCP confirmed a batch of five `dy: 127`
reports moved a LinkedIn feed to later posts, and five `dy: -127` reports
returned to the starting content. Scroll distance is app-dependent; this is a
diagnostic observation, not a promise of a fixed pixel displacement.

Valid action names are `type_text`, `press`, `move_to`, `move_by`, `click`,
`mouse_down`, `mouse_up`, `drag`, `scroll`, and `wait`. Common invalid shapes
are rejected on purpose:

```json
{"type": "press", "keys": ["cmd", "space"]}
{"type": "press", "key": "space", "modifiers": ["cmd"]}
{"type": "drag_to", "x": 100, "y": 100}
```

## Hosting

Optional background Live Activity updates use APNs. See
[Live Activity push setup](LIVE_ACTIVITY.md) for paid-team signing, credentials,
and device verification. Push delivery never gates computer-use commands.

The server can run on a VPS, but raw ports are not public-internet endpoints.
Use a private network or authenticated tunnel and route `/device`,
`/device-status/`, `/session/start`, and `/session/end` to 8765, and `/native`
to 8766. Keep controller and calibration administration routes private. A
controller running elsewhere needs a protected transport to the server host;
none is bundled yet. Read [SECURITY.md](../SECURITY.md) before deploying.

Preserve `/native` when proxying calibration. With Tailscale Serve, keep the
control server and calibration service as separate upstreams:

```sh
tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:8765
tailscale serve --bg --https=443 --set-path=/native http://127.0.0.1:8766
```

This route is private to the tailnet; do not use Funnel to publish these
unauthenticated services.

The catch-all control route does not serve MCP. MCP is a separate service on
8780 and should either stay loopback-only for Secure MCP Tunnel or bind directly
to the tailnet IP with `MCP_ALLOW_TAILNET=1`. Test `/mcp` with a JSON-RPC
`initialize` POST, not a browser GET (which intentionally returns HTTP 405).
Tailscale clients must be on the permitted tailnet; external cloud clients need
a separately authenticated tunnel.

Test with `npm test --workspace control_server`. The Swift integration test is
run from `ipad_app/scripts/test_relay.sh` and is skipped in the Node-only suite.

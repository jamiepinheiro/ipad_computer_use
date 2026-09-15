# Control server protocol

There is no app-layer pairing password. Browser Origin requests are rejected.
Administrative routes below additionally require a loopback source; do not expose
them through a public reverse proxy. Run app-facing routes only on a trusted
network or behind a private transport such as Tailscale.

## App lifecycle (remote app access)

| Route | Body / result |
| --- | --- |
| `POST /session/start` | `{deviceID}` -> `{sessionID, state:"starting"}` |
| `POST /session/end` | `{deviceID, sessionID}` -> `{state}`; 202 indicates requested, not necessarily stopped |
| `GET /device-status/<deviceID>` | Connection, calibration, session state, input activity, Live Activity update status |
| `WS /device` | One iPad connection with a valid session permit |

IDs are UUIDs. A new session permit is device-bound, single-use, and expires
after 120 seconds. The iPad must send:

```json
{"type":"hello","name":"iPad Session","deviceID":"UUID","sessionID":"UUID","capabilities":["input","screen"]}
```

The server returns `{"type":"ready","inputDeviceSecret":"..."}` after accepting
the session. The app uses that secret for mutating requests to the attached
input device; the input device does not publish the secret from `/status`.

## Controller API (loopback only)

| Route | Body / result |
| --- | --- |
| `GET /status` | Connected device, capabilities, calibration, pending command |
| `GET /screen` | Fresh JPEG as base64, frameID, dimensions, timestamps, orientation |
| `POST /computer-use/actions` | High-level screenshot-coordinate input for MCP/agent callers |
| `POST /run` | `{sequence:"hello{ENTER}", delay:1}` |
| `POST /actions` | Low-level structured input for diagnostics and calibration |
| `POST /stop` | Cancel pending input; does not end the session |

Computer-use action variants:

```json
{
  "coordinateSpace": {"width": 1280, "height": 960, "units": "screen_pixels"},
  "pointer": {"x": 400, "y": 300},
  "actions": [
    {"type": "type_text", "text": "hello"},
    {"type": "press", "keys": {"modifiers": ["cmd"], "key": "space"}},
    {"type": "click", "x": 500, "y": 300, "button": "left"},
    {"type": "move_to", "x": 600, "y": 360},
    {"type": "drag", "from": {"x": 600, "y": 360}, "to": {"x": 800, "y": 360}},
    {"type": "scroll", "dy": -3},
    {"type": "wait", "ms": 250}
  ],
  "delay": 0
}
```

`coordinateSpace` defaults to screenshot pixels when coordinates are present;
`units:"ui_points"` may be used by native callers. Coordinate actions compile
through the saved calibration profile. `move_to` and coordinate `click` need a
known pointer origin, supplied by top-level `pointer` or earlier actions in the
same request. The server does not observe the pointer location in arbitrary apps.

Low-level structured action variants:

```json
[
  {"type":"keys","sequence":"abc"},
  {"type":"move","dx":10,"dy":-5},
  {"type":"click","button":"left"},
  {"type":"drag","dx":30,"dy":0,"button":"left"},
  {"type":"scroll","wheel":3},
  {"type":"wait","ms":250}
]
```

Top-level `delay` is controller convenience only; the server compiles it into
an initial wait record before sending input records to the iPad. The input
device protocol itself has no batch delay field.

At most one input request and one screenshot request may be pending. They can
run independently. Pointer input before calibration returns 428 with
`code: calibration_required`. Other input during calibration returns 409 with
`code: calibration_in_progress`. An internal device-bound permit authorizes
calibration test movements, not normal callers.

## WebSocket messages

- Server `ready`: `{type, inputDeviceSecret}` after session acceptance.
- Server `run`: `{type, id, hex}`. Timing is encoded as wait records inside `hex`.
- App replies `accepted`, then `completed` or `failed`, echoing `id`.
- Server `screen`: `{type, id}`. App replies `screenshot` with id, MIME type,
  base64 JPEG data, width, height, capturedAt (milliseconds), and frameID.
- Server `stop`: cancel the current action.
- Server `end-session`: revoke input, release keys/buttons, then close the session.
- App `session-ended`: `{type, stopConfirmed:true|false}` after cleanup.
- App `activity-status`: `{type, updating:true|false}` for Live Activity diagnostics.

Session end immediately rejects new commands. The server allows 15 seconds for
stop acknowledgment, then disconnects with an unconfirmed outcome. Timeouts,
disconnects, and partial failures must never be automatically replayed. A `done`
firmware/command result confirms report delivery, not the target app's effect.

## Native calibration

The second service accepts `WS /native` from the app on the same trusted
transport. The app sends viewport, pointer, click, start, and stop messages; the
service sends ready, target, ack, and run-progress messages. `/state` and
`/target` are loopback-only worker APIs. No browser calibration endpoint or MCP
calibration tool is included.

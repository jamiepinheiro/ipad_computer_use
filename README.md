# iPad Computer Use

Control an iPad through a tiny USB input tool. A native iPad app shares its screen
and forwards keyboard and mouse commands to a Seeed Studio XIAO RP2040, which
plays them back as real USB HID input.

USB-C iPhones are also supported; see [iPhone setup](#iphone-setup) for the
additional AssistiveTouch configuration.

![iPad Computer Use demo](docs/demo.gif)

## Three components

```text
Your client / agent
       | commands and screenshot requests
       v
control_server/  <------ WebSocket ------>  ipad_app/
                                              |
                                         HTTP over USB
                                              v
                                         input_device/
                                              |
                                         USB HID input
                                              v
                                            iPadOS
```

| Component | Owns | Does not own |
| --- | --- | --- |
| [Input device](input_device/README.md) | RP2040 firmware, HTTP input protocol, HID reports, input codec | Screenshots, sessions, agents |
| [Control server](control_server/README.md) | Session permits, action routing, screenshot requests, calibration profiles | Apple APIs or physical USB access |
| [iPad app](ipad_app/README.md) | User-started sessions, ReplayKit capture, Live Activity, forwarding input to the tool | Agent decisions or firmware builds |

The control server runs independently of the iPad and can be hosted on another
computer. The iPad initiates the connection; it does not need an incoming server.

## Security model

This project intentionally does **not** include an app-layer pairing password or
OAuth flow. Its security model relies on the control network being reachable
only by you. Run the control server locally, on a private network such as
Tailscale, or behind a reverse proxy/tunnel that already authenticates access.
Do not expose the raw control server, calibration server, or MCP adapter on the
public internet.

**Current scope:** one connected iPad, ordered high-level computer-use actions,
fresh screenshots, native pointer calibration, and a no-auth MCP
adapter that defaults to loopback with optional private Tailnet access. This is not yet a multi-client pub-sub
service. Low-level mouse deltas remain available for diagnostics, but MCP
callers should use the high-level schema.

## Quickstart

You need a **Seeed Studio XIAO RP2040**, a USB data cable, and an iPad or USB-C iPhone.
Physical testing has used an M-series iPad and an iPhone 17 Pro. Development needs Node.js 20+
and npm; firmware builds need Arduino CLI. Building/installing the iPad app
requires macOS, full Xcode with command-line tools, and Apple signing credentials.
You do not need to open the Xcode UI.

### 1. Install dependencies

From the project root:

```sh
npm ci
```

### 2. Prepare the input tool

Flash the XIAO with the input-tool firmware:

```sh
bash input_device/scripts/setup.sh
bash input_device/scripts/build.sh
bash input_device/scripts/arduino.sh board list
bash input_device/scripts/flash.sh /dev/cu.YOUR_XIAO_PORT
```

The build script creates or reads `control_server/.state/input_device_secret`
and embeds it into the firmware. Start the control server from the same checkout
or set `INPUT_DEVICE_SECRET` explicitly in both places.

Use the serial port listed for your XIAO. If automatic flashing fails, connect
the board while holding BOOT, release it, and copy
`input_device/build/firmware/input_tool.ino.uf2` to the `RPI-RP2` drive.
Only use this firmware on a XIAO RP2040. [Firmware details](input_device/README.md)

### 3. Start the control server

```sh
npm run start:background --workspace control_server
npm run calibration:background --workspace control_server
npm run mcp:background --workspace control_server
```

The device connection uses port **8765**; calibration uses **8766**. For this
quickstart, use a trusted Wi-Fi network and allow those ports through the host
firewall only when that network is private to you.

### 4. Install the iPad app

```sh
cp ipad_app/.signing.env.example ipad_app/.signing.env
```

Set your Apple team ID and a unique bundle ID in that local file, then:

```sh
bash ipad_app/scripts/build.sh -allowProvisioningUpdates
xcrun devicectl list devices
bash ipad_app/scripts/install.sh YOUR_IPAD_DEVICE_ID
```

The iPad must be paired, unlocked, and in Developer Mode. Installation can use
the paired wireless connection. [App setup and signing](ipad_app/README.md)
For iPhone, use its device ID in the same install command, then complete
[iPhone setup](#iphone-setup) before pointer calibration.

### 5. Start a session

1. Plug the input tool into the iPad and keep Wi-Fi connected.
2. Open **iPad Computer Use**. Follow setup: connect the input tool, enter `ws://YOUR_SERVER_IP:8765/device`, then complete pointer calibration. Later, edit the server directly on the main page.
3. Tap **Start Session**, then confirm **Start Broadcast** in Apple's prompt.
4. Run **Calibrate Pointer** if requested. Keep the calibration screen open until it finishes.

There is no App/Broadcast mode selection. A session enables both screenshots and
input. End Session revokes new commands and requests release of existing input.

### 6. Try it

On the control_server host:

```sh
node control_server/client.js status
node control_server/client.js screen
node control_server/client.js send 'hello'
```

The last command types into the **currently focused iPad field**; focus a test
note first. Screenshots are saved under `control_server/.state/` by default.
More actions and API examples are in the [control_server guide](control_server/README.md).

For ChatGPT/Codex through OpenAI Secure MCP Tunnel, point the tunnel at:

```text
http://127.0.0.1:8780/mcp
```

For an agent that is itself on your Tailnet, you can instead bind the same MCP
service to the host's Tailscale IP and use `http://TAILSCALE_IP:8780/mcp`.
Set `MCP_HOST=TAILSCALE_IP` and `MCP_ALLOW_TAILNET=1` for that mode. The MCP
adapter has no MCP-layer auth. Run the control server on a trusted host or
behind a private transport such as Tailscale or OpenAI Secure MCP Tunnel. There
is intentionally no app-layer pairing password.

## iPhone setup

Use the same firmware, control server, and app as for iPad. Before running the
app's pointer calibration:

1. Connect the flashed XIAO to the iPhone using a USB data cable. Keep Wi-Fi connected for access to the control server.
2. Open **Settings > Accessibility > Touch > AssistiveTouch** and turn **AssistiveTouch on**. Leave it enabled while using mouse input.
3. Under **Devices**, select **XIAO RP2040**, then **Customize Additional Buttons...**.
4. When asked to press a button on the pointer device, briefly press the XIAO's **BOOT** button while it is already connected and idle. The current firmware emits a left mouse click. Do not press RESET or hold BOOT while connecting; that enters the flashing workflow instead.
5. Assign **Button 1** to **Single-Tap**, as shown below. If Button 1 is already listed, edit its action directly.

<img src="docs/iphone_assistive_touch.png" alt="iPhone AssistiveTouch settings for XIAO RP2040, with Button 1 assigned to Single-Tap" width="360">

Apple's [AssistiveTouch guide](https://support.apple.com/en-gb/111794) provides
additional accessibility setup details.

Return to **iPad Computer Use**, enter your control server URL, and complete
pointer calibration. Confirm Apple's **Start Broadcast** prompt when asked.
Keep the calibration screen open and **do not touch the screen or press BOOT
during calibration**: AssistiveTouch delivers mouse clicks as touch events, so
manual taps can interfere with the measurements. Calibration automatically
moves the pointer, checks six target clicks, and saves the resulting profile
on the control server.

If the pointer moves but clicks fail, check both that AssistiveTouch is enabled
and that **Button 1 = Single-Tap**, then retry with the latest app build. If
Safari can open `http://172.31.254.1/status` but the app cannot reach the input
tool, check the app's **Local Network** permission under **Settings > Privacy &
Security > Local Network**.

## Development

```sh
npm test
bash input_device/scripts/test.sh
bash ipad_app/scripts/test_relay.sh
bash ipad_app/scripts/test_frames.sh
bash ipad_app/scripts/test_setup.sh
npm run release:check
```

Each component contains its own sources, scripts, tests, and documentation.
The server depends on the input device's exported JavaScript codec package;
the iPad app communicates over documented network protocols, not source imports.

## Before publishing

See [SECURITY.md](SECURITY.md) for network and session limitations, and
[THIRD_PARTY.md](THIRD_PARTY.md) for dependency notices. Original code uses the
[MIT License](LICENSE). Packages remain private to prevent accidental npm publication.
The Live Activity implementation builds, but its background update and dismissal
behavior still needs physical-device verification.

Secrets, signing configuration, toolchains, builds, screenshots, and retired
experiments are excluded by `.gitignore`. Retired local work is preserved in
`.local/archive/`, not in the release tree. Do not publish the entire working
directory as an unfiltered archive.

Run `npm run release:pack` to create the allowlisted source archive at
`.local/releases/ipad_computer_use_source.tar.gz`. It includes the license and
third-party notices, and excludes local credentials, screenshots, and builds.

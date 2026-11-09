# Ghost Jack

**Ghost Jack: the port agents jack into when they need eyes, ears and a mouth in meatspace. Glassmouth is the voice on the wire.**

![The Ghost Jack control page in its demo state: a dark neon deck with panels named Uplink, Eye, Neck, Chrome and Glassmouth, a wireframe camera model, and a "No carrier, the bridge is flatlined" banner.](docs/images/preview.jpg)

Ghost Jack gives AI agents (netrunners) a body in the meat world: a cheap network camera for an eye and ear, a neck that pans and tilts, and a speaker for a mouth, all run locally, with no cloud app. **Glassmouth** is the night-shift voice on the wire: one glass eye, a dozen voices ([the guide](docs/glassmouth.md)). The first supported chrome (hardware) is the Tethys 825-C (SKU TT000074), a $2 thrift-store camera.

**For strangers, in plain words:** this is a local program (the bridge) plus a web page (the deck) that controls a compatible network camera: see, listen, aim, turn on night vision and speak through its speaker. You need a compatible camera (so far only that model) on a private cable or network, a Mac (the bridge reads the camera's password from the macOS Keychain and uses macOS speech), Node and ffmpeg (the regular build is enough: tested with Homebrew `ffmpeg` 9.0.1; `ffmpeg-full` isn't needed). The bridge runs on your machine behind its own ICE (an access token); the hosted page is only its remote control and shows a demo when no bridge answers. The deck has a neon cyberpunk look: a live Eye panel with an on-screen display, a wireframe 3D camera model that turns to the estimated aim, a pan/tilt pad, night vision, zoom, camera settings, a "Glassmouth says" box, optional generated sound and a light theme. Every cryptic label has a plain-language sublabel.

## Quick start

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # uses an installed Chromium
security add-generic-password -s tethys-camera -a <device id> -w   # once: stores the camera's password
npm start                                          # http://127.0.0.1:8787; prints an access token once
```

Open `http://localhost:8787/`, paste the token and Jack in (Connect). Flatline means the bridge isn't running or the camera isn't answering. Details, the API and Tailscale: [docs/bridge.md](docs/bridge.md). Changes: [CHANGELOG](CHANGELOG.md). Licensed MIT ([LICENSE](LICENSE), [NOTICE](NOTICE.md)).

## Docs

- [The bridge and control page](docs/bridge.md): endpoints, say, the stream, Tailscale, GitHub Pages.
- [Finding the camera](docs/discovery.md): the dated log from "is the USB cable data?" to signing in, moving, streaming, listening and talking.
- [Glassmouth](docs/glassmouth.md), [voice relay plan](docs/voice-relay-plan.md), [room map plan](docs/room-map-plan.md).
- `tools/`: the original probes (`snapshot.mjs` saves one snapshot; `web-login-probe.mjs` records the web app's requests after sign-in). They read the same Keychain item `tethys-camera` (the name stays: it is this camera's credential) and need Playwright (`PLAYWRIGHT=<path>/playwright-core/index.mjs`).

## Ground rules

- The camera stays on an isolated cable (straight into the computer) unless I decide otherwise. No cloud account, no internet access.
- Look before touching: no logins, resets or firmware changes until the camera is identified and backed up.
- Never commit passwords, serial numbers, device IDs or full hardware addresses. The serial doubles as the camera's cloud ID.
- Never commit pictures, video or audio from the camera. They show my home and me; test captures stay local and get deleted after testing (`.gitignore` blocks the usual image, audio and video files).

## What's known about the camera

| | |
| --- | --- |
| Label | TETHYS, Model 825-C, SKU TT000074, DC 5V 1.2A |
| Ports | 5 V input (USB cable, power only), reset button, microSD slot, RJ45 Ethernet (100 Mbps) |
| Software | MIPC family (the maker's phone app); firmware v5.3.3.2101181516 (2021-01-18), internal model F300; web server "MWS 0.01", web app mipc v2n 8.1 |
| Network | Asks for DHCP; meanwhile uses a built-in address, 192.168.187.254 |
| Open ports | 80 (MIPC web app and the `ccm_*` API), 554 (RTSP: H.264 1080p and AAC 16 kHz; one connection per `ccm_play` address), 7010 (RTMP: stream, and the publish for talking), 7030 (the maker's rtdp; refuses TCP) |
| Maker's FAQ | Says local HTTP/RTSP video isn't supported and it works only through the MIPC app. In practice that's wrong: it all works locally once signed in. |
| Pan and tilt | Steps queue and run one after another, each with its own speed (`ptz0`); a step of 10 at speed 100 is a good nudge. Position is not reported. |
| Night vision | `mode` night (forced infrared) or automatic; no white light on this model. |
| Lens | Fixed: no optical zoom or focus (digital zoom only). |
| Speaker | AAC 16 kHz mono over an RTMP publish; the amp wakes on sound; one address per stream, one talker at a time; about 3.5% level through the filter chain. |
| Clock | No battery: resets to 1971 on power-up; the bridge can set it. |
| Microphone | `as0` / `dev3`, level 70. |

## Roadmap

1. Voice relay: agents ask, the camera speaks, the answer is heard and transcribed ([plan](docs/voice-relay-plan.md)).
2. Room map with re-sweep ([plan](docs/room-map-plan.md)).
3. MCP tools so agents can "jack in" (look, listen, aim, say).
4. Local TTS voices per agent (the `synthesize()` boundary in `src/say.mjs`).
5. Pan/tilt calibration on a tripod.
6. Check live-stream playback in Safari.
7. Set the clock automatically on connect after a power loss.

## Credits

The control page's 3D uses [three.js](https://threejs.org) (MIT), loaded from a CDN at run time and not bundled. See [NOTICE](NOTICE.md).

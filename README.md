# Tethys 825-C camera

A $2 thrift-store network camera (Tethys model 825-C, SKU TT000074) that I'm turning into a camera I can use locally: to watch my Pocket Player boards and the TV the Raspberry Pi drives, without the maker's cloud app.

This repository holds what I learn about the camera and any code I write for it. It's kept separate from my other projects.

- [Finding the camera on the network](docs/discovery.md): step-by-step troubleshooting, from "is the USB cable data?" to signing in and taking a snapshot, with what each step showed.
- `tools/snapshot.mjs`: saves one 1920 x 1080 snapshot over the local network (no cloud). `tools/web-login-probe.mjs`: records the web app's requests after sign-in.

- [The local bridge and control page](docs/bridge.md): `npm start` runs a token-protected local service (snapshot, aim, night vision, live stream) and a control page in `web/`; with Tailscale it can be reached from other devices.

Both read the device id and password from the macOS Keychain item `tethys-camera` and need Playwright (`PLAYWRIGHT=<path>/playwright-core/index.mjs`).

## Ground rules

- The camera stays on an isolated cable (straight into the computer) unless I decide otherwise. No cloud account, no internet access.
- Look before touching: no logins, resets or firmware changes until the camera is identified and backed up.
- Never commit passwords, serial numbers, device IDs or full hardware addresses. The serial doubles as the camera's cloud ID.
- Never commit pictures, video or audio from the camera. They show my home and me; test captures stay local and get deleted after testing (`.gitignore` blocks the usual image, audio and video files).

## What's known so far

| | |
| --- | --- |
| Label | TETHYS, Model 825-C, SKU TT000074, DC 5V 1.2A |
| Ports | 5 V input (USB cable, power only), reset button, microSD slot, RJ45 Ethernet (100 Mbps) |
| Software | MIPC family (the maker's phone app); firmware v5.3.3.2101181516 (2021-01-18), internal model F300; web server "MWS 0.01", web app mipc v2n 8.1 |
| Network | Asks for DHCP; meanwhile uses a built-in address, 192.168.187.254 |
| Open ports | 80 (login page titled "IPC"; `ccm_*` API with a snapshot URL and `ccm_play` stream setup), 554 (accepts connections; silent without a session) |
| Maker's FAQ | Says local HTTP/RTSP video isn't supported, and it works only through the MIPC app |

## Possible next steps

1. A small local service that stays signed in: snapshot, move, a fresh RTSP address per viewer, and audio clips; plus a little control page for manual use and an MCP server so an AI can look, listen and aim.
2. Pin down pan/tilt units and stopping (on a tripod).
3. Speaking through the camera: work out the RTDP upload (`ccm_talk`).
4. Set the camera's clock (`ccm_date_set`).

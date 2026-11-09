# The Ghost Jack bridge (the wire) and control page (the deck)

`src/server.mjs` keeps one signed-in session with the camera's own web page
(headless Chromium, through Playwright) and offers a small HTTP API; `web/` is a
static control page for it. The camera stays on its isolated cable; only this
service talks to it.

## Run it

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # once; uses Playwright's cached Chromium
npm start                                        # http://127.0.0.1:8787
```

It reads the device id and password from the macOS Keychain item `tethys-camera`
(the item keeps its old name because it is this camera's credential; see the
README) and needs ffmpeg at `/opt/homebrew/bin/ffmpeg` (`FFMPEG=` to change).

**Which ffmpeg:** the regular build is enough (tested with Homebrew's `ffmpeg`
9.0.1); `ffmpeg-full` isn't needed. The bridge uses only: the RTSP demuxer over
TCP, stream copy of H.264 and AAC into fragmented MP4, the AAC encoder (the
camera's speaker plays only AAC 16 kHz), the FLV muxer with RTMP output, and the
`highpass`, `lowpass`, `acompressor`, `volume`, `alimiter` and `concat` filters.
Check a build with `ffmpeg -hide_banner -encoders | grep aac` and
`ffmpeg -hide_banner -protocols | grep rtmp`. If both builds are installed,
Homebrew keeps `ffmpeg-full` out of the path, and
`FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg npm start` selects it.
Environment: `PORT` (8787), `HOST` (127.0.0.1), `CAMERA_IP` (192.168.187.254).
Open `http://localhost:8787/` for the page.

## The token (the ICE)

On first run the bridge creates `~/.config/ghostjack/token` (mode 0600) and
prints it once. Every `/api` route except `/api/hello` needs it, as
`Authorization: Bearer <token>`. The live stream and snapshots also accept
`?token=` because a `<video>` tag can't send headers; the page uses that for the
stream only. Delete the file to make a new token. A token left in the old
`~/.config/tethys-camera/` folder (the project's earlier name) is moved here on
the first start.

## Endpoints

| Route                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/hello`                                               | No token. `{ok:true}`; lets the page tell a bridge from nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/status`                                              | Night-vision mode (`auto` or `night`) and whether the IR is on now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/snapshot.jpg?profile=p0&crop=x,y,w,h`                | A JPEG (p0 is 1920x1080, p1 smaller). `crop` is fractions 0 to 1; the crop is scaled to 1280 wide (digital zoom; the lens has no optical zoom).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/move` `{dx,dy,speed}`                               | One small step; +dx right, +dy up. Clamped to 20 and 100, one per second (moves queue in the camera and a stop doesn't cancel them, so keep steps at 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/night` `{mode:'night'\|'auto'}`                     | Forced infrared, or automatic (the factory value).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/info`                                                | Read-only: type, software version, network, camera clock, SD card, image settings, microphone, alerts. Serial, MAC and nickname are left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/image` `{brightness,contrast,saturation,sharpness}` | Any of them (0-100; sharpness 0-10); the whole image conf is written back with only those changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/mic` `{level}`                                      | Microphone level 0-100.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /api/clock`                                              | Sets the camera clock (UTC) from this computer's time (`ccm_date_set`, no timezone field; the camera has no time source).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/voices`                                              | English voices installed on this Mac (`say -v '?'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/say` `{text, voice?, level?, rate?, chime?}`        | Speak through the camera's speaker. `text` up to 300 characters; `level` 0.01 to 0.08 (default 0.035); `rate` 90 to 220 words a minute (default 140); `chime` (default true) plays Glassmouth's attention cue first, at `chimeLevel` 0.004 to 0.0316 (peak amplitude, default 0.016, about -36 dBFS, cap -30 dBFS). **Levels are capped in the bridge** (`speechArgs`, right before ffmpeg, so no path bypasses it): the speaker is alarm-loud. Larger values are clamped and the response returns the values used. There is deliberately no alarm, siren or alert feature; the vendor's alert settings are read-only. Returns 202 `{id, status}`. 10 per minute. |
| `GET /api/say/:id`                                             | `queued`, `speaking`, `done` or `failed` (with `ahead`, how many lines wait first).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/stream`                                              | Live video and sound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Not implemented on purpose: Wi-Fi setup, reboot, factory restore, firmware
upgrade, disk format and password change. The page lists them as disabled ("not
enabled in this build").

## Say (Glassmouth's mouth)

Says wait in one queue in `src/say.mjs`, because the camera's speaker takes one
talker at a time. For each line the bridge renders speech with macOS `say` into
`captures/` (git-ignored, deleted afterward), asks the camera for a talk address
(`ccm_talk`, RTMP) and immediately publishes to it with ffmpeg: 1 s of silence,
the attention chime (the camera's amp wakes on sound), 0.4 s of quiet, the
speech normalized to -3 dBFS, 1.5 s of silence. Filter chain:
`highpass=f=300,lowpass=f=3000,acompressor=threshold=-20dB:ratio=3:attack=5:release=100,volume=<level>,alimiter=limit=0.5:level=disabled`;
AAC 16 kHz mono 64k. An address that is requested but never published to jams
the speaker until the camera is power-cycled, so the bridge never requests one
without publishing, and if the publish fails it still sends a short silent
publish to free the slot. `GJ_SAY_PACE=ahead|fast|re` picks how fast ffmpeg
sends (default `ahead`, a little faster than real time; see discovery.md).
Voices: the one function `synthesize()` in `say.mjs` is the boundary where local
voices (Pocket TTS, Kokoro) can be added later; it only has to write an audio
file ffmpeg can read.

## The stream format

Fragmented MP4 over chunked HTTP: ffmpeg reads a fresh RTSP address over TCP and
copies the camera's H.264 and AAC without re-encoding
(`-c copy -movflags frag_keyframe+empty_moov`). A `<video src>` plays it
directly in Chromium; it takes a few seconds to start because the first fragment
waits for a keyframe. Each client gets its own ffmpeg and its own RTSP address
(they work once); ffmpeg is killed when the client disconnects and when the
bridge exits. Headless WebKit did not start playback in testing, so Safari is
unchecked. The MJPEG fallback wasn't needed.

## Using it from another device (Tailscale, a longer wire)

```sh
tailscale serve --bg 8787
```

This gives `https://<mac>.<tailnet>.ts.net` for devices on your tailnet only.
Open that address (it serves the page too), or open the hosted page and type
that address and the token into the Bridge box. The bridge allows cross-origin
requests only from `https://lewismoten.github.io` and answers Private Network
Access preflights. Stop sharing with `tailscale serve reset`.

Who can reach it: the camera has no internet connection of its own (private
cable, no cloud account, no route out); only the bridge talks to it, behind its
access token (the ICE), and by default the bridge listens only on this computer
(127.0.0.1). With `tailscale serve`, your own Tailscale devices can reach the
bridge, and so the camera, over the internet through Tailscale's encrypted
network. It is only as private as your tailnet and the token.

**Warning: never use `tailscale funnel` (or port forwarding) for the bridge.**
That would put the camera's eye, ears and mouth on the public internet.

## GitHub Pages (the demo page)

`web/` is the source of the control page; the bridge serves it. GitHub Pages can
only serve the repository root or `/docs`, so `npm run pages` copies `web/` into
`docs/` (beside the Markdown notes) and that copy is committed. Run it after
changing anything in `web/`. In the repository: Settings, Pages, Deploy from a
branch, `main`, folder `/docs`. The hosted page starts in its demo state (no
bridge, nothing unplugged-looking is hidden) with the bridge address
`http://localhost:8787`; type the bridge address and token to use it with your
own running bridge. Browsers allow an https page to call `http://localhost`, but
not a plain-http address on your network; use Tailscale's https address for
other devices.

## The page's look and the 3D

`web/` is plain HTML, CSS and JavaScript (no build). The 3D extras load last,
from `scene.js`, which imports three.js 0.170.0 from cdn.jsdelivr.net; if that
fails or WebGL is missing, the page keeps its CSS grid and scanline look. The
neon floor behind the panels and the wireframe camera model render at about 30
fps, stop when the tab is hidden (the model also when off screen), and hold
still with `prefers-reduced-motion`. The model turns to an estimated pan/tilt
counted from the moves sent (the camera can't report its position); "Re-center
estimate" zeroes it. Sound (`sound.js`) is synthesized with Web Audio, off by
default, and starts only after a click. In a headless test, CPU and dropped
frames were the same with the 3D blocked, so the cost is software video
decoding, not the scene.

The page speaks in Glassmouth's voice ([guide](glassmouth.md)): status lines
like "Eye's open", "Lost the angle" and "Back in sight" always carry the plain
meaning too. "Who has the eye" shows You while this page is watching live and
Nobody otherwise, with a relay click (if sound effects are on). The Eye panel
has a working "Glassmouth says" box (text, voice, level, Speak; its status line
says "On air.", "Done. Said it." or "Line's busy.") above the disabled
placeholder for the [voice relay](voice-relay-plan.md).

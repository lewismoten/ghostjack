# The Ghost Jack bridge (the wire) and control page (the deck)

`src/server.mjs` keeps one signed-in session with the camera's own web page
(headless Chromium, through Playwright) and offers a small HTTP API; `web/` is a
static control page for it. In the recommended setup the camera sits on its own
isolated cable; only this service talks to it.

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

| Route                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/hello`                                                               | No token. `{ok:true}`; lets the page tell a bridge from nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/status`                                                              | Night-vision mode (`auto` or `night`) and whether the IR is on now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/snapshot.jpg?profile=p0&crop=x,y,w,h&width=n`                        | A JPEG (p0 is 1920x1080, p1 smaller). `crop` is fractions 0 to 1; the crop is scaled to 1280 wide (digital zoom; the lens has no optical zoom). `width` (64 to 1920) scales the result and keeps the aspect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/move` `{dx,dy,speed}`                                               | One small step; +dx right, +dy up. Clamped to 20 and 100, one per second (moves queue in the camera and a stop doesn't cancel them, so keep steps at 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/travel` `{dx,dy}`                                                   | One long step at full speed, for going to a saved shot or re-centering; clamped to 480 across and 190 up or down. Returns `{ms}`, the estimated trip (70 ms per unit, a guess); other moves get 429 until then, because the camera can't cancel it.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/travel/done`                                                        | The page saw the picture settle after a travel move: nudges are allowed again before the estimate runs out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/night` `{mode:'night'\|'day'\|'auto'}`                              | Forced infrared, forced color (experimental: the camera accepts it, but forcing day mode in the dark has not been confirmed to turn the infrared picture to color; see discovery.md), or automatic (the factory value).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/info`                                                                | Read-only: type, software version, network, camera clock, SD card, image settings, microphone, alerts. Serial, MAC and nickname are left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/probe?name=ccm_..._get`                                              | Read-only: one of the camera's own "get" messages (the allowed names are listed in the error for a wrong one), with identifiers, addresses and secrets masked. For finding out what the camera can do.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/image` `{brightness,contrast,saturation,sharpness}`                 | Any of them (0-100; sharpness 0-10); the whole image conf is written back with only those changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/picture`                                                             | Read-only picture settings: now, day and night sets, WDR, backlight, white balance, exposure, power-line frequency, sensor resolution and fps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/picture` `{brightness,contrast,saturation,sharpness,wdr,backlight}` | Same as `POST /api/image`, which stays; `wdr` and `backlight` are `true`/`false` or `"on"`/`"off"`. The reply is the new image settings read back. Restore what you change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/mic` `{level}`                                                      | Microphone level 0-100.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/clock`                                                              | Sets the camera clock (UTC) from this computer's time (`ccm_date_set`, no timezone field; the camera has no time source).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/voices`                                                              | English voices installed on this Mac (`say -v '?'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/say` `{text, voice?, level?, rate?, chime?}`                        | Speak through the camera's speaker. `text` up to 300 characters; `level` 0.01 to 0.05 (default 0.03); `rate` 90 to 220 words a minute (default 140); `chime` (default true) plays Glassmouth's attention cue first, at `chimeLevel` 0.004 to 0.0316 (peak amplitude, default 0.008, held at least 9 dB under the speech peak, cap -30 dBFS). **Levels are capped in the bridge** (`speechArgs`, right before ffmpeg, so no path bypasses it): the speaker is alarm-loud. Larger values are clamped and the response returns the values used. There is deliberately no alarm, siren or alert feature; the vendor's alert settings are read-only. Returns 202 `{id, status}`. 10 per minute. |
| `GET /api/record`                                                              | Recording state: `{max, recording}` (`max` is the length cap in seconds, `GJ_REC_MAX`, default 600).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/record/start`                                                       | Start recording the live stream to an MP4 in `captures/` (ffmpeg `-c copy`, H.264 and AAC, no re-encode). One at a time (409 if already recording). Returns 202 `{id, status, seconds, max}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/record/stop`                                                        | Stop and finish the file (faststart). Returns `{id, status: 'ready', seconds, bytes}`. A recording that reaches the cap finishes on its own (`capped: true`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/record/:id`                                                          | Download the finished MP4 (`Content-Disposition: attachment`, name `ghostjack-YYYYMMDD-HHMMSS.mp4`). 409 while it is still recording.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DELETE /api/record/:id`                                                       | Remove the file. The page does this after it has its copy; leftovers are also deleted when the bridge exits or starts. Recordings show the owner's home and are never committed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/say/:id`                                                             | `queued`, `speaking`, `done` or `failed` (with `ahead`, how many lines wait first).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/goto` `{pan, tilt, crop?, width?}` or `{shot}`                      | Agent API. One fast travel move to an absolute pan and tilt (the shared estimated units; clamped to the measured range when known, and to one travel move of 480 across and 190 up or down), waits until the picture settles, then returns a JPEG from the main stream. Headers `X-GJ-Pan`, `X-GJ-Tilt`, `X-GJ-Settled: 1\|0`. `shot: 1` to `9` goes to a saved shot. 429 inside a second of the last move.                                                                                                                                                                                                                                                                                |
| `POST /api/clip` `{seconds, width?, audio?}`                                   | Agent API. Records 1 to 30 s of the stream and returns an MP4 (H.264 scaled to `width`, default 640, re-encoded; at 1920 the video is copied; AAC audio only with `audio: true`). 409 if a recording or another clip is running.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /api/listen` `{seconds, format?}`                                        | Agent API. 1 to 30 s from the camera microphone, as 16 kHz mono WAV (default) or M4A. Shares the one-capture lock with clips and recording.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /api/play?level=&chime=&band=`                                           | Agent API. A raw audio body (`Content-Type: audio/*`, 2 MB, 30 s after decoding) played through the same queue, wake pulse, chime, normalizer, limiter and level cap as say. `band=0` skips the phone band filter. Returns 202 `{id, status}`; poll `GET /api/say/:id`. Counts toward the ten a minute.                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/ask` `{question, choices, other?, listen?, voice?, level?}`         | Agent API. Says the question and 2 to 4 choices, listens `listen` seconds (default 6, max 15), transcribes with `whisper-cli` (`GJ_WHISPER`, `GJ_WHISPER_MODEL`) and maps the words to a choice. Returns 202 `{id, status}`; 409 while another ask is open.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/ask/:id`, `GET /api/ask/pending`                                     | `{status: asking\|listening\|answered\|timeout\|failed, choice: a\|b\|c\|d\|other\|null, transcript}`; `pending` is the open ask for the page to show (`{id: null}` when none).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /api/ask/:id/answer` `{choice, text?}`                                   | Answer by button; the first answer, spoken or pressed, wins (409 after).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/stream[?profile=p1]`                                                 | The live stream as fragmented MP4 (H.264 and AAC copied). Low latency since 0.1.2: no input buffering, a short probe, and a fragment every 0.5 s (not only at keyframes, which come about every 4.8 s). `profile=p1` is the camera sub-stream (640x360, about 7 fps); the default is the 1080p main stream.                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/aim`                                                                 | The shared estimated aim: `{pan, tilt, panMin, panMax, tiltMin, tiltMax, updated}` in move units (10 per step); min and max are the neck range the page measured with Find limits, centered on 0. After a measured Find limits it also holds the lens: `fovH` and `fovV` (degrees, picture width and height) and `tiltDegPerUnit` (degrees of tilt per move unit), with two decimals. Kept in `~/.config/ghostjack/aim.json`, outside the repo.                                                                                                                                                                                                                                            |
| `POST /api/aim`                                                                | Store it (small whole numbers; `fovH`, `fovV` and `tiltDegPerUnit` may have two decimals and must be in a sane range; the page sends it after each change).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/shots`                                                               | The nine saved shots (slot 1 first): `{name, pan, tilt, crop}` or `null` for an empty slot (the page treats an empty slot as the center). Kept in `~/.config/ghostjack/shots.json`, outside the repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/shots`                                                              | Store all nine (names up to 24 letters, numbers and simple punctuation; positions in the same estimated units as the aim).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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

## Conversation (the ears and the mouth together)

`src/converse.mjs` runs while Lewis has it switched on (off by default). One
ffmpeg reads the camera microphone as raw 16 kHz PCM (`media.listenStream`,
which holds the same one-capture lock as clips and steps aside when a clip or
recording asks for the camera). `converse-core.mjs` cuts it into utterances by
energy (a noise floor that follows the room, 80 ms to start, 900 ms of quiet to
end, 20 s at most), whisper transcribes each (`ask.mjs`; or a loopback
`whisper-server`), and only those with a wake word become events in
`~/.cache/ghostjack/converse/inbox.jsonl` and `GET /api/converse/heard`. WAVs
are deleted as soon as they are transcribed. `GJ_CONVERSE_INBOX` moves the file.
`src/history.mjs` also keeps a readable transcript of both sides in
`history.jsonl` beside it (`GJ_CONVERSE_HISTORY`), served by
`GET /api/converse/history?since=&limit=`. The camera's own voice: the
microphone is muted while it speaks and for 2.5 s after
(`GJ_CONVERSE_GUARD_MS`), except that an echo gate watches for Lewis talking
over it (barge-in). Replies: `reply.mjs` and `say.mjs` (the next line is
synthesized while the last plays; `stopAll()` cuts the line on air). The agent's
side is in [agent-api.md](agent-api.md); the unmeasured parts are in
[converse-design.md](converse-design.md).

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

Who can reach it. Recommended: give the camera its own cable or an isolated
network with no route to the internet (that is how it is tested). If it sits on
your normal network or Wi-Fi it can talk to the maker's cloud, and anything on
that network can reach its web page. Ghost Jack itself doesn't connect the
camera to the internet. Only the bridge talks to it, behind its access token
(the ICE), and the bridge listens on 127.0.0.1 unless you share it. With
`tailscale serve`, your own Tailscale devices can reach it over the internet
through Tailscale's encrypted network, so it is only as private as your tailnet
and the token.

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
from `scene.js`, which imports the vendored three.js 0.170.0 (`web/vendor/`, no
network needed); if that fails or WebGL is missing, the page keeps its CSS grid
and scanline look. The neon floor behind the panels and the wireframe camera
model render at about 30 fps, stop when the tab is hidden (the model also when
off screen), and hold still with `prefers-reduced-motion`. The model turns to an
estimated pan/tilt counted from the moves sent (the camera can't report its
position); "Re-center estimate" zeroes it. Sound (`sound.js`) is synthesized
with Web Audio, off by default, and starts only after a click. In a headless
test, CPU and dropped frames were the same with the 3D blocked, so the cost is
software video decoding, not the scene.

The page speaks in Glassmouth's voice ([guide](glassmouth.md)): status lines
like "Eye's open", "Lost the angle" and "Back in sight" always carry the plain
meaning too. "Who has the eye" shows You while this page is watching live and
Nobody otherwise, with a relay click (if sound effects are on). The Eye panel
has a working "Glassmouth says" box (text, voice, level, Speak; its status line
says "On air.", "Done. Said it." or "Line's busy.") above the disabled
placeholder for the [voice relay](voice-relay-plan.md).

## The photo sphere and the fake room

Find limits also measures the lens (pan step shifts between 160 x 90 pictures,
pinhole math, pan anchored to 350 degrees). Every picture then paints a 2048 x
1024 sphere kept in the browser (`web/sphere.js`); the SPH key (O) opens the
three.js view (`web/sphereView.js`) with Sweep and panorama downloads.
`node tools/fake-room.mjs` is a fake bridge and room (a known 62 degree lens)
and `node tools/fake-room-test.mjs <outdir>` runs the whole thing headless,
offline and against that fake only, never the camera.

### Strip scan

The sphere view's **Strip scan** (`web/strips.js`, `web/stripView.js`) does not
trust the estimated pose. The camera turns in small steps (4 units); from each
settled picture it keeps a thin vertical strip from the middle (the part the
lens bends least), and each strip's x position is the sum of the sideways shifts
measured between the pictures (coarse on 160 x 90, refined at full size on the
central band). Real measurements: step shifts are uneven (a 10-unit step moved
the picture 5 to 13 px of a 320 px frame), and the first one or two steps after
a turn-around can move nothing (backlash). So a row starts with two throwaway
steps and a wall needs three still measurements in a row. Every row starts at
the left wall (a physical reference), so rows share x near 0 and only a small
refine (+-10 px at 640) corrects the offset. With **Rows** on, the scan never
uses the lens or the old limits: it steps down to the bottom wall by measured
vertical shift, scans a row, steps up until the measured shifts add up to 0.65
of the picture height (the next row goes above, since tilting up moves content
down), makes one fast trip back to the left wall, and stops at the top wall (up
to 8 rows). Rows near the top or bottom are narrower in pixels than the middle
one (a flat picture's pan shift shrinks with the cosine of the pitch). The
panorama lives in memory until you press Download panorama. While a scan runs
the sphere view does not follow the camera. Find limits uses the same wall test
(3 steps whose measured shift is about 0, after 2 backlash steps), with the
small-gray comparison only for blank views.
`node tools/strip-scan-test.mjs <outdir> [--rows [--quick]]` checks a row, or
Find limits plus a multi-row scan, against the fake room.

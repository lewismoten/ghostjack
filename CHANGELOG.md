# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [SemVer](https://semver.org/).

## [0.1.1] - 2026-11-08

Fixes from using the published page, then recording, Glassmouth's browser voice
and a livelier deck.

### Fixed

- Go live and Snapshot "did nothing" on the page: the "no carrier" placeholder
  was an SVG, and an SVG has no `hidden` property, so it was never hidden and
  sat on top of every snapshot and live picture. It is hidden with the attribute
  now.
- Live view from a public page (GitHub Pages) talking to the bridge on
  localhost: the stream is fetched with `fetch()` (token in the Authorization
  header, not in a URL) and played through a MediaSource, because browsers can
  block a `<video src>` to a private address that `fetch()` is allowed to reach.
  Same-origin pages and browsers without MediaSource keep the plain `<video>`.
- Failed requests now say so in the status line (blocked by the browser, bridge
  not running, local network access needed) instead of doing nothing.
- Speech through the camera speaker was nearly inaudible next to the chime: the
  phone-band filter and compressor ran after the speech was normalized and left
  it 6 dB under the chime's peak. Speech is now normalized after them, and the
  chime is held at least 9 dB under the speech peak.

### Added

- Record: a REC button with a blinking dot and timer on the picture. The bridge
  records an MP4 (`POST /api/record/start`, `POST /api/record/stop`,
  `GET /api/record`, `GET` and `DELETE /api/record/:id`; ffmpeg copies the
  stream, one recording at a time, capped at 10 minutes, `GJ_REC_MAX` to
  change). With no bridge recording and the live view playing, the browser
  records a WebM instead.
- Tape tab: saved snapshots and recordings kept only in this browser
  (IndexedDB), with thumbnails, view, download, delete, storage used and clear
  all. Snapshots get Save and Download.
- Glassmouth speaks in the browser: a "Voice" switch (off by default,
  remembered) next to Music and Sound effects, short dry lines for events
  (docs/glassmouth.md, "Lines"), always shown in the status line too.
- Foley made with Web Audio: shutter, shuffling, film projector or CRT warm-up
  for Go live, relay clacks, static, tape reels, a servo whir while aiming.
- Hold an arrow (or an arrow key) to keep aiming, one small step a second; an
  Aim speed setting (Fine, Normal, Fast) in the Deck tab.
- Drag the 3D camera model to turn it; on release the camera is sent toward that
  aim in small queued steps, and the model glows amber until the estimated
  arrival.
- A neon circuit-route animation for connecting, ending in the jacked-in moment
  (a plain progress label with reduced motion).
- Floating cables with traveling pulses above the grid floor, and a rare, soft,
  panning "light traveling" whoosh with an echo (Sound effects switch; still
  wires and no whoosh with reduced motion; never over Glassmouth's voice).
- Dials tab for camera adjustments, split from Rig (read-only camera info), so
  loading the info never moves the controls.

### Changed

- "Chrome" is now "Rig" everywhere in the page and docs (tab, headings, lines).
- Ambient music is half as loud; it ducks while Glassmouth speaks.
- Speech level cap is 0.05 (default 0.03) and the chime default is 0.008,
  because the speech peak is now about the level times 0.71.
- Tab order: Uplink, Rig, Dials, Glassmouth, Tape, Deck.

## [0.1.0] - 2026-11-08

First release: Ghost Jack, the port agents jack into when they need eyes, ears
and a mouth in meatspace.

### Added

- Local bridge (`npm start`, `src/server.mjs`): one signed-in session with the
  camera, a token-protected HTTP API on 127.0.0.1.
- Snapshot with digital zoom (`crop`), pan and tilt steps, night vision (forced
  infrared or automatic), image and microphone settings, setting the camera
  clock, read-only camera info.
- Live video and audio stream (H.264 and AAC copied, no re-encode).
- Say: speak through the camera's speaker (`POST /api/say`, `GET /api/say/:id`,
  `GET /api/voices`): queued one talker at a time, macOS voices, level and rate,
  an attention chime (`chime:false` skips it), a limiter, and a 1.5 s tail,
  rate-limited to 10 a minute.
- Speech and chime levels are capped (speech level 0.08, default 0.035; chime
  cap -30 dBFS, default -36 dBFS) because the speaker is alarm-loud; the
  response returns the clamped values.
- Cyberpunk control deck (an Eye panel with aim arrows over the video, a camera
  model inset and a say bar, beside tabs for Uplink, Chrome, Glassmouth and
  Deck, all on one screen, each with a plain-language sublabel) with a three.js
  camera model, optional generated sound (Web Audio, off by default), the
  "Glassmouth says" box and a disabled voice-relay placeholder.
- Demo state for GitHub Pages (`docs/` copy of `web/`), Tailscale instructions,
  and Glassmouth, the voice of the interface.
- Notes on how the camera was found and worked out (`docs/discovery.md`), plans
  for the voice relay and a room map.

### Known limits

- Only the Tethys 825-C (firmware 5.3.3) has been tried.
- Pan and tilt positions are estimated from the moves sent; the camera does not
  report them.
- Voice relay (agents asking and hearing answers) is planned, not built.
- Whether macOS speech plays without gaps on the camera speaker is judged by
  ear; see `docs/discovery.md`.
- After the camera speaks, its speaker amplifier stays on with a faint hiss
  audible up close; whether it times out is not yet known (it's gone after a
  power cycle).
- Safari playback of the live stream is unverified.

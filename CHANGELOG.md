# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [SemVer](https://semver.org/).

## [0.1.2] - 2026-11-09

### Fixed

- Speech through the camera works again: since 0.1.1 the bridge sent each line
  in a few milliseconds instead of at playback pace (the pacing applied only to
  the opening silence), so the camera played a short blip and dropped the rest.
  The bridge now mixes the line into one file and sends that at the pace.
- The aim pad no longer greys out an arrow because the estimated range says the
  camera is at a wall: estimated walls only show an amber hint, the range slides
  to fit when the camera keeps moving past it, and a wall is confirmed only
  after two moves in a row leave a detailed picture unchanged.
- Live video was 5 to 10 seconds late. The camera sends a keyframe about every
  4.8 s and the bridge only cut a fragment at each one, so the player always
  held at least a whole group of pictures. The bridge now cuts a fragment every
  0.5 s, reads the camera with no input buffering and a short probe, and flushes
  each fragment at once. Measured (camera's burned-in clock, read with OCR,
  against the computer's clock): the oldest picture in each fragment was 4.8 to
  5.0 s old when it arrived, now 0.2 to 0.7 s (the clock only has whole seconds,
  so plus or minus 1 s).
- The player stays at the live edge: it starts 0.3 s behind the newest picture,
  plays at 1.1x when more than 1.5 s behind until under 0.5 s, jumps to the edge
  when more than 4 s behind, and drops picture older than 30 s. Measured buffer
  lag in a 20 s run: 0.1 to 1.1 s.
- Speech: the first words were lost ("Words to wonder" played as "...onder")
  because the quiet chime (9 dB under speech) no longer woke the camera's
  amplifier. A separate wake pulse (130 ms, as loud as the speech peak, soft
  edges) now comes first, then half a second of silence, then the quiet chime,
  then the speech. It is sent with the chime off too.
- Glassmouth's browser line "Shift starts now. Line is live." sounded like a
  curse word, and "live" was read as the verb. All spoken lines were rewritten
  with no two-way words, no ellipses and nothing that can run together into
  something rude (docs/glassmouth.md has the rules and the lines), plus a small
  pronunciation map for spoken text.

### Added

- Saved shots: nine numbered buttons under the picture, like the preset keypad
  on a camera controller. A number goes to that shot's pan, tilt and zoom (an
  empty slot goes to the center); SET, then a number, saves the current view
  with a name. Keys 1 to 9 (number row or numpad) and S for SET. The bridge
  keeps them for agents and other browsers (`GET`/`POST /api/shots`).
- Going to a saved shot or re-centering moves in one fast trip instead of small
  steps a second apart (`POST /api/travel`). The page watches quick small frames
  for the picture to settle, then takes the snapshot and frees the controls,
  instead of waiting out the trip estimate. During the trip the 3D camera model
  turns along the path at the learned speed, toward a magenta reticle at the
  target whose amber ring fills as the trip goes (and blinks if the camera is
  late).
- Jack out (disconnect) and Forget the ICE (remove the saved token from this
  browser) in the Uplink tab.
- When not live, the Eye refreshes itself: a quiet snapshot after jacking in and
  after each move settles (held arrows snap once, at the end).
- Jacking out (or losing the line) leaves the last frame on screen in grayscale,
  like a dead feed; color returns on Jack in.
- Coming back flatlined shows the last known frame (a small copy kept only in
  this browser) in grayscale under a SIGNAL LOST bar with its age; Forget the
  ICE removes it.
- Stills (bank-camera mode) next to Snapshot: a quiet still every 1 s, 5 s, 10
  s, 30 s or 1 min while not live; each waits for the previous one; going live
  pauses it and jacking out stops it.

- Find limits (Dials tab, only when you press it): the page steps the neck to
  each end in steps of 10, comparing small pictures, and records the range
  (measured here: pan 48 steps, tilt 19 steps; 480 and 190 units). It shows
  progress and a Cancel button, and has step and time caps. With a range known,
  the arrows, arrow keys, hold-to-aim and 3D drag stop at each end, a small
  range indicator in the Eye header shows where the estimate sits (labeled
  estimated), and Re-center moves to the middle. While the live picture is
  playing, a step that changes nothing is treated as hitting a wall ("That's the
  wall."). The range and estimate are kept per bridge address in the browser and
  on the bridge (`GET` and `POST /api/aim`) so agents and other browsers share
  them.
- Live quality in Dials: 1080p, or Fast (the camera's smaller sub-stream,
  `GET /api/stream?profile=p1`). Recording and snapshots stay at full size.

### Changed

- The bridge's stream uses low-latency ffmpeg options (see Fixed).

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

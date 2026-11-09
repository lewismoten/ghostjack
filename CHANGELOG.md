# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [SemVer](https://semver.org/).

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

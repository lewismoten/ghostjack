# AGENTS.md

Notes for AI coding agents (and people) working on Ghost Jack. The README covers
what the project is; this file covers how to work on it without hurting the
camera, the room or the person in it.

## Privacy

- Never commit or print the camera's password, serial number, device ID or full
  hardware address. The serial doubles as the camera's cloud ID. Credentials
  come from the macOS Keychain item `tethys-camera` (account = device ID); read
  them in code, never echo them.
- Never commit pictures, video or audio from the camera. They show the owner's
  home and the owner. Test captures go in `captures/` (git-ignored) and are
  deleted when you're done. The README preview is a screenshot of the page's
  demo state, never a camera image.
- Before any release, sweep the whole history (`git log -p`) for the device ID,
  the password, hardware addresses, private paths (home folders, scratch
  folders) and media files.

## The camera

- The camera stays on an isolated cable in the owner's setup (straight into the
  computer, built-in address 192.168.187.254); don't change that or add Wi-Fi
  setup. That is a recommendation, not a limit of the code: on a normal network
  the camera could reach the maker's cloud. Only the bridge talks to it, behind
  its access token, and by default the bridge listens only on 127.0.0.1.
  `tailscale serve` shares it with the owner's own tailnet devices (reachable
  over the internet through Tailscale, so only as private as the tailnet and the
  token).
- Never use `tailscale funnel` or port forwarding for the bridge: that would put
  the camera's eye, ears and mouth on the public internet.
- Look before touching: no factory reset, firmware change, disk format, password
  change or reboot from code. Those stay disabled in the page.
- When you change a setting to test it, read it back and restore the original.
  Leave night vision on automatic (`mode: ''`) when you finish.

## Hard-won rules (see docs/discovery.md for why)

- **Moves queue.** Each pan/tilt step runs after the previous one, at its own
  speed, and a stop doesn't cancel it. Use small steps (10) at speed 100, at
  most one a second. The one exception is `POST /api/travel` (saved shots and
  re-center): one long step the bridge times and guards, because it can't be
  cancelled. Never send other big steps.
- **One talker at a time.** Never request a talk address (`ccm_talk`) without
  publishing to it right away: an unused address jams the speaker until the
  camera is power-cycled. A finished publish frees it.
- **The speaker is alarm-loud.** Keep speech and chime levels at or below the
  bridge's caps, test with one or two short lines only, and never add an alarm
  or siren feature. Someone is usually in the room.
- **Stream addresses work once.** Ask `ccm_play` again for every connection.
- **Each power-up resets the camera clock to 1971.** Set it from the computer's
  time when needed.

## Working on the code

- `web/` is the page source; `npm run pages` copies it into `docs/` for GitHub
  Pages. Commit both.
- Every cryptic cyberpunk label keeps a plain-language sublabel or aria-label.
  Check new UI with axe at 1440 and 390 wide, dark and light, with no horizontal
  scroll.
- Glassmouth's voice follows `docs/glassmouth.md`.
- Keep `docs/discovery.md` as a factual, dated log: add new findings; mark old
  ones as solved instead of rewriting them.
- Credit third-party code and AI tools in `NOTICE.md`.
- Don't push, tag remotely or publish without the owner's go-ahead.
- Before committing, run `npm run format` and `npm run lint` (`npm run check`
  verifies both). Prettier uses 80 columns and wraps Markdown prose. A commit
  that only reformats goes in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once in the clone.

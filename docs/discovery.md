# Finding the camera on the network

How I found out what the Tethys 825-C is and how to reach it, using a Mac and an
Ethernet cable. Each step says what to run, what it showed, and what it means.
Commands marked `sudo` need an administrator password.

The log runs from the first cable test (step 1) to signing in, snapshots,
moving, the live stream, listening and talking through the speaker (step 13).
Serial numbers, device IDs and the full hardware address are left out on
purpose.

## 1. Is the USB cable data or just power?

Plug the camera's USB cable into the computer and give it about 30 seconds to
boot (this one speaks when it's ready). Then list the USB devices:

```sh
ioreg -p IOUSB -w0 | grep -o '+-o [^<]*<class [A-Za-z]*'
```

(`system_profiler SPUSBDataType` shows the same, with more detail.)

**Result:** nothing new appeared, even after the camera booted and spoke. The
cable is power only, matching "DC 5V" on the label. It can't be a USB webcam.

## 2. Put it on an isolated cable

Connect an Ethernet cable from the camera straight to the computer's Ethernet
port (here a dock port, interface `en10`), not to the router. That keeps it off
the internet and the home network.

Find the interface and confirm the link:

```sh
networksetup -listallhardwareports
ifconfig en10 | grep -E "status|media|inet"
```

**Result:** `status: active`, `100baseTX <full-duplex>` (the camera's 100 Mbps
port). With no router on the cable, the Mac gave itself a self-assigned
169.254.x.x address.

## 3. Does it speak IPv6?

Ping every device on that cable at once:

```sh
ping6 -c 3 ff02::1%en10
```

**Result:** no answer from the camera. It doesn't use IPv6, so we need to learn
its IPv4 address.

## 4. Listen to what it says

Without a router, a camera usually asks for an address and announces itself.
Listening needs administrator rights, and sends nothing:

```sh
sudo tcpdump -i en10 -n -e -c 30
```

**Result:**

- DHCP requests twice a second from its hardware address (a locally assigned
  one, not a registered maker's ID). It wants an address and gets no answer.
- Broadcasts to UDP port 3703 **from 192.168.187.254**. So it already has a
  built-in address to fall back on.

## 5. Read its announcement

Give the computer an address on the camera's network, on that cable only (Wi-Fi
is unaffected), then look inside the broadcasts:

```sh
sudo ifconfig en10 alias 192.168.187.10 255.255.255.0
sudo tcpdump -i en10 -n -X -c 4 udp port 3703
```

**Result:** a text message,
`HelloRequest {_msysenv:{...}, Nick:"Camera-…", type:"IPC", sn:"…", XAddrs:"192.168.187.254", listen_port:0}`.
That's the MIPC app's own discovery protocol (port 3703, next to ONVIF's 3702
but not the same). It names the camera, its type (IPC, an IP camera) and its
serial.

## 6. Which ports are open?

These are just connection attempts, no administrator rights needed:

```sh
ping -c 2 192.168.187.254
for p in 21 22 23 80 81 443 554 1935 3702 5000 6668 7070 8000 8001 8080 8081 8088 8554 8899 9000 9527 10554 34567 37777 40000 49152; do
  nc -z -G 2 -w 2 192.168.187.254 $p >/dev/null 2>&1 && echo "OPEN $p"
done
```

**Result:** it answers ping (under 1.2 ms). **Port 80 and port 554 are open**,
which the maker's FAQ says shouldn't be.

## 7. What answers on those ports?

The web page's headers and title:

```sh
curl -s -D - -o page.html http://192.168.187.254/
grep -o -i 'title>[^<]*' page.html
```

**Result:** `Server: MWS 0.01`, a login page titled "IPC" that loads
`mipc.v2n.min.js?v2n.8.1.1508311025` (MIPC web app 8.1, built 2015-08-31).

RTSP's list of supported commands, without logging in:

```sh
printf 'OPTIONS rtsp://192.168.187.254:554/ RTSP/1.0\r\nCSeq: 1\r\n\r\n' | nc -w 8 192.168.187.254 554
```

**Result:** the connection opens, but no reply in 8 seconds. Port 554 may need a
stream path or a login first, or it may not be RTSP at all.

## 8. The browser can't reach it, but curl can

`curl http://192.168.187.254/` returned the page, yet Chrome just spun. A
headless Chromium run from Terminal also loaded it fine: a dark login page with
a language button, the user name already filled in (the camera's serial), a
password box and "Stay signed in".

**Cause:** macOS's Local Network privacy setting. Terminal (and anything run
from it) had permission to reach local devices; Chrome didn't.

**Fix (when the entry exists):** System Settings → Privacy & Security → Local
Network → turn on the browser, then quit it completely (Cmd+Q) and reopen. Type
the address with `http://`. If the browser still upgrades to https, allow the
insecure page (the camera has no https).

## 9. Chrome still fails: it switched to https

Chrome's error was
`https://192.168.187.254/ is unreachable. ERR_ADDRESS_UNREACHABLE`, with only
"provisional headers" in the network panel. Note the `https`: Chrome upgraded
the typed `http://` address, and the camera has no https (port 443 is closed).
Safari didn't upgrade and showed the login page. On this Mac there was no Local
Network entry under Privacy & Security to change, so the permission wasn't the
cause here.

**Fix:** `chrome://settings/security` → turn off **Always use secure
connections**, then type `http://192.168.187.254/` again (an Incognito window
helps if Chrome remembered the upgrade).

## 10. The printed password doesn't work

The login page fills in the user ID (the serial) by itself, but the password on
the label was rejected. A secondhand camera usually means the previous owner
changed it. Don't guess passwords. Hold the rear RESET button for about 10
seconds while it's powered (until it speaks or restarts) to restore factory
settings, including the printed password; firmware isn't touched. Afterward,
check whether the camera's built-in address changed (repeat step 4).

## 11. After logging in: version, and how the web app gets video

After a factory reset and a new password, the web page showed **software version
v5.3.3.2101181516** (built 2021-01-18) and **model F300** (the internal model;
the label says 825-C).

Port 554 stays silent for every stream path tried (`live/ch00_0`, `live/ch00_1`,
`11`, `12`, `onvif1`, `stream1`, `h264`, `ch0_0.h264`), and `/video.mjpg`,
`/video.mpeg` and `/snapshot.jpg` are 404. So there's no plain RTSP or MJPEG
address without a session.

The web app's script shows how it does it (it's served gzipped; unzip it first):

```sh
curl -s -o mipc.js.gz "http://192.168.187.254/scripts/mipc.v2n.min.js?v2n.8.1.1508311025"
gunzip -c mipc.js.gz > mipc.js
python3 -c "import re;d=open('mipc.js',encoding='latin-1').read();print(sorted(set(re.findall(r'ccm_[a-z_]+',d))))"
grep -o '.\{200\}ccm_pic_get.jpg.\{200\}' mipc.js
```

What it shows:

- It talks to the camera with `ccm_*` messages (111 of them: login, Wi-Fi, date,
  disk, devices and more).
- **Snapshot:** after `ccm_snapshot`, the picture is at
  `/ccm/ccm_pic_get.jpg?hfrom_handle=887330&dsess=1&dsess_nid=<session id>&dsess_sn=<device id>&dtoken=<token>`.
  The session id comes from signing in, and the token from the snapshot reply.
- **Live video:** `ccm_play` returns a stream address; the settings offer the
  protocols rtmp, rtsp, rtdp and mutp.
- VLC can't open `rtsp://192.168.187.254:554` ("Your input can't be opened"), as
  expected: the stream address only exists after a signed-in `ccm_play` request.
- The device id doesn't need storing: the camera announces it in its port-3703
  HelloRequest (step 5).

## 12. Signing in and taking a snapshot from a script

Rebuilding the web app's sign-in by hand would mean reimplementing its
Diffie-Hellman exchange (`cacs_dh_req`), MD5 password scrambling and session ids
(`cacs_login_req`). Instead, `tools/web-login-probe.mjs` opens the camera's own
page in a headless browser, types the password from the macOS Keychain, and
records the requests the page makes:

```sh
security add-generic-password -s tethys-camera -a <device id> -w   # once
PLAYWRIGHT=<path>/playwright-core/index.mjs node tools/web-login-probe.mjs out/probe
```

What it showed:

- Every message is a script request:
  `GET /ccm/<message>.js?hfrom_handle=…&d<field>=…` (for example
  `cacs_dh_req.js?…&dbnum_prime&droot_num&dkey_a2b&dtid`, then
  `cacs_login_req.js?…&dlid&dnid&duser&dpass&dsession_req&dparam…`). After
  sign-in each request carries `dsess`, `dsess_nid` and `dsess_sn`.
- On a direct connection the page fills in and locks the user name (the device
  id) itself; only the password is typed.
- After "Successful login" the page asks to configure Wi-Fi; skipping it is
  fine.

Then `ccm_snapshot` from inside the signed-in page:

- It needs the device id as `sess.sn` **and** a profile token, `token: "p0"`
  (main stream). Without them the reply is `ccm.system.err`.
- The reply is
  `{ ret: {code: ""}, uri: { url: ".../ccm/ccm_pic_get/-dtoken-p0_….jpg" }, token: "p0_…" }`.
- Fetching that `uri.url` as-is returns a 525-byte error. Fetching
  `/ccm/ccm_pic_get.jpg?hfrom_handle=887330&dsess=1&dsess_nid=<nid>&dsess_sn=<device id>&dtoken=<token>`
  returns the picture: **a 1920 x 1080 JPEG** (about 130 KB).
- The picture's on-screen clock read 1971: the camera has no time source on an
  isolated cable.

`tools/snapshot.mjs out/now.jpg` does all of this in one step. A snapshot
described back to me matched the room exactly (laptop, monitors, the blue
speaker on the shelf), so the picture is live, not cached. Colors run a little
warm.

## 13. Moving, live stream, listening and talking

All from inside the signed-in page (same `acs.send_msg` pattern as the snapshot,
with `sess: { nid, sn: <device id> }`).

**Pan and tilt: `ccm_ptz_ctl`** with `token: "ptz0"` (found by trying; the web
app never shows where it gets it):

```js
{ token: 'ptz0', trans: { pan_tilt: { x, y, space: '' }, _deprecated_zoom: { x: 0, space: '' } },
  speed: { pan_tilt: { x: 1, y: 1, space: '' }, _deprecated_zoom: { x: 0, space: '' } } }
```

- It replies "success" to anything, so check with snapshots before and after
  (compare them; a real move changes most of the picture).
- Small values (x = 0.1 or 0.5 with `space: ''`) did nothing visible.
- **Moves queue and run one after another; each carries its own speed.** `trans`
  is the step size and `speed` how fast it runs: x = 100 at speed 1 crawled for
  over a minute, while the same step at speed 100 ran fast. An all-zero command
  does not cancel a step that's already running, and a "down" sent during a long
  "up" ran only after the "up" finished.
- **A good nudge is a step of 10 at speed 100**: tilt down 10 then up 10 at
  speed 100 each took under 4 seconds, and the view came back close to where it
  started (positive y = up, negative y = down; positive x = right).
- `ccm_video_srcs_get` reports video source `vs0` (25 fps) and its image
  settings.

**Zoom and focus: none.** `_deprecated_zoom` steps of +10 and -10 at speed 100
were accepted but changed nothing measurable (picture difference 7.3 and 5.4,
about noise; no change in sharpness). The lens is fixed; the zoom and focus
fields are leftovers from the shared MIPC software. Digital zoom (cropping the
1080p picture) is the way to look closer.

**Live stream: `ccm_play`** with
`setup: { stream: 'RTP_Unicast', trans: { proto: 'rtsp' } }, token: 'p0'`
returns `rtsp://192.168.187.254:554/live/<device id>_p0_<random>` (also
`rtmp://…:7010/…` and the maker's `rtdp://…:7030/…`).

- `ffprobe -rtsp_transport tcp <url>` shows **H.264 1920x1080 video and AAC 16
  kHz mono audio**.
- **Each address works for one connection only**: probing it used it up, and
  ffmpeg then failed with "Invalid data found when processing input". Ask
  `ccm_play` again for each connection.
- The page must stay signed in while streaming.

**Listening:** a 6-second recording from that stream
(`ffmpeg -rtsp_transport tcp -i <url> -t 6 -map 0:a -c:a pcm_s16le listen.wav`),
transcribed locally with `whisper-cli` (large-v3), came back as the exact
sentence spoken near the camera. Level about -28 dB mean, -10 dB peak.

**Microphone and speaker settings:** `ccm_mic_get` returns one mic (`dev3`,
level 70, not silent). `ccm_speaker_get` with no arguments answers
`InvalidArgVal` (it needs a token still to be found; the speaker turned out to
take speech through `ccm_talk`, below, and `ccm_speakers_get` never answers).

**Night vision (infrared LEDs and IR-cut filter):** the image settings come from
`ccm_video_srcs_get` (`vss[0].extension.conf`) and are written back whole with
`ccm_img_set { token: 'vs0', conf }`. Relevant fields: `mode`, `light_mode`,
`day_or_night`, `red_or_white`, `ir_cut_filter_modes`, and separate `day` /
`night` brightness, saturation, contrast and sharpness.

- **`mode: "night"` forces night vision**: the picture turns black-and-white and
  the IR LEDs glow faint red. Confirmed by eye: set at 18:25:01, the red light
  came on; `mode: ""` at 18:25:14 turned it off and the picture returned to
  color. **`mode: ""` (the factory value) is automatic**: covering the lens with
  a hand also triggers night vision, with an audible click from the IR-cut
  filter. `mode: "day"` was accepted, but the next picture was still
  black-and-white; forcing day mode is unconfirmed.
- `day_or_night` reads as the current state (2 while in night vision, 1 in day);
  writing 0 or 3 stored 1, and writing 2 back didn't stick, so it isn't the
  switch.
- **No white light on this model:** with night vision on, writing
  `red_or_white: 1` was accepted but stored as 0, and only the red IR glow
  appeared (seen by eye 18:26:57 to 18:27:22).
- Write back the whole `conf` you read, with only the field you're changing
  altered, and restore the original afterward.

**Talking (working):** the camera's speaker plays **AAC, 16 kHz, mono, published
over RTMP**.

1. `ccm_talk` with
   `setup: { stream: 'RTP_Unicast', trans: { proto: 'rtmp' } }, token: 'p0'`
   returns `rtmp://192.168.187.254:7010/pub/<random>`.
2. Publish to it:
   `ffmpeg -re -i speech.wav -c:a aac -ar 16000 -ac 1 -b:a 32k -f flv <url>`.
3. Start with about 3 seconds of silence: the camera begins playing late and
   cuts off the first second or two.
4. **One talker at a time, one address per stream.** A finished publish frees
   the slot, and the next `ccm_talk` works right away. An address that's
   requested but never published to holds the slot until the camera restarts
   (`ccm.system.err` until then). So always publish to every address you
   request.

How it was found: `rtdp` (the web app's default) refused TCP on 7030 and ignored
plain RTP over UDP, and there's no ONVIF backchannel on the RTSP stream. The
vendor's site still hosts the 2013 Flash version of its media engine
(`http://www.mipcm.com/mme/mme.swf`; the camera's own copy and the native
plugins are gone). Its strings (`getMicrophone`, `publish_start`, `connectRTMP`)
showed the Flash player sends the microphone by publishing RTMP. Of five formats
tried with the same RTMP address flow (AAC 16 kHz, G.711 A-law and mu-law 8 kHz,
ADPCM SWF 22 kHz, Nellymoser 8 and 16 kHz), **only AAC 16 kHz played**: two
recordings made beside the camera and the camera's own microphone all caught
"Number one, AAC…" and nothing from the others. The speaker is loud and small. A
listening test of four versions (all understood) picked the clearest: slower
speech (~140 words a minute), a phone-band filter (high-pass 300 Hz, low-pass
3.4 kHz), gentle compression (threshold -20 dB, ratio 3) and 64 kbps AAC; even
at 30% level it was "still a bit loud" and bright. Default chain:
`highpass=f=300,lowpass=f=3000,acompressor=threshold=-20dB:ratio=3:attack=5:release=100,volume=0.15`,
adjustable later (superseded by the chain below). The speaker volume can't be
read or set (`ccm_speakers_get` doesn't answer).

**Clipping and gaps (2026-11-08, after the first bridge `say`).** Listening
found the ends cut off, some distortion and silent gaps mid-speech. Fixes in
`src/say.mjs`: 1.5 s of silence after the speech (the camera finishes its buffer
before the publish closes); the macOS `say` render is normalized to -3 dBFS peak
before the chain; a true-peak limiter last (`alimiter=limit=0.5`, about -6 dBFS;
offline check: max volume -29 dB at level 0.12); default level 0.07. For the
gaps, `-re` (exactly real time) is suspected of underrunning the camera's
buffer, so two variants were tried through the camera: **variant one**
`-readrate 1.05 -readrate_initial_burst 2` (a little faster than playback, 2 s
head start, plus `-flush_packets 1 -flvflags no_duration_filesize`) and
**variant two** no rate limit at all (`GJ_SAY_PACE=fast`). Both published and
finished; which one plays without gaps is decided by ear (result below once
heard). Final chain:
`highpass=f=300,lowpass=f=3000,acompressor=threshold=-20dB:ratio=3:attack=5:release=100,volume=<level>,alimiter=limit=0.5:level=disabled`,
AAC 16 kHz mono 64k, 3 s lead-in, 1.5 s tail. `GJ_SAY_PACE=ahead|fast|re` picks
the pacing (default `ahead`).

**Wake sound and hiss (2026-11-08).** The camera's amp wakes on sound: silence
does not wake it, so the first syllable was lost. The say pipeline now plays a 1
s lead-in, then a short attention cue (a 30 ms relay click and a two-tone chime,
880 then 1320 Hz, about -18 dBFS), 0.4 s of quiet, the speech, and the 1.5 s
tail; `chime:false` skips the cue. Result of the cue: one test say reached
`done`; whether the first syllable now comes through is judged by ear. Known
quirk: after the camera speaks, its speaker amplifier stays on with a faint hiss
audible up close. It appears only after a talk session (never after a fresh boot
before any talk), it has happened every time, and it is gone after a power
cycle. No talk connection stays open on our side (no ffmpeg, no TCP to port
7010), and there is no ccm stop message: a session ends by closing the stream.
Whether the hiss times out is not yet known.

**Volume defaults (2026-11-08).** The first chime (-18 dBFS) and level 0.12 were
"very loud"; the speaker is probably alarm-grade (security cameras use loud
speakers to scare off intruders). Defaults now: chime peak 0.03 (-30.5 dBFS
offline), speech level 0.07 (peak -35 dBFS offline), speech normalized to -3
dBFS before the chain, `alimiter` with `level=disabled` (no makeup gain). Both
are API parameters (`level`, `chimeLevel`) and sliders on the page, and both are
hard-capped in the bridge (level 0.15, chime 0.063 = -24 dBFS).

**Lower again (2026-11-08).** Still loud, so the final defaults are speech level
0.035 (cap 0.08) and chime peak 0.016 (-36 dBFS; cap -30 dBFS). Numbers only;
the pipeline is unchanged.

## Cleaning up

Remove the extra address when done:

```sh
sudo ifconfig en10 -alias 192.168.187.10
```

## Next (written at step 1; done since: steps 11 to 13, then the bridge in `docs/bridge.md`)

Log in to the web page with the password printed on the camera, from the
isolated cable, and look for a stream address and the firmware version. See the
README for the steps after that.

## 14. Published-page bugs found in 0.1.1 (2026-11-08)

- **"Go live" and "Snapshot" did nothing from the hosted page.** Reproduced with
  headless Chromium on the real origin. Two findings. (a) The picture was
  fetched fine (status 200, a 1920 px image) but never seen: the "no carrier"
  placeholder is an `<svg>`, and `svg.hidden = true` only sets a plain JS
  property (SVG elements have no `hidden`), so it stayed on top of the picture.
  Fixed by setting the attribute. (b) Chrome's Local Network Access check blocks
  `fetch()` from a public page to localhost until the site is allowed
  ("Permission was denied for this request to access the loopback address
  space"; headless denies the prompt, so the test grants it). A `<video src>` to
  localhost also logs a mixed-content warning, so the live view now uses
  `fetch()` plus a MediaSource when the page is on another origin.
- **Speech sounded like a chirp.** The mix measured: chime peak -35.9 dBFS,
  speech peak -41.6 dBFS (mean -45 against -57). The phone band and compressor
  ran after the speech was normalized, taking about 9 dB off. Speech is now
  normalized after them (peak about -33.6 dBFS at the default), and the chime is
  held 9 dB under it (-42.6 dBFS).
- **Recording** copies a fresh RTSP address's H.264 and AAC into an MP4
  (checked: h264 and aac, a 4-second take). Recording while the live view is
  playing was not tested.

## 15. Live delay, the wake pulse and the neck's range (2026-11-09)

- **Keyframes come about every 4.8 s** (ffprobe on a 28 s capture of the main
  stream: keyframes at 0.0, 4.0, 8.9, 13.7, 18.5 and 23.3 s; 1920x1080 Main
  profile, about 12.5 fps). With a fragment cut only at each keyframe, a
  fragment arrived with its oldest picture 4.8 to 5.0 s old, and the player
  added to that: the ~10 s delay. With `-frag_duration 500000`,
  `-fflags nobuffer -flags low_delay -probesize 32k -analyzeduration 0` and
  `-flush_packets 1` the oldest picture in a fragment was 0.2 to 0.7 s old on
  arrival. Method: wall-clock arrival of each fragment against the camera's
  burned-in clock (OCR of the top-left text, the camera's clock offset taken
  from `/api/info`); the clock has whole seconds, so plus or minus 1 s. The
  sub-stream (`p1`) is 640x360 at about 7 fps with a keyframe much less often
  sampled; it plays, its delay was not measured.
- **The first words were lost** when the chime became quiet: the camera's amp
  wakes on sound above some level and spends the first syllables doing it. A
  wake pulse as loud as the speech, 130 ms, then 0.5 s of silence, then the
  quiet chime restores them. Levels per segment (offline): wake -33.5 dBFS,
  chime -42.6, speech -33.4. One real test line was played on 2026-11-09 at
  21:29:26 EST through the test bridge.
- **The neck's range** (Find limits, steps of 10 at speed 100, one every 1.3 s,
  small pictures to see when it stops): **pan 48 steps across, tilt 19 steps
  across** (480 and 190 units). If the pan travel is the camera's 350 degrees, a
  step of 10 is about 7.3 degrees. Tilt is then about 139 degrees if a step is
  the same size on both axes (not checked). The whole search took 200 s (122
  moves). What it cannot see: a featureless view looks the same moving or not,
  so it can stop early; a hand on the neck. Wall detection during normal use, on
  the live picture, was not exercised on the real camera.

---

Note (2026-11-08): this project became **Ghost Jack** (voice: Glassmouth). The
log above is left as it was written; the camera's Keychain item is still named
`tethys-camera`.

## 16. Speech lost to pacing (2026-11-09)

- **Symptom:** from 0.1.1 on, a say produced only a short sound ("a small
  sound", "…onder", then no words), and a job finished about 2 s after it was
  queued, too fast for a 5.5 s line.
- **Cause:** ffmpeg's `-readrate` (and `-re`) apply only to the input that
  follows them. 0.1.1 built the line from several lavfi inputs (silence, wake
  pulse, chime) plus the speech file, so only the 1 s lead-in was paced: the
  whole publish took 54 ms offline (517 ms with `-re`). The camera kept the
  first sound and dropped the rest.
- **Fix:** mix the line to a WAV first, then publish that single file with the
  pacing options in front of it: 3.3 s offline for the 5.5 s line (2 s burst,
  then 1.05x). The earlier level and wake-pulse conclusions were drawn while
  this bug was present, so they may need another listen.

## 17. How far a step really moves (2026-11-09, 00:10)

Measured on the real camera through the bridge: small (640x360) pictures scaled
to 320x180, the shift between consecutive pictures found by brute-force search.

- **Pan steps of 10 are small and uneven:** 7, 13, 12 and 5 px of 320 (about
  2.9% of the picture width on average). The earlier figure of about 7.3 degrees
  a step assumed the maker's 350 degrees over the 48 steps Find limits found;
  with steps this small, Find limits' "the picture stopped changing" test (on a
  32x18 gray) probably called walls too early, so the real pan travel is likely
  much larger than 48 steps (not yet measured).
- **Backlash:** after a change of direction, tilt steps of 10 moved 0, 0, then
  16 px of 180.
- **Long moves are proportional:** one fast trip of -40 after four steps of +10
  came back within 1 px of the start; -30 tilt within 2 px.
- **Pictures are not pure shifts:** the best match still differed by a mean of 7
  to 8 (of 255) against 0.6 between two still pictures, which fits a lens that
  bends lines toward the edges (and exposure changes).
- Consequence: placing pictures by the step count misplaces them (the repeated
  ceiling lights in the first photo sphere). Placement has to come from the
  pictures themselves; a strip scan (thin slices from the middle of each
  picture, placed by measured shift) is being built.

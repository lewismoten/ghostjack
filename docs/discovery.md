# Finding the camera on the network

How I found out what the Tethys 825-C is and how to reach it, using a Mac and an Ethernet cable. Each step says what to run, what it showed, and what it means. Commands marked `sudo` need an administrator password.

Serial numbers, device IDs and the full hardware address are left out on purpose.

## 1. Is the USB cable data or just power?

Plug the camera's USB cable into the computer and give it about 30 seconds to boot (this one speaks when it's ready). Then list the USB devices:

```sh
ioreg -p IOUSB -w0 | grep -o '+-o [^<]*<class [A-Za-z]*'
```

(`system_profiler SPUSBDataType` shows the same, with more detail.)

**Result:** nothing new appeared, even after the camera booted and spoke. The cable is power only, matching "DC 5V" on the label. It can't be a USB webcam.

## 2. Put it on an isolated cable

Connect an Ethernet cable from the camera straight to the computer's Ethernet port (here a dock port, interface `en10`), not to the router. That keeps it off the internet and the home network.

Find the interface and confirm the link:

```sh
networksetup -listallhardwareports
ifconfig en10 | grep -E "status|media|inet"
```

**Result:** `status: active`, `100baseTX <full-duplex>` (the camera's 100 Mbps port). With no router on the cable, the Mac gave itself a self-assigned 169.254.x.x address.

## 3. Does it speak IPv6?

Ping every device on that cable at once:

```sh
ping6 -c 3 ff02::1%en10
```

**Result:** no answer from the camera. It doesn't use IPv6, so we need to learn its IPv4 address.

## 4. Listen to what it says

Without a router, a camera usually asks for an address and announces itself. Listening needs administrator rights, and sends nothing:

```sh
sudo tcpdump -i en10 -n -e -c 30
```

**Result:**

- DHCP requests twice a second from its hardware address (a locally assigned one, not a registered maker's ID). It wants an address and gets no answer.
- Broadcasts to UDP port 3703 **from 192.168.187.254**. So it already has a built-in address to fall back on.

## 5. Read its announcement

Give the computer an address on the camera's network, on that cable only (Wi-Fi is unaffected), then look inside the broadcasts:

```sh
sudo ifconfig en10 alias 192.168.187.10 255.255.255.0
sudo tcpdump -i en10 -n -X -c 4 udp port 3703
```

**Result:** a text message, `HelloRequest {_msysenv:{...}, Nick:"Camera-…", type:"IPC", sn:"…", XAddrs:"192.168.187.254", listen_port:0}`. That's the MIPC app's own discovery protocol (port 3703, next to ONVIF's 3702 but not the same). It names the camera, its type (IPC, an IP camera) and its serial.

## 6. Which ports are open?

These are just connection attempts, no administrator rights needed:

```sh
ping -c 2 192.168.187.254
for p in 21 22 23 80 81 443 554 1935 3702 5000 6668 7070 8000 8001 8080 8081 8088 8554 8899 9000 9527 10554 34567 37777 40000 49152; do
  nc -z -G 2 -w 2 192.168.187.254 $p >/dev/null 2>&1 && echo "OPEN $p"
done
```

**Result:** it answers ping (under 1.2 ms). **Port 80 and port 554 are open**, which the maker's FAQ says shouldn't be.

## 7. What answers on those ports?

The web page's headers and title:

```sh
curl -s -D - -o page.html http://192.168.187.254/
grep -o -i 'title>[^<]*' page.html
```

**Result:** `Server: MWS 0.01`, a login page titled "IPC" that loads `mipc.v2n.min.js?v2n.8.1.1508311025` (MIPC web app 8.1, built 2015-08-31).

RTSP's list of supported commands, without logging in:

```sh
printf 'OPTIONS rtsp://192.168.187.254:554/ RTSP/1.0\r\nCSeq: 1\r\n\r\n' | nc -w 8 192.168.187.254 554
```

**Result:** the connection opens, but no reply in 8 seconds. Port 554 may need a stream path or a login first, or it may not be RTSP at all.

## 8. The browser can't reach it, but curl can

`curl http://192.168.187.254/` returned the page, yet Chrome just spun. A headless Chromium run from Terminal also loaded it fine: a dark login page with a language button, the user name already filled in (the camera's serial), a password box and "Stay signed in".

**Cause:** macOS's Local Network privacy setting. Terminal (and anything run from it) had permission to reach local devices; Chrome didn't.

**Fix (when the entry exists):** System Settings → Privacy & Security → Local Network → turn on the browser, then quit it completely (Cmd+Q) and reopen. Type the address with `http://`. If the browser still upgrades to https, allow the insecure page (the camera has no https).

## 9. Chrome still fails: it switched to https

Chrome's error was `https://192.168.187.254/ is unreachable. ERR_ADDRESS_UNREACHABLE`, with only "provisional headers" in the network panel. Note the `https`: Chrome upgraded the typed `http://` address, and the camera has no https (port 443 is closed). Safari didn't upgrade and showed the login page. On this Mac there was no Local Network entry under Privacy & Security to change, so the permission wasn't the cause here.

**Fix:** `chrome://settings/security` → turn off **Always use secure connections**, then type `http://192.168.187.254/` again (an Incognito window helps if Chrome remembered the upgrade).

## 10. The printed password doesn't work

The login page fills in the user ID (the serial) by itself, but the password on the label was rejected. A secondhand camera usually means the previous owner changed it. Don't guess passwords. Hold the rear RESET button for about 10 seconds while it's powered (until it speaks or restarts) to restore factory settings, including the printed password; firmware isn't touched. Afterward, check whether the camera's built-in address changed (repeat step 4).

## 11. After logging in: version, and how the web app gets video

After a factory reset and a new password, the web page showed **software version v5.3.3.2101181516** (built 2021-01-18) and **model F300** (the internal model; the label says 825-C).

Port 554 stays silent for every stream path tried (`live/ch00_0`, `live/ch00_1`, `11`, `12`, `onvif1`, `stream1`, `h264`, `ch0_0.h264`), and `/video.mjpg`, `/video.mpeg` and `/snapshot.jpg` are 404. So there's no plain RTSP or MJPEG address without a session.

The web app's script shows how it does it (it's served gzipped; unzip it first):

```sh
curl -s -o mipc.js.gz "http://192.168.187.254/scripts/mipc.v2n.min.js?v2n.8.1.1508311025"
gunzip -c mipc.js.gz > mipc.js
python3 -c "import re;d=open('mipc.js',encoding='latin-1').read();print(sorted(set(re.findall(r'ccm_[a-z_]+',d))))"
grep -o '.\{200\}ccm_pic_get.jpg.\{200\}' mipc.js
```

What it shows:

- It talks to the camera with `ccm_*` messages (111 of them: login, Wi-Fi, date, disk, devices and more).
- **Snapshot:** after `ccm_snapshot`, the picture is at `/ccm/ccm_pic_get.jpg?hfrom_handle=887330&dsess=1&dsess_nid=<session id>&dsess_sn=<device id>&dtoken=<token>`. The session id comes from signing in, and the token from the snapshot reply.
- **Live video:** `ccm_play` returns a stream address; the settings offer the protocols rtmp, rtsp, rtdp and mutp.
- VLC can't open `rtsp://192.168.187.254:554` ("Your input can't be opened"), as expected: the stream address only exists after a signed-in `ccm_play` request.
- The device id doesn't need storing: the camera announces it in its port-3703 HelloRequest (step 5).

## 12. Signing in and taking a snapshot from a script

Rebuilding the web app's sign-in by hand would mean reimplementing its Diffie-Hellman exchange (`cacs_dh_req`), MD5 password scrambling and session ids (`cacs_login_req`). Instead, `tools/web-login-probe.mjs` opens the camera's own page in a headless browser, types the password from the macOS Keychain, and records the requests the page makes:

```sh
security add-generic-password -s tethys-camera -a <device id> -w   # once
PLAYWRIGHT=<path>/playwright-core/index.mjs node tools/web-login-probe.mjs out/probe
```

What it showed:

- Every message is a script request: `GET /ccm/<message>.js?hfrom_handle=…&d<field>=…` (for example `cacs_dh_req.js?…&dbnum_prime&droot_num&dkey_a2b&dtid`, then `cacs_login_req.js?…&dlid&dnid&duser&dpass&dsession_req&dparam…`). After sign-in each request carries `dsess`, `dsess_nid` and `dsess_sn`.
- On a direct connection the page fills in and locks the user name (the device id) itself; only the password is typed.
- After "Successful login" the page asks to configure Wi-Fi; skipping it is fine.

Then `ccm_snapshot` from inside the signed-in page:

- It needs the device id as `sess.sn` **and** a profile token, `token: "p0"` (main stream). Without them the reply is `ccm.system.err`.
- The reply is `{ ret: {code: ""}, uri: { url: ".../ccm/ccm_pic_get/-dtoken-p0_….jpg" }, token: "p0_…" }`.
- Fetching that `uri.url` as-is returns a 525-byte error. Fetching `/ccm/ccm_pic_get.jpg?hfrom_handle=887330&dsess=1&dsess_nid=<nid>&dsess_sn=<device id>&dtoken=<token>` returns the picture: **a 1920 x 1080 JPEG** (about 130 KB).
- The picture's on-screen clock read 1971: the camera has no time source on an isolated cable.

`tools/snapshot.mjs out/now.jpg` does all of this in one step. A snapshot described back to me matched the room exactly (laptop, monitors, the blue speaker on the shelf), so the picture is live, not cached. Colors run a little warm.

## 13. Moving, live stream, listening and talking

All from inside the signed-in page (same `acs.send_msg` pattern as the snapshot, with `sess: { nid, sn: <device id> }`).

**Pan and tilt: `ccm_ptz_ctl`** with `token: "ptz0"` (found by trying; the web app never shows where it gets it):

```js
{ token: 'ptz0', trans: { pan_tilt: { x, y, space: '' }, _deprecated_zoom: { x: 0, space: '' } },
  speed: { pan_tilt: { x: 1, y: 1, space: '' }, _deprecated_zoom: { x: 0, space: '' } } }
```

- It replies "success" to anything, so check with snapshots before and after (compare them; a real move changes most of the picture).
- Small values (x = 0.1 or 0.5 with `space: ''`) did nothing visible.
- **Moves queue and run one after another; each carries its own speed.** `trans` is the step size and `speed` how fast it runs: x = 100 at speed 1 crawled for over a minute, while the same step at speed 100 ran fast. An all-zero command does not cancel a step that's already running, and a "down" sent during a long "up" ran only after the "up" finished.
- **A good nudge is a step of 10 at speed 100**: tilt down 10 then up 10 at speed 100 each took under 4 seconds, and the view came back close to where it started (positive y = up, negative y = down; positive x = right).
- `ccm_video_srcs_get` reports video source `vs0` (25 fps) and its image settings.

**Live stream: `ccm_play`** with `setup: { stream: 'RTP_Unicast', trans: { proto: 'rtsp' } }, token: 'p0'` returns
`rtsp://192.168.187.254:554/live/<device id>_p0_<random>` (also `rtmp://…:7010/…` and the maker's `rtdp://…:7030/…`).

- `ffprobe -rtsp_transport tcp <url>` shows **H.264 1920x1080 video and AAC 16 kHz mono audio**.
- **Each address works for one connection only**: probing it used it up, and ffmpeg then failed with "Invalid data found when processing input". Ask `ccm_play` again for each connection.
- The page must stay signed in while streaming.

**Listening:** a 6-second recording from that stream (`ffmpeg -rtsp_transport tcp -i <url> -t 6 -map 0:a -c:a pcm_s16le listen.wav`), transcribed locally with `whisper-cli` (large-v3), came back as the exact sentence spoken near the camera. Level about -28 dB mean, -10 dB peak.

**Microphone and speaker settings:** `ccm_mic_get` returns one mic (`dev3`, level 70, not silent). `ccm_speaker_get` with no arguments answers `InvalidArgVal` (it needs a token still to be found).

**Night vision (infrared LEDs and IR-cut filter):** the image settings come from `ccm_video_srcs_get` (`vss[0].extension.conf`) and are written back whole with `ccm_img_set { token: 'vs0', conf }`. Relevant fields: `mode`, `light_mode`, `day_or_night`, `red_or_white`, `ir_cut_filter_modes`, and separate `day` / `night` brightness, saturation, contrast and sharpness.

- **`mode: "night"` forces night vision**: the picture turns black-and-white and the IR LEDs glow faint red. **`mode: ""` (the factory value) is automatic**: covering the lens with a hand also triggers night vision, with an audible click from the IR-cut filter. `mode: "day"` was accepted, but the next picture was still black-and-white; forcing day mode is unconfirmed.
- `day_or_night` reads as the current state (2 while in night vision, 1 in day); writing 0 or 3 stored 1, and writing 2 back didn't stick, so it isn't the switch.
- `red_or_white` is 0 (probably infrared versus a white light, if the camera has one); not yet tested.
- Write back the whole `conf` you read, with only the field you're changing altered, and restore the original afterward.

**Talking (not working yet):** `ccm_talk` with `proto: 'rtdp'` returns an upload address `rtdp://192.168.187.254:7030/pub/<random>`; with `rtsp` or `rtmp` it returns nothing. The web app sends microphone audio to that address through a browser plugin, so speaking needs the maker's RTDP protocol worked out (the 826-x-ip-camera project documents this camera family and may help).

## Cleaning up

Remove the extra address when done:

```sh
sudo ifconfig en10 -alias 192.168.187.10
```

## Next

Log in to the web page with the password printed on the camera, from the isolated cable, and look for a stream address and the firmware version. See the README for the steps after that.

# Tethys 825-C

The first camera Ghost Jack supports: a pan/tilt indoor network camera sold as
the Tethys 825-C (SKU TT000074), bought for $2 at a thrift store. It's a
MIPC-family camera (Shenzhen Mining's platform), so other MIPC cameras may
behave the same; this page describes only what was tested on this unit.

## At a glance

|              |                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Label        | TETHYS, Model 825-C, SKU TT000074, DC 5V 1.2A                                                                                                                                                                |
| Ports        | 5 V input (USB cable, power only), reset button, microSD slot, RJ45 Ethernet (100 Mbps)                                                                                                                      |
| Software     | MIPC family (the maker's phone app); firmware v5.3.3.2101181516 (2021-01-18), internal model F300; web server "MWS 0.01", web app mipc v2n 8.1                                                               |
| Network      | Asks for DHCP; meanwhile uses a built-in address, 192.168.187.254                                                                                                                                            |
| Open ports   | 80 (MIPC web app and the `ccm_*` API), 554 (RTSP: H.264 1080p and AAC 16 kHz; one connection per `ccm_play` address), 7010 (RTMP: stream, and the publish for talking), 7030 (the maker's rtdp; refuses TCP) |
| Maker's FAQ  | Says local HTTP/RTSP video isn't supported and it works only through the MIPC app. In practice that's wrong: it all works locally once signed in.                                                            |
| Pan and tilt | Steps queue and run one after another, each with its own speed (`ptz0`); a step of 10 at speed 100 is a good nudge. Position is not reported.                                                                |
| Night vision | `mode` night (forced infrared) or automatic; no white light on this model.                                                                                                                                   |
| Lens         | Fixed: no optical zoom or focus (digital zoom only).                                                                                                                                                         |
| Speaker      | AAC 16 kHz mono over an RTMP publish; the amp wakes on sound; one address per stream, one talker at a time; about 3.5% level through the filter chain.                                                       |
| Clock        | No battery: resets to 1971 on power-up; the bridge can set it.                                                                                                                                               |
| Microphone   | `as0` / `dev3`, level 70.                                                                                                                                                                                    |

## How Ghost Jack talks to it

- **Sign-in:** the bridge opens the camera's own web page in a headless browser
  and lets it do the key exchange and login, then calls its `acs.send_msg`
  messaging with the session attached. Credentials come from the macOS Keychain
  item `tethys-camera`.
- **Snapshot:** `ccm_snapshot` (profile `p0` for 1920x1080), then
  `/ccm/ccm_pic_get.jpg` with the session.
- **Live stream:** `ccm_play` (RTSP) gives a one-time address; the bridge copies
  its H.264 and AAC into fragmented MP4.
- **Pan and tilt:** `ccm_ptz_ctl` with token `ptz0`.
- **Night vision and image settings:** `ccm_video_srcs_get`, then `ccm_img_set`
  with token `vs0`.
- **Speaking:** `ccm_talk` (RTMP), then an AAC 16 kHz publish with a wake chime
  and capped level.
- **Clock:** `ccm_date_set` (send it without a `timezone` field).

## Quirks

- The maker's FAQ says local video isn't possible; it is, once signed in.
- One talk address at a time, used once: an address that's requested but never
  published to jams the speaker until a power cycle.
- The speaker is alarm-loud, wakes on sound (the first syllable is lost without
  a chime), and hisses faintly up close after talking until the next power-up.
- Pan/tilt moves queue and a stop doesn't cancel them.
- Every power-up resets the clock to 1971.

## The full story

[docs/discovery.md](../discovery.md) is the dated, step-by-step log of how all
of this was found, from "is the USB cable data?" to the speaker working.

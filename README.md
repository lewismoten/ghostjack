# Tethys 825-C camera

A $2 thrift-store network camera (Tethys model 825-C, SKU TT000074) that I'm turning into a camera I can use locally: to watch my Pocket Player boards and the TV the Raspberry Pi drives, without the maker's cloud app.

This repository holds what I learn about the camera and any code I write for it. It's kept separate from my other projects.

- [Finding the camera on the network](docs/discovery.md): step-by-step troubleshooting, from "is the USB cable data?" to the camera's own announcement and open ports, with what each step showed.

## Ground rules

- The camera stays on an isolated cable (straight into the computer) unless I decide otherwise. No cloud account, no internet access.
- Look before touching: no logins, resets or firmware changes until the camera is identified and backed up.
- Never commit passwords, serial numbers, device IDs or full hardware addresses. The serial doubles as the camera's cloud ID.

## What's known so far

| | |
| --- | --- |
| Label | TETHYS, Model 825-C, SKU TT000074, DC 5V 1.2A |
| Ports | 5 V input (USB cable, power only), reset button, microSD slot, RJ45 Ethernet (100 Mbps) |
| Software | MIPC family (the maker's phone app), web server "MWS 0.01", web app mipc v2n 8.1 (built 2015-08-31) |
| Network | Asks for DHCP; meanwhile uses a built-in address, 192.168.187.254 |
| Open ports | 80 (web page titled "IPC"), 554 (accepts connections; no reply to a plain RTSP request yet) |
| Maker's FAQ | Says local HTTP/RTSP video isn't supported, and it works only through the MIPC app |

## Possible next steps

1. Log in to the local web page with the password printed on the camera, from the isolated cable, and see what it offers (stream address, settings, firmware version).
2. Try RTSP with that login and common stream paths.
3. If there's no local video, identify the chip (photos of the circuit board, markings, serial pads) and make a full flash backup before considering open firmware such as OpenIPC.

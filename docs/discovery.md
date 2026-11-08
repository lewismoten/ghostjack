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

**Result:** `Server: MWS 0.01`, a page titled "IPC" that loads `mipc.v2n.min.js?v2n.8.1.1508311025` (MIPC web app 8.1, built 2015-08-31).

RTSP's list of supported commands, without logging in:

```sh
printf 'OPTIONS rtsp://192.168.187.254:554/ RTSP/1.0\r\nCSeq: 1\r\n\r\n' | nc -w 8 192.168.187.254 554
```

**Result:** the connection opens, but no reply in 8 seconds. Port 554 may need a stream path or a login first, or it may not be RTSP at all.

## Cleaning up

Remove the extra address when done:

```sh
sudo ifconfig en10 -alias 192.168.187.10
```

## Next

Log in to the web page with the password printed on the camera, from the isolated cable, and look for a stream address and the firmware version. See the README for the steps after that.

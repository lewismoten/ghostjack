// Live view that works from a public page (GitHub Pages) talking to the bridge on localhost.
// Chrome's Private Network Access / Local Network Access rules and mixed-content checks can block a
// <video src="http://localhost/..."> subresource even when fetch() is allowed (fetch asks permission with a
// preflight the bridge answers). So the stream is fetched with fetch() (token in the Authorization
// header, never in a URL) and fed to a MediaSource. The bridge sends fragmented MP4: ftyp+moov, then
// moof+mdat fragments. The codecs string is read from the init segment (avcC and mp4a boxes).
// Same-origin pages, or browsers with no MSE for the stream, keep using <video src> (see canUse).

const u32 = (b, i) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const hex = (n) => n.toString(16).padStart(2, '0');

// Find 'needle' (4 ASCII chars) in bytes; returns the index or -1.
function find(b, needle) {
  for (let i = 0; i + 4 <= b.length; i++) if (tag(b, i) === needle) return i;
  return -1;
}
// 'video/mp4; codecs="avc1.PPCCLL,mp4a.40.2"' from an init segment (ftyp+moov), or null.
export function codecsOf(init) {
  const a = find(init, 'avcC');
  if (a < 0) return null;
  const avc = `avc1.${hex(init[a + 5])}${hex(init[a + 6])}${hex(init[a + 7])}`;
  const list = [avc];
  if (find(init, 'mp4a') >= 0) list.push('mp4a.40.2');
  return `video/mp4; codecs="${list.join(',')}"`;
}
// Splits a growing byte buffer into complete top-level boxes: pull() returns the complete ones.
export function boxer() {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      const n = new Uint8Array(buf.length + chunk.length);
      n.set(buf);
      n.set(chunk, buf.length);
      buf = n;
    },
    pull() {
      const boxes = [];
      let at = 0;
      while (buf.length - at >= 8) {
        const size = u32(buf, at);
        if (size < 8 || buf.length - at < size) break;
        boxes.push({
          type: tag(buf, at + 4),
          bytes: buf.subarray(at, at + size),
        });
        at += size;
      }
      buf = buf.slice(at);
      return boxes;
    },
  };
}

// Can this page use the fetch+MSE path? Cross-origin only; the browser must support MSE.
export const canUse = (base) => {
  try {
    return 'MediaSource' in window && new URL(base).origin !== location.origin;
  } catch {
    return false;
  }
};

// Starts the live view. Resolves { stop } once the first fragment is queued; rejects with an Error
// whose .unsupported is true when the browser cannot play this stream by MSE (the caller then falls
// back to <video src>). onError(message) is called if the stream dies later.
export async function start(video, url, token, onError) {
  const ac = new AbortController();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ac.signal,
  });
  if (!res.ok) {
    let msg = `the bridge answered ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const bx = boxer();
  const fail = (m) => {
    ac.abort();
    onError(m);
  };
  // Read until the init segment (ftyp + moov) is complete.
  const init = [];
  const pending = [];
  while (!init.some((b) => b.type === 'moov')) {
    const { done, value } = await reader.read();
    if (done) throw new Error('the stream ended before it started');
    bx.push(value);
    for (const b of bx.pull()) {
      if (b.type === 'ftyp' || b.type === 'moov') init.push(b);
      else pending.push(b);
    }
  }
  const initBytes = new Uint8Array(
    init.reduce((n, b) => n + b.bytes.length, 0),
  );
  let o = 0;
  for (const b of init) {
    initBytes.set(b.bytes, o);
    o += b.bytes.length;
  }
  const mime = codecsOf(initBytes);
  if (!mime || !MediaSource.isTypeSupported(mime)) {
    ac.abort();
    throw Object.assign(new Error('this browser cannot play the stream'), {
      unsupported: true,
    });
  }
  const ms = new MediaSource();
  const objUrl = URL.createObjectURL(ms);
  video.src = objUrl;
  await new Promise((r) =>
    ms.addEventListener('sourceopen', r, { once: true }),
  );
  const sb = ms.addSourceBuffer(mime);
  const queue = [initBytes];
  let stopped = false;
  const pump = () => {
    if (stopped || sb.updating || ms.readyState !== 'open') return;
    // Keep about 30 s behind the playhead at most, and stay close to the live edge.
    if (
      video.currentTime > 30 &&
      sb.buffered.length &&
      sb.buffered.start(0) < video.currentTime - 20
    ) {
      try {
        sb.remove(0, video.currentTime - 10);
        return;
      } catch {
        /* try again on the next update */
      }
    }
    const next = queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next);
    } catch (e) {
      if (e.name === 'QuotaExceededError' && video.currentTime > 2) {
        queue.unshift(next);
        sb.remove(0, video.currentTime - 1);
      } else fail(`the player refused the stream (${e.name})`);
    }
  };
  sb.addEventListener('updateend', () => {
    // Skip ahead if playback has fallen well behind the newest picture.
    if (sb.buffered.length) {
      const end = sb.buffered.end(sb.buffered.length - 1);
      if (end - video.currentTime > 4) video.currentTime = end - 0.5;
    }
    pump();
  });
  const add = (b) => {
    // A fragment is moof + mdat; append them together.
    queue.push(b.bytes);
    pump();
  };
  pending.forEach(add);
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return stopped || fail('the live stream ended');
        bx.push(value);
        for (const b of bx.pull()) add(b);
      }
    } catch (e) {
      if (!stopped) fail(`the live stream stopped (${e.message})`);
    }
  })();
  return {
    stop() {
      stopped = true;
      ac.abort();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objUrl);
    },
  };
}

// Recording from the page. Preferred: the bridge records an MP4 (ffmpeg copies the camera's H.264 and
// AAC, capped in length), and the page fetches it with fetch() (Authorization header, so it works from a
// public page like the live view) and keeps it in the Tape. Fallback, when the bridge cannot record
// (an older bridge, or the camera is busy) and the live view is playing: MediaRecorder on the <video>
// captureStream() makes a WebM. Either way one recording at a time and a length cap.
import * as tape from './tape.js';

const CAP_FALLBACK = 600; // seconds, same as the bridge's default

export function createRecorder({ api, video, isLive, on }) {
  let cur = null; // { mode, id, t0, timer, poll, rec, chunks, mime }
  const secs = () => Math.floor((Date.now() - cur.t0) / 1000);
  const clear = () => {
    clearInterval(cur.timer);
    clearInterval(cur.poll);
  };

  async function save(blob, ext, capped) {
    const name = tape.stamp(ext);
    let kept = true;
    try {
      await tape.add({ kind: 'video', blob, name });
    } catch {
      kept = false; // no IndexedDB: offer the file instead
      tape.download(blob, name);
    }
    on.end({ capped, kept, name, size: blob.size });
  }
  async function fetchBridge(id, capped) {
    const r = await api(`/api/record/${id}`);
    if (!r.ok)
      throw new Error((await r.json().catch(() => ({}))).error || r.status);
    const blob = await r.blob();
    await save(blob, 'mp4', capped);
    api(`/api/record/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  async function startBridge() {
    const r = await api('/api/record/start', { method: 'POST' });
    if (r.status === 409) throw new Error('the camera is already recording');
    if (!r.ok) return null; // not available: use the fallback
    const j = await r.json();
    cur = { mode: 'bridge', id: j.id, t0: Date.now(), max: j.max };
    cur.poll = setInterval(async () => {
      // The bridge stops at its cap: notice, then fetch the file.
      try {
        const s = await (await api('/api/record')).json();
        if (!s.recording && cur) {
          const { id } = cur;
          clear();
          cur = null;
          await fetchBridge(id, true);
        }
      } catch {
        /* the next poll tries again */
      }
    }, 3000);
    return true;
  }
  function startFallback() {
    if (!isLive() || !video.captureStream || !window.MediaRecorder)
      throw new Error(
        'the bridge cannot record; go live first to record in the browser',
      );
    const mime = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(
      video.captureStream(),
      mime ? { mimeType: mime } : {},
    );
    cur = {
      mode: 'browser',
      t0: Date.now(),
      rec,
      chunks: [],
      max: CAP_FALLBACK,
    };
    rec.ondataavailable = (e) => e.data.size && cur?.chunks.push(e.data);
    rec.start(1000);
  }

  return {
    get active() {
      return !!cur;
    },
    async start() {
      if (cur) return;
      try {
        if (!(await startBridge())) startFallback();
      } catch (e) {
        // A blocked or unreachable bridge is the same as "cannot record": try the browser path.
        if (!(e instanceof TypeError)) {
          cur = null;
          return on.error(e.message);
        }
        try {
          startFallback();
        } catch (e2) {
          cur = null;
          return on.error(e2.message);
        }
      }
      cur.timer = setInterval(() => {
        const s = secs();
        on.tick(s);
        if (cur.mode === 'browser' && s >= cur.max) this.stop(true);
      }, 1000);
      on.start(cur.mode);
    },
    async stop(capped = false) {
      if (!cur) return;
      const c = cur;
      clear();
      cur = null;
      try {
        if (c.mode === 'bridge') {
          const r = await api('/api/record/stop', { method: 'POST' });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error);
          await fetchBridge(c.id, capped || j.capped);
        } else {
          const blob = await new Promise((resolve) => {
            c.rec.onstop = () =>
              resolve(
                new Blob(c.chunks, { type: c.rec.mimeType || 'video/webm' }),
              );
            c.rec.stop();
          });
          await save(blob, 'webm', capped);
        }
      } catch (e) {
        on.error(`the recording did not come through (${e.message})`);
      }
    },
  };
}

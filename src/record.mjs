// Bridge-side recording: ffmpeg copies a fresh RTSP address's H.264 and AAC into an MP4 in captures/
// (no re-encode), one recording at a time, capped in length (GJ_REC_MAX seconds, default 600). The
// page downloads the file, then deletes it; leftovers are deleted when the bridge exits or starts.
// captures/ is git-ignored: recordings show the owner's home and are never committed.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camera } from './camera-select.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
export const MAX_SECONDS = Math.max(
  5,
  Math.min(3600, Number(process.env.GJ_REC_MAX) || 600),
);
const recs = new Map(); // id -> { id, status, started, seconds, file, proc, capped }

export function cleanup() {
  for (const r of recs.values()) {
    r.proc?.kill('SIGKILL');
    rmSync(r.file, { force: true });
  }
  recs.clear();
}
// Recordings the last run left behind (a crash): only our own rec-*.mp4 names.
export function sweep() {
  if (!existsSync(DIR)) return;
  for (const f of readdirSync(DIR))
    if (/^rec-[0-9a-f]{12}\.mp4$/.test(f))
      rmSync(join(DIR, f), { force: true });
}

export const active = () =>
  [...recs.values()].find((r) => r.status === 'recording');

// Set by media.mjs while an agent's clip or listen runs: one capture at a time.
export const gate = { busy: false, starting: false };

export async function start() {
  if (gate.busy)
    throw Object.assign(new Error('a clip is being recorded'), { code: 409 });
  if (active() || gate.starting)
    throw Object.assign(new Error('already recording'), { code: 409 });
  gate.starting = true; // set before the await: a second start in the gap is refused
  let url;
  try {
    mkdirSync(DIR, { recursive: true });
    url = await camera.streamUrl(); // never logged or sent to the client
  } finally {
    gate.starting = false;
  }
  const id = randomBytes(6).toString('hex');
  const file = join(DIR, `rec-${id}.mp4`);
  const r = {
    id,
    status: 'recording',
    started: Date.now(),
    file,
    max: MAX_SECONDS,
    capped: false,
  };
  r.proc = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
      '-t',
      String(MAX_SECONDS),
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      file,
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  r.proc.stdin.on('error', () => {});
  r.done = new Promise((resolve) => {
    r.proc.on('close', (code) => {
      r.proc = null;
      r.seconds = Math.round((Date.now() - r.started) / 1000);
      // Reaching -t is a normal finish; the page is told it was capped.
      r.capped = !r.stopping && r.seconds >= MAX_SECONDS - 1;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        /* no file */
      }
      r.bytes = size;
      r.status = size > 1000 ? 'ready' : 'failed';
      if (r.status === 'failed') {
        r.error = `ffmpeg exited ${code} without a picture`;
        rmSync(file, { force: true });
      }
      resolve();
    });
    r.proc.on('error', () => r.proc?.kill());
  });
  recs.set(id, r);
  if (recs.size > 8) {
    const old = recs.keys().next().value;
    rmSync(recs.get(old).file, { force: true });
    recs.delete(old);
  }
  return view(r);
}

// 'q' on ffmpeg's stdin lets it finish the file properly (faststart needs a clean end).
export async function stop() {
  const r = active();
  if (!r) throw Object.assign(new Error('not recording'), { code: 409 });
  r.stopping = true;
  r.proc.stdin.end('q');
  const t = setTimeout(() => r.proc?.kill('SIGINT'), 8000);
  await r.done;
  clearTimeout(t);
  return view(r);
}

export function view(r) {
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    seconds:
      r.status === 'recording'
        ? Math.round((Date.now() - r.started) / 1000)
        : r.seconds,
    max: r.max,
    ...(r.bytes ? { bytes: r.bytes } : {}),
    ...(r.capped ? { capped: true } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}
export const get = (id) => recs.get(id);
export const state = () => ({ max: MAX_SECONDS, recording: view(active()) });
export function remove(id) {
  const r = recs.get(id);
  if (!r) return false;
  if (r.status === 'recording') return null;
  rmSync(r.file, { force: true });
  recs.delete(id);
  return true;
}

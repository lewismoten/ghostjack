// Pictures, clips and microphone audio for agents: scaling and cropping snapshots, telling when the
// picture has settled after a move, and short recordings (MP4 clips, WAV or M4A audio) made from a
// fresh RTSP address. One clip or listen at a time, and never while the page's recording runs.
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camera } from './camera-select.mjs';
import * as rec from './record.mjs';
import * as cameras from './cameras.mjs';

export const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
export const children = new Set();

export const clampWidth = (v, def) => {
  const n = Math.round(Number(v));
  if (v === undefined || v === null || v === '' || !Number.isFinite(n))
    return def;
  return Math.max(64, Math.min(1920, n)) & ~1;
};

// [x,y,w,h] as fractions of the picture, or null when missing or unusable.
export function parseCrop(c) {
  if (!Array.isArray(c) || c.length !== 4) return null;
  const n = c.map(Number);
  if (!n.every(Number.isFinite)) return null;
  const [x, y, w, h] = n.map((v) => Math.max(0, Math.min(1, v)));
  return w >= 0.02 && h >= 0.02 && x + w <= 1.001 && y + h <= 1.001
    ? [x, y, w, h]
    : null;
}

// Run ffmpeg with a buffer on stdin and collect stdout.
function pipeFfmpeg(args, input, strict = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    children.add(p);
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('error', (e) => {
      clearTimeout(timer);
      children.delete(p);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      children.delete(p);
      if (code !== 0 && strict)
        return reject(
          Object.assign(new Error('ffmpeg failed or timed out'), { code: 502 }),
        );
      resolve(Buffer.concat(out));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// Crop (fractions) and scale a JPEG to `width` (keeps the aspect). With neither, it comes back as is.
export async function reshapeJpeg(jpg, { crop, width } = {}) {
  if (!crop && !width) return jpg;
  const vf = [];
  if (crop) {
    const [x, y, w, h] = crop;
    vf.push(`crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`);
  }
  vf.push(`scale=${width || 1280}:-2`);
  const out = await pipeFfmpeg(
    [
      '-f',
      'image2pipe',
      '-i',
      'pipe:0',
      '-vf',
      vf.join(','),
      '-frames:v',
      '1',
      '-f',
      'mjpeg',
      '-q:v',
      '3',
      'pipe:1',
    ],
    jpg,
    true,
  );
  if (!out.length)
    throw Object.assign(new Error('ffmpeg made no picture'), { code: 502 });
  return out;
}

// A 64x36 grayscale thumbnail of a JPEG (2304 bytes), to compare pictures cheaply.
const thumb = (jpg) =>
  pipeFfmpeg(
    [
      '-f',
      'image2pipe',
      '-i',
      'pipe:0',
      '-vf',
      'scale=64:36,format=gray',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    jpg,
  );
export function meanAbsDiff(a, b) {
  if (!a.length || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// After a move: wait for the picture to stop changing (two small p1 snapshots in a row that differ by
// under `threshold` of 255), or give up at `maxMs`. Returns true when it settled.
export async function waitSettled(
  maxMs,
  { startMs = 500, pollMs = 150, threshold = 2 } = {},
) {
  const t0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(Math.min(startMs, maxMs));
  let prev = null;
  while (Date.now() - t0 < maxMs) {
    const t = await thumb(await camera.snapshot('p1'));
    if (prev && meanAbsDiff(prev, t) < threshold) return true;
    prev = t;
    await sleep(pollMs);
  }
  return false;
}

// ffmpeg input options for a camera address (rtsp:// gets TCP; anything else is a test file).
const inputArgs = (url) => [
  ...(url.startsWith('rtsp://') ? ['-rtsp_transport', 'tcp'] : []),
  '-i',
  url,
];

// One capture per device at a time. Glasseye's lock ('tethys') also drives record.mjs's gate; a USB
// camera or mic has its own key per device, so a clip from one never blocks the other.
const TETHYS = 'tethys';
const held = new Map(); // key -> { preempt }
const busyError = () =>
  Object.assign(new Error('the camera is already recording'), { code: 409 });

function acquire(keys, preempt = null, steal = false) {
  if (steal) for (const k of keys) held.get(k)?.preempt?.(); // converse mode steps aside for a clip
  if (keys.some((k) => held.has(k))) throw busyError();
  if (keys.includes(TETHYS) && (rec.active() || rec.gate.starting))
    throw busyError();
  for (const k of keys) held.set(k, { preempt });
  if (keys.includes(TETHYS)) {
    rec.gate.busy = true;
    if (preempt) rec.gate.preempt = preempt;
  }
}

function release(keys, preempt = null) {
  for (const k of keys) held.delete(k);
  if (keys.includes(TETHYS)) {
    rec.gate.busy = false;
    if (preempt && rec.gate.preempt === preempt) rec.gate.preempt = null;
  }
}

// What ffmpeg opens for a camera entry: its lock keys, input arguments and (for USB) the capture size.
async function sourceFor(cam, { video, audio, size }) {
  if (cam.kind === 'tethys')
    return { keys: [TETHYS], args: inputArgs(await camera.streamUrl()) };
  return {
    keys: cameras.avfKeys(cam, { video, audio }),
    args: cameras.avfInput(cam, { video, audio, size }),
  };
}

const avfOnly = (cam) => cam.kind !== 'tethys';

// The ffmpeg input for the live view of a USB camera (the stream copies Glasseye's feed instead).
export const liveInput = (cam) =>
  cameras.avfInput(cam, { video: true, audio: false, size: process.env.GJ_USB_LIVE_SIZE || '1920x1080' });

// One JPEG frame from a USB camera: skips the first frames, which are dark while exposure settles.
export async function snapshotAvf(cam) {
  const keys = cameras.avfKeys(cam, { video: true });
  acquire(keys);
  try {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...cameras.avfInput(cam, { video: true, size: '1920x1080' }),
      '-vf',
      'select=gte(n\\,10)',
      '-frames:v',
      '1',
      '-fps_mode',
      'passthrough',
      '-q:v',
      '3',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ];
    const jpg = await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      children.add(p);
      const bufs = [];
      const t = setTimeout(() => p.kill('SIGKILL'), 15000);
      p.stdout.on('data', (d) => bufs.push(d));
      p.on('error', reject);
      p.on('close', () => {
        clearTimeout(t);
        children.delete(p);
        const b = Buffer.concat(bufs);
        b.length > 500
          ? resolve(b)
          : reject(new Error('the USB camera gave no picture'));
      });
    });
    return jpg;
  } finally {
    release(keys);
  }
}

// Record `seconds` from the camera `cam` into a temp file. Returns { done, cancel }: `done` resolves to
// the file path (the caller deletes it) and rejects with code 409/499/502.
function capture(seconds, ext, outArgs, cam, want) {
  const keys = cam.kind === 'tethys' ? [TETHYS] : cameras.avfKeys(cam, want);
  acquire(keys, null, true);
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `agent-${randomBytes(6).toString('hex')}.${ext}`);
  let proc = null,
    cancelled = false;
  const stopped = () => Object.assign(new Error('cancelled'), { code: 499 });
  const done = (async () => {
    try {
      const src = await sourceFor(cam, want);
      if (cancelled) throw stopped();
      await new Promise((resolve, reject) => {
        proc = spawn(
          FFMPEG,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            ...src.args,
            '-t',
            String(seconds),
            ...outArgs,
            '-y',
            file,
          ],
          { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        children.add(proc);
        const t = setTimeout(() => proc.kill('SIGKILL'), (seconds + 20) * 1000);
        proc.on('error', reject);
        proc.on('close', (code) => {
          clearTimeout(t);
          children.delete(proc);
          code === 0 || cancelled
            ? resolve()
            : reject(new Error('ffmpeg could not record'));
        });
      });
      if (cancelled) throw stopped();
      if (statSync(file).size < 500) throw new Error('nothing was recorded');
      return file;
    } catch (e) {
      rmSync(file, { force: true });
      throw e;
    } finally {
      release(keys);
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      proc?.kill('SIGKILL');
    },
  };
}

// An MP4 clip. Re-encodes (H.264, scaled) only when width is under 1920; at 1920 Glasseye's video is
// copied (a USB camera is always encoded: it sends raw frames).
export function clip(seconds, width, audio, cam = cameras.videoNow()) {
  const v =
    width >= 1920 && !avfOnly(cam)
      ? ['-c:v', 'copy']
      : [
          '-vf',
          `scale=${width}:-2`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '28',
          '-pix_fmt',
          'yuv420p',
        ];
  const a = audio ? ['-c:a', 'aac', '-ar', '16000', '-ac', '1'] : ['-an'];
  const want = {
    video: true,
    audio: audio && cam.capabilities.includes('mic'),
    size: width >= 1920 ? '1920x1080' : '1280x720',
  };
  return capture(
    seconds,
    'mp4',
    [
      '-map',
      '0:v:0',
      ...(want.audio ? ['-map', '0:a:0?'] : []),
      ...v,
      ...(want.audio ? a : ['-an']),
      '-movflags',
      '+faststart',
    ],
    cam,
    want,
  );
}

// Microphone audio only (no video decoded): 16 kHz mono WAV, or AAC in M4A. From the listening mic
// unless `cam` names another.
export function listen(seconds, format = 'wav', cam = cameras.micNow()) {
  const m4a = format === 'm4a';
  return capture(
    seconds,
    m4a ? 'm4a' : 'wav',
    [
      '-vn',
      '-map',
      '0:a:0',
      ...(m4a
        ? ['-c:a', 'aac', '-ar', '16000', '-ac', '1', '-b:a', '48k']
        : ['-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1']),
    ],
    cam,
    { audio: true },
  );
}

// Continuous microphone audio for converse mode: raw 16 kHz mono s16le on `stream`, until `cancel()`, a
// clip or recording asking for the same device (it steps aside: `preempted()` is then true), or the
// device dropping the stream. Holds the same one-capture lock as clip and listen.
export function listenStream(cam = cameras.micNow()) {
  const keys =
    cam.kind === 'tethys' ? [TETHYS] : cameras.avfKeys(cam, { audio: true });
  const out = new PassThrough();
  let proc = null,
    cancelled = false,
    released = false;
  const free = () => {
    if (released) return;
    released = true;
    release(keys, cancel);
  };
  const cancel = () => {
    cancelled = true;
    proc?.kill('SIGKILL');
    free();
    out.end();
  };
  acquire(keys, cancel);
  (async () => {
    try {
      const src = await sourceFor(cam, { audio: true });
      if (cancelled) return;
      proc = spawn(
        FFMPEG,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          ...src.args,
          '-vn',
          '-map',
          '0:a:0',
          '-f',
          's16le',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-flush_packets',
          '1',
          'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      children.add(proc);
      proc.stdout.pipe(out);
      proc.on('error', () => {
        free();
        out.end();
      });
      proc.on('close', () => {
        children.delete(proc);
        free();
      });
    } catch {
      free();
      out.end();
    }
  })();
  return { stream: out, cancel, preempted: () => cancelled };
}

// A stand-in for src/camera.mjs for offline tests (set GJ_FAKE_CAMERA to this file's path). It touches no
// camera and no network: pictures and a stream file are generated with ffmpeg's test sources into
// captures/ (git-ignored; tools/agent-api-selftest.mjs deletes them). The "talk address" is a local file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
mkdirSync(DIR, { recursive: true });
export const files = {
  still: join(DIR, 'fake-still.jpg'),
  other: join(DIR, 'fake-other.jpg'),
  small: join(DIR, 'fake-small.jpg'),
  smallMoving: join(DIR, 'fake-small2.jpg'),
  stream: join(DIR, 'fake-stream.mp4'),
};
const ff = (...a) =>
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const still = (src, size, out) =>
  ff('-f', 'lavfi', '-i', `${src}=s=${size}`, '-frames:v', '1', out);
still('testsrc', '1920x1080', files.still);
still('testsrc2', '1920x1080', files.other);
still('testsrc', '640x360', files.small);
still('testsrc2', '640x360', files.smallMoving);
ff(
  '-f',
  'lavfi',
  '-i',
  'testsrc=s=1920x1080:r=10:d=8',
  '-f',
  'lavfi',
  '-i',
  'sine=f=440:r=16000:d=8',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  files.stream,
);

let movingUntil = 0,
  flips = 0,
  talks = 0;
export const talkFile = (n) => join(DIR, `fake-talk-${n}.flv`);

// While moving, the sub-stream flips between two different pictures; at rest it is constant.
export async function snapshot(profile = 'p0') {
  if (profile !== 'p1') return readFileSync(files.still);
  const flip = Date.now() < movingUntil && ++flips % 2;
  return readFileSync(flip ? files.smallMoving : files.small);
}
export async function move() {
  movingUntil = Date.now() + 900;
}
export const streamUrl = async () => files.stream;
export async function talkUrl() {
  return talkFile(++talks);
}
export const status = async () => ({ mode: 'auto', ir: false });
export const shutdown = async () => {};

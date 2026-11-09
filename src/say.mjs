// Speak through the camera's speaker. One talker at a time: requests wait in a queue.
// Speech comes from synthesize() (macOS `say` today; swap in Pocket TTS or Kokoro by replacing that one function:
// it must write an audio file ffmpeg can read and return its path). See docs/bridge.md.
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as camera from './camera.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const TMP = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
// Phone band, gentle compression, level, then a true-peak limiter last (about -6 dBFS).
const CHAIN = (level) =>
  `highpass=f=300,lowpass=f=3000,acompressor=threshold=-20dB:ratio=3:attack=5:release=100,volume=${level},alimiter=limit=0.5:level=disabled`;
// How fast to send: 'ahead' = a little faster than playback with a 2 s head start (the camera's buffer
// stays full), 'fast' = no limit, 're' = exactly real time (underran in testing; see docs/discovery.md).
const PACE = {
  ahead: ['-readrate', '1.05', '-readrate_initial_burst', '2'],
  fast: [],
  re: ['-re'],
};
const pace = () => PACE[process.env.GJ_SAY_PACE] || PACE.ahead;
const jobs = new Map(); // id -> { status, text, error? }
const queue = [];
let busy = false;

export function voices() {
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], (err, out) => {
      if (err) return resolve([]);
      resolve(
        out
          .split('\n')
          .map((l) => /^(.+?)\s{2,}([a-z]{2}[_-][A-Za-z]+)/.exec(l))
          .filter((m) => m && /^en[_-]/.test(m[2]))
          .map((m) => m[1].trim()),
      );
    });
  });
}

// Boundary for other voices: (text, {voice, rate}) -> path of an audio file.
async function synthesize(text, { voice, rate }) {
  const file = join(TMP, `say-${randomBytes(6).toString('hex')}.aiff`);
  const args = ['-o', file, '-r', String(rate)];
  if (voice) args.push('-v', voice);
  await new Promise((resolve, reject) => {
    const p = spawn('say', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('close', (c) =>
      c ? reject(new Error('speech synthesis failed')) : resolve(),
    );
    p.stdin.end(text);
  });
  return file;
}

const run = (args, capture) =>
  new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', ...args], {
      stdio: ['ignore', 'ignore', capture ? 'pipe' : 'ignore'],
    });
    let err = '';
    p.stderr?.on('data', (d) => {
      err += d;
    });
    p.on('error', reject);
    p.on('close', (c) =>
      c ? reject(new Error('ffmpeg failed')) : resolve(err),
    );
  });

// Loudest sample of a file, in dB.
async function peakDb(file) {
  const err = await run(
    ['-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    true,
  );
  const m = /max_volume: (-?[\d.]+) dB/.exec(err);
  return m ? Number(m[1]) : -3;
}

// 1 s of silence, then (unless chime is false) Glassmouth's attention cue: a 30 ms relay click and a two-tone
// chime (880 then 1320 Hz, peak 0.016 = about -36 dBFS by default) and 0.4 s of quiet, then the speech normalized to -3 dBFS peak,
// then 1.5 s of silence so the camera finishes its buffer before the publish closes. The camera's amp
// wakes on sound, so without the cue the first syllable is spent waking it (silence does not wake it).
// The same cue is the voice relay's chime (docs/voice-relay-plan.md).
// Hard caps: the speaker is alarm-loud, so no caller or page can ask for more than this.
export const MAX_LEVEL = 0.08,
  MAX_CHIME = 0.0316; // speech volume; chime peak (-30 dBFS)
export const capLevel = (v) =>
  Math.max(0.01, Math.min(MAX_LEVEL, Number(v) || 0.035));
export const capChime = (v) =>
  Math.max(0.004, Math.min(MAX_CHIME, Number(v) || 0.016));

export async function speechArgs(
  file,
  rawLevel,
  out,
  chime = true,
  rawChime = 0.016,
) {
  const level = capLevel(rawLevel),
    chimeLevel = capChime(rawChime);
  const gain = (-3 - (await peakDb(file))).toFixed(2);
  const sil = (t) => `anullsrc=r=16000:cl=mono:d=${t}`;
  const tone = (f, d) => `sine=f=${f}:r=16000:d=${d}`;
  const inputs = [sil(1)];
  if (chime)
    inputs.push(tone(2200, 0.03), tone(880, 0.1), tone(1320, 0.1), sil(0.4));
  const cueIdx = chime ? [1, 2, 3, 4] : [];
  const speechIdx = inputs.length;
  inputs.push(sil(1.5));
  const args = ['-loglevel', 'error', ...out.pre];
  for (const i of inputs) args.push('-f', 'lavfi', '-i', i);
  args.push('-i', file);
  const tailIdx = speechIdx; // the tail was pushed at speechIdx; the speech file comes after it
  const fileIdx = inputs.length;
  const parts = [`[0:a]aresample=16000[s0]`];
  const order = ['[s0]'];
  for (const i of cueIdx) {
    parts.push(
      `[${i}:a]aresample=16000,volume=${(chimeLevel / 0.125).toFixed(3)},afade=t=out:st=0.02:d=0.01[c${i}]`,
    );
    order.push(`[c${i}]`);
  }
  parts.push(
    `[${fileIdx}:a]aresample=16000,volume=${gain}dB,${CHAIN(level)}[sp]`,
    `[${tailIdx}:a]aresample=16000[tl]`,
  );
  order.push('[sp]', '[tl]');
  parts.push(`${order.join('')}concat=n=${order.length}:v=0:a=1[o]`);
  return [
    ...args,
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[o]',
    ...out.post,
  ];
}
const AAC = ['-c:a', 'aac', '-ar', '16000', '-ac', '1', '-b:a', '64k'];
const toCamera = (url) => ({
  pre: pace(),
  post: [
    ...AAC,
    '-flush_packets',
    '1',
    '-flvflags',
    'no_duration_filesize',
    '-f',
    'flv',
    url,
  ],
});
export const toFile = (path) => ({
  pre: [],
  post: ['-c:a', 'pcm_s16le', '-ar', '16000', '-y', path],
});

const silentPublish = (url) =>
  run([
    '-loglevel',
    'error',
    '-re',
    '-f',
    'lavfi',
    '-t',
    '1',
    '-i',
    'anullsrc=r=16000:cl=mono',
    ...AAC,
    '-f',
    'flv',
    url,
  ]);

async function speak(job) {
  mkdirSync(TMP, { recursive: true });
  let file = null;
  try {
    file = await synthesize(job.text, job);
    job.status = 'speaking';
    const url = await camera.talkUrl();
    try {
      await run(
        await speechArgs(
          file,
          job.level,
          toCamera(url),
          job.chime,
          job.chimeLevel,
        ),
      );
    } catch (e) {
      // Free the slot with a short silent publish to the same address.
      await silentPublish(url).catch(() => {});
      throw e;
    }
    job.status = 'done';
  } catch (e) {
    job.status = 'failed';
    job.error = String(e.message || e).slice(0, 120);
  } finally {
    if (file && existsSync(file)) rmSync(file, { force: true });
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await speak(queue.shift());
  busy = false;
}

export function say({
  text,
  voice,
  level,
  rate,
  chime = true,
  chimeLevel = 0.016,
}) {
  const id = randomBytes(6).toString('hex');
  const job = {
    id,
    status: 'queued',
    text,
    voice: voice || '',
    level,
    rate,
    chime,
    chimeLevel,
  };
  jobs.set(id, job);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  queue.push(job);
  pump();
  return { id, status: job.status };
}

export const sayStatus = (id) => {
  const j = jobs.get(id);
  return (
    j && {
      id,
      status: j.status,
      ahead: queue.indexOf(j),
      ...(j.error ? { error: j.error } : {}),
    }
  );
};

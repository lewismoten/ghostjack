// Speak through the camera's speaker. One talker at a time: requests wait in a queue.
// Speech comes from synthesize() (macOS `say` today; swap in Pocket TTS or Kokoro by replacing that one function:
// it must write an audio file ffmpeg can read and return its path). See docs/bridge.md.
import { spawn, execFile } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camera } from './camera-select.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const TMP = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
// Phone band and gentle compression first (0.1.1: measured on their own output, so the gain that
// normalizes the speech is exact), then gain and level, then a true-peak limiter (about -6 dBFS).
const BAND =
  'highpass=f=300,lowpass=f=3000,acompressor=threshold=-20dB:ratio=3:attack=5:release=100';
const LIMIT = (level) => `volume=${level},alimiter=limit=0.5:level=disabled`;
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

const run = (args, capture, onProc) =>
  new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', ...args], {
      stdio: ['ignore', 'ignore', capture ? 'pipe' : 'ignore'],
    });
    let err = '';
    onProc?.(p);
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
// 0.1.1: speech is normalized to -3 dBFS after the phone band and compressor, then scaled by level,
// so the speech peak is about level x 0.71 (0.03 = -33.5 dBFS). Before, the band and compressor took
// another 9 dB off after the normalizing and the speech peaked 6 dB BELOW the chime. The chime peak
// is also held at least 9 dB under the speech peak (CHIME_BELOW), whatever the chime slider says.
export const MAX_LEVEL = 0.05,
  MAX_CHIME = 0.0316; // speech volume; chime peak (-30 dBFS)
// Wake pulse (see speechArgs): length, pitch (inside the 300 to 3000 Hz phone band) and the quiet gap after.
export const WAKE_SEC = 0.13,
  WAKE_HZ = 1000,
  WAKE_GAP = 0.5,
  CUE_GAP = 0.3;
export const CHIME_BELOW = 0.35; // chime peak <= speech peak x this (-9 dB)
export const capLevel = (v) =>
  Math.max(0.01, Math.min(MAX_LEVEL, Number(v) || 0.03));
export const capChime = (v) =>
  Math.max(0.004, Math.min(MAX_CHIME, Number(v) || 0.008));
export const chimeFor = (level, chime) =>
  Math.min(capChime(chime), 0.7079 * capLevel(level) * CHIME_BELOW);

export async function speechArgs(
  file,
  rawLevel,
  out,
  chime = true,
  rawChime = 0.008,
  band = true,
  fast = false,
) {
  const level = capLevel(rawLevel),
    chimeLevel = chimeFor(level, rawChime);
  const filter = band ? BAND : 'anull';
  const banded = file + '.band.wav';
  await run(['-loglevel', 'error', '-i', file, '-af', filter, '-y', banded]);
  const gain = (-3 - (await peakDb(banded))).toFixed(2);
  rmSync(banded, { force: true });
  // Segments, in order. Each is [lavfi source, filter after it, or null for silence].
  const sil = (t) => [`anullsrc=r=16000:cl=mono:d=${t}`, ''];
  const pulse = (f, d, peak, fade) => [
    `sine=f=${f}:r=16000:d=${d}`,
    `,volume=${(peak / 0.125).toFixed(4)},afade=t=in:st=0:d=${fade},afade=t=out:st=${(d - fade).toFixed(3)}:d=${fade}`,
  ];
  const speechPeak = 0.7079 * level; // speech is normalized to -3 dBFS, then scaled by level
  // fast: a short cue right after the speaker was in use (the amp is awake): no wake pulse, tiny lead and tail.
  const seg = fast
    ? [sil(0.1)]
    : [
        sil(1), // lead-in: the link settles
        // The wake pulse (0.1.2): the camera's amp wakes on sound, and until it has, the first words are
        // lost ("Words to wonder" played as "...onder"). A short pulse as loud as the speech peak (never
        // louder; the limiter and level cap still apply) with soft edges so it is not a click, then half a
        // second of silence while the amp stays awake. The quiet chime alone (9 dB under speech) did not wake it.
        pulse(WAKE_HZ, WAKE_SEC, speechPeak, 0.02),
        sil(WAKE_GAP),
      ];
  if (chime && !fast)
    seg.push(
      pulse(880, 0.1, chimeLevel, 0.01),
      pulse(1320, 0.1, chimeLevel, 0.01),
      sil(CUE_GAP),
    );
  const speechIdx = seg.length;
  // the tail: the camera finishes its buffer before the publish closes. 0.4 s after a fast line cut its last
  // word on the real camera (2026-11-10: "...without stopping" lost "stopping"), so it is 0.9 s by default.
  seg.push(sil(fast ? Number(process.env.GJ_FAST_TAIL_SEC) || 0.9 : 1.5));
  const args = ['-loglevel', 'error', ...out.pre];
  for (const [src] of seg) args.push('-f', 'lavfi', '-i', src);
  args.push('-i', file);
  const fileIdx = seg.length;
  const parts = [],
    order = [];
  seg.forEach(([, f], i) => {
    if (i === speechIdx) return;
    parts.push(`[${i}:a]aresample=16000${f}[g${i}]`);
    order.push(`[g${i}]`);
  });
  parts.push(
    `[${fileIdx}:a]aresample=16000,${filter},volume=${gain}dB,${LIMIT(level)}[sp]`,
    `[${speechIdx}:a]aresample=16000[tl]`,
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
// Send a finished mix to the camera, paced (the options sit right before
// the only input, so they apply to it).
export const sendArgs = (wav, url) => {
  const t = toCamera(url);
  return ['-loglevel', 'error', ...t.pre, '-i', wav, ...t.post];
};
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

// Phase 1 (can run while the previous line plays): synthesize and mix into one finished file. Resolves to
// { file, mixed, ref } where ref is the mix's 20 ms loudness envelope and where the speech sits in it.
async function prepare(job) {
  mkdirSync(TMP, { recursive: true });
  // Both sources end up as one audio file; the mixer below is the same for speech and uploads.
  const file = job.file || (await synthesize(job.text, job));
  job.file = file;
  // Mix first, then send the one finished file at the pace. (0.1.2 fix: the
  // pacing options only govern the input right after them, so sending the
  // mix straight from its pieces paced only the lead-in silence and pushed
  // the rest in a few milliseconds; the camera played a blip and dropped it.)
  const mixed = file + '.mix.wav';
  await run(
    await speechArgs(
      file,
      job.level,
      toFile(mixed),
      job.chime,
      job.chimeLevel,
      job.band,
      job.fast,
    ),
  );
  const pcm = readFileSync(mixed).subarray(44);
  const env = [];
  for (let i = 0; i + 640 <= pcm.length; i += 640) {
    let sum = 0;
    for (let j = 0; j < 640; j += 2) sum += pcm.readInt16LE(i + j) ** 2;
    env.push(Math.sqrt(sum / 320));
  }
  const totalMs = (pcm.length / 32000) * 1000;
  const leadMs = job.fast
    ? 100
    : (1 + WAKE_SEC + WAKE_GAP + (job.chime ? 0.2 + CUE_GAP : 0)) * 1000;
  const tailMs = job.fast ? 400 : 1500;
  return {
    file,
    mixed,
    ref: { env, leadMs, speechMs: totalMs - leadMs - tailMs },
  };
}

let current = null; // { job, proc } while a line is being published
async function speak(job) {
  let prep = null;
  try {
    prep = await job.prep;
    if (job.status === 'cancelled') return;
    job.status = 'speaking';
    const url = await camera.talkUrl();
    try {
      job.publishAt = Date.now();
      job.ref = prep.ref;
      await run(sendArgs(prep.mixed, url), false, (p) => {
        current = { job, proc: p };
      });
    } catch (e) {
      // Free the slot with a short silent publish to the same address.
      await silentPublish(url).catch(() => {});
      if (job.status !== 'cancelled') throw e;
    }
    if (job.status !== 'cancelled') job.status = 'done';
  } catch (e) {
    if (job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = String(e.message || e).slice(0, 120);
    }
  } finally {
    current = null;
    job.endedAt = Date.now();
    if (prep) {
      rmSync(prep.mixed, { force: true });
      if (existsSync(prep.file)) rmSync(prep.file, { force: true });
    }
  }
}

const start = (job) => {
  job.prep ||= prepare(job);
  job.prep.catch(() => {}); // a failure is reported by speak(), not as an unhandled rejection
};

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    start(job);
    if (queue[0]) start(queue[0]); // synthesize the next line while this one plays
    await speak(job);
  }
  busy = false;
  endedAt = Date.now();
}
let endedAt = 0;
// Is the speaker busy (or about to be), when it last finished, and the job now on air (its loudness
// envelope, for converse mode's echo handling).
export const activity = () => ({
  speaking: busy || queue.length > 0,
  endedAt,
  playing: current?.job ?? null,
});
// Barge-in: drop everything queued and cut the line on air. Returns the cut job (or null).
export function stopAll() {
  const cut = current?.job ?? null;
  for (const j of queue.splice(0)) {
    j.status = 'cancelled';
    j.prep
      ?.then((p) => {
        rmSync(p.mixed, { force: true });
        rmSync(p.file, { force: true });
      })
      .catch(() => {});
  }
  if (cut) {
    cut.status = 'cancelled';
    cut.stoppedAt = Date.now();
    current.proc?.kill('SIGKILL');
  }
  return cut;
}
export const jobInfo = (id) => jobs.get(id) || null;

export function say({
  text,
  voice,
  level,
  rate,
  chime = true,
  chimeLevel = 0.008,
  file = null, // an audio file to play instead of synthesizing text (deleted afterward)
  band = true,
  fast = false,
}) {
  const id = randomBytes(6).toString('hex');
  const job = {
    id,
    status: 'queued',
    text: text || '',
    voice: voice || '',
    level,
    rate,
    chime,
    chimeLevel,
    file,
    band,
    fast,
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

// Longest uploaded clip, after decoding.
export const MAX_PLAY_SECONDS = 30;

// Decode an uploaded audio body (any format ffmpeg reads) to a 16 kHz mono WAV in captures/.
// Returns { file, seconds }; throws an error with code 400 when it is not audio or too long.
export async function decodeUpload(buf) {
  mkdirSync(TMP, { recursive: true });
  const id = randomBytes(6).toString('hex');
  const input = join(TMP, `play-${id}.in`),
    wav = join(TMP, `play-${id}.wav`);
  try {
    writeFileSync(input, buf);
    try {
      await run([
        '-loglevel',
        'error',
        '-i',
        input,
        '-vn',
        '-t',
        String(MAX_PLAY_SECONDS + 1),
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-y',
        wav,
      ]);
    } catch {
      throw Object.assign(new Error('that body is not audio'), { code: 400 });
    }
    const seconds = Math.max(0, (statSync(wav).size - 44) / 32000);
    if (seconds < 0.05)
      throw Object.assign(new Error('the audio is empty'), { code: 400 });
    if (seconds > MAX_PLAY_SECONDS)
      throw Object.assign(
        new Error(`audio is ${MAX_PLAY_SECONDS} seconds at most`),
        { code: 400 },
      );
    return { file: wav, seconds: Math.round(seconds * 10) / 10 };
  } catch (e) {
    rmSync(wav, { force: true });
    throw e;
  } finally {
    rmSync(input, { force: true });
  }
}

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
import { SpeechStream, silence, sine } from './speech-stream.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const TMP = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
// Phone band and gentle compression first (0.1.1: measured on their own output, so the gain that
// normalizes the speech is exact), then gain and level, then a true-peak limiter (about -6 dBFS).
const BAND =
  'highpass=f=300,lowpass=f=3000,acompressor=threshold=-20dB:ratio=3:attack=5:release=100';
const LIMIT = (level) => `volume=${level},alimiter=limit=0.5:level=disabled`;
const AAC = ['-c:a', 'aac', '-ar', '16000', '-ac', '1', '-b:a', '64k'];
const jobs = new Map(); // id -> { status, text, error? }

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
  WAKE_GAP = Number(process.env.GJ_WAKE_GAP_SEC) || 0.9, // 0.5 left the first word garbled on the camera (2026-11-10)
  CUE_GAP = 0.3;
export const CHIME_BELOW = 0.35; // chime peak <= speech peak x this (-9 dB)
export const capLevel = (v) =>
  Math.max(0.01, Math.min(MAX_LEVEL, Number(v) || 0.03));
export const capChime = (v) =>
  Math.max(0.004, Math.min(MAX_CHIME, Number(v) || 0.008));
export const chimeFor = (level, chime) =>
  Math.min(capChime(chime), 0.7079 * capLevel(level) * CHIME_BELOW);

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

// Phase 1 (runs while earlier sentences play): synthesize and condition one sentence to raw PCM: the phone band
// and compressor, normalized to -3 dBFS, then scaled by level and held under the limiter. No lead-in or tail:
// the stream (speech-stream.mjs) adds those once per reply.
async function prepareSpeech(job) {
  mkdirSync(TMP, { recursive: true });
  const file = job.file || (await synthesize(job.text, job));
  job.file = file;
  const level = capLevel(job.level);
  const filter = job.band ? BAND : 'anull';
  const banded = file + '.band.wav';
  await run(['-loglevel', 'error', '-i', file, '-af', filter, '-y', banded]);
  const gain = (-3 - (await peakDb(banded))).toFixed(2);
  rmSync(banded, { force: true });
  const raw = file + '.pcm';
  await run([
    '-loglevel',
    'error',
    '-i',
    file,
    '-af',
    `aresample=16000,${filter},volume=${gain}dB,${LIMIT(level)}`,
    '-ac',
    '1',
    '-f',
    's16le',
    '-y',
    raw,
  ]);
  const pcm = readFileSync(raw);
  rmSync(raw, { force: true });
  return pcm;
}
// Two sentences are prepared at a time, started in order, so a short sentence is ready before the last ends.
const PREP_PARALLEL = Number(process.env.GJ_PREP_PARALLEL) || 2;
let preparing = 0;
const prepWaiting = [];
const prepare = (job) =>
  new Promise((resolve) => {
    prepWaiting.push({ job, resolve });
    nextPrep();
  });
function nextPrep() {
  while (preparing < PREP_PARALLEL && prepWaiting.length) {
    const { job, resolve } = prepWaiting.shift();
    preparing++;
    (async () => {
      if (job.status === 'cancelled') return;
      try {
        job.pcm = await prepareSpeech(job);
      } catch (e) {
        job.failed = true;
        job.error = String(e.message || e).slice(0, 120);
        if (job.status !== 'cancelled') job.status = 'failed';
      } finally {
        if (job.file && existsSync(job.file)) rmSync(job.file, { force: true });
      }
    })().finally(() => {
      preparing--;
      resolve();
      nextPrep();
    });
  }
}

// The camera's amp sleeps soon after sound stops: a stream that opens within AWAKE_MS of the last publish
// ending skips the wake pulse (the camera link takes up to 5 s to set up, so this is judged after the talk
// address arrives, just before the publish starts).
export const AWAKE_MS = Number(process.env.GJ_AWAKE_MS) || 2500;
export const isAwake = (lastEnd, now = Date.now()) => now - lastEnd < AWAKE_MS;
let lastPublishEnd = 0;

// The lead-in, written once at the start of a reply: a short lead when the amp is awake; otherwise a second of
// quiet while the link settles, the wake pulse (as loud as the speech peak, soft edges) and half a second of
// quiet, then Glassmouth's chime when asked (a 880 then 1320 Hz two-tone, see MAX_CHIME).
export function leadIn({ awake, level, chime, chimeLevel, fast }) {
  // a fast line (the wake bleep) skips the wake pulse and the settle: it must come out right away
  if (fast) return silence(awake ? 40 : 250);
  if (awake) return silence(350);
  const peak = 0.7079 * capLevel(level);
  const parts = [
    silence(1000),
    sine(WAKE_HZ, WAKE_SEC * 1000, peak, 20),
    silence(WAKE_GAP * 1000),
  ];
  if (chime) {
    const c = chimeFor(level, chimeLevel);
    parts.push(
      sine(880, 100, c, 10),
      sine(1320, 100, c, 10),
      silence(CUE_GAP * 1000),
    );
  }
  return Buffer.concat(parts);
}

// Real publisher: ffmpeg reads raw PCM on stdin (paced by the stream, not by ffmpeg) and publishes AAC in FLV.
// Its -progress output tells the stream when the publish really began.
function openPublish(url, onProgress) {
  const p = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-nostats',
      '-progress',
      'pipe:1',
      '-stats_period',
      '0.1',
      '-f',
      's16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-i',
      'pipe:0',
      ...AAC,
      '-flush_packets',
      '1',
      '-flvflags',
      'no_duration_filesize',
      '-f',
      'flv',
      url,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  p.stdin.on('error', () => {}); // a killed or refused publish: writes just stop
  let buf = '';
  let seen = false;
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const m = /^out_time_us=(\d+)/.exec(l);
      if (m && !seen && Number(m[1]) > 0) {
        seen = true;
        onProgress(100, Date.now()); // the first report comes one stats period after byte 0
      }
    }
  });
  const exited = new Promise((resolve) => {
    p.on('error', () => resolve(-1));
    p.on('close', (c, sig) => resolve(sig ? -1 : (c ?? -1)));
  });
  return {
    canWrite: () => !p.stdin.destroyed && p.stdin.writableLength < 32768,
    write: (b) => p.stdin.write(b),
    end: () => p.stdin.end(),
    kill: () => p.kill('SIGKILL'),
    exited,
  };
}

// Output target: 'camera' (talk link, publish) or 'mac' (the laptop's default audio output). A call may name one;
// otherwise the resolver (the server wires it to the default persona) decides; failing that, 'camera'.
export const OUTPUTS = ['camera', 'mac'];
export const cleanOutput = (o) => (OUTPUTS.includes(o) ? o : null);
let outputResolver = () => 'camera';
export const setOutputResolver = (f) => {
  outputResolver = f;
};
export const resolveOutput = (o) =>
  cleanOutput(o) ?? cleanOutput(outputResolver()) ?? 'camera';

// The laptop speaker: ffplay reads the same raw PCM on stdin. Same handle shape as openPublish.
const FFPLAY = process.env.FFPLAY || '/opt/homebrew/bin/ffplay';
function spawnMacPlayer(onProgress) {
  const p = spawn(
    FFPLAY,
    [
      '-nodisp',
      // speech levels are tuned for the camera's tiny speaker (capped at 0.05): lift them for the laptop (GJ_MAC_GAIN)
      '-af',
      `volume=${Number(process.env.GJ_MAC_GAIN) || 14}`,
      '-autoexit',
      '-loglevel',
      'quiet',
      '-fflags',
      'nobuffer',
      '-f',
      's16le',
      '-sample_rate',
      '16000',
      '-ch_layout',
      'mono',
      '-i',
      'pipe:0',
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  p.stdin.on('error', () => {});
  p.once('spawn', () => setTimeout(() => onProgress(0, Date.now()), 50));
  const exited = new Promise((resolve) => {
    p.on('error', () => resolve(-1));
    p.on('close', (c, sig) => resolve(sig ? -1 : (c ?? -1)));
  });
  return {
    canWrite: () => !p.stdin.destroyed && p.stdin.writableLength < 32768,
    write: (b) => p.stdin.write(b),
    end: () => p.stdin.end(),
    kill: () => p.kill('SIGKILL'),
    exited,
  };
}
// tests swap in a fake: (onProgress) => handle
let macPlayer = spawnMacPlayer;
export const setMacPlayer = (f) => {
  macPlayer = f ?? spawnMacPlayer;
};
const openMac = (_url, onProgress) => macPlayer(onProgress);

const streamConfig = () => ({
  ...(Number(process.env.GJ_STREAM_AHEAD_MS) && {
    aheadMs: Number(process.env.GJ_STREAM_AHEAD_MS),
  }),
  ...(Number(process.env.GJ_STREAM_PAUSE_MS) && {
    pauseMs: Number(process.env.GJ_STREAM_PAUSE_MS),
  }),
  ...(Number(process.env.GJ_STREAM_TAIL_MS) && {
    tailMs: Number(process.env.GJ_STREAM_TAIL_MS),
  }),
  ...(Number(process.env.GJ_STREAM_IDLE_MS) && {
    idleEndMs: Number(process.env.GJ_STREAM_IDLE_MS),
  }),
  // what plays between sentences when the next is not ready: 'silence' (default) or 'tone' (barely audible)
  keepalive: process.env.GJ_STREAM_KEEPALIVE === 'tone' ? 'tone' : 'silence',
});
// One line per event in the bridge log (stdout), so a filmed test can be aligned exactly.
const logLine = (o) =>
  console.log(`[say] ${JSON.stringify({ t: new Date().toISOString(), ...o })}`);

let current = null; // the stream being published
let running = null; // the stream being set up or published (current, plus while its talk link is asked for)
async function runStream(st) {
  running = st;
  let url = null;
  let error = null;
  let timer = null;
  try {
    if (st.stopped || (st.ended && !st.jobs.length)) return;
    const mac = st.output === 'mac';
    if (!mac) {
      const asked = Date.now();
      url = await camera.talkUrl();
      st.log({ ev: 'talk', stream: st.id, talkMs: Date.now() - asked });
    }
    if (st.stopped) return;
    const first = st.jobs[0] ?? { fast: st.warm };
    const now = Date.now();
    current = st;
    st.begin(
      url,
      leadIn({
        // the laptop needs no wake pulse and no link: a short lead only
        awake: mac || isAwake(lastPublishEnd, now),
        level: first.level,
        chime: first.chime,
        chimeLevel: first.chimeLevel,
        fast: first.fast,
      }),
      now,
    );
    timer = setInterval(() => st.tick(Date.now()), 20);
    const code = await st.handle.exited;
    if (!st.stopped && (code !== 0 || !st.closing))
      error = new Error('the publish ended early');
  } catch (e) {
    error = e;
  } finally {
    clearInterval(timer);
    current = null;
    running = null;
    if (warmStream === st) warmStream = null;
    // an unfinished publish can jam the speaker: after a cut or a failure, free it with a short silent one
    if (url && (st.stopped || error)) await silentPublish(url).catch(() => {});
    const t = Date.now();
    if (!st.stopped && !error) st.finish(t);
    else st.finish(t, error);
    if (st.output !== 'mac') lastPublishEnd = t;
    for (const j of st.jobs) {
      j.endedAt = t;
      if (j.file && existsSync(j.file)) rmSync(j.file, { force: true });
    }
  }
}

const streams = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (streams.length) {
    const st = streams.shift();
    await runStream(st);
  }
  busy = false;
  endedAt = Date.now();
}
let endedAt = 0;
// Is the speaker busy (or about to be), when it last finished, and the sentence now on air (its loudness
// envelope, for converse mode's echo handling).
// A warm stream with nothing to say yet (the link held open for the wake bleep) is not the camera speaking.
const idleWarm = (st) => st?.warm && !st.jobs.length;
export const activity = () => ({
  speaking: streams.some((st) => !idleWarm(st)) || (busy && !idleWarm(running)),
  endedAt,
  playing: current?.handle ? current.currentJob(Date.now()) : null,
});
// Barge-in: cut the stream on air and drop everything queued. Returns the sentence that was on air (or null).
export function stopAll() {
  let cut = null;
  const now = Date.now();
  for (const st of streams.splice(0)) {
    st.stopped = true;
    for (const j of st.jobs) {
      j.status = 'cancelled';
      if (j.file && existsSync(j.file)) rmSync(j.file, { force: true });
    }
  }
  if (current) cut = current.stop(now);
  return cut;
}
export const jobInfo = (id) => jobs.get(id) || null;

// A stream: the pieces of one reply (or one say) played as a single continuous publish. add() a sentence as
// soon as it exists; end() when there is no more. The first sentence's level and chime set the lead-in.
export function openStream({
  label = 'say',
  warm = false,
  cfg = {},
  output,
} = {}) {
  const out = warm ? 'camera' : resolveOutput(output);
  const id = randomBytes(6).toString('hex');
  // a real stream takes the camera link over from a warm one right away
  if (!warm) releaseWarm('hand over');
  const st = new SpeechStream({
    openPublish: out === 'mac' ? openMac : openPublish,
    log: (o) => logLine({ kind: label, output: out, ...o }),
    cfg: { ...streamConfig(), ...cfg },
    id,
  });
  st.warm = warm;
  st.output = out;
  streams.push(st);
  pump();
  return {
    id,
    output: out,
    stream: st,
    end: () => st.end(),
    add: (spec) => addJob(st, spec),
    get open() {
      return !st.ended && !st.stopped && !st.finished;
    },
  };
}
function addJob(
  st,
  {
    text,
    voice,
    level,
    rate,
    chime = true,
    chimeLevel = 0.008,
    file = null, // an audio file to play instead of synthesizing text (deleted afterward)
    band = true,
    fast = false,
    pcm = null, // ready 16 kHz mono PCM to play as it is (no synthesis or conditioning)
  },
) {
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
    pcm,
  };
  jobs.set(id, job);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  st.add(job);
  if (!pcm) prepare(job);
  return { id, status: job.status };
}

// One line, as its own short stream. (`fast` is gone: whether the amp is awake is judged when the publish
// opens.)
export function say(spec) {
  const s = openStream({ label: 'say', output: spec.output });
  const r = s.add(spec);
  s.end();
  return r;
}

// The warm link: converse mode opens a publish when someone starts talking (before the wake word is even
// recognized) so the bleep only has to be written into it, skipping the talk request and the publish setup.
// It plays a very low tone (GJ_WARM_PEAK, default 0, silence: 0.003 was a steady high tone on the camera speaker, 2026-11-10) and ends itself after
// GJ_WARM_IDLE_MS (4 s). A real stream (a reply) hands it over at once; stop, converse off and errors end it.
let warmStream = null;
const warmUsable = () =>
  warmStream &&
  !warmStream.ended &&
  !warmStream.stopped &&
  !warmStream.finished;
export function openWarm() {
  if (resolveOutput() === 'mac') return null; // the laptop has no link to warm
  if (warmUsable()) return warmStream;
  if (streams.some((st) => !idleWarm(st)) || (running && !idleWarm(running)))
    return null; // the camera is in use
  const peak = process.env.GJ_WARM_PEAK ?? '0';
  const w = openStream({
    label: 'wake-warm',
    warm: true,
    cfg: {
      aheadMs: 600,
      fillAheadMs: 120,
      tailMs: 150,
      idleEndMs: Number(process.env.GJ_WARM_IDLE_MS) || 4000,
      keepalive: Number(peak) > 0 ? 'tone' : 'silence',
      keepalivePeak: Number(peak) || 0,
    },
  });
  warmStream = w.stream;
  logLine({ kind: 'wake-warm', ev: 'warm-open', stream: w.id });
  return warmStream;
}
// Close the warm link cleanly (a reply needs it, the session ended, or nobody woke it).
export function releaseWarm(why = 'released') {
  const st = warmStream;
  if (!st || st.ended) return false;
  st.end();
  logLine({ kind: 'wake-warm', ev: 'warm-release', stream: st.id, why });
  return true;
}
// A short line that should come out as soon as possible: into the warm link when it is open, else its own stream.
export function sayFast(spec) {
  // the warm link is the camera's; the laptop has nothing to warm
  if (resolveOutput(spec.output) === 'mac' || !warmUsable())
    return say({ ...spec, fast: true });
  const st = warmStream;
  const r = addJob(st, { ...spec, fast: true });
  st.end();
  logLine({ kind: 'wake-warm', ev: 'warm-used', stream: st.id, job: r.id });
  return r;
}

export const sayStatus = (id) => {
  const j = jobs.get(id);
  return (
    j && {
      id,
      status: j.status,
      ahead: Math.max(
        0,
        streams.findIndex((st) => st.jobs.includes(j)),
      ),
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

// Converse mode: Lewis talks in the room, the agent reads it as text, replies go out through the camera.
// While on, it listens to the camera microphone continuously (one ffmpeg, raw PCM), cuts utterances by
// energy (converse-core.mjs), transcribes locally with whisper-cli (the same as ask.mjs) and keeps only
// utterances with a wake word. Events (partial and final transcripts, end of utterance, barge-in, agent
// interruptions) go to a private inbox file and to GET /api/converse/heard. Off by default, and off again
// after `idleSeconds` with no wake word. Audio is never kept: each piece goes to a temp WAV that is
// deleted as soon as it is transcribed. Full duplex: while the camera speaks the microphone stays open and
// an echo gate (converse-turns.mjs) listens for Lewis talking over it; see docs/converse-design.md.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as media from './media.mjs';
import * as speech from './say.mjs';
import * as reply from './reply.mjs';
import { TMP } from './paths.mjs';
import { transcribe, whisperReady } from './ask.mjs';
import {
  Segmenter,
  SelfGuard,
  Inbox,
  chimeWav,
  cleanWake,
  matchWake,
  rms,
  wavFromPcm,
} from './converse-core.mjs';
import { EchoGate, playbackReport } from './converse-turns.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (name, def) => Number(process.env[name]) || def;
export const INBOX_FILE = () =>
  process.env.GJ_CONVERSE_INBOX ||
  join(homedir(), '.cache', 'ghostjack', 'converse', 'inbox.jsonl');
const tilde = (p) => p.replace(homedir(), '~');
export const IDLE = { min: 30, max: 3600, def: 900 };
export const END_SILENCE = { min: 400, max: 2500, def: 900 };
const FRAME = 640; // bytes of a 20 ms frame
// Delay from the bridge starting to send a line to the microphone hearing it (camera playback delay plus
// the microphone stream's lag), and the camera's playback delay alone. Defaults are guesses until measured
// (tools/echo-calibrate.mjs).
const ECHO_DELAY_MS = () => num('GJ_ECHO_DELAY_MS', 1200);
const PLAY_LATENCY_MS = () => num('GJ_PLAY_LATENCY_MS', 600);
const PARTIAL_EVERY_MS = () => num('GJ_PARTIAL_EVERY_MS', 1500);

let inbox = null;
let sess = null; // the running session, or null
let lastStop = null; // why the last session ended

// Hallucinations whisper writes for silence and noise: "[BLANK_AUDIO]", "(music)".
export const cleanTranscript = (t) =>
  String(t ?? '')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function status() {
  const s = sess;
  const a = speech.activity();
  const playing =
    a.playing && a.playing.status === 'speaking' ? a.playing : null;
  return {
    on: !!s,
    state: s ? s.state : 'off',
    ...(s?.why ? { why: s.why } : {}),
    ...(!s && lastStop ? { lastStop } : {}),
    ...(s
      ? {
          wake: s.wake,
          idleSeconds: s.idleSeconds,
          idleLeftSeconds: Math.max(
            0,
            Math.round((s.lastWake + s.idleSeconds * 1000 - Date.now()) / 1000),
          ),
          endSilenceMs: s.endSilenceMs,
          since: new Date(s.since).toISOString(),
          mutedForSpeech: s.muted,
          inUtterance: s.seg.speaking,
          partial: s.partial,
          bargeActive: s.bargeActive,
        }
      : {}),
    playing: playing ? { text: playing.text, status: playing.status } : null,
    tones: { ...reply.tones },
    inbox: tilde(INBOX_FILE()),
    cursor: inbox ? inbox.n : 0,
    heard: inbox ? inbox.ring.filter((e) => e.type === 'final').slice(-5) : [],
    marks: inbox
      ? inbox.ring
          .filter((e) => e.type === 'barge' || e.type === 'interrupt')
          .slice(-5)
      : [],
    replies: reply.recentLines(),
  };
}

export const heard = (after) =>
  inbox ? inbox.since(after) : { cursor: 0, heard: [] };

export function start({ wake, idleSeconds, tones, endSilenceMs, chime } = {}) {
  if (sess) return status();
  if (!whisperReady())
    throw Object.assign(
      new Error(
        'whisper-cli or its model is missing (GJ_WHISPER, GJ_WHISPER_MODEL)',
      ),
      { code: 503 },
    );
  const idle = Math.round(Number(idleSeconds ?? IDLE.def));
  if (!Number.isFinite(idle) || idle < IDLE.min || idle > IDLE.max)
    throw Object.assign(
      new Error(`idleSeconds is ${IDLE.min} to ${IDLE.max}`),
      {
        code: 400,
      },
    );
  const endMs = Math.round(Number(endSilenceMs ?? END_SILENCE.def));
  if (
    !Number.isFinite(endMs) ||
    endMs < END_SILENCE.min ||
    endMs > END_SILENCE.max
  )
    throw Object.assign(
      new Error(`endSilenceMs is ${END_SILENCE.min} to ${END_SILENCE.max}`),
      { code: 400 },
    );
  if (tones) reply.setTones(tones);
  if (!inbox || inbox.file !== INBOX_FILE()) {
    const n = inbox ? inbox.n : 0;
    inbox = new Inbox(INBOX_FILE());
    inbox.n = n;
  }
  sweep();
  const segOpts = { hangoverMs: endMs };
  if (num('GJ_CONVERSE_MIN_RMS', 0))
    segOpts.minRms = num('GJ_CONVERSE_MIN_RMS', 0);
  const s = (sess = {
    state: 'starting',
    why: '',
    wake: cleanWake(wake),
    idleSeconds: idle,
    endSilenceMs: endMs,
    since: Date.now(),
    lastWake: Date.now(),
    seg: new Segmenter(segOpts),
    guard: new SelfGuard(num('GJ_CONVERSE_GUARD_MS', 2500)),
    gate: new EchoGate(),
    ring: [], // the last 1.5 s of microphone frames, kept while the camera speaks
    muted: false,
    partial: null,
    partialAt: 0,
    partialBusy: false,
    addressed: new Set(), // utterance ids that have shown a wake word
    ended: new Set(), // ids whose end was reported
    finals: new Set(), // ids already finished (a late partial is dropped)
    handle: null,
    work: Promise.resolve(),
    pending: 0,
    bargeActive: false,
    bargeId: null,
    bargeAt: 0,
    wasSpeaking: false,
  });
  lastStop = null;
  run(s).catch(() => {});
  if (chime === true) readyChime();
  return status();
}

export function stop(reason = 'switched off') {
  const s = sess;
  if (!s) return status();
  sess = null;
  lastStop = { reason, at: new Date().toISOString() };
  s.handle?.cancel();
  return status();
}

// Delete converse WAVs a killed run left behind.
function sweep() {
  try {
    for (const f of readdirSync(TMP))
      if (/^converse-.*\.wav$/.test(f)) rmSync(join(TMP, f), { force: true });
  } catch {
    /* no captures folder yet */
  }
}

async function run(s) {
  while (sess === s) {
    try {
      s.handle = media.listenStream();
    } catch {
      s.state = 'paused';
      s.why =
        'the camera is busy with a clip or recording; listening resumes after';
      await sleep(2500);
      continue;
    }
    const h = s.handle;
    s.state = 'listening';
    s.why = '';
    s.seg.reset();
    try {
      for await (const chunk of h.stream) {
        if (sess !== s) break;
        feed(s, chunk);
      }
    } catch {
      /* the stream ended badly; reconnect below */
    }
    const preempted = h.preempted();
    h.cancel();
    if (sess !== s) return;
    s.state = 'paused';
    s.why = preempted
      ? 'a clip or recording has the camera; listening resumes after'
      : 'the camera stream dropped; reconnecting';
    await sleep(preempted ? 1500 : 3000);
  }
}

const event = (fields) => inbox.add(fields);

// Echo gate over a chunk while the camera speaks: true when Lewis is talking over the playback.
function bargeCheck(s, chunk, job, now) {
  const env = job.ref?.env;
  if (!env || !job.publishAt) return false;
  const n = Math.floor(chunk.length / FRAME);
  let hit = false;
  for (let i = 0; i < n; i++) {
    const t = now - (n - i) * 20 - job.publishAt - ECHO_DELAY_MS();
    const idx = Math.floor(t / 20);
    // the loudest reference frame within +-150 ms: the delay is only roughly known
    let r = 0;
    for (let j = Math.max(0, idx - 7); j <= idx + 7 && j < env.length; j++)
      r = Math.max(r, env[j]);
    if (s.gate.push(rms(chunk, i * FRAME, FRAME), r)) hit = true;
  }
  return hit;
}

function feed(s, chunk) {
  const now = Date.now();
  const a = speech.activity();
  const onAir =
    a.playing && a.playing.status === 'speaking' && a.playing.text
      ? a.playing
      : null;
  s.muted = s.guard.muted(now, a.speaking);
  if (!s.state.startsWith('listening')) s.state = 'listening';

  if (now - s.lastWake > s.idleSeconds * 1000 && !s.seg.speaking) {
    stop('idle: no wake word for a while');
    return;
  }

  if (onAir && !s.bargeActive) {
    // The camera is speaking: keep the last 1.5 s, and watch for Lewis talking over it.
    s.ring.push(chunk);
    let size = s.ring.reduce((x, c) => x + c.length, 0);
    while (size > 48000 && s.ring.length > 1) size -= s.ring.shift().length;
    s.seg.reset();
    s.state = 'listening (camera is speaking; watching for an interruption)';
    if (bargeCheck(s, chunk, onAir, now)) bargeIn(s, now);
    return;
  }
  s.gate.reset();
  if (s.bargeActive && now - s.bargeAt > 30000) s.bargeActive = false;
  if (s.muted && !s.bargeActive) {
    s.ring = [];
    s.seg.reset();
    s.state = 'listening (muted while the camera speaks)';
    return;
  }

  const wasIn = s.seg.speaking;
  for (const u of s.seg.push(chunk)) {
    if (s.pending >= 3) continue; // transcription is behind; drop rather than pile up
    // turn-taking: tell the agent Lewis stopped, if the words so far were addressed to it
    if (s.addressed.has(u.id) || s.bargeActive) {
      s.ended.add(u.id);
      event({
        type: 'end',
        id: u.id,
        silenceMs: s.endSilenceMs,
        durationMs: u.durationMs,
      });
    }
    u.endedAt = new Date().toISOString();
    s.pending++;
    s.work = s.work.then(() => handle(s, u)).finally(() => s.pending--);
  }
  if (!wasIn && s.seg.speaking) s.partialAt = now;
  if (s.seg.speaking) maybePartial(s, now);
  else s.partial = null;
}

async function wavText(pcm, model) {
  const file = join(TMP, `converse-${randomBytes(6).toString('hex')}.wav`);
  try {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(file, wavFromPcm(pcm));
    return cleanTranscript(await transcribe(file, model));
  } catch {
    return '';
  } finally {
    rmSync(file, { force: true }); // audio is never kept
  }
}

// Live transcript: every PARTIAL_EVERY_MS, transcribe what has been said so far (one at a time). Whisper
// is not a streaming model, so this is the whole utterance again; GJ_WHISPER_PARTIAL_MODEL can name a
// smaller, faster model for it. Partials are only reported once a wake word shows (or after a barge-in).
function maybePartial(s, now) {
  if (s.partialBusy || now - s.partialAt < PARTIAL_EVERY_MS()) return;
  const pcm = s.seg.snapshot();
  const id = s.seg.currentId;
  if (!pcm || pcm.length < 32000) return; // under a second
  s.partialBusy = true;
  s.partialAt = now;
  const t0 = Date.now();
  wavText(pcm, process.env.GJ_WHISPER_PARTIAL_MODEL || undefined)
    .then((text) => {
      if (sess !== s || !text || s.finals.has(id)) return;
      const woke = matchWake(text, s.wake);
      if (woke) s.addressed.add(id);
      if (!s.addressed.has(id) && !s.bargeActive) return;
      if (s.partial?.id === id && s.partial.text === text) return;
      s.partial = { id, text, ms: Date.now() - t0 };
      event({ type: 'partial', id, text });
    })
    .finally(() => (s.partialBusy = false));
}

async function handle(s, u) {
  try {
    await handleOne(s, u);
  } finally {
    s.finals.add(u.id);
  }
}

async function handleOne(s, u) {
  const text = await wavText(u.pcm);
  if (!text || sess !== s) return;
  // The camera started talking while this was transcribed: it may be its own voice.
  if (!s.bargeActive && s.guard.muted(Date.now(), speech.activity().speaking))
    return;
  const m = matchWake(text, s.wake);
  const viaBarge = s.bargeActive;
  if (!m && !viaBarge) return;
  s.lastWake = Date.now();
  s.partial = null;
  // Words are only known to be addressed now, so the end of the utterance is reported late, with its time.
  if (!s.ended.has(u.id))
    event({
      type: 'end',
      id: u.id,
      endedAt: u.endedAt,
      late: true,
      silenceMs: s.endSilenceMs,
      durationMs: u.durationMs,
    });
  const e = {
    type: 'final',
    id: u.id,
    text,
    wake: m ? m.wake : null,
    durationMs: u.durationMs,
  };
  if (viaBarge) {
    e.interrupted = s.bargeId;
    s.bargeActive = false;
  }
  event(e);
}

// Lewis talked over the camera: stop the speaker, work out what was heard, tell the agent.
function bargeIn(s, now) {
  const cut = speech.stopAll();
  if (!cut) return;
  const r = reply.replyOf(cut.id);
  let report = { heard: [], cut: null, unplayed: [] };
  if (r) {
    r.cut = true;
    const t = reply.timeline(r, PLAY_LATENCY_MS());
    report = playbackReport(t, cut.stoppedAt ?? now);
    report.unsentText = r.buf;
  }
  s.bargeActive = true;
  s.bargeAt = now;
  const e = event({
    type: 'barge',
    reply: r ? r.id : null,
    ...report,
  });
  s.bargeId = e.n;
  // His words so far were in the ring while the camera spoke: start the utterance from them.
  const ring = Buffer.concat(s.ring);
  s.ring = [];
  s.gate.reset();
  s.seg.reset();
  s.seg.push(ring);
  s.lastWake = now;
  reply.playTone('heard');
}

// The agent cuts in on Lewis: tone, then the words; the event says where in his sentence it happened.
export function interrupt({ text, voice, level, rate }) {
  const s = sess;
  const id = s?.seg.currentId ?? null;
  const e = inbox
    ? event({
        type: 'interrupt',
        utterance: id,
        partialText: s?.partial?.id === id ? s.partial.text : null,
        text,
      })
    : null;
  const tone = reply.playTone('interrupting');
  const r = reply.append({ text, end: true, voice, level, rate });
  return { event: e ? e.n : null, utterance: id, tone: !!tone, reply: r };
}

// The old listening cue, for a chime when converse starts (kept for callers that want it).
export function readyChime() {
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, `chime-${randomBytes(6).toString('hex')}.wav`);
  writeFileSync(file, chimeWav());
  return speech.say({
    file,
    chime: false,
    band: false,
    level: speech.capLevel(0.02),
  });
}

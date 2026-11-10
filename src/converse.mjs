// Converse mode: Lewis talks in the room, the agent reads it as text, replies go out through /api/say.
// While on, it listens to the camera microphone continuously (one ffmpeg, raw PCM), cuts utterances by
// energy (converse-core.mjs), transcribes each locally with whisper-cli (the same as ask.mjs) and keeps
// only those with a wake word. Kept lines go to a private inbox file and to GET /api/converse/heard.
// Off by default, and off again after `idleSeconds` with no wake word. Audio is never kept: each utterance
// goes to a temp WAV that is deleted as soon as it is transcribed.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as media from './media.mjs';
import * as speech from './say.mjs';
import { transcribe, whisperReady } from './ask.mjs';
import {
  Segmenter,
  SelfGuard,
  Inbox,
  chimeWav,
  cleanWake,
  matchWake,
  wavFromPcm,
} from './converse-core.mjs';

const TMP = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const INBOX_FILE = () =>
  process.env.GJ_CONVERSE_INBOX ||
  join(homedir(), '.cache', 'ghostjack', 'converse', 'inbox.jsonl');
const tilde = (p) => p.replace(homedir(), '~');
export const IDLE = { min: 30, max: 3600, def: 900 };

let inbox = null;
let sess = null; // the running session, or null
const replies = [];
let lastStop = null; // why the last session ended

// Hallucinations whisper writes for silence and noise: "[BLANK_AUDIO]", "(music)", "you".
export const cleanTranscript = (t) =>
  String(t ?? '')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function noteReply(text) {
  replies.push({
    at: new Date().toISOString(),
    text: String(text).slice(0, 300),
  });
  if (replies.length > 10) replies.shift();
}

export function status() {
  const s = sess;
  const a = speech.activity();
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
          chime: s.chime,
          since: new Date(s.since).toISOString(),
          mutedForSpeech: s.guard.muted(Date.now(), a.speaking),
          inUtterance: s.seg.speaking,
        }
      : {}),
    inbox: tilde(INBOX_FILE()),
    cursor: inbox ? inbox.n : 0,
    heard: inbox ? inbox.ring.slice(-5) : [],
    replies: replies.slice(-5),
  };
}

export const heard = (after) =>
  inbox ? inbox.since(after) : { cursor: 0, heard: [] };

export function start({ wake, idleSeconds, chime } = {}) {
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
      { code: 400 },
    );
  if (!inbox || inbox.file !== INBOX_FILE()) {
    const n = inbox ? inbox.n : 0;
    inbox = new Inbox(INBOX_FILE());
    inbox.n = n;
  }
  const s = (sess = {
    on: true,
    state: 'starting',
    why: '',
    wake: cleanWake(wake),
    idleSeconds: idle,
    chime: chime === true,
    since: Date.now(),
    lastWake: Date.now(),
    seg: new Segmenter(
      Number(process.env.GJ_CONVERSE_MIN_RMS)
        ? { minRms: Number(process.env.GJ_CONVERSE_MIN_RMS) }
        : {},
    ),
    guard: new SelfGuard(Number(process.env.GJ_CONVERSE_GUARD_MS) || 2500),
    handle: null,
    work: Promise.resolve(),
    pending: 0,
    awaitingReply: false,
    wasSpeaking: false,
  });
  lastStop = null;
  run(s).catch(() => {});
  if (s.chime) playChime();
  return status();
}

export function stop(reason = 'switched off') {
  const s = sess;
  if (!s) return status();
  s.on = false;
  sess = null;
  lastStop = { reason, at: new Date().toISOString() };
  s.handle?.cancel();
  return status();
}

function playChime() {
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, `chime-${randomBytes(6).toString('hex')}.wav`);
  writeFileSync(file, chimeWav());
  speech.say({
    file,
    chime: false,
    band: false,
    level: speech.capLevel(0.02),
  });
}

async function run(s) {
  while (s.on) {
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
        if (!s.on) break;
        feed(s, chunk);
      }
    } catch {
      /* the stream ended badly; reconnect below */
    }
    const preempted = h.preempted();
    h.cancel();
    if (!s.on) return;
    s.state = 'paused';
    s.why = preempted
      ? 'a clip or recording has the camera; listening resumes after'
      : 'the camera stream dropped; reconnecting';
    await sleep(preempted ? 1500 : 3000);
  }
}

function feed(s, chunk) {
  const now = Date.now();
  const a = speech.activity();
  const muted = s.guard.muted(now, a.speaking);
  if (a.speaking) s.wasSpeaking = true;
  else if (s.wasSpeaking) {
    s.wasSpeaking = false;
    // The agent's reply has finished: one cue that it is listening again.
    if (s.chime && s.awaitingReply) {
      s.awaitingReply = false;
      playChime();
    }
  }
  if (!s.state.startsWith('listening')) s.state = 'listening';
  if (muted) {
    s.seg.reset();
    s.state = 'listening (muted while the camera speaks)';
    return;
  }
  if (now - s.lastWake > s.idleSeconds * 1000) {
    stop('idle: no wake word for a while');
    return;
  }
  for (const u of s.seg.push(chunk)) {
    if (s.pending >= 3) continue; // transcription is behind; drop rather than pile up
    s.pending++;
    s.work = s.work.then(() => handle(s, u)).finally(() => s.pending--);
  }
}

async function handle(s, u) {
  const file = join(TMP, `converse-${randomBytes(6).toString('hex')}.wav`);
  let text;
  try {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(file, wavFromPcm(u.pcm));
    text = cleanTranscript(await transcribe(file));
  } catch {
    text = null;
  } finally {
    rmSync(file, { force: true }); // audio is never kept
  }
  if (!text || !sess || sess !== s) return;
  // The camera started talking while this was transcribed: it may be its own voice.
  if (s.guard.muted(Date.now(), speech.activity().speaking)) return;
  const m = matchWake(text, s.wake);
  if (!m) return;
  s.lastWake = Date.now();
  s.awaitingReply = true;
  inbox.add({ text, wake: m.wake, durationMs: u.durationMs });
}

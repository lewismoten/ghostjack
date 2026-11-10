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
import { personas } from './personas.mjs';
import {
  Segmenter,
  SelfGuard,
  Inbox,
  chimeWav,
  cleanWake,
  isWakeOnly,
  WakeAck,
  BleepFilter,
  matchWake,
  rms,
  wavFromPcm,
} from './converse-core.mjs';
import { EchoGate, playbackReport } from './converse-turns.mjs';
import { note } from './history.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (name, def) => Number(process.env[name]) || def;
// One log line per utterance: kept or dropped and why (bridge.log), so a lost sentence can be traced.
const dlog = (what, u, why, text = '') =>
  console.log(
    `[converse] ${what} id=${u.id} ${Math.round(u.durationMs || 0)}ms ended=${u.endedAt || '?'} ${why}${text ? ` "${String(text).slice(0, 80)}"` : ''}`,
  );
const FOLLOW_MS = () =>
  process.env.GJ_FOLLOW_MS === '0' ? 0 : num('GJ_FOLLOW_MS', 20000);
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
// the first look for a wake word comes this long after speech starts (later partials keep PARTIAL_EVERY_MS)
const WAKE_FIRST_MS = () => num('GJ_WAKE_FIRST_MS', 700);

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

export function start({
  wake,
  idleSeconds,
  tones,
  endSilenceMs,
  chime,
  persona,
} = {}) {
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
    guard: new SelfGuard(num('GJ_CONVERSE_GUARD_MS', 200)),
    gate: new EchoGate({
      margin: num('GJ_ECHO_MARGIN', 1.6),
      floor: num('GJ_ECHO_FLOOR', 400),
      holdMs: num('GJ_ECHO_HOLD_MS', 200),
    }),
    ring: [], // the last 1.5 s of microphone frames, kept while the camera speaks
    muted: false,
    partial: null,
    partialAt: 0,
    partialBusy: false,
    addressed: new Set(), // utterance ids that have shown a wake word
    wakeAck: new WakeAck(), // one bleep per utterance
    bleep: new BleepFilter(),
    persona: persona?.name ?? null,
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
  if (process.env.GJ_BARGE === '0') return false; // barge-in off (until the echo is calibrated)
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

// The wake bleep is the camera speaking, but it must not mute the microphone or count as a reply: Lewis is
// talking over it on purpose. Only while it is expected is the speaker's activity ignored.
const bleeping = (s, now) => {
  if (!s.bleepJob) return false;
  const st = speech.sayStatus(s.bleepJob)?.status;
  if (st === 'queued' || st === 'speaking') {
    // armed when the sound actually starts, so the filter follows the camera's real delay
    if (st === 'speaking' && !s.bleepArmed) {
      s.bleepArmed = true;
      s.bleep.arm(now, ECHO_DELAY_MS());
    }
    s.bleepSeen = now;
    return true;
  }
  return now - (s.bleepSeen || 0) < ECHO_DELAY_MS() + 300; // its tail is still coming back from the room
};
const speakingNow = (s, now = Date.now()) =>
  speech.activity().speaking && !bleeping(s, now);

// A wake word was recognized in utterance `id`: play the bleep (once, only when the camera is quiet).
function wakeBleep(s, id, via, speechStartedAt) {
  if (!reply.tones.wake || !s.wakeAck.ack(id)) return;
  if (speech.activity().speaking) return; // a reply is on air: barge-in covers it
  const at = Date.now();
  s.bleepArmed = false;
  s.bleepSeen = at;
  s.bleepJob = reply.playTone('wake', { fast: true })?.id ?? null;
  event({
    type: 'wake',
    id,
    via,
    afterMs: speechStartedAt ? at - speechStartedAt : null,
  });
  dlog(
    'wake',
    { id, durationMs: 0 },
    `${via} bleep after ${speechStartedAt ? at - speechStartedAt : '?'} ms of speech`,
  );
}

function feed(s, chunk0) {
  const now = Date.now();
  const chunk = s.bleep.apply(chunk0, now);
  const a = { ...speech.activity(), speaking: speakingNow(s, now) };
  const onAir =
    a.playing && a.playing.status === 'speaking' && a.playing.text
      ? a.playing
      : null;
  if (a.speaking) s.lastSpokeAt = now; // a follow-up window after the camera speaks (see FOLLOW_MS)
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
  // right after a cut the speaker still plays out its buffer: don't take that tail for Lewis
  if (s.bargeActive && now - s.bargeAt < ECHO_DELAY_MS() + 500) {
    s.ring = [];
    s.seg.reset();
    return;
  }
  if (s.muted && !s.bargeActive) {
    s.ring = [];
    s.seg.reset();
    s.state = 'listening (muted while the camera speaks)';
    return;
  }

  const wasIn = s.seg.speaking;
  for (const u of s.seg.push(chunk)) {
    if (s.pending >= 3) {
      dlog('drop', u, 'transcription behind');
      continue; // transcription is behind; drop rather than pile up
    }
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
  if (!wasIn && s.seg.speaking) {
    s.partialAt = now - (PARTIAL_EVERY_MS() - WAKE_FIRST_MS());
    s.speechStart = now;
  }
  if (s.seg.speaking) maybePartial(s, now);
  else s.partial = null;
}

async function wavText(pcm, model, persona) {
  const file = join(TMP, `converse-${randomBytes(6).toString('hex')}.wav`);
  try {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(file, wavFromPcm(pcm));
    return cleanTranscript(
      await transcribe(file, model, personas.vocabularyPrompt(persona)),
    );
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
  const min = reply.tones.wake && !s.addressed.has(id) ? 16000 : 32000; // half a second to look for the wake word, else a second
  if (!pcm || pcm.length < min) return;
  s.partialBusy = true;
  s.partialAt = now;
  const t0 = Date.now();
  wavText(pcm, process.env.GJ_WHISPER_PARTIAL_MODEL || undefined, s.persona)
    .then((text) => {
      if (sess !== s || !text || s.finals.has(id)) return;
      const woke = matchWake(text, s.wake);
      if (woke) {
        s.addressed.add(id);
        wakeBleep(s, id, 'partial', s.speechStart);
      }
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
  const text = await wavText(u.pcm, undefined, s.persona);
  if (!text || sess !== s)
    return dlog('drop', u, text ? 'session ended' : 'no text from whisper');
  // The camera started talking while this was transcribed: it may be its own voice.
  if (!s.bargeActive && s.guard.muted(Date.now(), speakingNow(s)))
    return dlog('drop', u, 'camera spoke during transcription', text);
  const m = matchWake(text, s.wake);
  if (m)
    wakeBleep(
      s,
      u.id,
      'final',
      u.endedAt ? Date.parse(u.endedAt) - u.durationMs : null,
    );
  const wakeOnly = !!m && isWakeOnly(text, s.wake);
  const viaBarge = s.bargeActive;
  // After the camera has spoken, Lewis may just answer: an utterance that starts within FOLLOW_MS of the
  // end of speech is kept without a wake word (GJ_FOLLOW_MS, default 20 s; 0 turns it off).
  const follow =
    !m &&
    !viaBarge &&
    s.lastSpokeAt &&
    (u.endedAt && u.durationMs
      ? Date.parse(u.endedAt) - u.durationMs
      : Date.now()) -
      s.lastSpokeAt <=
      FOLLOW_MS();
  if (!m && !viaBarge && !follow)
    return dlog(
      'drop',
      u,
      `no wake word, ${s.lastSpokeAt ? Math.round(((u.endedAt ? Date.parse(u.endedAt) - u.durationMs : Date.now()) - s.lastSpokeAt) / 1000) + ' s after speech' : 'no speech yet'}`,
      text,
    );
  dlog('keep', u, m ? 'wake word' : viaBarge ? 'barge' : 'follow-up', text);
  // the follow-up window also restarts when Lewis is heard, so a long answer cut at the utterance
  // limit (or several sentences in a row) stays in the conversation (2026-11-10: the rest was dropped)
  s.lastSpokeAt = Date.now();
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
  if (follow) e.followUp = true;
  if (wakeOnly) e.wakeOnly = true;
  if (viaBarge) {
    e.interrupted = s.bargeId;
    s.bargeActive = false;
  }
  event(e);
  if (wakeOnly) note('mark', 'Waiting for Lewis to go on', { partial: text });
  else
    note('you', text, {
      ...(follow ? { followUp: true } : {}),
      ...(viaBarge ? { interrupted: true } : {}),
    });
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
  note('mark', 'Lewis talked over Patchwork', {
    heard: report.heardText || '',
    unheard: [report.unheardText, report.unsentText].filter(Boolean).join(' '),
  });
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
  note('mark', 'Patchwork cut in on Lewis', {
    partial: s?.partial?.id === id ? s.partial.text : null,
  });
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
    level: speech.capLevel(Number(process.env.GJ_REPLY_LEVEL) || 0.03),
  });
}

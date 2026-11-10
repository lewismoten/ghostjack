// Streamed replies and tones. The agent sends its text in pieces (POST /api/reply); each finished sentence
// or clause becomes one spoken line at once, and the next is synthesized while the last plays (say.mjs).
// This file also keeps the record converse mode needs after a barge-in: which lines were on air and when.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as speech from './say.mjs';
import { takeSegments, toneWav, TONE_KINDS } from './converse-turns.mjs';
import { TMP } from './paths.mjs';
import { note } from './history.mjs';

// Words the macOS voice says wrong, written the way they should sound (2026-11-10: "Glasseye" came out "glassy").
const SAY_AS = [
  [/\bglass-?eye\b/gi, 'glass eye'],
  [/\bghostjack\b/gi, 'Ghost Jack'],
];
export const sayable = (t) =>
  SAY_AS.reduce((s, [re, to]) => s.replace(re, to), t);

export const MAX_REPLY_CHARS = 2400;
// Tones, each on or off. Only the interruption tone is on by default; all are quiet and short.
export const tones = {
  start: false,
  done: false,
  interrupting: true,
  heard: false,
};
export function setTones(t) {
  if (!t || typeof t !== 'object')
    throw Object.assign(new Error('tones is an object like {"done":true}'), {
      code: 400,
    });
  for (const [k, v] of Object.entries(t)) {
    if (!TONE_KINDS.includes(k))
      throw Object.assign(
        new Error(`unknown tone; kinds are ${TONE_KINDS.join(', ')}`),
        { code: 400 },
      );
    tones[k] = v === true;
  }
  return { ...tones };
}

const replies = new Map();
const recent = []; // the last lines said, for the page
export function noteReply(text) {
  note('patchwork', text);
  recent.push({
    at: new Date().toISOString(),
    text: String(text).slice(0, 300),
  });
  if (recent.length > 10) recent.shift();
}
export const recentLines = () => recent.slice(-5);

// Play a named tone through the speaker (its own short stream; the lead-in is chosen when it opens).
export function playTone(kind, { force = false } = {}) {
  if (!force && !tones[kind]) return null;
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, `tone-${randomBytes(6).toString('hex')}.wav`);
  writeFileSync(file, toneWav(kind));
  return speech.say({
    file,
    chime: false,
    band: false,
    level: speech.capLevel(Number(process.env.GJ_REPLY_LEVEL) || 0.03),
  });
}

const newReply = () => {
  const id = randomBytes(6).toString('hex');
  const r = {
    id,
    buf: '',
    segments: [],
    closed: false,
    cut: false,
    chars: 0,
    stream: null,
  };
  replies.set(id, r);
  if (replies.size > 10) replies.delete(replies.keys().next().value);
  return r;
};
const err = (m, code, extra) => Object.assign(new Error(m), { code, ...extra });

// Append text to a reply (a new one when `id` is missing). `end` closes it. Returns the reply's view.
export function append({ id, text, end, voice, level, rate }) {
  const r = id ? replies.get(id) : newReply();
  if (!r) throw err('no such reply', 404);
  if (r.cut)
    throw err('Lewis interrupted this reply; stop sending it', 409, {
      interrupted: true,
    });
  if (r.closed) throw err('this reply is closed', 409);
  const t = sayable(String(text ?? ''));
  r.chars += t.length;
  if (r.chars > MAX_REPLY_CHARS)
    throw err(`a reply is ${MAX_REPLY_CHARS} characters at most`, 400);
  r.buf += t;
  const { segments, rest } = takeSegments(r.buf, {
    first: r.segments.length === 0,
    final: end === true,
  });
  r.buf = rest;
  for (const text of segments) {
    if (!r.segments.length) playTone('start');
    // the whole reply is one continuous publish; a new one only if the last closed itself (the agent paused
    // longer than the stream's idle limit) or was cut
    if (!r.stream?.open) r.stream = speech.openStream({ label: 'reply' });
    const job = r.stream.add({
      text,
      voice,
      level,
      rate,
      chime: false,
      chimeLevel: 0.008,
    });
    r.segments.push({ id: job.id, text });
    noteReply(text);
  }
  if (end === true) {
    r.closed = true;
    // the done tone rides at the end of the reply's own stream, right after the last word: a separate
    // publish came 5.5 s late and muted the mic while Lewis started answering (2026-11-10)
    if (r.segments.length && tones.done && r.stream?.open) {
      mkdirSync(TMP, { recursive: true });
      const file = join(TMP, `tone-${randomBytes(6).toString('hex')}.wav`);
      writeFileSync(file, toneWav('done'));
      r.stream.add({
        file,
        chime: false,
        band: false,
        level: speech.capLevel(Number(process.env.GJ_REPLY_LEVEL) || 0.03),
      });
    } else if (r.segments.length) playTone('done');
    r.stream?.end();
  }
  return view(r);
}

export const view = (r) => ({
  id: r.id,
  closed: r.closed,
  cut: r.cut,
  pendingText: r.buf.length,
  segments: r.segments.map((s) => ({
    id: s.id,
    text: s.text,
    status: speech.sayStatus(s.id)?.status ?? 'gone',
  })),
});
export const get = (id) => replies.get(id);

// The reply that owns the line on air (or null).
export function replyOf(jobId) {
  for (const r of replies.values())
    if (r.segments.some((s) => s.id === jobId)) return r;
  return null;
}

// Timeline of a reply for playbackReport: each line's speech start (an absolute time, from when its publish
// began plus the camera's playback delay and the line's lead-in) and length.
export function timeline(r, playLatencyMs) {
  return r.segments.map((s) => {
    const j = speech.jobInfo(s.id);
    return j?.publishAt && j.ref
      ? {
          id: s.id,
          text: s.text,
          startMs: j.publishAt + playLatencyMs + j.ref.leadMs,
          durMs: j.ref.speechMs,
        }
      : { id: s.id, text: s.text, startMs: Infinity, durMs: 0 };
  });
}

// Ask the room a question: say it (with the choices) through the camera, listen on the microphone for a
// few seconds, transcribe locally with whisper-cli and map what was said to a choice. The page can answer
// by button instead; whichever comes first wins. One ask at a time.
// GJ_WHISPER and GJ_WHISPER_MODEL override the program and model; if either is missing the transcript
// is null (the ask then times out unless a button answers).
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as speech from './say.mjs';
import * as media from './media.mjs';

const WHISPER = () => process.env.GJ_WHISPER || '/opt/homebrew/bin/whisper-cli';
const MODEL = () =>
  process.env.GJ_WHISPER_MODEL ||
  join(homedir(), '.cache', 'whisper-cpp', 'ggml-large-v3.bin');

export const LETTERS = ['a', 'b', 'c', 'd'];
// Words a transcriber writes for a spoken letter. Spoken to the camera as the first word of each pair
// (a text-to-speech voice reads a bare "A" as the article).
const LETTER_WORDS = {
  a: ['a', 'ay', 'eh', 'alpha'],
  b: ['b', 'bee', 'be', 'bravo'],
  c: ['c', 'see', 'sea', 'cee', 'charlie'],
  d: ['d', 'dee', 'delta'],
};
const SPOKEN = { a: 'ay', b: 'bee', c: 'see', d: 'dee' };

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// The spoken prompt: the question, then each choice with its letter, then the way out.
export function promptText(question, choices, other) {
  const parts = choices.map((c, i) => `Say ${SPOKEN[LETTERS[i]]} for ${c}`);
  return `${question}  ${parts.join(', ')}${other ? ', or say something else' : ''}.`;
}

// Map a transcript to 'a'..'d', or 'other' / null. A choice's own words win; otherwise a short reply
// containing a letter word counts.
export function mapAnswer(transcript, choices, other) {
  const t = norm(transcript);
  if (!t) return null;
  const texts = choices.map(norm);
  let best = -1;
  texts.forEach((c, i) => {
    if (c.length >= 2 && (` ${t} `.includes(` ${c} `) || c === t))
      if (best < 0 || c.length > texts[best].length) best = i;
  });
  if (best >= 0) return LETTERS[best];
  const words = t.split(' ');
  if (words.length <= 4)
    for (const w of words)
      for (const [k, list] of Object.entries(LETTER_WORDS))
        if (list.includes(w) && LETTERS.indexOf(k) < choices.length) return k;
  return other ? 'other' : null;
}

// Transcribe a WAV with whisper-cli. Resolves to the text, or null when whisper or its model is missing
// or fails.
export function transcribe(wav) {
  if (!existsSync(WHISPER()) || !existsSync(MODEL()))
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn(
      WHISPER(),
      ['-m', MODEL(), '-f', wav, '-l', 'en', '-nt', '-np'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    media.children.add(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill('SIGKILL'), 120000);
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      clearTimeout(t);
      media.children.delete(p);
      resolve(code === 0 ? out.replace(/\s+/g, ' ').trim() : null);
    });
  });
}

const asks = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (a) => a.status === 'asking' || a.status === 'listening';

export const view = (a) =>
  a && {
    id: a.id,
    status: a.status,
    question: a.question,
    choices: a.choices,
    other: a.other,
    choice: a.choice,
    transcript: a.transcript,
    ...(a.source ? { source: a.source } : {}),
    ...(a.error ? { error: a.error } : {}),
  };
export const get = (id) => asks.get(id);
export const pending = () =>
  [...asks.values()].reverse().find((a) => open(a)) || null;

function finish(a, patch) {
  if (!open(a)) return false;
  Object.assign(a, patch);
  a.cancel?.();
  return true;
}

// Answer from the page's button (or an agent): the first answer wins.
export function answer(id, choice, text) {
  const a = asks.get(id);
  if (!a) throw Object.assign(new Error('no such ask'), { code: 404 });
  const c = String(choice ?? '').toLowerCase();
  const ok =
    (c === 'other' && a.other) ||
    (LETTERS.includes(c) && LETTERS.indexOf(c) < a.choices.length);
  if (!ok)
    throw Object.assign(new Error('not one of the choices'), { code: 400 });
  const t = text === undefined ? null : String(text).slice(0, 200);
  if (
    !finish(a, {
      status: 'answered',
      choice: c,
      transcript: t ?? a.transcript,
      source: 'button',
    })
  )
    throw Object.assign(new Error('already answered'), { code: 409 });
  return view(a);
}

export function ask({ question, choices, other, listen, voice, level, rate }) {
  if (pending())
    throw Object.assign(new Error('another ask is open'), { code: 409 });
  const id = randomBytes(6).toString('hex');
  const a = {
    id,
    status: 'asking',
    question,
    choices,
    other,
    choice: null,
    transcript: null,
  };
  asks.set(id, a);
  if (asks.size > 20) asks.delete(asks.keys().next().value);
  const spoken = speech.say({
    text: promptText(question, choices, other),
    voice,
    level,
    rate,
    chime: true,
    chimeLevel: speech.chimeFor(level),
  });
  (async () => {
    let wav = null;
    try {
      for (;;) {
        if (!open(a)) return;
        const s = speech.sayStatus(spoken.id);
        if (!s || s.status === 'done') break;
        if (s.status === 'failed') {
          finish(a, { status: 'failed', error: s.error || 'speech failed' });
          return;
        }
        await sleep(250);
      }
      await sleep(800); // the speaker's own buffer finishes before the microphone opens
      if (!open(a)) return;
      a.status = 'listening';
      const rec = media.listen(listen, 'wav');
      a.cancel = rec.cancel;
      wav = await rec.done.catch((e) => {
        if (e.code === 499) return null;
        throw e;
      });
      a.cancel = null;
      if (!open(a) || !wav) return;
      const transcript = await transcribe(wav);
      if (!open(a)) return;
      const choice = mapAnswer(transcript, choices, other);
      finish(a, {
        status: choice ? 'answered' : 'timeout',
        choice,
        transcript,
        source: choice ? 'voice' : undefined,
      });
    } catch (e) {
      finish(a, {
        status: 'failed',
        error: String(e.message || e).slice(0, 120),
      });
    } finally {
      if (wav) rmSync(wav, { force: true });
    }
  })();
  return view(a);
}

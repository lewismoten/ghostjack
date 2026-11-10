// Pure pieces of converse mode (no camera, no network): the speech segmenter, wake-word matching, the
// guard that keeps the camera from hearing its own voice, the inbox of heard lines, line splitting for long
// replies, and WAV helpers. src/converse.mjs wires them to the microphone.
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const RATE = 16000; // samples per second of the PCM the segmenter reads (16 kHz mono s16le)

// ---- speech segmenter -------------------------------------------------------------------------------
// Cuts a PCM stream into utterances by energy. Quiet frames set a slow noise floor; speech is a run of
// frames above max(minRms, floor x factor). An utterance ends after `hangoverMs` of quiet or at `maxMs`.
export const SEGMENTER_DEFAULTS = {
  frameMs: 20,
  minRms: 250, // of 32768; about -42 dBFS
  factor: 3, // speech must be this many times the noise floor
  startMs: 80, // loud this long in a row starts an utterance
  preRollMs: 300,
  hangoverMs: 900,
  trailMs: 250, // quiet kept after the last loud frame
  minVoicedMs: 300, // shorter bursts (a door, a cough) are dropped
  maxMs: 20000,
};

export function rms(buf, off = 0, len = buf.length - off) {
  let s = 0;
  const n = len >> 1;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(off + i * 2);
    s += v * v;
  }
  return n ? Math.sqrt(s / n) : 0;
}

export class Segmenter {
  constructor(opts = {}) {
    const o = { ...SEGMENTER_DEFAULTS, ...opts };
    this.o = o;
    this.frameBytes = ((RATE * o.frameMs) / 1000) * 2;
    this.startFrames = Math.max(1, Math.round(o.startMs / o.frameMs));
    this.preFrames = Math.round(o.preRollMs / o.frameMs);
    this.hangFrames = Math.round(o.hangoverMs / o.frameMs);
    this.trailFrames = Math.round(o.trailMs / o.frameMs);
    this.maxFrames = Math.round(o.maxMs / o.frameMs);
    this.reset();
  }
  reset() {
    this.rest = Buffer.alloc(0);
    this.floor = null;
    this.ring = [];
    this.loudRun = 0;
    this.utter = null; // { id, frames, quiet, voiced }
  }
  count = 0;
  // The audio of the utterance in progress so far (for a partial transcript), or null.
  snapshot() {
    return this.utter ? Buffer.concat(this.utter.frames) : null;
  }
  get currentId() {
    return this.utter ? this.utter.id : null;
  }
  get threshold() {
    return Math.max(this.o.minRms, (this.floor ?? 0) * this.o.factor);
  }
  get speaking() {
    return !!this.utter;
  }
  // Feed PCM; returns the utterances that finished: [{ pcm, durationMs, voicedMs }].
  push(chunk) {
    const out = [];
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= this.frameBytes) {
      const frame = buf.subarray(off, off + this.frameBytes);
      off += this.frameBytes;
      const done = this.#frame(frame);
      if (done) out.push(done);
    }
    this.rest = Buffer.from(buf.subarray(off));
    return out;
  }
  #frame(frame) {
    const level = rms(frame);
    const loud = level > this.threshold;
    const u = this.utter;
    if (!u) {
      if (!loud)
        this.floor =
          this.floor === null ? level : this.floor * 0.97 + level * 0.03;
      this.ring.push(frame);
      if (this.ring.length > this.preFrames + this.startFrames)
        this.ring.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= this.startFrames) {
        this.utter = {
          id: ++this.count,
          frames: [...this.ring],
          quiet: 0,
          voiced: this.loudRun,
        };
        this.ring = [];
        this.loudRun = 0;
      }
      return null;
    }
    u.frames.push(frame);
    if (loud) {
      u.quiet = 0;
      u.voiced++;
    } else u.quiet++;
    if (u.quiet >= this.hangFrames || u.frames.length >= this.maxFrames)
      return this.#finish();
    return null;
  }
  // End the utterance now (for the stream's end). Returns it or null.
  flush() {
    return this.utter ? this.#finish() : null;
  }
  #finish() {
    const u = this.utter;
    this.utter = null;
    const keep = Math.max(
      0,
      u.frames.length - Math.max(0, u.quiet - this.trailFrames),
    );
    const frames = u.frames.slice(0, keep);
    const voicedMs = u.voiced * this.o.frameMs;
    if (voicedMs < this.o.minVoicedMs) return null;
    return {
      id: u.id,
      pcm: Buffer.concat(frames),
      durationMs: frames.length * this.o.frameMs,
      voicedMs,
    };
  }
}

// A 16 kHz mono 16-bit WAV from PCM.
export function wavFromPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// A short two-note rising cue as a WAV (the "ready to listen" chime). Peak is kept low on purpose; the
// speaker is loud and say.mjs scales it again.
export function chimeWav(peak = 0.6) {
  const notes = [
    [880, 0.12],
    [1320, 0.16],
  ];
  const parts = [];
  for (const [hz, sec] of notes) {
    const n = Math.round(RATE * sec);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 160, (n - i) / 400);
      b.writeInt16LE(
        Math.round(
          Math.sin((2 * Math.PI * hz * i) / RATE) * env * peak * 32767,
        ),
        i * 2,
      );
    }
    parts.push(b, Buffer.alloc(Math.round(RATE * 0.04) * 2));
  }
  return wavFromPcm(Buffer.concat(parts));
}

// ---- wake words -------------------------------------------------------------------------------------
export const DEFAULT_WAKE = ['patchwork', 'glasseye'];
// How a transcriber tends to write each name (spaced, misheard). Compared with spaces removed.
const ALIASES = {
  patchwork: [
    'patch work',
    'patchwerk',
    'patchwurk',
    'pachwork',
    'patchworks',
    'patch works',
  ],
  glasseye: [
    'glass eye',
    'glass i',
    'glass eyes',
    'glasseyes',
    'glass-eye',
    'glass high',
  ],
};

export const normText = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const squash = (s) => normText(s).replace(/ /g, '');

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}

// Clean a configured wake list: lowercase words and phrases, 2 to 30 characters, at most 6.
export function cleanWake(list) {
  if (!Array.isArray(list)) return [...DEFAULT_WAKE];
  const out = [];
  for (const w of list) {
    const k = squash(w);
    if (k.length >= 3 && k.length <= 30 && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 6).length ? out.slice(0, 6) : [...DEFAULT_WAKE];
}

// The wake word in a transcript, or null: { wake, index (word position), atStart }. Looks at each word and
// each run of two or three words joined ("patch work" is "patchwork"), allowing one slip in names of
// eight letters or more. A word merely containing the name ("dispatchworkers") does not count.
export function matchWake(text, wakes = DEFAULT_WAKE) {
  const words = normText(text).split(' ').filter(Boolean);
  if (!words.length) return null;
  const targets = wakes.map((w) => ({
    wake: w,
    keys: [w, ...(ALIASES[w] || []).map(squash)],
  }));
  for (let i = 0; i < words.length; i++)
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const s = words.slice(i, i + n).join('');
      for (const t of targets)
        for (const k of t.keys)
          if (s === k || (k.length >= 8 && s.length >= 8 && lev(s, k) <= 1))
            return { wake: t.wake, index: i, atStart: i <= 2 };
    }
  return null;
}

// ---- the camera's own voice -------------------------------------------------------------------------
// The camera must not transcribe itself: muted while it speaks (or has speech queued) and for `tailMs`
// after, because the microphone stream runs a little behind and the room rings.
export class SelfGuard {
  constructor(tailMs = 2500) {
    this.tailMs = tailMs;
    this.lastSpeech = -Infinity;
  }
  muted(now, speaking) {
    if (speaking) this.lastSpeech = now;
    return speaking || now - this.lastSpeech < this.tailMs;
  }
}

// ---- long replies -----------------------------------------------------------------------------------
// Split text into lines of at most `max` characters, at sentence ends where it can, else at spaces.
export function splitLines(text, max = 280) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return [];
  const sentences = t.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [t];
  const out = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (let s of sentences) {
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max);
      flush();
      const at = cut > max * 0.4 ? cut : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if ((cur + s).trim().length > max) flush();
    cur += s;
  }
  flush();
  return out;
}

// ---- the inbox --------------------------------------------------------------------------------------
// Heard lines: one small JSON object per line appended to a file (private to the owner), and a ring in
// memory that GET /api/converse/heard reads by cursor. Only transcripts are ever stored.
export class Inbox {
  constructor(file, max = 100) {
    this.file = file;
    this.max = max;
    this.ring = [];
    this.n = 0;
  }
  // Any event: { type, ...fields }. Adds the cursor `n` and the time `at`.
  add(fields) {
    const entry = { n: ++this.n, at: new Date().toISOString(), ...fields };
    this.ring.push(entry);
    if (this.ring.length > this.max) this.ring.shift();
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* not ours to change; fine */
      }
    }
    return entry;
  }
  // Entries after cursor `after` (0 or missing is from the start of what is kept).
  since(after = 0) {
    const a = Number(after) || 0;
    return { cursor: this.n, heard: this.ring.filter((e) => e.n > a) };
  }
}

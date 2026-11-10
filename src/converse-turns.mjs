// Pure pieces of full-duplex conversation: cutting streamed reply text into spoken segments, word timing
// and the "what was heard" report after a barge-in, the echo gate that tells Lewis's voice from the
// camera's own speaker, the lag estimate for calibrating it, and the short tones. No camera here.
import { RATE, wavFromPcm } from './converse-core.mjs';

// ---- streamed replies -------------------------------------------------------------------------------
// Take the complete spoken segments out of `buf` (text the agent has written so far). A segment ends at a
// sentence end; the first one may also end at a comma once it is 30 characters long, so speech starts
// early; later ones at a comma once they are 70. Nothing longer than `max`. `final` flushes the rest.
export function takeSegments(
  buf,
  { first = false, final = false, max = 280 } = {},
) {
  const out = [];
  let rest = String(buf ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^ /, '');
  let isFirst = first;
  for (;;) {
    const clauseMin = isFirst ? 30 : 70;
    let cut = -1;
    const sentence = /[.!?]+["')\]]*(?= )/g;
    let m;
    while ((m = sentence.exec(rest))) {
      if (m.index + m[0].length <= max) cut = m.index + m[0].length;
      break;
    }
    if (cut < 0) {
      const clause = /[,;:](?= )| —(?= )/g;
      while ((m = clause.exec(rest))) {
        const end = m.index + m[0].length;
        if (end >= clauseMin && end <= max) {
          cut = end;
          break;
        }
        if (end > max) break;
      }
    }
    if (cut < 0 && rest.length > max) {
      const sp = rest.lastIndexOf(' ', max);
      cut = sp > max * 0.4 ? sp : max;
    }
    if (cut < 0) break;
    const seg = rest.slice(0, cut).trim();
    if (seg) out.push(seg);
    rest = rest.slice(cut).replace(/^ /, '');
    isFirst = false;
  }
  if (final && rest.trim()) {
    out.push(rest.trim());
    rest = '';
  }
  return { segments: out, rest };
}

// ---- what was heard ---------------------------------------------------------------------------------
// Word times inside a segment, spread by letters over its speech duration (a stand-in for synthesizer word
// marks, which macOS `say` does not give).
export function wordTimes(text, durMs) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return words.map((word, i) => {
    const startMs = (t / total) * durMs;
    t += weights[i];
    return { word, startMs, endMs: (t / total) * durMs };
  });
}

// After playback was cut at `cutMs` (counted from the start of the reply's first segment's speech), say
// which segments were heard in full, where the cut fell and what never played.
// segments: [{ id, text, startMs, durMs }] in order. A word counts as heard once it has finished; the one
// the cut fell inside is `cutWord` (heard in part); the rest are unheard.
export function playbackReport(segments, cutMs) {
  const heard = [],
    unplayed = [];
  let cut = null;
  for (const s of segments) {
    if (cutMs >= s.startMs + s.durMs) heard.push(s.id);
    else if (cutMs <= s.startMs) unplayed.push(s.id);
    else {
      const rel = cutMs - s.startMs;
      const w = wordTimes(s.text, s.durMs);
      const done = w.filter((x) => x.endMs <= rel);
      const mid = w.find((x) => x.startMs < rel && x.endMs > rel) || null;
      cut = {
        id: s.id,
        wordsHeard: done.map((x) => x.word),
        cutWord: mid ? mid.word : null,
        wordsUnheard: w.filter((x) => x.startMs >= rel).map((x) => x.word),
      };
    }
  }
  const text = (ids) =>
    segments
      .filter((s) => ids.includes(s.id))
      .map((s) => s.text)
      .join(' ');
  return {
    heard,
    cut,
    unplayed,
    heardText: [text(heard), cut ? cut.wordsHeard.join(' ') : '']
      .filter(Boolean)
      .join(' '),
    unheardText: [
      cut ? [cut.cutWord, ...cut.wordsUnheard].filter(Boolean).join(' ') : '',
      text(unplayed),
    ]
      .filter(Boolean)
      .join(' '),
  };
}

// ---- echo gate --------------------------------------------------------------------------------------
// While the camera speaks its microphone hears the speaker. We know what is being played (its 20 ms
// loudness envelope `ref`), so the echo is predicted as k x ref, with k (how much of the speaker the
// microphone hears) learned slowly from frames that look like echo alone. Lewis talking over it adds to the
// microphone more than the prediction: barge-in is `holdMs` of mic > margin x prediction + floor.
// Uncalibrated until measured in the room; see docs/converse-design.md.
export class EchoGate {
  constructor({
    margin = 1.6,
    floor = 400,
    holdMs = 200,
    k = 0.3,
    frameMs = 20,
    warm = 20,
  } = {}) {
    Object.assign(this, {
      margin,
      floor,
      holdFrames: Math.round(holdMs / frameMs),
      k,
      run: 0,
    });
    this.warmLeft = warm;
    this.kCap = Infinity;
  }
  // mic and ref are RMS of the same 20 ms (ref already shifted by the speaker-to-microphone delay). The
  // first `warm` loud reference frames of a session only learn k (nobody is assumed to talk over the very
  // first words); after that k follows the echo slowly.
  push(mic, ref) {
    const loud = ref > 600;
    const warming = loud && this.warmLeft > 0;
    if (warming) {
      this.warmLeft--;
      const r = mic / ref;
      this.k += (r - this.k) * 0.25;
      this.kCap = this.k * 1.3; // a voice must not be learned as echo
      this.run = 0;
      return false;
    }
    const over = mic > this.margin * this.k * ref + this.floor;
    this.run = over ? this.run + 1 : 0;
    if (!over && loud) {
      // echo alone: up fast and down slow, so a loud echo is never taken for a voice
      const r = mic / ref;
      this.k = Math.min(
        this.kCap,
        this.k + (r - this.k) * (r > this.k ? 0.004 : 0.01),
      );
    }
    return this.run >= this.holdFrames;
  }
  reset() {
    this.run = 0;
  }
}

// How many frames the microphone envelope lags the played one: the lag (0..maxFrames) at which they
// match best, by correlation of mean-removed envelopes. For tools/echo-calibrate (a test tone burst played
// through the camera and recorded); returns { lag, score }.
export function estimateLag(ref, mic, maxFrames = 150) {
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const mr = mean(ref),
    mm = mean(mic);
  let best = { lag: 0, score: -Infinity };
  for (let lag = 0; lag <= maxFrames; lag++) {
    let s = 0;
    for (let i = 0; i < ref.length && i + lag < mic.length; i++)
      s += (ref[i] - mr) * (mic[i + lag] - mm);
    if (s > best.score) best = { lag, score: s };
  }
  return best;
}

// ---- tones ------------------------------------------------------------------------------------------
// Short and distinct, one per event; the peak is low (say.mjs caps and scales it again).
export const TONES = {
  start: {
    name: 'agent starts speaking',
    notes: [
      [660, 0.09],
      [880, 0.09],
    ],
  },
  done: {
    name: 'agent finished',
    notes: [
      [880, 0.09],
      [660, 0.12],
    ],
  },
  interrupting: {
    name: 'agent is interrupting',
    notes: [
      [1000, 0.07],
      [0, 0.05],
      [1000, 0.07],
    ],
  },
  heard: { name: 'your interruption was heard', notes: [[1250, 0.08]] },
};
export function toneWav(kind, peak = 0.5) {
  const parts = [];
  for (const [hz, sec] of TONES[kind].notes) {
    const n = Math.round(RATE * sec),
      b = Buffer.alloc(n * 2);
    for (let i = 0; i < n && hz; i++) {
      const env = Math.min(1, i / 120, (n - i) / 240);
      b.writeInt16LE(
        Math.round(
          Math.sin((2 * Math.PI * hz * i) / RATE) * env * peak * 32767,
        ),
        i * 2,
      );
    }
    parts.push(b);
  }
  return wavFromPcm(Buffer.concat(parts));
}
export const TONE_KINDS = Object.keys(TONES);

// Glassmouth's browser voice (web/glass.js) plays through the Mac speaker, so the room microphone hears it
// as if Lewis said it ("Hold on.", "Closing the eye." glued onto his sentence). The page reports each line
// as it starts and ends (POST /api/converse/page-voice); this module keeps those windows and cleans a
// transcribed utterance two ways: by time (inside a window plus a tail: dropped; overlapping an end: those
// words trimmed) and by text (a line the page spoke in the last few seconds is cut off either end).
import { normText } from './converse-core.mjs';
import { wordTimes } from './converse-turns.mjs';

export class PageVoice {
  constructor({ tailMs = 1500, leadMs = 300, recentMs = 8000 } = {}) {
    Object.assign(this, { tailMs, leadMs, recentMs });
    this.spans = []; // { text, start, end|null }
  }
  set(speaking, text, now = Date.now()) {
    this.spans = this.spans.filter((w) => now - (w.end ?? w.start) < 60000);
    const open = this.spans.findLast((w) => w.end === null);
    if (speaking) {
      if (open) open.end = now; // a new line cancelled the old one
      this.spans.push({ text: String(text ?? ''), start: now, end: null });
    } else if (open) open.end = now;
    else this.spans.push({ text: String(text ?? ''), start: now, end: now });
  }
  // The utterance's text, cleaned ('' means drop it), with why when anything was removed.
  // a, b: when the audio began and ended (ms).
  filter(text, a, b, now = Date.now()) {
    const all = String(text).split(/\s+/).filter(Boolean);
    const times = wordTimes(all.join(' '), Math.max(1, b - a));
    let items = all.map((word, i) => ({
      word,
      mid: a + (times[i].startMs + times[i].endMs) / 2,
    }));
    let why = '';
    for (const w of this.spans) {
      const lo = w.start - this.leadMs,
        hi = (w.end ?? now) + this.tailMs;
      const inside = items.map((x) => x.mid >= lo && x.mid <= hi);
      const n = inside.filter(Boolean).length;
      // only a start, an end or the whole: a window strictly inside the speech is left to the text filter
      if (!n || (n < items.length && !(inside[0] !== inside.at(-1)))) continue;
      items = items.filter((_, i) => !inside[i]);
      why = items.length ? 'page voice at an end' : 'inside page voice';
    }
    let words = items.map((x) => x.word);
    // the text safety net: a line spoken in the last few seconds, at either end
    for (const w of this.spans) {
      if (now - (w.end ?? now) > this.recentMs) continue;
      const line = normText(w.text).split(' ').filter(Boolean);
      if (!line.length) continue;
      for (let again = true; again && words.length;) {
        again = false;
        const nw = words.map(normText);
        const at = (from) =>
          line.every((x, i) => nw[from + i] === x) && from >= 0;
        if (at(words.length - line.length)) {
          words = words.slice(0, words.length - line.length);
          again = true;
        } else if (at(0) && words.length >= line.length) {
          words = words.slice(line.length);
          again = true;
        }
        if (again) why ||= 'page voice line';
      }
    }
    return { text: words.join(' '), why };
  }
}

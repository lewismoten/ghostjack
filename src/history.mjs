// The conversation history: both sides in order (Lewis's final utterances, each line Patchwork said, and the
// interruption marks), kept in a private git-ignored file next to the inbox and served by
// GET /api/converse/history. Bounded by count and age. Transcripts only; no audio.
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HISTORY_FILE = () =>
  process.env.GJ_CONVERSE_HISTORY ||
  join(homedir(), '.cache', 'ghostjack', 'converse', 'history.jsonl');
export const MAX_ENTRIES = 2000;
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SLACK = 200; // rewrite the file only once it is this far past the bound

export class History {
  constructor(
    file,
    { max = MAX_ENTRIES, maxAgeMs = MAX_AGE_MS, now = Date.now } = {},
  ) {
    this.file = file;
    this.max = max;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.entries = [];
    this.n = 0;
    this.fileLines = 0;
    this.load();
  }
  load() {
    if (!this.file) return;
    let raw;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      try {
        const e = JSON.parse(line);
        if (e && Number.isFinite(e.n)) this.entries.push(e);
      } catch {
        /* a torn last line; skip it */
      }
    }
    this.fileLines = this.entries.length;
    this.n = this.entries.reduce((m, e) => Math.max(m, e.n), 0);
    this.trim();
  }
  trim() {
    const cutoff = this.now() - this.maxAgeMs;
    let dropped = false;
    while (
      this.entries.length &&
      (this.entries.length > this.max ||
        Date.parse(this.entries[0].at) < cutoff)
    ) {
      this.entries.shift();
      dropped = true;
    }
    return dropped;
  }
  // who: 'you' | 'patchwork' | 'mark'. Extra fields (followUp, interrupted, heard, unheard) ride along.
  add(who, text, extra = {}) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    const e = {
      n: ++this.n,
      at: new Date(this.now()).toISOString(),
      who,
      text: t,
      ...extra,
    };
    this.entries.push(e);
    this.fileLines++;
    this.trim();
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        if (this.fileLines > this.max + SLACK) {
          writeFileSync(
            this.file,
            this.entries.map((x) => JSON.stringify(x)).join('\n') + '\n',
            { mode: 0o600 },
          );
          this.fileLines = this.entries.length;
        } else {
          appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 });
        }
        chmodSync(this.file, 0o600);
      } catch {
        /* history is a convenience; never break a conversation over it */
      }
    }
    return e;
  }
  // Entries with n > since, the last `limit` of them, oldest first.
  since(since = 0, limit = 500) {
    const s = Number(since) || 0;
    const l = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 500));
    return {
      cursor: this.n,
      entries: this.entries.filter((e) => e.n > s).slice(-l),
    };
  }
}

let shared = null;
export const history = () => (shared ??= new History(HISTORY_FILE()));
export const note = (who, text, extra) => history().add(who, text, extra);

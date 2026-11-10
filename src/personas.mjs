// Personas: a voice and a manner of speaking per agent. Shipped examples are tracked in personas/*.json;
// Lewis's choices (edits, the default, which agent uses which persona, the lock) live in one untracked file,
// ~/.config/ghostjack/personas.local.json (GJ_PERSONAS_LOCAL moves it). A persona applies voice, rate, level
// and pronunciation fixes to a reply or a say, and its wake words and tones to a conversation.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TONE_KINDS } from './converse-turns.mjs';

export const SHIPPED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'personas',
);
export const LOCAL_FILE = () =>
  process.env.GJ_PERSONAS_LOCAL ||
  join(homedir(), '.config', 'ghostjack', 'personas.local.json');

const err = (m, code = 400) => Object.assign(new Error(m), { code });
const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const AGENT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED = ['settings'];
// Text a persona may carry: letters, digits, spaces and plain punctuation. No markup, no control characters.
const SAFE = /^[\p{L}\p{N} '’.,!?:;()-]*$/u;
const VOICE = /^[A-Za-z0-9 ()._-]{1,40}$/;
export const DEFAULT_VOCABULARY = [
  'Patchwork',
  'Glasseye',
  'Ghost Jack',
  'Glassmouth',
  'Gwinn',
  'Teddy',
  'Kaylee',
  'Codex',
  'Doc Leo',
  'THE CHEZ',
  'Game-Maker',
  'CYD',
  'Pi',
  'netrunner',
];
// the whole word list handed to the transcriber is this many characters at most
export const VOCAB_CHARS = 400;
export const LIMITS = {
  wakeWords: 6,
  sayAs: 30,
  glossary: 40,
  line: 200,
  bytes: 12000,
};

export const isName = (n) =>
  typeof n === 'string' && NAME.test(n) && !RESERVED.includes(n);
export const cleanAgent = (a) => {
  const s = String(a ?? '')
    .trim()
    .toLowerCase();
  return AGENT.test(s) ? s : '';
};

function text(v, what, max, { required = false } = {}) {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s && required) throw err(`${what} is needed`);
  if (s.length > max) throw err(`${what} is ${max} characters at most`);
  if (!SAFE.test(s))
    throw err(
      `${what} may use letters, digits, spaces and . , ! ? : ; ( ) - only`,
    );
  return s;
}

function vocabulary_(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw err('vocabulary is a list of words');
  const out = [];
  for (const w of v) {
    const s = text(w, 'a vocabulary word', 40, { required: true });
    if (!out.includes(s)) out.push(s);
  }
  if (out.join(', ').length > VOCAB_CHARS)
    throw err(`vocabulary is ${VOCAB_CHARS} characters at most`);
  return out;
}

// Check and normalize a persona. Throws a 400 error that says what is wrong.
export function validatePersona(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p))
    throw err('a persona is a JSON object');
  if (JSON.stringify(p).length > LIMITS.bytes) throw err('persona too large');
  if (!isName(p.name))
    throw err(
      'name is 1 to 24 characters: a to z, 0 to 9 and -, starting with a letter or digit ("settings" is reserved)',
    );
  const out = { name: p.name };
  const voice = String(p.voice ?? '').trim();
  if (voice && !VOICE.test(voice)) throw err('voice has unsafe characters');
  out.voice = voice;
  const rate = Number(p.rate ?? 140);
  if (!Number.isFinite(rate) || rate < 90 || rate > 220)
    throw err('rate is 90 to 220 words a minute');
  out.rate = Math.round(rate);
  const level = Number(p.level ?? 0.03);
  if (!Number.isFinite(level) || level < 0.01 || level > 0.05)
    throw err('level is 0.01 to 0.05');
  out.level = level;
  const style = String(p.style ?? 'netrunner')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9-]{1,24}$/.test(style))
    throw err('style is a short word like "netrunner" or "plain"');
  out.style = style;
  const wake = p.wakeWords ?? [];
  if (!Array.isArray(wake) || wake.length > LIMITS.wakeWords)
    throw err(`wakeWords is a list of ${LIMITS.wakeWords} words at most`);
  out.wakeWords = wake.map((w) => {
    const s = String(w).trim().toLowerCase();
    if (!/^[a-z]{3,30}$/.test(s)) throw err('a wake word is 3 to 30 letters');
    return s;
  });
  const sa = p.sayAs ?? [];
  if (!Array.isArray(sa) || sa.length > LIMITS.sayAs)
    throw err(`sayAs is a list of ${LIMITS.sayAs} pairs at most`);
  out.sayAs = sa.map((pair) => {
    if (!pair || typeof pair !== 'object')
      throw err('sayAs pairs are {from, to}');
    const from = text(pair.from, 'sayAs.from', 40, { required: true });
    const to = text(pair.to, 'sayAs.to', 60);
    return { from, to };
  });
  const g = p.glossary ?? {};
  if (!g || typeof g !== 'object' || Array.isArray(g))
    throw err('glossary is an object of term: meaning');
  const terms = Object.entries(g);
  if (terms.length > LIMITS.glossary)
    throw err(`glossary has ${LIMITS.glossary} terms at most`);
  out.glossary = Object.fromEntries(
    terms.map(([k, v]) => [
      text(k, 'glossary term', 30, { required: true }),
      text(v, 'glossary meaning', LIMITS.line),
    ]),
  );
  out.vocabulary = vocabulary_(p.vocabulary);
  out.greeting = text(p.greeting, 'greeting', LIMITS.line);
  out.signoff = text(p.signoff, 'signoff', LIMITS.line);
  const t = p.tones ?? {};
  if (!t || typeof t !== 'object' || Array.isArray(t))
    throw err('tones is an object like {"done":true}');
  out.tones = {};
  for (const [k, v] of Object.entries(t)) {
    if (!TONE_KINDS.includes(k))
      throw err(`unknown tone; kinds are ${TONE_KINDS.join(', ')}`);
    out.tones[k] = v === true;
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Apply a persona's pronunciation pairs: whole words, any case, the first pair that fits a place wins.
export function applySayAs(t, pairs = []) {
  let s = String(t);
  for (const { from, to } of pairs)
    s = s.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escape(from)}(?![\\p{L}\\p{N}])`, 'giu'),
      () => to,
    );
  return s;
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export class Personas {
  constructor({ dir = SHIPPED_DIR, localFile = LOCAL_FILE } = {}) {
    this.dir = dir;
    this.localFile =
      typeof localFile === 'function' ? localFile : () => localFile;
  }
  #local() {
    const j = readJson(this.localFile());
    const l = j && typeof j === 'object' ? j : {};
    return {
      default: typeof l.default === 'string' ? l.default : '',
      lock: l.lock === true,
      agents: l.agents && typeof l.agents === 'object' ? l.agents : {},
      personas: l.personas && typeof l.personas === 'object' ? l.personas : {},
      vocabulary: Array.isArray(l.vocabulary) ? l.vocabulary : null,
    };
  }
  #write(l) {
    const f = this.localFile();
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, f);
  }
  #shipped() {
    const out = {};
    if (!existsSync(this.dir)) return out;
    for (const f of readdirSync(this.dir).sort()) {
      if (!f.endsWith('.json') || f === 'schema.json') continue;
      try {
        const p = validatePersona(readJson(join(this.dir, f)));
        if (`${p.name}.json` === f) out[p.name] = p;
      } catch {
        /* a shipped file that does not validate is skipped */
      }
    }
    return out;
  }
  // name -> {...persona, source: 'shipped' | 'local' | 'edited'}
  all() {
    const ship = this.#shipped();
    const loc = this.#local().personas;
    const out = {};
    for (const [n, p] of Object.entries(ship))
      out[n] = { ...p, source: 'shipped' };
    for (const [n, raw] of Object.entries(loc)) {
      try {
        const p = validatePersona({ ...raw, name: n });
        out[n] = { ...p, source: ship[n] ? 'edited' : 'local' };
      } catch {
        /* skip a bad local entry */
      }
    }
    return out;
  }
  list() {
    return Object.values(this.all());
  }
  get(name) {
    return this.all()[name] ?? null;
  }
  settings() {
    const l = this.#local();
    const all = this.all();
    const def = all[l.default]
      ? l.default
      : all.patchwork
        ? 'patchwork'
        : (Object.keys(all)[0] ?? '');
    const agents = {};
    for (const [a, p] of Object.entries(l.agents))
      if (AGENT.test(a) && all[p]) agents[a] = p;
    let vocabulary = DEFAULT_VOCABULARY;
    if (l.vocabulary)
      try {
        vocabulary = vocabulary_(l.vocabulary);
      } catch {
        /* a bad saved list falls back to the default */
      }
    return { default: def, lock: l.lock, agents, vocabulary };
  }
  save(p) {
    const v = validatePersona(p);
    const l = this.#local();
    const { name, ...rest } = v;
    l.personas[name] = rest;
    this.#write(l);
    return this.get(name);
  }
  // Remove a local persona, or undo edits to a shipped one. A shipped persona itself cannot be deleted.
  remove(name) {
    const l = this.#local();
    if (!(name in l.personas)) {
      if (this.get(name))
        throw err('a shipped persona has no edits to remove', 409);
      throw err('no such persona', 404);
    }
    delete l.personas[name];
    this.#write(l);
    this.#heal(l);
    return true;
  }
  // drop a default or an assignment that points at a persona that is gone
  #heal(l) {
    const all = this.all();
    if (!all[l.default]) l.default = '';
    for (const [a, p] of Object.entries(l.agents))
      if (!all[p]) delete l.agents[a];
    this.#write(l);
  }
  setSettings({ default: def, lock, agents, vocabulary: vocab } = {}) {
    const l = this.#local();
    const all = this.all();
    if (def !== undefined) {
      if (!all[def]) throw err('unknown persona for the default');
      l.default = def;
    }
    if (lock !== undefined) l.lock = lock === true;
    if (vocab !== undefined) l.vocabulary = vocabulary_(vocab);
    if (agents !== undefined) {
      if (!agents || typeof agents !== 'object' || Array.isArray(agents))
        throw err('agents is an object of agent: persona');
      const n = Object.entries(agents);
      if (n.length > 30) throw err('30 agents at most');
      const next = {};
      for (const [a, p] of n) {
        const k = cleanAgent(a);
        if (!k || k !== a)
          throw err(`agent name "${a}" is 1 to 32 letters, digits, - or _`);
        if (!all[p]) throw err(`unknown persona "${p}" for ${a}`);
        next[k] = p;
      }
      l.agents = next;
    }
    this.#write(l);
    return this.settings();
  }
  // The initial prompt for the transcriber: the global word list and the persona's, 400 characters at most.
  vocabularyPrompt(personaName) {
    const words = [...this.settings().vocabulary];
    for (const w of this.get(personaName)?.vocabulary ?? [])
      if (!words.includes(w)) words.push(w);
    let out = '';
    for (const w of words) {
      const next = out ? `${out}, ${w}` : w;
      if (next.length > VOCAB_CHARS) break;
      out = next;
    }
    return out;
  }
  // Which persona a call uses. `persona` is what the agent asked for, `agent` who it says it is. With the lock
  // on, Lewis's assignment (or the default) wins over a request. Unknown requested names are errors.
  resolve({ persona, agent } = {}) {
    const s = this.settings();
    const a = cleanAgent(agent);
    const want =
      persona === undefined || persona === null || persona === ''
        ? ''
        : String(persona);
    if (want && !s.lock) {
      const p = this.get(want);
      if (!p) throw err('unknown persona', 400);
      return p;
    }
    const name = (a && s.agents[a]) || s.default;
    return this.get(name) ?? null;
  }
}

export const personas = new Personas();

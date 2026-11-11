// Per-speaker setup: how loud each output is. A persona's `output` picks the speaker; the speaker's own setting
// decides loudness. Kept in the untracked ~/.config/ghostjack/speakers.local.json (GJ_SPEAKERS_LOCAL moves it, mode 0600).
// camera.level: speech level for the camera speaker (0.01 to 0.05, the hard cap in say.mjs); unset = the persona's level.
// mac.gain: the laptop player's volume multiplier (1 to 40); GJ_MAC_GAIN overrides it. The Mac output device is always the
// system default: ffplay cannot pick one reliably on macOS.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const FILE = () =>
  process.env.GJ_SPEAKERS_LOCAL ||
  join(homedir(), '.config', 'ghostjack', 'speakers.local.json');
export const LIMITS = {
  camera: { min: 0.01, max: 0.05, step: 0.005 },
  mac: { min: 1, max: 40, step: 1 },
};
const DEFAULT_GAIN = 14;

function load() {
  try {
    const j = JSON.parse(readFileSync(FILE(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};

// Values in force: the file's, with GJ_MAC_GAIN overriding the laptop gain.
export function get() {
  const f = load();
  const env = Number(process.env.GJ_MAC_GAIN) || null;
  const cam = num(f.camera?.level, LIMITS.camera.min, LIMITS.camera.max);
  const gain = num(f.mac?.gain, LIMITS.mac.min, LIMITS.mac.max);
  return {
    camera: { level: cam },
    mac: { gain: env ?? gain ?? DEFAULT_GAIN, device: 'default' },
    limits: LIMITS,
    overrides: { macGain: env !== null },
    defaults: { cameraLevel: 0.03, macGain: DEFAULT_GAIN },
  };
}
export const cameraLevel = () => get().camera.level;
export const macGain = () => get().mac.gain;

// Validate and save. Unknown keys are refused; out-of-range numbers are errors, not clamped.
export function set(body) {
  const bad = (m) => Object.assign(new Error(m), { code: 400 });
  if (!body || typeof body !== 'object') throw bad('an object is needed');
  for (const k of Object.keys(body))
    if (!['camera', 'mac'].includes(k)) throw bad(`unknown speaker ${k}`);
  const f = load();
  const field = (sp, key, lim) => {
    const v = body[sp]?.[key];
    if (v === undefined) return;
    if (v === null && sp === 'camera') {
      delete f.camera;
      return;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < lim.min || n > lim.max)
      throw bad(`${sp} ${key} must be ${lim.min} to ${lim.max}`);
    f[sp] = { ...f[sp], [key]: n };
  };
  field('camera', 'level', LIMITS.camera);
  field('mac', 'gain', LIMITS.mac);
  const file = FILE();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return get();
}
export const exists = () => existsSync(FILE());

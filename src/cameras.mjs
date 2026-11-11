// The camera registry: Glasseye (the Tethys IP camera) plus USB cameras and microphones the Mac lists
// through avfoundation. Two separate choices live here: the active camera (look, snapshot, clip, live
// view) and the listening mic (listen, ask, converse). Devices are found and kept by NAME, never by
// index (indexes change when something is plugged in). Choices are saved to
// ~/.config/ghostjack/cameras.local.json (GJ_CAMERAS_LOCAL moves it), 0600, never in the repository.
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const GLASSEYE = 'glasseye';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const FILE =
  process.env.GJ_CAMERAS_LOCAL ||
  join(homedir(), '.config', 'ghostjack', 'cameras.local.json');
const CACHE_MS = 30000;

const GLASSEYE_ENTRY = {
  id: GLASSEYE,
  name: 'Glasseye',
  kind: 'tethys',
  capabilities: ['video', 'mic', 'speaker', 'ptz'],
};

let lister = defaultLister; // () => Promise<string>: ffmpeg's device list text
let found = []; // avfoundation entries from the last discovery
let foundAt = 0;
let modeLister = defaultModeLister; // (videoName) => Promise<string>: ffmpeg's "Supported modes" text
const modes = new Map(); // video device name -> [{ size: 'WxH', fps: [numbers] }], cached
let choice = load(); // { active, mic, modes: { [cameraId]: { size, fps } } }

function defaultLister() {
  if (process.env.GJ_FAKE_AVF_LIST)
    return Promise.resolve(readFileSync(process.env.GJ_FAKE_AVF_LIST, 'utf8'));
  return new Promise((resolve) =>
    // ffmpeg prints the list on stderr and exits 1; that is normal.
    execFile(
      FFMPEG,
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { timeout: 10000 },
      (_e, _out, err) => resolve(String(err || '')),
    ),
  );
}

function defaultModeLister(name) {
  if (process.env.GJ_FAKE_AVF_MODES)
    return Promise.resolve(readFileSync(process.env.GJ_FAKE_AVF_MODES, 'utf8'));
  return new Promise((resolve) =>
    // Asking for 1 fps makes ffmpeg fail and print every mode the device offers.
    execFile(
      FFMPEG,
      [
        '-hide_banner',
        '-f',
        'avfoundation',
        '-framerate',
        '1',
        '-i',
        `${name}:none`,
      ],
      { timeout: 10000 },
      (_e, _out, err) => resolve(String(err || '')),
    ),
  );
}

// Parse "Supported modes" lines such as `640x480@[5.000000 30.000000]fps` into [{ size, fps: [..] }].
export function parseModes(text) {
  const by = new Map();
  for (const m of text.matchAll(/(\d+)x(\d+)@\[([\d.]+)\s+([\d.]+)\]fps/g)) {
    const size = `${m[1]}x${m[2]}`;
    const set = by.get(size) || new Set();
    for (const f of [m[3], m[4]]) set.add(Math.round(Number(f) * 100) / 100);
    by.set(size, set);
  }
  return [...by].map(([size, set]) => ({
    size,
    fps: [...set].sort((a, b) => a - b),
  }));
}

// The default mode: the largest 16:9 size at 30 fps (else the largest size, at its fps nearest 30).
export function defaultMode(list) {
  if (!list.length) return null;
  const area = (m) => m.size.split('x').reduce((a, b) => a * b, 1);
  const wide = (m) => {
    const [w, h] = m.size.split('x').map(Number);
    return Math.abs(w / h - 16 / 9) < 0.02;
  };
  const pool = list.filter(wide);
  const best = [...(pool.length ? pool : list)].sort(
    (a, b) => area(b) - area(a),
  )[0];
  const fps = [...best.fps].sort(
    (a, b) => Math.abs(a - 30) - Math.abs(b - 30),
  )[0];
  return { size: best.size, fps };
}

function load() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      active: typeof j.active === 'string' ? j.active : GLASSEYE,
      mic: typeof j.mic === 'string' ? j.mic : GLASSEYE,
      modes: j.modes && typeof j.modes === 'object' ? j.modes : {},
    };
  } catch {
    return { active: GLASSEYE, mic: GLASSEYE, modes: {} };
  }
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(choice, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, FILE);
  } catch {
    /* the choice still holds for this run */
  }
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Parse `ffmpeg -f avfoundation -list_devices true -i ""` text into registry entries.
export function parseDevices(text) {
  const video = [],
    audio = [];
  let into = null;
  for (const line of text.split('\n')) {
    if (/AVFoundation video devices/i.test(line)) into = video;
    else if (/AVFoundation audio devices/i.test(line)) into = audio;
    else if (into) {
      const m = /\[\d+\]\s+(.+?)\s*$/.exec(line);
      if (m) into.push(m[1]);
    }
  }
  const out = [];
  const usedAudio = new Set();
  for (const v of video) {
    if (/^capture screen/i.test(v)) continue; // screens are not cameras
    const a = audio.find(
      (n) => n !== v && n.toLowerCase().startsWith(v.toLowerCase()),
    );
    if (a) usedAudio.add(a);
    out.push({
      id: slug(v),
      name: v,
      kind: 'avfoundation',
      capabilities: a ? ['video', 'mic'] : ['video'],
      device: { video: v, audio: a || null },
    });
  }
  for (const a of audio) {
    if (usedAudio.has(a)) continue;
    out.push({
      id: slug(a),
      name: a,
      kind: 'avfoundation',
      capabilities: ['mic'],
      device: { video: null, audio: a },
    });
  }
  return out;
}

export async function refresh(force = false) {
  if (!force && foundAt && Date.now() - foundAt < CACHE_MS) return;
  const text = await lister();
  if (text.trim() || !found.length) found = parseDevices(text);
  foundAt = Date.now();
}

// The mode a USB camera captures in: the saved choice if the camera still offers it, else the default.
export function modeFor(e) {
  if (!e || !e.device || !e.device.video) return null;
  const list = modes.get(e.device.video) || [];
  const c = choice.modes[e.id];
  if (c && list.some((m) => m.size === c.size && m.fps.includes(c.fps)))
    return { size: c.size, fps: c.fps };
  return defaultMode(list);
}

async function loadModes(e, force) {
  const name = e.device && e.device.video;
  if (!name || (!force && modes.has(name))) return;
  const text = await modeLister(name);
  const list = parseModes(text);
  // a failed or busy probe keeps what was known; an empty first probe is retried next time
  if (list.length) modes.set(name, list);
}

const publicEntry = (e) => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  capabilities: e.capabilities,
  active: e.id === choice.active,
  mic: e.id === choice.mic,
  ...(e.device && e.device.video
    ? { modes: modes.get(e.device.video) || [], mode: modeFor(e) }
    : {}),
});

const all = () => [GLASSEYE_ENTRY, ...found];
const entry = (id) => all().find((e) => e.id === id);

export async function list(force = false) {
  await refresh(force);
  await Promise.all(
    found.filter((e) => e.device.video).map((e) => loadModes(e, force)),
  );
  return {
    active: choice.active,
    mic: choice.mic,
    cameras: all().map(publicEntry),
  };
}

function need(id, cap) {
  const e = entry(id);
  if (!e)
    throw Object.assign(new Error(`no camera or mic called ${id}`), {
      code: 404,
    });
  if (!e.capabilities.includes(cap))
    throw Object.assign(new Error(`${e.name} has no ${cap}`), { code: 400 });
  return e;
}

export async function setActive(id) {
  await refresh(true);
  need(id, 'video');
  choice.active = id;
  save();
  return list();
}

// Choose a USB camera's live/snapshot/clip mode. Must be one the camera lists.
export async function setMode(id, size, fps) {
  await refresh();
  const e = need(id, 'video');
  if (e.kind === 'tethys')
    throw Object.assign(new Error('Glasseye has no choice of mode'), {
      code: 400,
    });
  await loadModes(e);
  const offered = modes.get(e.device.video) || [];
  const f = Number(fps);
  const m = offered.find((x) => x.size === size);
  if (!m)
    throw Object.assign(new Error(`${e.name} has no ${size} mode`), {
      code: 400,
    });
  if (!m.fps.includes(f))
    throw Object.assign(
      new Error(`${e.name} has no ${size} mode at ${fps} fps`),
      { code: 400 },
    );
  choice.modes[id] = { size, fps: f };
  save();
  return list();
}

export async function setMic(id) {
  await refresh(true);
  need(id, 'mic');
  choice.mic = id;
  save();
  return list();
}

// The camera a call uses: its own `camera` param, else the active one. Falls back to Glasseye when the
// saved choice is a USB device that is unplugged now.
export async function pickVideo(id) {
  if (!id && choice.active === GLASSEYE) return GLASSEYE_ENTRY; // the default needs no discovery
  await refresh();
  const e = id ? need(id, 'video') : entry(choice.active) || GLASSEYE_ENTRY;
  if (e.device) await loadModes(e);
  return e;
}

export async function pickMic(id) {
  if (!id && choice.mic === GLASSEYE) return GLASSEYE_ENTRY;
  await refresh();
  if (id) return need(id, 'mic');
  return entry(choice.mic) || GLASSEYE_ENTRY;
}

export const hasPtz = (e) => e.capabilities.includes('ptz');
export const isTethys = (e) => e.kind === 'tethys';

// The ffmpeg input for an avfoundation entry. `size` is WxH. The "video:audio" spec uses names.
export function avfInput(e, { video, audio, size = '1280x720' }) {
  const mode = modeFor(e); // the chosen (or default) mode wins over the caller's size
  const v = video && e.device.video ? e.device.video : 'none';
  const a = audio && e.device.audio ? e.device.audio : 'none';
  return [
    '-f',
    'avfoundation',
    ...(v !== 'none'
      ? [
          '-framerate',
          String(mode ? mode.fps : 30),
          '-video_size',
          mode ? mode.size : size,
        ]
      : []),
    '-i',
    `${v}:${a}`,
  ];
}

// The one-capture lock keys an avfoundation capture needs: one per device it opens.
export const avfKeys = (e, { video, audio }) => [
  ...(video && e.device.video ? [`avf:${e.device.video}`] : []),
  ...(audio && e.device.audio ? [`avf:${e.device.audio}`] : []),
];

// Test hooks.
export function _reset({ lister: l, file, modeLister: ml } = {}) {
  lister = l || defaultLister;
  modeLister = ml || defaultModeLister;
  modes.clear();
  found = [];
  foundAt = 0;
  choice =
    file === false || !existsSync(FILE)
      ? { active: GLASSEYE, mic: GLASSEYE, modes: {} }
      : load();
}

// Synchronous views of the saved choices (from the last discovery) for code that cannot await.
export const videoNow = () => entry(choice.active) || GLASSEYE_ENTRY;
export const micNow = () => entry(choice.mic) || GLASSEYE_ENTRY;

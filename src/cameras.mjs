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
let choice = load(); // { active, mic }

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

function load() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      active: typeof j.active === 'string' ? j.active : GLASSEYE,
      mic: typeof j.mic === 'string' ? j.mic : GLASSEYE,
    };
  } catch {
    return { active: GLASSEYE, mic: GLASSEYE };
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

const publicEntry = (e) => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  capabilities: e.capabilities,
  active: e.id === choice.active,
  mic: e.id === choice.mic,
});

const all = () => [GLASSEYE_ENTRY, ...found];
const entry = (id) => all().find((e) => e.id === id);

export async function list(force = false) {
  await refresh(force);
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
  if (id) return need(id, 'video');
  return entry(choice.active) || GLASSEYE_ENTRY;
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
  const v = video && e.device.video ? e.device.video : 'none';
  const a = audio && e.device.audio ? e.device.audio : 'none';
  return [
    '-f',
    'avfoundation',
    ...(v !== 'none' ? ['-framerate', '30', '-video_size', size] : []),
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
export function _reset({ lister: l, file } = {}) {
  lister = l || defaultLister;
  found = [];
  foundAt = 0;
  choice =
    file === false || !existsSync(FILE)
      ? { active: GLASSEYE, mic: GLASSEYE }
      : load();
}

// Synchronous views of the saved choices (from the last discovery) for code that cannot await.
export const videoNow = () => entry(choice.active) || GLASSEYE_ENTRY;
export const micNow = () => entry(choice.mic) || GLASSEYE_ENTRY;

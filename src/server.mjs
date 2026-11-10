// Ghost Jack bridge: a small HTTP API in front of the camera session, plus the control page in web/.
// Binds 127.0.0.1 by default. Every /api route except /api/hello needs the bearer token.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
  createReadStream,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camera } from './camera-select.mjs';
import * as speech from './say.mjs';
import * as rec from './record.mjs';
import * as media from './media.mjs';
import * as asker from './ask.mjs';
import { streamVideo } from './stream.mjs';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ALLOWED_ORIGIN = 'https://lewismoten.github.io';

function loadToken() {
  const dir = join(homedir(), '.config', 'ghostjack');
  const file = join(dir, 'token');
  // The project used to be called tethys-camera: carry its token over once.
  const old = join(homedir(), '.config', 'tethys-camera', 'token');
  if (!existsSync(file) && existsSync(old)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    renameSync(old, file);
    chmodSync(file, 0o600);
  }
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = randomBytes(24).toString('base64url');
  writeFileSync(file, t + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`Access token (created once; stored in ${file}):\n  ${t}`);
  return t;
}
const TOKEN = loadToken();

function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  let given = m?.[1];
  if (!given) given = new URL(req.url, 'http://x').searchParams.get('token'); // <video>/<img> cannot send headers
  if (!given) return false;
  const a = Buffer.from(given),
    b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Disposition, Content-Length',
    );
  }
}

const json = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 4096) throw new Error('body too large');
  }
  return s ? JSON.parse(s) : {};
}

// A raw request body (uploaded audio), at most `max` bytes.
async function readRaw(req, max) {
  const parts = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max)
      throw Object.assign(new Error(`body is ${max} bytes at most`), {
        code: 413,
      });
    parts.push(c);
  }
  return Buffer.concat(parts);
}

// Shared aim state (estimated pan and tilt in move units, plus the neck's measured range), so agents and
// other browsers see what the page learned. Kept in the owner's config folder, never in the repo.
const AIM_FILE = join(homedir(), '.config', 'ghostjack', 'aim.json');
let aim = { updated: 0 };
try {
  aim = JSON.parse(readFileSync(AIM_FILE, 'utf8'));
} catch {
  /* none yet */
}
const AIM_KEYS = ['pan', 'tilt', 'panMin', 'panMax', 'tiltMin', 'tiltMax'];
// Lens numbers from Find limits (degrees, degrees per move unit): decimals kept to 2 places.
const AIM_LENS = { fovH: [10, 170], fovV: [5, 120], tiltDegPerUnit: [0.01, 5] };
function setAim(b) {
  const n = { updated: Date.now() };
  for (const k of AIM_KEYS) {
    if (b[k] === null || b[k] === undefined) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || Math.abs(v) > 100000)
      throw Object.assign(new Error(`${k} must be a small number`), {
        code: 400,
      });
    n[k] = Math.round(v);
  }
  for (const [k, [lo, hi]] of Object.entries(AIM_LENS)) {
    if (b[k] === null || b[k] === undefined) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < lo || v > hi)
      throw Object.assign(new Error(`${k} must be between ${lo} and ${hi}`), {
        code: 400,
      });
    n[k] = Math.round(v * 100) / 100;
  }
  aim = n;
  mkdirSync(dirname(AIM_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(AIM_FILE, JSON.stringify(aim), { mode: 0o600 });
  return aim;
}

// Saved shots: nine numbered slots of pan, tilt and zoom, like the preset
// keypad on a camera controller (null = an empty slot). Positions are in the same estimated units as the aim.
const SHOTS_FILE = join(homedir(), '.config', 'ghostjack', 'shots.json');
let shots = [];
try {
  shots = JSON.parse(readFileSync(SHOTS_FILE, 'utf8'));
} catch {
  /* none yet */
}
const MAX_SHOTS = 9;
function setShots(list) {
  if (!Array.isArray(list) || list.length > MAX_SHOTS)
    throw Object.assign(new Error(`up to ${MAX_SHOTS} shots`), { code: 400 });
  const num = (v, lim) => {
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > lim)
      throw Object.assign(new Error('positions must be small numbers'), {
        code: 400,
      });
    return n;
  };
  shots = list.map((s) => {
    if (s === null) return null; // an empty slot
    const name = String(s?.name ?? '')
      .replace(/[^\p{L}\p{N} .,'&()-]/gu, '')
      .trim()
      .slice(0, 24);
    if (!name)
      throw Object.assign(new Error('each shot needs a name'), { code: 400 });
    const crop =
      Array.isArray(s.crop) && s.crop.length === 4
        ? s.crop.map((v) => Math.round(num(v, 1) * 1000) / 1000)
        : null;
    return {
      name,
      pan: Math.round(num(s.pan, 10000)),
      tilt: Math.round(num(s.tilt, 10000)),
      crop,
    };
  });
  mkdirSync(dirname(SHOTS_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(SHOTS_FILE, JSON.stringify(shots), { mode: 0o600 });
  return shots;
}
// A travel move (going to a saved shot or re-centering) is one long step at
// full speed instead of many small ones. The camera can't cancel it, so the
// bridge refuses other moves until it should have arrived.
const MS_PER_UNIT = 70; // a guess: a step of 10 at speed 100 takes about 0.7 s
const travelMs = (dx, dy) =>
  Math.round(
    (Math.max(Math.abs(dx), Math.abs(dy)) +
      Math.min(Math.abs(dx), Math.abs(dy)) / 2) *
      MS_PER_UNIT +
      500,
  );

// Getters only: nothing here changes the camera.
const PROBE_NAMES = new Set([
  'ccm_info_get',
  'ccm_misc_get',
  'ccm_osd_get',
  'ccm_speaker_get',
  'ccm_speakers_get',
  'ccm_mic_get',
  'ccm_mics_get',
  'ccm_video_srcs_get',
  'ccm_date_get',
  'ccm_ntp_get',
  'ccm_disk_get',
  'ccm_record_task_get',
  'ccm_alert_action_get',
  'ccm_alert_dev_get',
  'ccm_upgrade_get',
  'ccm_net_get',
  'ccm_dev_info_get',
  'ccm_devs_get',
  'ccm_msg_get',
  'ccm_hardware_test_get',
]);
// true or false from true, 1, 'on' ... false, 0, 'off'; undefined for anything else.
function onOff(v) {
  if (v === true || v === 1 || /^(on|1|true)$/i.test(String(v))) return true;
  if (v === false || v === 0 || /^(off|0|false)$/i.test(String(v)))
    return false;
  return undefined;
}

const SECRET =
  /(^|_)(sn|mac|id|nid|sid|uid|guid|serial|pwd|pass|password|key|token|sess|session|ip|gw|gateway|dns|ssid|bssid|mask|addr|address|user|name|nick|email|phone|qr)($|_)/i;
function redact(v, k = '') {
  if (Array.isArray(v)) return v.map((x) => redact(x, k));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([kk, x]) => [kk, redact(x, kk)]),
    );
  if (typeof v === 'string' && v && SECRET.test(k)) return '(masked)';
  // long letter-and-digit runs look like serials or cloud IDs
  if (
    typeof v === 'string' &&
    /[a-z]/i.test(v) &&
    /\d/.test(v) &&
    /^[0-9a-z]{10,}$/i.test(v)
  )
    return '(masked)';
  if (typeof v === 'string' && /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.test(v))
    return '(masked)';
  if (typeof v === 'string' && /\b\d{1,3}(\.\d{1,3}){3}\b/.test(v))
    return '(masked)';
  return v;
}

const clamp = (n, lim) =>
  Math.max(-lim, Math.min(lim, Math.round(Number(n) || 0)));
let lastMove = 0;
const sayTimes = []; // timestamps of recent say, play and ask requests (10 per minute, shared)
// Counts one use of the speaker; false when ten were used in the last minute.
function sayAllowed() {
  const now = Date.now();
  while (sayTimes.length && now - sayTimes[0] > 60000) sayTimes.shift();
  if (sayTimes.length >= 10) return false;
  sayTimes.push(now);
  return true;
}
const children = media.children;

const stream = (req, res, profile) =>
  streamVideo({ camera, ffmpeg: FFMPEG, children, req, res, profile });

// Go to an absolute pan/tilt (or a saved shot) in one travel move, wait for the picture to settle and
// answer with a snapshot. Headers: X-GJ-Pan, X-GJ-Tilt, X-GJ-Settled.
async function goto(req, res) {
  const b = await readBody(req);
  let tp, tt, crop;
  if (b.shot !== undefined) {
    const n = Number(b.shot);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SHOTS)
      return json(res, 400, { error: `shot is 1 to ${MAX_SHOTS}` });
    const s = shots[n - 1];
    if (!s) return json(res, 404, { error: `shot ${n} is empty` });
    [tp, tt, crop] = [s.pan, s.tilt, media.parseCrop(s.crop)];
  } else {
    [tp, tt] = [Number(b.pan), Number(b.tilt)];
    if (!Number.isFinite(tp) || !Number.isFinite(tt))
      return json(res, 400, { error: 'pan and tilt (or shot) needed' });
  }
  if (b.crop !== undefined) {
    crop = media.parseCrop(b.crop);
    if (!crop)
      return json(res, 400, { error: 'crop is [x, y, w, h] as fractions' });
  }
  const width = media.clampWidth(b.width, 1280);
  const lim = (v, lo, hi) =>
    Math.max(lo ?? -Infinity, Math.min(hi ?? Infinity, v));
  tp = lim(tp, aim.panMin, aim.panMax);
  tt = lim(tt, aim.tiltMin, aim.tiltMax);
  const cur = { pan: aim.pan ?? 0, tilt: aim.tilt ?? 0 };
  const dx = clamp(tp - cur.pan, 480),
    dy = clamp(tt - cur.tilt, 190);
  const now = Date.now();
  if (now - lastMove < 1000) return json(res, 429, { error: 'still moving' });
  const ms = travelMs(dx, dy);
  if (dx || dy) {
    lastMove = now + ms - 1000;
    await camera.move(dx, dy, 100);
    setAim({ ...aim, pan: cur.pan + dx, tilt: cur.tilt + dy });
  }
  const settled = dx || dy ? await media.waitSettled(ms) : true; // nothing moved: the picture is as settled as it will be
  lastMove = Math.min(lastMove, Date.now());
  const jpg = await media.reshapeJpeg(await camera.snapshot('p0'), {
    crop,
    width,
  });
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store',
    'X-GJ-Pan': String(cur.pan + dx),
    'X-GJ-Tilt': String(cur.tilt + dy),
    'X-GJ-Settled': settled ? '1' : '0',
    'Access-Control-Expose-Headers':
      'X-GJ-Pan, X-GJ-Tilt, X-GJ-Settled, Content-Length',
  });
  res.end(jpg);
}

// POST /api/clip (MP4) and POST /api/listen (WAV or M4A): record from the camera and send the file.
async function capture(req, res, isClip) {
  const b = await readBody(req);
  const seconds = Number(b.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30)
    return json(res, 400, { error: 'seconds is 1 to 30' });
  const secs = Math.round(seconds * 10) / 10;
  let job, type, ext;
  if (isClip) {
    job = media.clip(secs, media.clampWidth(b.width, 640), b.audio === true);
    [type, ext] = ['video/mp4', 'mp4'];
  } else {
    const m4a = b.format === 'm4a';
    if (b.format !== undefined && !['wav', 'm4a'].includes(b.format))
      return json(res, 400, { error: "format is 'wav' or 'm4a'" });
    job = media.listen(secs, m4a ? 'm4a' : 'wav');
    [type, ext] = [m4a ? 'audio/mp4' : 'audio/wav', m4a ? 'm4a' : 'wav'];
  }
  res.on('close', () => job.cancel());
  const file = await job.done;
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename="ghostjack-${isClip ? 'clip' : 'audio'}.${ext}"`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } finally {
    rmSync(file, { force: true });
  }
}

// POST /api/play: a raw audio body through the same queue, chime, normalizer and limiter as say.
async function play(req, res) {
  if (!/^audio\//i.test(req.headers['content-type'] || ''))
    return json(res, 415, { error: 'Content-Type audio/* needed' });
  const url = new URL(req.url, 'http://x');
  const flag = (k, d) => {
    const v = url.searchParams.get(k);
    return v === null ? d : !['0', 'false', 'no'].includes(v);
  };
  const body = await readRaw(req, 2 * 1024 * 1024);
  if (!body.length) return json(res, 400, { error: 'audio body needed' });
  if (!sayAllowed()) return json(res, 429, { error: 'ten says a minute' });
  let dec;
  try {
    dec = await speech.decodeUpload(body);
  } catch (e) {
    sayTimes.pop();
    throw e;
  }
  const level = speech.capLevel(url.searchParams.get('level')),
    chime = flag('chime', true),
    chimeLevel = speech.chimeFor(level);
  return json(res, 202, {
    level,
    chimeLevel: chime ? chimeLevel : null,
    seconds: dec.seconds,
    ...speech.say({
      file: dec.file,
      level,
      chime,
      chimeLevel,
      band: flag('band', true),
    }),
  });
}

// POST /api/ask: say a question with choices, listen, transcribe, answer. See src/ask.mjs.
async function ask(req, res) {
  const b = await readBody(req);
  const clean = (t) =>
    String(t ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const question = clean(b.question);
  const choices = Array.isArray(b.choices) ? b.choices.map(clean) : [];
  if (!question) return json(res, 400, { error: 'question needed' });
  if (choices.length < 2 || choices.length > 4 || choices.some((c) => !c))
    return json(res, 400, { error: 'choices: 2 to 4 short texts' });
  if (question.length + choices.join('').length > 280)
    return json(res, 400, { error: 'question and choices are too long' });
  const voice = b.voice ? String(b.voice) : '';
  if (voice && !(await speech.voices()).includes(voice))
    return json(res, 400, { error: 'unknown voice' });
  if (asker.pending()) return json(res, 409, { error: 'another ask is open' });
  if (!sayAllowed()) return json(res, 429, { error: 'ten says a minute' });
  const listen = Math.max(1, Math.min(15, Number(b.listen) || 6));
  const a = asker.ask({
    question,
    choices,
    other: b.other === true,
    listen,
    voice,
    level: speech.capLevel(b.level),
    rate: 140,
  });
  return json(res, 202, { id: a.id, status: a.status });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const file = join(WEB, rel);
  if (!file.startsWith(WEB) || !existsSync(file) || !TYPES[extname(file)]) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (!url.pathname.startsWith('/api/'))
      return serveStatic(req, res, url.pathname);
    if (url.pathname === '/api/hello')
      return json(res, 200, { name: 'ghostjack-bridge', ok: true });
    if (!authorized(req)) return json(res, 401, { error: 'token needed' });
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/status')
      return json(res, 200, await camera.status());
    if (route === 'GET /api/snapshot.jpg') {
      const q = url.searchParams;
      const jpg = await camera.snapshot(q.get('profile') || 'p0');
      const crop = media.parseCrop(
        (q.get('crop') || '').split(',').map(Number),
      );
      // The old behavior stays: a crop alone is scaled to 1280 wide; no crop and no width is untouched.
      const width = q.has('width')
        ? media.clampWidth(q.get('width'), 1280)
        : crop
          ? 1280
          : 0;
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
      });
      return res.end(await media.reshapeJpeg(jpg, { crop, width }));
    }
    if (route === 'POST /api/goto') return await goto(req, res);
    if (route === 'POST /api/clip' || route === 'POST /api/listen')
      return await capture(req, res, route.endsWith('clip'));
    if (route === 'POST /api/play') return await play(req, res);
    if (route === 'POST /api/ask') return await ask(req, res);
    if (route === 'GET /api/ask/pending') {
      const a = asker.pending();
      return json(res, 200, a ? asker.view(a) : { id: null });
    }
    const km = /^(GET|POST) \/api\/ask\/([0-9a-f]{12})(\/answer)?$/.exec(route);
    if (km) {
      const a = asker.get(km[2]);
      if (!a) return json(res, 404, { error: 'no such ask' });
      if (km[1] === 'GET' && !km[3]) return json(res, 200, asker.view(a));
      if (km[1] === 'POST' && km[3]) {
        const b = await readBody(req);
        return json(res, 200, asker.answer(km[2], b.choice, b.text));
      }
    }
    if (route === 'POST /api/move') {
      const b = await readBody(req);
      const dx = clamp(b.dx, 20),
        dy = clamp(b.dy, 20),
        speed = Math.max(1, clamp(b.speed ?? 100, 100));
      if (!dx && !dy) return json(res, 400, { error: 'dx or dy needed' });
      const now = Date.now();
      if (now - lastMove < 1000)
        return json(res, 429, { error: 'one move per second' });
      lastMove = now;
      await camera.move(dx, dy, speed);
      return json(res, 200, { ok: true, dx, dy, speed });
    }
    if (route === 'POST /api/travel') {
      const b = await readBody(req);
      const dx = clamp(b.dx, 480),
        dy = clamp(b.dy, 190);
      if (!dx && !dy) return json(res, 400, { error: 'dx or dy needed' });
      const now = Date.now();
      if (now - lastMove < 1000)
        return json(res, 429, { error: 'still moving' });
      const ms = travelMs(dx, dy);
      lastMove = now + ms - 1000; // other moves wait until it arrives
      await camera.move(dx, dy, 100);
      return json(res, 200, { ok: true, dx, dy, ms });
    }
    if (route === 'POST /api/travel/done') {
      // the page saw the picture settle: the trip is over, nudges may follow
      lastMove = Math.min(lastMove, Date.now());
      return json(res, 200, { ok: true });
    }
    if (route === 'GET /api/shots') return json(res, 200, shots);
    if (route === 'POST /api/shots') {
      try {
        return json(res, 200, setShots(await readBody(req)));
      } catch (e) {
        if (e.code === 400) return json(res, 400, { error: e.message });
        throw e;
      }
    }
    if (route === 'POST /api/night') {
      const b = await readBody(req);
      if (!['night', 'day', 'auto'].includes(b.mode))
        return json(res, 400, { error: "mode is 'night', 'day' or 'auto'" });
      return json(res, 200, { mode: await camera.setNight(b.mode) });
    }
    if (route === 'GET /api/info') return json(res, 200, await camera.info());
    // Read-only probe of the camera's own "get" messages (names from its web
    // page's script), for finding out what it can do. Identifiers, addresses
    // and secrets are masked before anything leaves the bridge.
    if (route === 'GET /api/probe') {
      const name = url.searchParams.get('name') || '';
      if (!PROBE_NAMES.has(name))
        return json(res, 400, {
          error: `name is one of: ${[...PROBE_NAMES].join(', ')}`,
        });
      const msg = await camera.raw(name);
      return json(res, 200, { name, data: redact(msg) });
    }
    if (route === 'GET /api/picture')
      return json(res, 200, await camera.picture());
    if (route === 'POST /api/image' || route === 'POST /api/picture') {
      const b = await readBody(req);
      const p = {};
      for (const k of ['brightness', 'contrast', 'saturation', 'sharpness'])
        if (b[k] !== undefined && Number.isFinite(Number(b[k])))
          p[k] = Number(b[k]);
      for (const k of ['wdr', 'backlight']) {
        if (b[k] === undefined) continue;
        const on = onOff(b[k]);
        if (on === undefined)
          return json(res, 400, { error: `${k} is on or off` });
        p[k] = on;
      }
      if (!Object.keys(p).length)
        return json(res, 400, {
          error:
            'brightness, contrast, saturation, sharpness, wdr or backlight needed',
        });
      return json(res, 200, await camera.setImage(p));
    }
    if (route === 'POST /api/mic') {
      const b = await readBody(req);
      if (!Number.isFinite(Number(b.level)))
        return json(res, 400, { error: 'level 0-100 needed' });
      return json(res, 200, { level: await camera.setMic(Number(b.level)) });
    }
    if (route === 'POST /api/clock')
      return json(res, 200, await camera.setClock());
    if (route === 'GET /api/voices')
      return json(res, 200, { voices: await speech.voices() });
    if (route === 'POST /api/say') {
      const b = await readBody(req);
      const text = String(b.text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) return json(res, 400, { error: 'text needed' });
      if (text.length > 300)
        return json(res, 400, { error: 'text is 300 characters at most' });
      if (!sayAllowed()) return json(res, 429, { error: 'ten says a minute' });
      const voice = b.voice ? String(b.voice) : '';
      if (voice && !(await speech.voices()).includes(voice))
        return json(res, 400, { error: 'unknown voice' });
      const level = speech.capLevel(b.level),
        chimeLevel = speech.chimeFor(level, b.chimeLevel);
      const rate = Math.max(
        90,
        Math.min(220, Math.round(Number(b.rate ?? 140) || 140)),
      );
      return json(res, 202, {
        level,
        chimeLevel: b.chime === false ? null : chimeLevel,
        ...speech.say({
          text,
          voice,
          level,
          rate,
          chime: b.chime !== false,
          chimeLevel,
        }),
      });
    }
    const sm = /^GET \/api\/say\/([0-9a-f]{12})$/.exec(route);
    if (sm) {
      const j = speech.sayStatus(sm[1]);
      return j ? json(res, 200, j) : json(res, 404, { error: 'no such say' });
    }
    if (route === 'GET /api/stream')
      return await stream(
        req,
        res,
        url.searchParams.get('profile') === 'p1' ? 'p1' : 'p0',
      );
    if (route === 'GET /api/aim') return json(res, 200, aim);
    if (route === 'POST /api/aim') {
      try {
        return json(res, 200, setAim(await readBody(req)));
      } catch (e) {
        if (e.code === 400) return json(res, 400, { error: e.message });
        throw e;
      }
    }
    if (route === 'GET /api/record') return json(res, 200, rec.state());
    if (route === 'POST /api/record/start') {
      try {
        return json(res, 202, await rec.start());
      } catch (e) {
        if (e.code === 409) return json(res, 409, { error: e.message });
        throw e;
      }
    }
    if (route === 'POST /api/record/stop') {
      try {
        return json(res, 200, await rec.stop());
      } catch (e) {
        if (e.code === 409) return json(res, 409, { error: e.message });
        throw e;
      }
    }
    const rm = /^(GET|DELETE) \/api\/record\/([0-9a-f]{12})$/.exec(route);
    if (rm) {
      const r = rec.get(rm[2]);
      if (!r) return json(res, 404, { error: 'no such recording' });
      if (rm[1] === 'DELETE') {
        if (rec.remove(rm[2]) === null)
          return json(res, 409, { error: 'still recording' });
        return json(res, 200, { ok: true });
      }
      if (r.status !== 'ready')
        return json(res, r.status === 'recording' ? 409 : 404, rec.view(r));
      const d = new Date(r.started),
        z = (n) => String(n).padStart(2, '0');
      const name = `ghostjack-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.mp4`;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': r.bytes,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      return createReadStream(r.file).pipe(res);
    }
    json(res, 404, { error: 'no such route' });
  } catch (e) {
    if (!res.headersSent)
      json(res, [400, 404, 409, 413, 415].includes(e.code) ? e.code : 502, {
        error: String(e.message || e).slice(0, 200),
      });
    else res.end();
  }
});

function stop() {
  for (const p of children) p.kill('SIGKILL');
  rec.cleanup();
  camera.shutdown().finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

rec.sweep();
server.listen(PORT, HOST, () =>
  console.log(`Ghost Jack bridge on http://${HOST}:${PORT}`),
);

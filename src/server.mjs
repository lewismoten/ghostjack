// Ghost Jack bridge: a small HTTP API in front of the camera session, plus the control page in web/.
// Binds 127.0.0.1 by default. Every /api route except /api/hello needs the bearer token.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as camera from './camera.mjs';
import * as speech from './say.mjs';
import * as rec from './record.mjs';
import { createReadStream } from 'node:fs';

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

const clamp = (n, lim) =>
  Math.max(-lim, Math.min(lim, Math.round(Number(n) || 0)));
let lastMove = 0;
const sayTimes = []; // timestamps of recent say requests (10 per minute)
const children = new Set();

// Crop a JPEG (fractions of the picture) and scale it back up to 1280 wide.
async function cropJpeg(jpg, w, h, x, y) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-i',
        'pipe:0',
        '-vf',
        `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=1280:-2`,
        '-frames:v',
        '1',
        '-f',
        'mjpeg',
        '-q:v',
        '3',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    children.add(p);
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', reject);
    p.on('close', () => {
      children.delete(p);
      resolve(Buffer.concat(out));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(jpg);
  });
}

async function stream(req, res, profile) {
  const url = await camera.streamUrl(profile); // never logged or sent to the client
  // Fragmented MP4: H.264 copied as-is (no re-encode), AAC copied. Low latency (0.1.2): no input
  // buffering, a short probe, and a fragment every 0.5 s (not only at keyframes: the camera sends one
  // about every 4.8 s, which made the picture 5 to 10 s late), each flushed as soon as it is written.
  const p = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-probesize',
      '32k',
      '-analyzeduration',
      '0',
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
      '-c',
      'copy',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration',
      '500000',
      '-flush_packets',
      '1',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.add(p);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
  });
  p.stdout.pipe(res);
  p.on('exit', () => {
    children.delete(p);
    res.end();
  });
  res.on('close', () => p.kill('SIGKILL'));
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
      let jpg = await camera.snapshot(url.searchParams.get('profile') || 'p0');
      const c = (url.searchParams.get('crop') || '').split(',').map(Number);
      if (c.length === 4 && c.every(Number.isFinite)) {
        const [x, y, w, h] = c.map((n) => Math.max(0, Math.min(1, n)));
        if (w >= 0.02 && h >= 0.02 && x + w <= 1.001 && y + h <= 1.001)
          jpg = (await cropJpeg(jpg, w, h, x, y)) || jpg;
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
      });
      return res.end(jpg);
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
      if (!['night', 'auto'].includes(b.mode))
        return json(res, 400, { error: "mode is 'night' or 'auto'" });
      return json(res, 200, { mode: await camera.setNight(b.mode) });
    }
    if (route === 'GET /api/info') return json(res, 200, await camera.info());
    if (route === 'POST /api/image') {
      const b = await readBody(req);
      const p = {};
      for (const k of ['brightness', 'contrast', 'saturation', 'sharpness'])
        if (b[k] !== undefined && Number.isFinite(Number(b[k])))
          p[k] = Number(b[k]);
      if (!Object.keys(p).length)
        return json(res, 400, {
          error: 'brightness, contrast, saturation or sharpness needed',
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
      const now = Date.now();
      while (sayTimes.length && now - sayTimes[0] > 60000) sayTimes.shift();
      if (sayTimes.length >= 10)
        return json(res, 429, { error: 'ten says a minute' });
      const voice = b.voice ? String(b.voice) : '';
      if (voice && !(await speech.voices()).includes(voice))
        return json(res, 400, { error: 'unknown voice' });
      const level = speech.capLevel(b.level),
        chimeLevel = speech.chimeFor(level, b.chimeLevel);
      const rate = Math.max(
        90,
        Math.min(220, Math.round(Number(b.rate ?? 140) || 140)),
      );
      sayTimes.push(now);
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
      json(res, 502, { error: String(e.message || e).slice(0, 200) });
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

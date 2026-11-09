// A fake room for testing the page without a camera: a small HTTP server (default port 18792) that serves
// web/ and fakes the bridge API the page uses, and keeps a pan/tilt state with walls. snapshot.jpg is the view
// from a synthetic 360 x 180 panorama (smooth colored texture, a lat/long grid every 30 degrees, colored
// landmarks), rendered with ffmpeg's v360 filter, so a calibration can be checked against a known lens.
// Truth: 62 degrees wide (16:9), 350 degrees of pan over 48 steps (480 units), 19 tilt steps (190 units) at
// TILT_DEG degrees per unit, starting off-center. It never touches the real camera or the owner's bridge
// (port 8787). The panorama is generated into captures/ (git-ignored). Run: node tools/fake-room.mjs
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
export const TRUE = {
  fovH: 62,
  fovV:
    (2 * Math.atan(Math.tan((31 * Math.PI) / 180) * (9 / 16)) * 180) / Math.PI,
  panDegrees: 350,
  panUnits: 480,
  tiltUnits: 190,
  tiltDegPerUnit: 0.62,
};
const PANO = join(ROOT, 'captures', 'fake-room-pano.jpg');

// The panorama: sums of sines over the direction vector (seamless, no pole pinch), plus grid and landmarks.
export function makePanorama() {
  if (existsSync(PANO)) return PANO;
  mkdirSync(dirname(PANO), { recursive: true });
  const PW = 4320,
    PH = 2160,
    rgb = Buffer.alloc(PW * PH * 3);
  const waves = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 14; i++) {
    const f = 6 + i * 6,
      v = [rnd(), rnd(), rnd()],
      n = Math.hypot(...v);
    waves.push({
      k: v.map((c) => (c / n) * f),
      ph: rnd() * 3,
      amp: 1 / (1 + i * 0.12),
    });
  }
  const marks = [
    [0, 0, [230, 40, 40]],
    [90, 10, [40, 200, 70]],
    [-90, -10, [50, 90, 240]],
    [180, 0, [240, 220, 40]],
    [45, 35, [240, 120, 20]],
    [-45, -30, [200, 60, 220]],
    [135, -25, [30, 210, 210]],
    [-135, 30, [250, 250, 250]],
  ];
  for (let y = 0; y < PH; y++) {
    const lat = (0.5 - (y + 0.5) / PH) * Math.PI,
      cl = Math.cos(lat),
      dy = Math.sin(lat);
    for (let x = 0; x < PW; x++) {
      const lon = ((x + 0.5) / PW - 0.5) * 2 * Math.PI,
        dx = cl * Math.sin(lon),
        dz = cl * Math.cos(lon);
      let a = 0;
      for (const w of waves)
        a += w.amp * Math.sin(w.k[0] * dx + w.k[1] * dy + w.k[2] * dz + w.ph);
      const b = Math.sin(a * 1.3 + 1) * 0.5 + 0.5,
        c = Math.sin(a * 0.9 + dy * 3) * 0.5 + 0.5;
      let r = 60 + 150 * b,
        g = 70 + 130 * c,
        bl = 80 + 120 * (1 - b * c);
      const lo = (lon * 180) / Math.PI,
        la = (lat * 180) / Math.PI;
      if (
        Math.abs(((lo + 15) % 30) - 15) < 0.25 ||
        Math.abs(((la + 15) % 30) - 15) < 0.25
      ) {
        r = g = bl = 20;
      }
      for (const [ml, mp, col] of marks) {
        const dl = Math.abs(((lo - ml + 540) % 360) - 180),
          d = Math.hypot(dl * cl, la - mp);
        if (d < 4) [r, g, bl] = col;
        else if (d < 4.6) r = g = bl = 255;
      }
      const o = (y * PW + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = bl;
    }
  }
  execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${PW}x${PH}`,
      '-i',
      '-',
      '-q:v',
      '2',
      PANO,
    ],
    { input: rgb, maxBuffer: 1 << 28 },
  );
  return PANO;
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// startFakeRoom({ port, fast }): fast shortens the page's wait after each Find limits step (limits.js STEP_MS).
export function startFakeRoom({
  port = 18792,
  fast = false,
  startPan = 130,
  startTilt = 60,
} = {}) {
  makePanorama();
  let panU = startPan,
    tiltU = startTilt,
    mv = null,
    aim = { updated: 0 },
    shots = Array(9).fill(null);
  const clampU = () => {
    panU = Math.max(0, Math.min(TRUE.panUnits, panU));
    tiltU = Math.max(0, Math.min(TRUE.tiltUnits, tiltU));
  };
  const poseNow = () => {
    if (mv) {
      const f = Math.min(1, (Date.now() - mv.t0) / mv.dur);
      if (f >= 1) {
        panU = mv.to.p;
        tiltU = mv.to.t;
        mv = null;
      } else
        return {
          p: mv.from.p + (mv.to.p - mv.from.p) * f,
          t: mv.from.t + (mv.to.t - mv.from.t) * f,
        };
    }
    return { p: panU, t: tiltU };
  };
  const yawPitch = ({ p, t }) => ({
    yaw: (p - TRUE.panUnits / 2) * (TRUE.panDegrees / TRUE.panUnits),
    pitch: (t - TRUE.tiltUnits / 2) * TRUE.tiltDegPerUnit,
  });
  const json = (res, code, o) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const body = (req) =>
    new Promise((resolve) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(s || '{}'));
        } catch {
          resolve({});
        }
      });
    });
  const render = (res, profile) => {
    const { yaw, pitch } = yawPitch(poseNow()),
      [w, h] = profile === 'p1' ? [640, 360] : [1920, 1080];
    const ff = spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        PANO,
        '-vf',
        `v360=e:flat:yaw=${yaw.toFixed(3)}:pitch=${pitch.toFixed(3)}:h_fov=${TRUE.fovH}:v_fov=${TRUE.fovV.toFixed(4)}:w=${w}:h=${h}:interp=linear`,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    ff.stdout.pipe(res);
  };
  const stat = (req, res, path) => {
    const f = normalize(join(ROOT, 'web', path === '/' ? 'index.html' : path));
    if (
      !f.startsWith(join(ROOT, 'web')) ||
      !existsSync(f) ||
      !statSync(f).isFile()
    ) {
      res.writeHead(404);
      return res.end();
    }
    let data = readFileSync(f);
    if (fast && f.endsWith('limits.js'))
      data = Buffer.from(
        String(data).replace('STEP_MS = 1300', 'STEP_MS = 250'),
      );
    if (fast && f.endsWith('strips.js'))
      data = Buffer.from(
        String(data).replace('STRIP_WAIT_MS = 1100', 'STRIP_WAIT_MS = 120'),
      );
    res.writeHead(200, {
      'Content-Type': TYPES[extname(f)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'),
      route = `${req.method} ${url.pathname}`;
    if (!url.pathname.startsWith('/api/')) return stat(req, res, url.pathname);
    if (url.pathname === '/api/hello')
      return json(res, 200, { name: 'ghostjack-bridge', ok: true });
    switch (route) {
      case 'GET /api/status':
        return json(res, 200, {
          mode: 'auto',
          night: '',
          inNightVision: false,
        });
      case 'GET /api/snapshot.jpg':
        return render(
          res,
          url.searchParams.get('profile') === 'p1' ? 'p1' : 'p0',
        );
      case 'POST /api/move': {
        const b = await body(req),
          c = poseNow();
        panU = c.p + (Number(b.dx) || 0);
        tiltU = c.t + (Number(b.dy) || 0);
        mv = null;
        clampU();
        return json(res, 200, { ok: true });
      }
      case 'POST /api/travel': {
        const b = await body(req),
          c = poseNow(),
          dx = Number(b.dx) || 0,
          dy = Number(b.dy) || 0;
        const to = {
          p: Math.max(0, Math.min(TRUE.panUnits, c.p + dx)),
          t: Math.max(0, Math.min(TRUE.tiltUnits, c.t + dy)),
        };
        const ms = Math.round(
          (Math.max(Math.abs(dx), Math.abs(dy)) +
            Math.min(Math.abs(dx), Math.abs(dy)) / 2) *
            5 +
            500,
        );
        mv = { from: c, to, t0: Date.now(), dur: ms - 400 };
        return json(res, 200, { ok: true, dx, dy, ms });
      }
      case 'POST /api/travel/done':
        return json(res, 200, { ok: true });
      case 'GET /api/aim':
        return json(res, 200, aim);
      case 'POST /api/aim':
        aim = { ...(await body(req)), updated: Date.now() };
        return json(res, 200, aim);
      case 'GET /api/shots':
        return json(res, 200, shots);
      case 'POST /api/shots':
        shots = await body(req);
        return json(res, 200, shots);
      case 'GET /api/ask/pending':
        return json(res, 200, { pending: null });
      case 'GET /api/info':
        return json(res, 200, {});
      case 'GET /api/voices':
        return json(res, 200, []);
      default:
        return json(res, 404, { error: 'not in the fake room' });
    }
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        aim: () => aim,
        truth: () => ({ ...yawPitch(poseNow()), panU, tiltU }),
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startFakeRoom({ fast: process.argv.includes('--fast') });
  console.log(`Fake room at http://127.0.0.1:${s.port}/ (token: anything)`);
}

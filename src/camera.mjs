// One long-lived signed-in session with the camera's own web page (headless Chromium).
// Credentials come from the macOS Keychain item "tethys-camera" (this camera's credential; the name stays); nothing secret is logged.
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const IP = process.env.CAMERA_IP || '192.168.187.254';
let browser = null;
let page = null;
let deviceId = '';
let signedInAt = 0;
let chain = Promise.resolve(); // one camera operation at a time

function credentials() {
  const item = execFileSync('security', ['find-generic-password', '-s', 'tethys-camera'], { encoding: 'utf8' });
  const id = (item.match(/"acct"<blob>="([^"]*)"/) || [])[1];
  const pass = execFileSync('security', ['find-generic-password', '-s', 'tethys-camera', '-w'], { encoding: 'utf8' }).trim();
  if (!id || !pass) throw new Error('Keychain item tethys-camera needs an account (device id) and a password');
  return { id, pass };
}

async function close() {
  try { await browser?.close(); } catch { /* already gone */ }
  browser = page = null;
}

async function signIn() {
  await close();
  const { id, pass } = credentials();
  deviceId = id;
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`http://${IP}/`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  if (await page.isEnabled('#signin_name')) await page.fill('#signin_name', id);
  await page.click('#signin_show_pw');
  await page.fill('#signin_pw', pass);
  await page.click('#sign_in');
  await page.waitForFunction(() => window.acs && acs.ctrl && acs.ctrl({ type: 'get_info' }).sid, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  signedInAt = Date.now();
}

// Send one ccm message from inside the page; resolves to the reply message.
function send(name, extra) {
  return page.evaluate(
    ([sn, name, extra]) =>
      new Promise((resolve) => {
        const nid = () => acs.create_nid(acs.ctrl({ type: 'get_info' }));
        acs.send_msg(name, { sess: { nid: nid(), sn }, ...extra }, (_a, msg) => resolve(msg || { ret: { code: 'empty' } }), { ip: g_ref.server_device, to: 'ccm' });
        setTimeout(() => resolve({ ret: { code: 'timeout' } }), 10000);
      }),
    [deviceId, name, extra],
  );
}

const failed = (msg) => !msg || (msg.ret && msg.ret.code);

// Run fn(); on a failure, sign in again once and retry.
function run(fn) {
  const next = chain.then(async () => {
    if (!page) await signIn();
    try { return await fn(); } catch {
      await signIn();
      return fn();
    }
  });
  chain = next.catch(() => {});
  return next;
}

async function call(name, extra) {
  const msg = await send(name, extra);
  if (failed(msg)) throw new Error(`${name} failed: ${msg.ret?.code || 'no reply'}`);
  return msg;
}

export function snapshot(profile = 'p0') {
  if (!['p0', 'p1'].includes(profile)) profile = 'p0';
  return run(async () => {
    const msg = await call('ccm_snapshot', { token: profile });
    const url = await page.evaluate(
      ([sn, token]) => `http://${g_ref.server_device}/ccm/ccm_pic_get.jpg?hfrom_handle=887330&dsess=1&dsess_nid=${acs.create_nid(acs.ctrl({ type: 'get_info' }))}&dsess_sn=${sn}&dtoken=${token}`,
      [deviceId, msg.token],
    );
    const res = await page.request.get(url);
    const body = await res.body();
    if (res.status() !== 200 || body.length < 1000) throw new Error('picture download failed');
    return body;
  });
}

export function move(dx, dy, speed = 100) {
  return run(async () => {
    const sp = { x: speed, y: speed, space: '' };
    await call('ccm_ptz_ctl', {
      token: 'ptz0',
      trans: { pan_tilt: { x: dx, y: dy, space: '' }, _deprecated_zoom: { x: 0, space: '' } },
      speed: { pan_tilt: sp, _deprecated_zoom: { x: 0, space: '' } },
    });
  });
}

async function readConf() {
  const msg = await call('ccm_video_srcs_get', {});
  const conf = msg.vss?.[0]?.extension?.conf;
  if (!conf) throw new Error('image settings not found');
  return conf;
}

// mode 'night' = forced infrared; 'auto' = automatic (the factory value, mode "").
export function setNight(mode) {
  return run(async () => {
    const conf = await readConf();
    conf.mode = mode === 'night' ? 'night' : '';
    await call('ccm_img_set', { token: 'vs0', conf });
    return (await readConf()).mode === 'night' ? 'night' : 'auto';
  });
}

export function status() {
  return run(async () => {
    const conf = await readConf();
    return {
      connected: true,
      night: conf.mode === 'night' ? 'night' : conf.mode === '' ? 'auto' : conf.mode,
      inNightVision: conf.day_or_night === 2,
      signedInSeconds: Math.round((Date.now() - signedInAt) / 1000),
    };
  });
}

// A fresh rtsp address; each works for one connection only.
export function streamUrl() {
  return run(async () => {
    const msg = await call('ccm_play', { setup: { stream: 'RTP_Unicast', trans: { proto: 'rtsp' } }, token: 'p0' });
    const url = msg.uri?.url || msg.uri;
    if (typeof url !== 'string' || !url.startsWith('rtsp://')) throw new Error('no stream address');
    return url;
  });
}

export const shutdown = close;

// Raw read of one message (used by info readers; the caller decides what to expose).
export function raw(name, extra = {}) { return run(() => call(name, extra)); }

const safe = (fn) => fn().catch(() => null);
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

// Read-only information for the settings panel. Serial, MAC and nickname are never included.
export function info() { return run(infoNow); }
async function infoNow() {
  const [i, n, d, k, v, m, al] = await Promise.all(
    [['ccm_info_get'], ['ccm_net_get'], ['ccm_date_get'], ['ccm_disk_get'], ['ccm_video_srcs_get'], ['ccm_mic_get'], ['ccm_alert_action_get']].map(([name]) => safe(() => call(name, {}))),
  );
  const nic = n?.info?.ifs?.[0];
  const disk = k?.disks?.[0];
  const conf = v?.vss?.[0]?.extension?.conf;
  const pad = (x) => String(x).padStart(2, '0');
  const u = d?.utc_date;
  return {
    system: i && { type: i.type, version: i.ver, model: 'Tethys 825-C (internal F300)' },
    network: nic && {
      link: nic.phy?.info?.stat, mtu: nic.phy?.conf?.mtu, mode: nic.ipv4?.conf?.mode,
      ip: nic.ipv4?.info?.ip, dns: n.info.dns?.info?.dns,
    },
    date: u && { utc: `${u.date.year}-${pad(u.date.mon)}-${pad(u.date.day)} ${pad(u.time.hour)}:${pad(u.time.min)}:${pad(u.time.sec)}` },
    disk: disk && pick(disk, ['stat', 'size', 'available_size', 'used_size']),
    image: conf && {
      resolution: v.vss[0].resolution, framerate: v.vss[0].framerate, mode: conf.mode || 'auto', dayOrNight: conf.day_or_night,
      brightness: conf.brightness, contrast: conf.contrast, saturation: conf.color_saturation, sharpness: conf.sharpness,
      wdr: conf.wide_dynamic_range?.mode, backlight: conf.backlight_compensation?.mode, whiteBalance: conf.white_balance?.mode, exposure: conf.exposure?.mode,
    },
    mic: m?.conf?.[0] && pick(m.conf[0], ['level', 'silent']),
    alerts: al && { enabled: al.Enable ?? al.enable ?? null },
  };
}

const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n))));

// Image settings: brightness, contrast, saturation 0-100, sharpness 0-10. Applies to the current
// settings and to the day or night set in use. The whole conf is written back, as the web app does.
export function setImage(p) {
  return run(async () => {
    const conf = await readConf();
    const set = (key, name, lo, hi) => {
      if (p[name] === undefined) return;
      const val = clampN(p[name], lo, hi);
      conf[key] = val;
      const set = conf.day_or_night === 2 || conf.mode === 'night' ? conf.night : conf.day;
      if (set) set[key] = val;
    };
    set('brightness', 'brightness', 0, 100);
    set('contrast', 'contrast', 0, 100);
    set('color_saturation', 'saturation', 0, 100);
    set('sharpness', 'sharpness', 0, 10);
    await call('ccm_img_set', { token: 'vs0', conf });
    return (await infoNow()).image;
  });
}

export function setMic(level) {
  return run(async () => {
    const m = await call('ccm_mic_get', {});
    const entry = { ...m.conf[0], level: clampN(level, 0, 100) };
    await call('ccm_mic_set', { conf: entry, force_persistence: 1 });
    return (await call('ccm_mic_get', {})).conf[0].level;
  });
}

// Set the camera clock (UTC) from this computer's time. The camera has no time source of its own.
export function setClock() {
  return run(async () => {
    const t = new Date();
    await call('ccm_date_set', {
      type: 'manually', daylight_savings: 0,
      utc_date: { time: { hour: t.getUTCHours(), min: t.getUTCMinutes(), sec: t.getUTCSeconds() }, date: { year: t.getUTCFullYear(), mon: t.getUTCMonth() + 1, day: t.getUTCDate() } },
    });
    return (await infoNow()).date;
  });
}

// A fresh rtmp address to publish speech to. Request one ONLY when a publish follows at once:
// an address nobody publishes to jams the speaker until the camera restarts (docs/discovery.md step 13).
export function talkUrl() {
  return run(async () => {
    const msg = await call('ccm_talk', { setup: { stream: 'RTP_Unicast', trans: { proto: 'rtmp' } }, token: 'p0' });
    const url = msg.uri?.url || msg.uri;
    if (typeof url !== 'string' || !url.startsWith('rtmp://')) throw new Error('no talk address');
    return url;
  });
}

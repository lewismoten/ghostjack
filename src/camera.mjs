// One long-lived signed-in session with the camera's own web page (headless Chromium).
// Credentials come from the macOS Keychain item "tethys-camera"; nothing secret is logged.
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

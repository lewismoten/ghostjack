// Ghost Jack control page (Glassmouth's voice in the status text): talks to the local bridge (docs/bridge.md). No camera images are bundled.
import * as snd from './sound.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
$('addr').value = store.get('bridge', /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.protocol.startsWith('http') ? location.origin : 'http://localhost:8787');
$('token').value = store.get('token', '');

// Theme: dark is the default; the choice is remembered.
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').setAttribute('aria-pressed', String(t === 'light')); $('theme').textContent = t === 'light' ? 'Dark theme' : 'Light theme';
  store.set('gm-theme', t);
}
setTheme(store.get('gm-theme', 'dark'));
$('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

// Sound (both off by default).
$('sfx').checked = snd.state.sfx; $('music').checked = snd.state.music;
$('sfx').onchange = () => snd.setSfx($('sfx').checked);
$('music').onchange = () => snd.setMusic($('music').checked);
document.addEventListener('click', (e) => { if (e.target.closest('button')) snd.sfx.blip(); }, true);
// Music was on last time: it can only start after a click.
if (snd.state.music) document.addEventListener('click', () => snd.setMusic(true), { once: true });

let lost = false, base = '', token = '', connected = false, crop = null, lastMove = 0;
const controls = ['live', 'sound', 'shot', 'zoom', 'zoomReset', 'night', 'infoLoad'];
const pads = [...document.querySelectorAll('.pad button')];

function setStatus(t, bad) { $('status').textContent = t; if (bad) snd.sfx.error(); }
function setConnected(on) {
  const was = connected;
  connected = on;
  for (const id of controls) $(id).disabled = !on;
  for (const b of pads) b.disabled = !on;
  $('sayGo').disabled = !on;
  if (on) loadVoices();
  $('demo').hidden = on;
  $('light').classList.toggle('on', on);
  $('hConn').textContent = on ? 'JACKED IN' : 'FLATLINE';
  if (!on) { stopLive(); setEye('Nobody'); }
  if (on && !was) { snd.sfx.powerUp(); if (!reduced) { const h = document.querySelector('h1'); h.style.animation = 'none'; void h.offsetWidth; h.style.animation = ''; } }
}
const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers } });

async function connect(e) {
  e?.preventDefault();
  base = $('addr').value.trim().replace(/\/+$/, '');
  token = $('token').value.trim();
  store.set('bridge', base); store.set('token', token);
  setStatus('Jacking in... listening for the wire.');
  $('radar').hidden = false;
  try {
    try {
      const hello = await fetch(base + '/api/hello').then((r) => r.json());
      if (!hello.ok) throw new Error('not a camera bridge');
    } catch { setConnected(false); $('demo').hidden = false; return setStatus("No carrier. Nothing answered on the wire at that address: the bridge is flatlined. Showing the demo.", true); }
    try {
      const r = await api('/api/status');
      if (r.status === 401) { setConnected(false); return setStatus("Wrong token. The ICE held: the bridge answered but won't talk to strangers.", true); }
      const s = await r.json();
      if (!r.ok) throw new Error(s.error);
      setConnected(true);
      $('night').checked = s.night === 'night'; showNight(s.night);
      setStatus(`${lost ? 'Back in sight. ' : "Eye's open. "}Jacked in. Night vision: ${s.night}${s.inNightVision ? ' (infrared on now)' : ''}.`); lost = false; loadDevice();
    } catch (err) { setConnected(false); lost = true; setStatus(`Lost the angle. The bridge is up but the chrome did not answer: ${err.message}`, true); }
  } finally { $('radar').hidden = true; }
}
// Who has the eye: You while this page is watching live, Nobody otherwise (agents come with the voice relay).
let eyeWho = 'Nobody';
function setEye(who) {
  if (who === eyeWho) return;
  eyeWho = who;
  $('eyeText').textContent = who === 'Nobody' ? 'Nobody has the eye' : `${who} ${who === 'You' ? 'have' : 'has'} the eye`;
  $('eye').classList.toggle('has', who !== 'Nobody');
  snd.sfx.relay();
  $('eye').classList.remove('flip'); void $('eye').offsetWidth; $('eye').classList.add('flip');
}
async function loadDevice() {
  try { const r = await api('/api/info'); const j = await r.json(); if (r.ok && j.system?.model) $('device').textContent = `Chrome: ${j.system.model.replace(/ \(.*/, '')}`; } catch { /* leave the line as it was */ }
}
const showNight = (m) => { $('hNight').textContent = m === 'night' ? 'NV IR ON' : 'NV AUTO'; };

// HUD clock (local time of this computer).
setInterval(() => { $('hClock').textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 1000);

function showImage(src) {
  const old = $('snap').dataset.url; if (old) URL.revokeObjectURL(old);
  $('snap').src = src; $('snap').dataset.url = src;
  $('snap').hidden = false; $('placeholder').hidden = true; $('video').hidden = true;
}
async function snapshot() {
  stopLive();
  setStatus('Framing it...');
  const q = crop ? `?crop=${crop.map((n) => n.toFixed(4)).join(',')}` : '';
  try {
    const r = await api('/api/snapshot.jpg' + q);
    if (!r.ok) throw new Error((await r.json()).error);
    showImage(URL.createObjectURL(await r.blob()));
    setStatus(crop ? 'Hold that frame. Zoomed snapshot taken.' : 'Hold that frame. Snapshot taken.');
  } catch (e) { setStatus(`Lost the angle. Snapshot failed: ${e.message}`, true); }
}

function stopLive() {
  const v = $('video'); if (!v.getAttribute('src')) return;
  v.removeAttribute('src'); v.load(); v.hidden = true;
  $('live').textContent = 'Start live view'; $('live').setAttribute('aria-pressed', 'false');
  setEye('Nobody');
}
function startLive() {
  const v = $('video');
  v.src = `${base}/api/stream?token=${encodeURIComponent(token)}`;
  v.muted = $('sound').getAttribute('aria-pressed') !== 'true';
  v.hidden = false; $('snap').hidden = true; $('placeholder').hidden = true;
  v.play().catch(() => setStatus('Lost the angle. The browser could not play the live view.', true));
  v.onerror = () => { setStatus('Lost the angle. Live view stopped.', true); stopLive(); };
  $('live').textContent = 'Stop live view'; $('live').setAttribute('aria-pressed', 'true');
  setEye('You'); setStatus("Eye's open on live view. It takes a few seconds. Sound is off until you press Sound.");
}
$('live').onclick = () => ($('video').getAttribute('src') ? stopLive() : startLive());
$('sound').onclick = () => {
  const on = $('sound').getAttribute('aria-pressed') !== 'true';
  $('sound').setAttribute('aria-pressed', String(on)); $('sound').textContent = on ? 'Sound on' : 'Sound off';
  $('video').muted = !on; if (on) $('video').play().catch(() => {});
};
$('shot').onclick = snapshot;

// Estimated aim: counted from the moves sent (the camera cannot report its position). Units are steps.
let pan = +store.get('gm-pan', 0) || 0, tilt = +store.get('gm-tilt', 0) || 0, scene = null;
const sgn = (n) => (n >= 0 ? '+' : '') + n;
const DEG_PER_STEP = 1.5; // illustration only
function showPose(instant) {
  const t = `Pan ~${sgn(pan)}, Tilt ~${sgn(tilt)} (estimated, in steps)`;
  $('pose').textContent = t; $('hPose').textContent = `P ${sgn(pan)} T ${sgn(tilt)} est.`;
  store.set('gm-pan', pan); store.set('gm-tilt', tilt);
  scene?.setPose(Math.max(-90, Math.min(90, pan * DEG_PER_STEP)), Math.max(-60, Math.min(60, tilt * DEG_PER_STEP)), instant);
}
$('recenter').onclick = () => { pan = tilt = 0; showPose(); };
showPose(true);

async function move(dx, dy) {
  if (!connected || Date.now() - lastMove < 1100) return;
  lastMove = Date.now();
  setStatus('Nudging...');
  try {
    const r = await api('/api/move', { method: 'POST', body: JSON.stringify({ dx, dy, speed: 100 }) });
    if (!r.ok) throw new Error((await r.json()).error);
    pan += dx; tilt += dy; showPose();
    setStatus('Nudged one small step.');
  } catch (e) { setStatus(`Lost the angle. Move failed: ${e.message}`, true); }
}
for (const b of pads) b.onclick = () => move(+b.dataset.dx, +b.dataset.dy);
const keys = { ArrowUp: [0, 10], ArrowDown: [0, -10], ArrowLeft: [-10, 0], ArrowRight: [10, 0] };
document.addEventListener('keydown', (e) => {
  if (!connected || !keys[e.key] || ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  e.preventDefault(); move(...keys[e.key]);
});
// Dragging the camera model sends one small step in the dragged direction.
{
  let from = null;
  const m = $('model');
  m.addEventListener('pointerdown', (e) => { from = [e.clientX, e.clientY]; m.setPointerCapture(e.pointerId); });
  m.addEventListener('pointerup', (e) => {
    if (!from) return;
    const dx = e.clientX - from[0], dy = e.clientY - from[1]; from = null;
    if (Math.hypot(dx, dy) < 20) return;
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 10 : -10, 0); else move(0, dy > 0 ? -10 : 10);
  });
}

$('night').onchange = async () => {
  const mode = $('night').checked ? 'night' : 'auto';
  try {
    const r = await api('/api/night', { method: 'POST', body: JSON.stringify({ mode }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    showNight(j.mode); setStatus(`Night vision: ${j.mode}.`);
  } catch (e) { $('night').checked = !$('night').checked; setStatus(`Night vision change failed: ${e.message}`, true); }
};

// Digital zoom: a slider (centered crop) or a dragged box on the picture; the bridge crops the 1080p snapshot.
function setZoom(z) {
  $('zoomOut').textContent = `${z}x`;
  crop = z <= 1 ? null : [(1 - 1 / z) / 2, (1 - 1 / z) / 2, 1 / z, 1 / z];
}
$('zoom').oninput = () => { setZoom(+$('zoom').value); snapshot(); };
$('zoomReset').onclick = () => { $('zoom').value = 1; setZoom(1); snapshot(); };
let drag = null;
const stage = $('stage');
function frac(e) { const r = stage.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; }
stage.addEventListener('pointerdown', (e) => { if (!connected || $('snap').hidden) return; drag = frac(e); stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = frac(e), b = $('box');
  b.hidden = false;
  Object.assign(b.style, { left: `${Math.min(x, drag[0]) * 100}%`, top: `${Math.min(y, drag[1]) * 100}%`, width: `${Math.abs(x - drag[0]) * 100}%`, height: `${Math.abs(y - drag[1]) * 100}%` });
});
stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const [x, y] = frac(e), x0 = Math.min(x, drag[0]), y0 = Math.min(y, drag[1]);
  const w = Math.abs(x - drag[0]), h = Math.abs(y - drag[1]);
  drag = null; $('box').hidden = true;
  if (w < 0.04 || h < 0.04) return;
  zoomTo(x0, y0, w, h);
});
function zoomTo(x0, y0, bw, bh) {
  const w = Math.min(1, Math.max(bw, bh * (16 / 9))), h = w * (9 / 16);
  const cx = x0 + bw / 2, cy = y0 + bh / 2;
  crop = [Math.min(1 - w, Math.max(0, cx - w / 2)), Math.min(1 - h, Math.max(0, cy - h / 2)), w, h];
  $('zoom').value = Math.min(4, Math.max(1, Math.round((1 / w) * 4) / 4)); $('zoomOut').textContent = `${(1 / w).toFixed(1)}x`;
  snapshot();
}

// Info and settings: read-only facts, plus the safe writes (image, microphone, clock).
const sliders = { brightness: 's-brightness', contrast: 's-contrast', saturation: 's-saturation', sharpness: 's-sharpness' };
function fill(info) {
  const rows = [];
  const add = (k, v) => v !== undefined && v !== null && rows.push([k, String(v)]);
  add('Type', info.system?.type); add('Model', info.system?.model); add('Software', info.system?.version);
  if (info.network) { add('Network link', info.network.link); add('Address mode', info.network.mode); add('IP address', info.network.ip?.addr); add('Netmask', info.network.ip?.mask); add('DNS', info.network.dns?.join(', ')); }
  add('Camera clock (UTC)', info.date?.utc);
  if (info.disk) { add('SD card', info.disk.stat); add('SD size (MB)', info.disk.size); }
  const i = info.image;
  if (i) { add('Picture', `${i.resolution.width}x${i.resolution.height} at ${i.framerate} fps (sensor setting; snapshots are 1080p)`); add('Night mode', i.mode); add('Exposure', i.exposure); add('Wide dynamic range', i.wdr); add('Backlight compensation', i.backlight); add('White balance', i.whiteBalance); }
  add('Microphone', info.mic && (info.mic.silent ? 'muted' : `level ${info.mic.level}`));
  add('Alerts', info.alerts && (info.alerts.enabled ? 'on' : 'off'));
  $('infoList').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
  if (i) for (const [k, id] of Object.entries(sliders)) setSlider(id, i[k]);
  if (info.mic) setSlider('s-mic', info.mic.level);
  $('info').hidden = false;
}
function setSlider(id, v) { if (v === undefined) return; $(id).value = v; $(id).nextElementSibling.textContent = v; }
async function loadInfo() {
  setStatus('Looking the chrome over...');
  try { const r = await api('/api/info'); const j = await r.json(); if (!r.ok) throw new Error(j.error); fill(j); setStatus('Chrome read. Everything on the sheet.'); }
  catch (e) { setStatus(`Could not read camera info: ${e.message}`, true); }
}
$('infoLoad').onclick = loadInfo;
async function write(path, body, done) {
  try { const r = await api(path, { method: 'POST', body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); setStatus(done); return j; }
  catch (e) { setStatus(`Change failed: ${e.message}`, true); loadInfo(); }
}
for (const [k, id] of Object.entries(sliders)) {
  $(id).oninput = () => { $(id).nextElementSibling.textContent = $(id).value; };
  $(id).onchange = () => write('/api/image', { [k]: +$(id).value }, `${k} set to ${$(id).value}.`);
}
$('s-mic').oninput = () => { $('s-mic').nextElementSibling.textContent = $('s-mic').value; };
$('s-mic').onchange = () => write('/api/mic', { level: +$('s-mic').value }, `Microphone level set to ${$('s-mic').value}.`);
$('clock').onclick = async () => { const j = await write('/api/clock', {}, 'Camera clock set from this computer (UTC).'); if (j) loadInfo(); };

// Glassmouth says: speak through the camera's speaker (one line at a time; the bridge queues them).
let voicesLoaded = false;
async function loadVoices() {
  if (voicesLoaded) return;
  voicesLoaded = true;
  try {
    const j = await (await api('/api/voices')).json();
    for (const v of j.voices || []) { const o = document.createElement('option'); o.value = o.textContent = v; $('sayVoice').append(o); }
  } catch { voicesLoaded = false; }
}
$('sayChime').oninput = () => { $('sayChimeOut').textContent = (+$('sayChime').value).toFixed(3); };
$('sayLevel').oninput = () => { $('sayLevelOut').textContent = (+$('sayLevel').value).toFixed(3); };
const sayLine = (t) => { $('sayStatus').textContent = t; };
let saying = false;
$('sayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('sayText').value.trim();
  if (!text || saying) return;
  saying = true; $('sayGo').disabled = true;
  try {
    const r = await api('/api/say', { method: 'POST', body: JSON.stringify({ text, voice: $('sayVoice').value || undefined, level: +$('sayLevel').value, chimeLevel: +$('sayChime').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    snd.sfx.relay();
    sayLine('Line open. Waiting for the floor.');
    for (let i = 0; i < 90; i++) {
      await new Promise((ok) => setTimeout(ok, 1000));
      const s = await (await api(`/api/say/${j.id}`)).json();
      if (s.status === 'speaking') sayLine('On air.');
      else if (s.status === 'queued') sayLine(`Waiting for the floor. ${s.ahead} ahead.`);
      else if (s.status === 'done') { sayLine('Done. Said it.'); snd.sfx.relay(); $('sayText').value = ''; return; }
      else { sayLine(`Line's busy. It did not go out (${s.error || 'failed'}).`); snd.sfx.error(); return; }
    }
    sayLine("Line's busy. Static, no word back; check the chrome.");
  } catch (err) { sayLine(`Line's busy. ${err.message}`); snd.sfx.error(); }
  finally { saying = false; $('sayGo').disabled = !connected; }
});

$('conn').addEventListener('submit', connect);
setConnected(false);
if (store.get('token', '')) connect(); else { $('demo').hidden = false; setStatus('Flatlined, no carrier yet. Enter the uplink address and token, then Jack in.'); }

// The 3D extras load last, so the page works without them; any failure leaves the plain CSS look.
const loadScene = () => import('./scene.js').then((m) => m.start({ bg: $('bg'), model: $('model'), reduced })).then((s) => { scene = s; showPose(true); }).catch(() => { $('bg').hidden = true; });
if ('requestIdleCallback' in window) requestIdleCallback(loadScene, { timeout: 3000 }); else setTimeout(loadScene, 1500);

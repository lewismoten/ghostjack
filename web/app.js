// Control page: talks to the local bridge (docs/bridge.md). No camera images are bundled.
const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};
$('addr').value = store.get('bridge', location.protocol.startsWith('http') && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : 'http://localhost:8787');
$('token').value = store.get('token', '');

let base = '', token = '', connected = false, crop = null, lastMove = 0;
const controls = ['live', 'sound', 'shot', 'zoom', 'zoomReset', 'night'];
const pads = [...document.querySelectorAll('.pad button')];

function setStatus(t) { $('status').textContent = t; }
function setConnected(on) {
  connected = on;
  for (const id of controls) $(id).disabled = !on;
  for (const b of pads) b.disabled = !on;
  $('demo').hidden = on;
  if (!on) stopLive();
}
const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers } });

async function connect(e) {
  e?.preventDefault();
  base = $('addr').value.trim().replace(/\/+$/, '');
  token = $('token').value.trim();
  store.set('bridge', base); store.set('token', token);
  setStatus('Connecting...');
  try {
    const hello = await fetch(base + '/api/hello').then((r) => r.json());
    if (!hello.ok) throw new Error('not a camera bridge');
  } catch { setConnected(false); return setStatus('No bridge reachable at that address. Showing the demo.'); }
  try {
    const r = await api('/api/status');
    if (r.status === 401) { setConnected(false); return setStatus('The bridge answered, but the access token was refused.'); }
    const s = await r.json();
    if (!r.ok) throw new Error(s.error);
    setConnected(true);
    $('night').checked = s.night === 'night';
    setStatus(`Connected. Night vision: ${s.night}${s.inNightVision ? ' (infrared on now)' : ''}.`);
  } catch (err) { setConnected(false); setStatus(`The bridge is running but the camera did not answer: ${err.message}`); }
}

function showImage(src) {
  const old = $('snap').dataset.url; if (old) URL.revokeObjectURL(old);
  $('snap').src = src; $('snap').dataset.url = src;
  $('snap').hidden = false; $('placeholder').hidden = true; $('video').hidden = true;
}
async function snapshot() {
  stopLive();
  setStatus('Taking a snapshot...');
  const q = crop ? `?crop=${crop.map((n) => n.toFixed(4)).join(',')}` : '';
  try {
    const r = await api('/api/snapshot.jpg' + q);
    if (!r.ok) throw new Error((await r.json()).error);
    showImage(URL.createObjectURL(await r.blob()));
    setStatus(crop ? 'Zoomed snapshot.' : 'Snapshot taken.');
  } catch (e) { setStatus(`Snapshot failed: ${e.message}`); }
}

function stopLive() {
  const v = $('video'); if (!v.src) return;
  v.removeAttribute('src'); v.load(); v.hidden = true;
  $('live').textContent = 'Start live view'; $('live').setAttribute('aria-pressed', 'false');
}
function startLive() {
  const v = $('video');
  v.src = `${base}/api/stream?token=${encodeURIComponent(token)}`;
  v.muted = $('sound').getAttribute('aria-pressed') !== 'true';
  v.hidden = false; $('snap').hidden = true; $('placeholder').hidden = true;
  v.play().catch(() => setStatus('The browser could not play the live view.'));
  v.onerror = () => { setStatus('Live view stopped.'); stopLive(); };
  $('live').textContent = 'Stop live view'; $('live').setAttribute('aria-pressed', 'true');
  setStatus('Live view started. Sound is off until you press Sound.');
}
$('live').onclick = () => ($('video').getAttribute('src') ? stopLive() : startLive());
$('sound').onclick = () => {
  const on = $('sound').getAttribute('aria-pressed') !== 'true';
  $('sound').setAttribute('aria-pressed', String(on)); $('sound').textContent = on ? 'Sound on' : 'Sound off';
  $('video').muted = !on; if (on) $('video').play().catch(() => {});
};
$('shot').onclick = snapshot;

async function move(dx, dy) {
  if (Date.now() - lastMove < 1100) return;
  lastMove = Date.now();
  setStatus('Moving...');
  try {
    const r = await api('/api/move', { method: 'POST', body: JSON.stringify({ dx, dy, speed: 100 }) });
    if (!r.ok) throw new Error((await r.json()).error);
    setStatus('Moved one small step.');
  } catch (e) { setStatus(`Move failed: ${e.message}`); }
}
for (const b of pads) b.onclick = () => move(+b.dataset.dx, +b.dataset.dy);
const keys = { ArrowUp: [0, 10], ArrowDown: [0, -10], ArrowLeft: [-10, 0], ArrowRight: [10, 0] };
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (!connected || !keys[e.key] || ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(tag)) return;
  e.preventDefault(); move(...keys[e.key]);
});

$('night').onchange = async () => {
  const mode = $('night').checked ? 'night' : 'auto';
  try {
    const r = await api('/api/night', { method: 'POST', body: JSON.stringify({ mode }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    setStatus(`Night vision: ${j.mode}.`);
  } catch (e) { $('night').checked = !$('night').checked; setStatus(`Night vision change failed: ${e.message}`); }
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

$('conn').addEventListener('submit', connect);
setConnected(false);
if (store.get('token', '')) connect(); else { $('demo').hidden = false; setStatus('Not connected. Enter the bridge address and token, then Connect.'); }

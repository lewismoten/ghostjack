// Ghost Jack control page (Glassmouth's voice in the status text): talks to the local bridge (docs/bridge.md). No camera images are bundled.
import * as snd from './sound.js';
import { foley } from './foley.js';
import * as glass from './glass.js';
import * as live from './live.js';
import { netpath } from './netpath.js';
import * as tape from './tape.js';
import { createRecorder } from './record.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window */
    }
  },
};
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
$('addr').value = store.get(
  'bridge',
  /^(localhost|127\.0\.0\.1)$/.test(location.hostname) &&
    location.protocol.startsWith('http')
    ? location.origin
    : 'http://localhost:8787',
);
$('token').value = store.get('token', '');

// Theme: dark is the default; the choice is remembered.
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').setAttribute('aria-pressed', String(t === 'light'));
  $('theme').textContent = t === 'light' ? 'Dark theme' : 'Light theme';
  store.set('gm-theme', t);
}
setTheme(store.get('gm-theme', 'dark'));
$('theme').onclick = () =>
  setTheme(
    document.documentElement.dataset.theme === 'light' ? 'dark' : 'light',
  );

// Sound (both off by default).
$('sfx').checked = snd.state.sfx;
$('music').checked = snd.state.music;
$('sfx').onchange = () => snd.setSfx($('sfx').checked);
$('music').onchange = () => snd.setMusic($('music').checked);
$('voice').checked = snd.state.voice;
$('voice').onchange = () => {
  snd.setVoice($('voice').checked);
  if ($('voice').checked) setStatus(glass.line('jackIn'));
};
document.addEventListener(
  'click',
  (e) => {
    if (e.target.closest('button')) snd.sfx.blip();
  },
  true,
);
// Music was on last time: it can only start after a click.
if (snd.state.music)
  document.addEventListener('click', () => snd.setMusic(true), { once: true });

let lost = false,
  base = '',
  token = '',
  connected = false,
  crop = null,
  lastMove = 0;
const controls = [
  'live',
  'sound',
  'shot',
  'rec',
  'zoom',
  'zoomReset',
  'night',
  'infoLoad',
];
const pads = [...document.querySelectorAll('.pad button')];

function setStatus(t, bad) {
  $('status').textContent = t;
  if (bad) snd.sfx.error();
}
function setConnected(on) {
  const was = connected;
  connected = on;
  $('device').hidden = !on; // the header shows the camera only when one is jacked in
  for (const id of controls) $(id).disabled = !on;
  for (const b of pads) b.disabled = !on;
  $('sayGo').disabled = !on;
  for (const id of [
    's-brightness',
    's-contrast',
    's-saturation',
    's-sharpness',
    's-mic',
    'clock',
  ])
    $(id).disabled = !on;
  $('uplinkState').textContent = on ? 'Jacked in' : 'Flatline';
  $('uplinkState').classList.toggle('on', on);
  $('uplinkState').setAttribute(
    'aria-label',
    `Connection: ${on ? 'jacked in' : 'flatline'}. Open the Uplink tab`,
  );
  $('demoText').hidden = on;
  if (on) loadVoices();
  $('demo').hidden = on;
  $('light').classList.toggle('on', on);
  $('hConn').textContent = on ? 'JACKED IN' : 'FLATLINE';
  if (!on) {
    stopLive();
    setEye('Nobody');
  }
  if (on && !was) {
    snd.sfx.powerUp();
    if (!reduced) {
      const h = document.querySelector('h1');
      h.style.animation = 'none';
      void h.offsetWidth;
      h.style.animation = '';
    }
  }
}
// A fetch that fails outright (TypeError) means the browser blocked it or nothing answered: say so.
const BLOCKED =
  'the browser could not reach the bridge (is it running? from a public page, allow "local network access" for this site)';
const api = async (path, opts = {}) => {
  try {
    return await fetch(base + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });
  } catch (e) {
    throw e instanceof TypeError ? new Error(BLOCKED) : e;
  }
};
const net = netpath($('radar'), reduced);

async function connect(e) {
  e?.preventDefault();
  base = $('addr').value.trim().replace(/\/+$/, '');
  token = $('token').value.trim();
  store.set('bridge', base);
  store.set('token', token);
  setStatus('Jacking in...');
  net.start();
  let ok = false;
  try {
    try {
      const hello = await fetch(base + '/api/hello').then((r) => r.json());
      if (!hello.ok) throw new Error('not a camera bridge');
    } catch {
      setConnected(false);
      $('demo').hidden = false;
      return setStatus(
        `${glass.line('jackFail')} Nothing answered at that address, or the browser blocked it (public pages need "local network access" allowed). Demo shown.`,
        true,
      );
    }
    try {
      const r = await api('/api/status');
      if (r.status === 401) {
        setConnected(false);
        return setStatus('Wrong token. The ICE held.', true);
      }
      const s = await r.json();
      if (!r.ok) throw new Error(s.error);
      const first = !connected;
      ok = true;
      setConnected(true);
      if (first && tabNow() === 'uplink') selectTab('rig');
      $('night').checked = s.night === 'night';
      showNight(s.night);
      setStatus(
        `${lost ? 'Back in sight. ' : ''}${first ? glass.line('jackIn') : 'Jacked in.'} Night vision: ${s.night}${s.inNightVision ? ' (infrared on now)' : ''}.`,
      );
      lost = false;
      loadDevice();
    } catch (err) {
      setConnected(false);
      lost = true;
      setStatus(`Lost the angle. The rig did not answer: ${err.message}`, true);
    }
  } finally {
    foley.clack();
    await net.end(ok);
  }
}
// Who has the eye: You while this page is watching live, Nobody otherwise (agents come with the voice relay).
let eyeWho = 'Nobody';
function setEye(who) {
  if (who === eyeWho) return;
  eyeWho = who;
  $('eyeText').textContent =
    who === 'Nobody'
      ? 'Nobody has the eye'
      : `${who} ${who === 'You' ? 'have' : 'has'} the eye`;
  $('eye').classList.toggle('has', who !== 'Nobody');
  snd.sfx.relay();
  $('eye').classList.remove('flip');
  void $('eye').offsetWidth;
  $('eye').classList.add('flip');
}
async function loadDevice() {
  try {
    const r = await api('/api/info');
    const j = await r.json();
    if (r.ok && j.system?.model)
      $('device').textContent = `Rig: ${j.system.model.replace(/ \(.*/, '')}`;
  } catch {
    /* leave the line as it was */
  }
}
const showNight = (m) => {
  $('hNight').textContent = m === 'night' ? 'NV IR ON' : 'NV AUTO';
};

// HUD clock (local time of this computer).
setInterval(() => {
  $('hClock').textContent = new Date().toLocaleTimeString([], {
    hour12: false,
  });
}, 1000);

function showImage(src) {
  const old = $('snap').dataset.url;
  if (old) URL.revokeObjectURL(old);
  $('snap').src = src;
  $('snap').dataset.url = src;
  $('snap').hidden = false;
  $('placeholder').setAttribute('hidden', '');
  $('video').hidden = true;
}
let lastShot = null; // the picture on screen, with any digital-zoom crop already applied
async function snapshot() {
  stopLive();
  setStatus(glass.line('snapshot'));
  setTimeout(foley.shutter, 450);
  const q = crop ? `?crop=${crop.map((n) => n.toFixed(4)).join(',')}` : '';
  try {
    const r = await api('/api/snapshot.jpg' + q);
    if (!r.ok) throw new Error((await r.json()).error);
    lastShot = await r.blob();
    $('shotSave').disabled = $('shotDl').disabled = false;
    showImage(URL.createObjectURL(lastShot));
    setStatus(
      crop
        ? 'Hold that frame. Zoomed snapshot taken.'
        : 'Hold that frame. Snapshot taken.',
    );
  } catch (e) {
    setStatus(`Lost the angle. Snapshot failed: ${e.message}`, true);
    foley.staticBurst();
  }
}

let liveOn = false,
  liveHandle = null,
  liveLoop = null,
  liveToken = 0; // a new Go live or a stop cancels a start that is still waiting
let projectorNext = false;
// Live quality: the 1080p main stream, or the small sub-stream (p1) that starts faster and runs lighter.
// Recording and snapshots always use the main stream.
let liveQ = store.get('gm-liveq', 'hd') === 'fast' ? 'fast' : 'hd';
for (const r of document.querySelectorAll('input[name="lq"]')) {
  r.checked = r.value === liveQ;
  r.onchange = () => {
    liveQ = r.value;
    store.set('gm-liveq', liveQ);
    setStatus(
      `Live quality: ${liveQ === 'fast' ? 'Fast (sub-stream)' : '1080p'}. It applies the next time you go live.`,
    );
  };
}
function stopLive() {
  if (!liveOn) return;
  liveOn = false;
  scene?.setLive(false);
  liveToken++;
  liveHandle?.stop();
  liveHandle = null;
  liveLoop?.stop(0.3);
  liveLoop = null;
  const v = $('video');
  v.removeAttribute('src');
  v.load();
  v.hidden = true;
  $('live').textContent = 'Go live';
  $('live').setAttribute('aria-pressed', 'false');
  setEye('Nobody');
}
// The picture is really playing: settle the loop sound, then Glassmouth says so.
function liveStarted() {
  if (!liveOn) return;
  setTimeout(() => liveLoop?.stop(1.5), 1200);
  setStatus(
    `${glass.line('liveOpen')} Sound is ${$('video').muted ? 'off' : 'on'}.`,
  );
}
async function startLive() {
  const v = $('video'),
    me = ++liveToken;
  liveOn = true;
  scene?.setLive(true);
  v.muted = $('sound').getAttribute('aria-pressed') !== 'true';
  v.hidden = false;
  $('snap').hidden = true;
  $('placeholder').setAttribute('hidden', '');
  $('live').textContent = 'Stop live';
  $('live').setAttribute('aria-pressed', 'true');
  setEye('You');
  setStatus(`${glass.line('live')} Starting in a few seconds.`);
  foley.shuffle();
  projectorNext = !projectorNext;
  setTimeout(() => {
    if (liveOn && me === liveToken)
      liveLoop = projectorNext ? foley.projector() : foley.crt();
  }, 700);
  v.onerror = () => {
    if (me !== liveToken) return;
    setStatus('Lost the angle. Live view stopped.', true);
    stopLive();
  };
  v.onplaying = liveStarted;
  const fail = (m) => {
    if (me !== liveToken) return;
    setStatus(`Lost the angle. Live view stopped: ${m}.`, true);
    foley.staticBurst();
    stopLive();
  };
  const url = `${base}/api/stream${liveQ === 'fast' ? '?profile=p1' : ''}`;
  // Cross-origin (the public page talking to localhost): fetch + MediaSource, because the browser can
  // block a <video src> to a private address that fetch() is allowed to reach (see live.js).
  if (live.canUse(base)) {
    try {
      const h = await live.start(v, url, token, fail);
      if (me !== liveToken) return h.stop();
      liveHandle = h;
      v.play().catch(() => fail('the browser would not start playback'));
      return;
    } catch (e) {
      if (me !== liveToken) return;
      if (!e.unsupported) {
        if (e instanceof TypeError) return fail(BLOCKED);
        return fail(e.message);
      }
      // No MSE for this stream: fall through to the plain <video src>.
    }
  }
  v.src = `${url}${liveQ === 'fast' ? '&' : '?'}token=${encodeURIComponent(token)}`;
  v.play().catch(() => fail('the browser could not play the live view'));
}
$('live').onclick = () =>
  liveOn ? (stopLive(), setStatus(glass.line('liveStop'))) : startLive();
$('sound').onclick = () => {
  const on = $('sound').getAttribute('aria-pressed') !== 'true';
  $('sound').setAttribute('aria-pressed', String(on));
  $('sound').textContent = on ? 'Sound on' : 'Sound off';
  $('video').muted = !on;
  if (on)
    $('video')
      .play()
      .catch(() => {});
};
$('shot').onclick = snapshot;
$('shotDl').onclick = () => {
  if (lastShot) tape.download(lastShot, tape.stamp('jpg'));
};
$('shotSave').onclick = async () => {
  if (!lastShot) return;
  try {
    await tape.add({ kind: 'image', blob: lastShot, name: tape.stamp('jpg') });
    setStatus(
      `Saved to the Tape (${tape.bytes(lastShot.size)}). It stays in this browser.`,
    );
    renderTape();
  } catch {
    setStatus(
      'This browser would not keep it (storage is blocked). Use Download.',
      true,
    );
  }
};

// Recording: REC button, red blinking dot and timer in the video HUD, lines from Glassmouth.
const clock = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
const recorder = createRecorder({
  api,
  video: $('video'),
  isLive: () => liveOn,
  on: {
    start: (mode) => {
      $('rec').setAttribute('aria-pressed', 'true');
      $('rec').textContent = 'Stop REC';
      $('hRec').hidden = false;
      $('hRecT').textContent = '0:00';
      foley.reel(true);
      setStatus(
        `${glass.line('recStart')} Recording ${mode === 'bridge' ? 'on the bridge (MP4)' : 'in this browser (WebM)'}. Press Stop REC when done.`,
      );
    },
    tick: (n) => {
      $('hRecT').textContent = clock(n);
    },
    end: ({ capped, kept, size }) => {
      endRec();
      foley.reel(false);
      setStatus(
        `${glass.line(capped ? 'recCap' : 'recStop')} ${kept ? `Saved to the Tape (${tape.bytes(size)}), kept only in this browser.` : 'Downloaded (this browser would not keep it).'}`,
      );
      renderTape();
    },
    error: (m) => {
      endRec();
      setStatus(`Lost the angle. Recording: ${m}.`, true);
    },
  },
});
function endRec() {
  $('rec').setAttribute('aria-pressed', 'false');
  $('rec').textContent = 'REC';
  $('hRec').hidden = true;
}
$('rec').onclick = () => (recorder.active ? recorder.stop() : recorder.start());

// The Tape tab: everything saved, with thumbnails, view/play, Download and Delete.
async function renderTape() {
  const list = $('tapeList');
  let items;
  try {
    items = await tape.list();
  } catch {
    $('tapeUsed').textContent = 'Storage unavailable in this browser';
    list.replaceChildren();
    return;
  }
  for (const u of list.querySelectorAll('[data-url]'))
    URL.revokeObjectURL(u.dataset.url);
  const total = items.reduce((n, i) => n + i.size, 0);
  $('tapeUsed').textContent = items.length
    ? `${items.length} saved, ${tape.bytes(total)} used`
    : 'Empty';
  $('tapeClear').disabled = !items.length;
  list.replaceChildren(
    ...items.map((it) => {
      const url = URL.createObjectURL(it.blob);
      const li = document.createElement('li');
      const media = document.createElement(
        it.kind === 'image' ? 'img' : 'video',
      );
      media.src = url;
      media.dataset.url = url;
      if (it.kind === 'image') media.alt = `Saved snapshot ${it.name}`;
      else {
        media.controls = true;
        media.preload = 'metadata';
        media.setAttribute('aria-label', `Saved recording ${it.name}`);
      }
      const box = document.createElement('div');
      const name = document.createElement('div');
      name.textContent = `${it.name} (${tape.bytes(it.size)})`;
      const row = document.createElement('div');
      row.className = 'row';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.onclick = fn;
        return b;
      };
      row.append(
        mk('View', () =>
          it.kind === 'image'
            ? (showImage(URL.createObjectURL(it.blob)),
              (lastShot = it.blob),
              ($('shotSave').disabled = $('shotDl').disabled = false))
            : media.requestFullscreen?.().catch(() => media.play()),
        ),
        mk('Download', () => tape.download(it.blob, it.name)),
        mk('Delete', async () => {
          await tape.remove(it.id);
          renderTape();
        }),
      );
      box.append(name, row);
      li.append(media, box);
      return li;
    }),
  );
}
$('tapeClear').onclick = async () => {
  if (!confirm('Delete every saved snapshot and recording from this browser?'))
    return;
  await tape.clear();
  renderTape();
};
renderTape();

// Estimated aim: counted from the moves sent (the camera cannot report its position). Units are steps.
let pan = +store.get('gm-pan', 0) || 0,
  tilt = +store.get('gm-tilt', 0) || 0,
  scene = null;
const sgn = (n) => (n > 0 ? '+' : '') + n;
const DEG_PER_STEP = 1.5; // illustration only
let aim = null; // while the camera is being sent to a dragged target: { p, t } in steps
function showPose(instant) {
  const t = `Pan ${sgn(pan)} \u00b7 Tilt ${sgn(tilt)} (estimated${aim ? ', moving' : ''})`;
  $('pose').textContent = t;
  store.set('gm-pan', pan);
  store.set('gm-tilt', tilt);
  const mp = aim ? aim.p : pan,
    mt = aim ? aim.t : tilt;
  scene?.setPose(
    Math.max(-90, Math.min(90, mp * DEG_PER_STEP)),
    Math.max(-60, Math.min(60, mt * DEG_PER_STEP)),
    instant,
  );
}
$('recenter').onclick = () => {
  pan = tilt = 0;
  showPose();
};
showPose(true);

// Aim speed: the step size of one nudge (and of each repeat while a control is held). Remembered.
const STEPS = { fine: 4, normal: 10, fast: 15 }; // the bridge accepts up to 20; one step a second
let aimSens = store.get('gm-aim', 'normal');
if (!STEPS[aimSens]) aimSens = 'normal';
const stepSize = () => STEPS[aimSens];
for (const r of document.querySelectorAll('input[name="aim"]')) {
  r.checked = r.value === aimSens;
  r.onchange = () => {
    aimSens = r.value;
    store.set('gm-aim', aimSens);
    setStatus(`Aim speed: ${aimSens} (${stepSize()} a step).`);
  };
}
const STEP_MS = 1150; // the bridge allows one move a second
const TRAVEL_MS = 700; // a guess at how long one queued step takes to run

async function move(dx, dy, quiet) {
  if (!connected || Date.now() - lastMove < 1100) return false;
  lastMove = Date.now();
  if (!quiet) setStatus('Nudging...');
  try {
    const r = await api('/api/move', {
      method: 'POST',
      body: JSON.stringify({ dx, dy, speed: 100 }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    foley.servo(TRAVEL_MS / 1000);
    pan += dx;
    tilt += dy;
    showPose();
    if (!quiet) setStatus('Nudged one small step.');
    return true;
  } catch (e) {
    setStatus(`Lost the angle. Move failed: ${e.message}`, true);
    return false;
  }
}
// Hold a control: one step now, then one more every STEP_MS until released. Moves queue in the camera
// and a stop does not cancel them, so steps stay small and nothing is sent after the release.
let holdTimer = 0;
function holdStart(dx, dy) {
  holdStop();
  move(dx, dy);
  holdTimer = setInterval(() => move(dx, dy, true), STEP_MS);
}
function holdStop() {
  clearInterval(holdTimer);
  holdTimer = 0;
}
$('stage')
  .querySelector('.pad')
  .addEventListener('pointerdown', (e) => e.stopPropagation());
for (const b of pads) {
  const vec = () => [
    Math.sign(+b.dataset.dx) * stepSize(),
    Math.sign(+b.dataset.dy) * stepSize(),
  ];
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || b.disabled) return;
    b.setPointerCapture(e.pointerId);
    holdStart(...vec());
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'])
    b.addEventListener(ev, holdStop);
  // Keyboard activation (Enter or Space on a focused arrow) has no pointer: one step.
  b.addEventListener('click', (e) => {
    if (e.detail === 0) move(...vec());
  });
}
const keys = {
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};
let heldKey = null;
document.addEventListener('keydown', (e) => {
  if (
    !connected ||
    !keys[e.key] ||
    ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)
  )
    return;
  e.preventDefault();
  if (e.repeat || heldKey) return; // the page repeats on its own timer
  heldKey = e.key;
  holdStart(keys[e.key][0] * stepSize(), keys[e.key][1] * stepSize());
});
document.addEventListener('keyup', (e) => {
  if (e.key !== heldKey) return;
  heldKey = null;
  holdStop();
});
addEventListener('blur', () => {
  heldKey = null;
  holdStop();
});

// Dragging the camera model turns it in real time (the model follows the pointer). On release the
// camera is sent toward that orientation as small queued steps, one a second; the model is amber from
// then until the estimated arrival (the last step sent, plus a guess at its travel time).
let aimRun = 0; // a new drag cancels the steps still waiting to be sent
async function aimTo(tp, tt) {
  const me = ++aimRun;
  let rx = tp - pan,
    ry = tt - tilt;
  const st = stepSize();
  const cl = (n) => Math.max(-st, Math.min(st, n));
  if (Math.abs(rx) < st / 2 && Math.abs(ry) < st / 2) {
    aim = null;
    scene?.setMoving(false);
    return showPose();
  }
  aim = { p: pan + rx, t: tilt + ry };
  scene?.setMoving(true);
  showPose();
  setStatus(glass.line('moveStart'));
  while ((Math.abs(rx) >= st / 2 || Math.abs(ry) >= st / 2) && me === aimRun) {
    const sx = Math.abs(rx) >= st / 2 ? cl(rx) : 0,
      sy = Math.abs(ry) >= st / 2 ? cl(ry) : 0;
    while (Date.now() - lastMove < 1100)
      await new Promise((r) => setTimeout(r, 100));
    if (me !== aimRun) return;
    if (!(await move(sx, sy, true))) break;
    rx -= sx;
    ry -= sy;
    if (Math.abs(rx) >= st / 2 || Math.abs(ry) >= st / 2)
      await new Promise((r) => setTimeout(r, 50));
  }
  if (me !== aimRun) return;
  await new Promise((r) => setTimeout(r, TRAVEL_MS)); // the last queued step arrives
  if (me !== aimRun) return;
  aim = null;
  scene?.setMoving(false);
  showPose();
  setStatus(glass.line('moveDone'));
}
{
  let from = null;
  const m = $('model'),
    PX_PER_STEP = 3; // pixels of drag for one step of aim
  const lim = (n, l) => Math.max(-l, Math.min(l, n));
  m.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (!connected) return;
    aimRun++; // stop sending the steps of an earlier drag
    from = {
      x: e.clientX,
      y: e.clientY,
      p: aim ? aim.p : pan,
      t: aim ? aim.t : tilt,
    };
    m.setPointerCapture(e.pointerId);
  });
  const target = (e) => ({
    p: lim(Math.round(from.p + (e.clientX - from.x) / PX_PER_STEP), 60),
    t: lim(Math.round(from.t - (e.clientY - from.y) / PX_PER_STEP), 40),
  });
  m.addEventListener('pointermove', (e) => {
    if (!from) return;
    const t = target(e);
    scene?.setPose(t.p * DEG_PER_STEP, t.t * DEG_PER_STEP, true);
  });
  m.addEventListener('pointerup', (e) => {
    if (!from) return;
    const t = target(e);
    from = null;
    aimTo(t.p, t.t);
  });
  m.addEventListener('pointercancel', () => {
    from = null;
    aim = null;
    showPose(true);
  });
}

$('night').onchange = async () => {
  const mode = $('night').checked ? 'night' : 'auto';
  try {
    const r = await api('/api/night', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    showNight(j.mode);
    foley.softClick();
    setStatus(
      `${glass.line(j.mode === 'night' ? 'nightOn' : 'nightAuto')} Night vision: ${j.mode}.`,
    );
  } catch (e) {
    $('night').checked = !$('night').checked;
    setStatus(`Night vision change failed: ${e.message}`, true);
  }
};

// Digital zoom: a slider (centered crop) or a dragged box on the picture; the bridge crops the 1080p snapshot.
function setZoom(z) {
  $('zoomOut').textContent = `${z}x`;
  crop = z <= 1 ? null : [(1 - 1 / z) / 2, (1 - 1 / z) / 2, 1 / z, 1 / z];
}
$('zoom').oninput = () => {
  setZoom(+$('zoom').value);
  snapshot();
};
$('zoomReset').onclick = () => {
  $('zoom').value = 1;
  setZoom(1);
  snapshot();
};
let drag = null;
const stage = $('stage');
function frac(e) {
  const r = stage.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  ];
}
stage.addEventListener('pointerdown', (e) => {
  if (!connected || $('snap').hidden) return;
  drag = frac(e);
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = frac(e),
    b = $('box');
  b.hidden = false;
  Object.assign(b.style, {
    left: `${Math.min(x, drag[0]) * 100}%`,
    top: `${Math.min(y, drag[1]) * 100}%`,
    width: `${Math.abs(x - drag[0]) * 100}%`,
    height: `${Math.abs(y - drag[1]) * 100}%`,
  });
});
stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const [x, y] = frac(e),
    x0 = Math.min(x, drag[0]),
    y0 = Math.min(y, drag[1]);
  const w = Math.abs(x - drag[0]),
    h = Math.abs(y - drag[1]);
  drag = null;
  $('box').hidden = true;
  if (w < 0.04 || h < 0.04) return;
  zoomTo(x0, y0, w, h);
});
function zoomTo(x0, y0, bw, bh) {
  const w = Math.min(1, Math.max(bw, bh * (16 / 9))),
    h = w * (9 / 16);
  const cx = x0 + bw / 2,
    cy = y0 + bh / 2;
  crop = [
    Math.min(1 - w, Math.max(0, cx - w / 2)),
    Math.min(1 - h, Math.max(0, cy - h / 2)),
    w,
    h,
  ];
  $('zoom').value = Math.min(4, Math.max(1, Math.round((1 / w) * 4) / 4));
  $('zoomOut').textContent = `${(1 / w).toFixed(1)}x`;
  snapshot();
}

// Info and settings: read-only facts, plus the safe writes (image, microphone, clock).
const sliders = {
  brightness: 's-brightness',
  contrast: 's-contrast',
  saturation: 's-saturation',
  sharpness: 's-sharpness',
};
function fill(info) {
  const rows = [];
  const add = (k, v) =>
    v !== undefined && v !== null && rows.push([k, String(v)]);
  add('Type', info.system?.type);
  add('Model', info.system?.model);
  add('Software', info.system?.version);
  if (info.network) {
    add('Network link', info.network.link);
    add('Address mode', info.network.mode);
    add('IP address', info.network.ip?.addr);
    add('Netmask', info.network.ip?.mask);
    add('DNS', info.network.dns?.join(', '));
  }
  add('Camera clock (UTC)', info.date?.utc);
  if (info.disk) {
    add('SD card', info.disk.stat);
    add('SD size (MB)', info.disk.size);
  }
  const i = info.image;
  if (i) {
    add(
      'Picture',
      `${i.resolution.width}x${i.resolution.height} at ${i.framerate} fps (sensor setting; snapshots are 1080p)`,
    );
    add('Night mode', i.mode);
    add('Exposure', i.exposure);
    add('Wide dynamic range', i.wdr);
    add('Backlight compensation', i.backlight);
    add('White balance', i.whiteBalance);
  }
  add(
    'Microphone',
    info.mic && (info.mic.silent ? 'muted' : `level ${info.mic.level}`),
  );
  add('Alerts', info.alerts && (info.alerts.enabled ? 'on' : 'off'));
  $('infoList').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      return [dt, dd];
    }),
  );
  if (i) for (const [k, id] of Object.entries(sliders)) setSlider(id, i[k]);
  if (info.mic) setSlider('s-mic', info.mic.level);
}
const blank = () =>
  $('infoList').replaceChildren(
    ...[
      'Type',
      'Model',
      'Software',
      'Network link',
      'IP address',
      'Camera clock (UTC)',
      'SD card',
      'Picture',
      'Night mode',
      'Microphone',
      'Alerts',
    ].flatMap((k) => {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = '--';
      return [dt, dd];
    }),
  );
blank();
function setSlider(id, v) {
  if (v === undefined) return;
  $(id).value = v;
  $(id).nextElementSibling.textContent = v;
}
async function loadInfo() {
  setStatus('Looking the rig over...');
  try {
    const r = await api('/api/info');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    fill(j);
    setStatus('Rig read. Everything on the sheet.');
  } catch (e) {
    setStatus(`Could not read camera info: ${e.message}`, true);
  }
}
$('infoLoad').onclick = loadInfo;
async function write(path, body, done) {
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    setStatus(done);
    return j;
  } catch (e) {
    setStatus(`Change failed: ${e.message}`, true);
    loadInfo();
  }
}
for (const [k, id] of Object.entries(sliders)) {
  $(id).oninput = () => {
    $(id).nextElementSibling.textContent = $(id).value;
  };
  $(id).onchange = () =>
    write('/api/image', { [k]: +$(id).value }, `${k} set to ${$(id).value}.`);
}
$('s-mic').oninput = () => {
  $('s-mic').nextElementSibling.textContent = $('s-mic').value;
};
$('s-mic').onchange = () =>
  write(
    '/api/mic',
    { level: +$('s-mic').value },
    `Microphone level set to ${$('s-mic').value}.`,
  );
$('clock').onclick = async () => {
  const j = await write(
    '/api/clock',
    {},
    'Camera clock set from this computer (UTC).',
  );
  if (j) loadInfo();
};

// Tabs (WAI-ARIA tabs pattern): arrows, Home and End move between them; the last one is remembered.
const tabEls = [...document.querySelectorAll('[role=tab]')];
const tabNow = () =>
  tabEls.find((t) => t.getAttribute('aria-selected') === 'true').dataset.tab;
function selectTab(id, focus) {
  if (!tabEls.some((t) => t.dataset.tab === id)) id = 'uplink';
  for (const t of tabEls) {
    const on = t.dataset.tab === id;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus();
  }
  store.set('gm-tab', id);
}
tabEls.forEach((t, i) => {
  t.onclick = () => selectTab(t.dataset.tab);
  t.onkeydown = (e) => {
    const to = {
      ArrowRight: (i + 1) % tabEls.length,
      ArrowLeft: (i + tabEls.length - 1) % tabEls.length,
      Home: 0,
      End: tabEls.length - 1,
    }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    selectTab(tabEls[to].dataset.tab, true);
  };
});
selectTab(store.get('gm-tab', 'uplink'));
$('uplinkState').onclick = () => selectTab('uplink', true);
$('demoHelp').onclick = () => selectTab('uplink', true);

// Glassmouth says: speak through the camera's speaker (one line at a time; the bridge queues them).
let voicesLoaded = false;
async function loadVoices() {
  if (voicesLoaded) return;
  voicesLoaded = true;
  try {
    const j = await (await api('/api/voices')).json();
    for (const v of j.voices || []) {
      const o = document.createElement('option');
      o.value = o.textContent = v;
      $('sayVoice').append(o);
    }
  } catch {
    voicesLoaded = false;
  }
}
$('sayChime').oninput = () => {
  $('sayChimeOut').textContent = (+$('sayChime').value).toFixed(3);
};
$('sayLevel').oninput = () => {
  $('sayLevelOut').textContent = (+$('sayLevel').value).toFixed(3);
};
const sayLine = (t) => {
  $('sayStatus').textContent = t;
};
let saying = false;
$('sayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('sayText').value.trim();
  if (!text || saying) return;
  saying = true;
  $('sayGo').disabled = true;
  sayLine(glass.line('say'));
  try {
    const r = await api('/api/say', {
      method: 'POST',
      body: JSON.stringify({
        text,
        voice: $('sayVoice').value || undefined,
        level: +$('sayLevel').value,
        chimeLevel: +$('sayChime').value,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    snd.sfx.relay();
    sayLine('Line open. Waiting for the floor.');
    for (let i = 0; i < 90; i++) {
      await new Promise((ok) => setTimeout(ok, 1000));
      const s = await (await api(`/api/say/${j.id}`)).json();
      if (s.status === 'speaking') sayLine('On air.');
      else if (s.status === 'queued')
        sayLine(`Waiting for the floor. ${s.ahead} ahead.`);
      else if (s.status === 'done') {
        sayLine('Done. Said it.');
        snd.sfx.relay();
        $('sayText').value = '';
        return;
      } else {
        sayLine(`Line's busy. It did not go out (${s.error || 'failed'}).`);
        snd.sfx.error();
        return;
      }
    }
    sayLine("Line's busy. Static, no word back; check the rig.");
  } catch (err) {
    sayLine(`Line's busy. ${err.message}`);
    snd.sfx.error();
  } finally {
    saying = false;
    $('sayGo').disabled = !connected;
  }
});

$('conn').addEventListener('submit', connect);
setConnected(false);
if (store.get('token', '')) connect();
else {
  $('demo').hidden = false; // the demo strip already says it; no second status line
}

// The 3D extras load last, so the page works without them; any failure leaves the plain CSS look.
const loadScene = () =>
  import('./scene.js')
    .then((m) =>
      m.start({
        bg: $('bg'),
        model: $('model'),
        reduced,
        onPulse: (dir) => foley.whoosh(dir),
        // never over Glassmouth's voice, never under the live picture's first seconds
        canPulse: () => !(window.speechSynthesis && speechSynthesis.speaking),
      }),
    )
    .then((s) => {
      scene = s;
      showPose(true);
    })
    .catch(() => {
      $('bg').hidden = true;
    });
if ('requestIdleCallback' in window)
  requestIdleCallback(loadScene, { timeout: 3000 });
else setTimeout(loadScene, 1500);

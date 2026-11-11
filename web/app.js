// Ghost Jack control page (Glassmouth's voice in the status text): talks to the local bridge (docs/bridge.md). No camera images are bundled.
import * as snd from './sound.js';
import { foley } from './foley.js';
import * as glass from './glass.js';
import * as live from './live.js';
import { netpath } from './netpath.js';
import * as tape from './tape.js';
import { createRecorder } from './record.js';
import * as lim from './limits.js';
import * as sph from './sphere.js';

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
// Agent voice lives on the bridge (so it survives a reload): the box follows /api/status and posts changes.
$('agentVoice').onchange = async () => {
  const want = $('agentVoice').checked;
  try {
    const r = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ agentVoice: want }),
    });
    if (!r.ok) throw new Error();
    $('agentVoice').checked = (await r.json()).agentVoice;
  } catch {
    $('agentVoice').checked = !want;
    setStatus('Could not change the agent voice.');
  }
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
const updateArrowsSoon = () => queueMicrotask(() => updateArrows());
let activeCam = '';
let activeEntry = null; // the active camera's entry from /api/cameras
let frameSize = null; // width and height of the last full-frame snapshot // the active camera's id (the zoomed view is remembered per camera)
let ptzOn = true; // the active camera can pan and tilt (see loadCameras)
const controls = [
  'live',
  'sound',
  'shot',
  'stills',
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
  updateArrowsSoon();
  if (on) loadCameras();
  else for (const id of ['camSel', 'micSel']) $(id).disabled = true;
  $('sayGo').disabled = !on;
  $('jackOut').disabled = !on;
  renderKeys();
  if (on && Number($('stills').value)) setTimeout(stillsTick, 1500);
  if (!on) clearTimeout(stillsTimer);
  // Flatlined: whatever was last on screen stays, drained to grayscale.
  $('stage').classList.toggle('flat', !on);
  $('lastBar').hidden = on || $('snap').hidden;
  if (!on) showAge();
  $('limitsGo').disabled = !on || finding;
  for (const id of [
    's-brightness',
    's-contrast',
    's-saturation',
    's-sharpness',
    'c-wdr',
    'c-backlight',
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
// The bridge's microphone would hear Glassmouth's voice as Lewis: tell it when a line is spoken.
glass.onSpeech((speaking, text) => {
  if (!token) return;
  api('/api/converse/page-voice', {
    method: 'POST',
    body: JSON.stringify({ speaking, text }),
  }).catch(() => {});
});
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
      $('night').value = ['night', 'day'].includes(s.night) ? s.night : 'auto';
      showNight(s.night);
      $('agentVoice').checked = s.agentVoice !== false;
      // the infrared tint is Glasseye's: a USB camera's picture is never tinted (2026-11-10)
      setIR(
        s.inNightVision && (!s.activeCamera || s.activeCamera === 'glasseye'),
      );
      setStatus(
        `${lost ? 'Back in sight. ' : ''}${first ? glass.line('jackIn') : 'Jacked in.'} Night vision: ${s.night}${s.inNightVision ? ' (infrared on now)' : ''}.`,
      );
      lost = false;
      loadDevice();
      loadCameras();
      loadAim().then(showLimitsInfo);
      loadShotPics();
      loadShots();
      if (first && !liveOn) autoSnapSoon(300);
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
  if (activeEntry && !activeEntry.capabilities.includes('ptz')) {
    $('device').textContent = `Rig: ${activeEntry.name} (USB camera)`;
    return;
  }
  try {
    const r = await api('/api/info');
    const j = await r.json();
    if (r.ok && j.system?.model)
      $('device').textContent = `Rig: ${j.system.model.replace(/ \(.*/, '')}`;
  } catch {
    /* leave the line as it was */
  }
}
var lastNight = 'auto';
const showNight = (m) => {
  lastNight = ['night', 'day'].includes(m) ? m : 'auto';
  $('hNight').textContent =
    m === 'night' ? 'NV IR ON' : m === 'day' ? 'NV COLOR?' : 'NV AUTO';
  if (m === 'night') setIR(true);
  else setTimeout(pollIR, 3000); // automatic: ask the camera what it chose
};
// Is the picture infrared right now? The camera says so in its status;
// automatic mode switches on its own, so it is asked again every 20 s.
var ir = false;
function setIR(on) {
  ir = !!on;
  $('stage').classList.toggle('ir', ir);
}
async function pollIR() {
  if (!connected) return;
  try {
    const r = await api('/api/status');
    if (r.ok) setIR((await r.json()).inNightVision);
  } catch {
    /* next time */
  }
}
setInterval(pollIR, 20000);

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
// auto: a quiet refresh (after jacking in or a move while not live): no voice
// line or shutter sound, just a fresh frame.
async function snapshot(auto = false) {
  stopLive();
  if (!auto) {
    setStatus(glass.line('snapshot'));
    setTimeout(foley.shutter, 450);
  }
  const q = crop ? `?crop=${crop.map((n) => n.toFixed(4)).join(',')}` : '';
  try {
    const r = await api('/api/snapshot.jpg' + q);
    if (!r.ok) throw new Error((await r.json()).error);
    lastShot = await r.blob();
    rememberFrame(lastShot);
    rememberPose(lastShot);
    if (!crop) {
      paintBlob(lastShot);
      createImageBitmap(lastShot)
        .then((b) => {
          frameSize = [b.width, b.height];
          b.close();
        })
        .catch(() => {});
    }
    $('shotSave').disabled = $('shotDl').disabled = false;
    showImage(URL.createObjectURL(lastShot));
    setStatus(
      auto
        ? 'Fresh frame.'
        : crop
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
  setTimeout(() => {
    // the picture's noise with nothing aimed: two frames apart, for wall detection
    const a = liveFrame();
    setTimeout(() => {
      const b = liveFrame();
      if (a && b) liveNoise = lim.diff(a, b);
    }, 500);
  }, 2500);
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
let aim = null; // while the camera is being sent to a dragged target: { p, t } in units
// The neck's measured range (units, centered on 0) once "Find limits" has run, and any wall the page ran
// into since (blocked directions). Both are estimates; Find limits again if someone turned the neck by hand.
let limits = null; // { panMin, panMax, tiltMin, tiltMax }
const blocked = { l: false, r: false, u: false, d: false };
const PAN_DEGREES = 350; // the camera's pan travel (about), from its specification
const degPer = () =>
  limits ? PAN_DEGREES / (limits.panMax - limits.panMin) : DEG_PER_STEP;
// The lens Find limits measured: { fovH, fovV, tiltDegPerUnit } (degrees), or null. Tilt uses the measured
// degrees per unit when there are some, else the pan figure (unchecked).
let lens = null;
const degPerTilt = () => lens?.tiltDegPerUnit ?? degPer();
// How much of a wanted move fits before a wall: returns [dx, dy] (zero where blocked).
function room(dx, dy) {
  let rx = dx,
    ry = dy;
  // The measured range is only an estimate (the camera never reports where it
  // points, and it may be turned by hand or re-home after a power cycle), so
  // it doesn't clamp moves; only a wall confirmed by the picture does.
  if ((dx > 0 && blocked.r) || (dx < 0 && blocked.l)) rx = 0;
  if ((dy > 0 && blocked.u) || (dy < 0 && blocked.d)) ry = 0;
  // under 2 units is not worth a move
  return [
    Math.abs(rx) < 2 ? 0 : Math.round(rx),
    Math.abs(ry) < 2 ? 0 : Math.round(ry),
  ];
}
// Cameras: the active camera (picture) and the listening mic are chosen on the bridge (GET /api/cameras).
// Pan, tilt and Vision belong to Glasseye, so they disable when another camera is active.
function applyPtz() {
  $('night').disabled = !connected || !ptzOn;
  updateArrows();
}
async function loadCameras() {
  try {
    const r = await api('/api/cameras');
    if (!r.ok) return;
    const j = await r.json();
    const fill = (id, cap, current) => {
      const sel = $(id);
      sel.replaceChildren();
      for (const c of j.cameras.filter((c) => c.capabilities.includes(cap))) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        sel.append(o);
      }
      sel.value = current;
      sel.disabled = !connected || sel.options.length < 2;
    };
    fill('camSel', 'video', j.active);
    fill('micSel', 'mic', j.mic);
    const cam = j.cameras.find((c) => c.id === j.active);
    ptzOn = !!cam && cam.capabilities.includes('ptz');
    activeEntry = cam ?? null;
    fillModes(cam);
    frameSize = null;
    loadDevice();
    if (j.active !== activeCam) {
      activeCam = j.active;
      restoreView();
    }
    applyPtz();
  } catch {
    /* the selectors stay as they were */
  }
}
// Resolution and FPS selects: shown only for a USB camera that lists modes.
function fillModes(cam) {
  const list = cam?.modes ?? [];
  const show = list.length > 0 && !!cam.mode;
  $('modeBox').hidden = $('fpsBox').hidden = !show;
  if (!show) return;
  const area = (m) => m.size.split('x').reduce((a, b) => a * b, 1);
  const opt = (v, t) =>
    Object.assign(document.createElement('option'), {
      value: v,
      textContent: t,
    });
  const sizes = $('modeSel');
  sizes.replaceChildren(
    ...[...list]
      .sort((a, b) => area(b) - area(a))
      .map((m) => opt(m.size, m.size.replace('x', ' x '))),
  );
  sizes.value = cam.mode.size;
  const fps = $('fpsSel');
  fps.replaceChildren(
    ...(list.find((m) => m.size === cam.mode.size)?.fps ?? []).map((f) =>
      opt(f, String(f)),
    ),
  );
  fps.value = String(cam.mode.fps);
  sizes.disabled = fps.disabled = !connected;
}
async function pickMode(size, fps) {
  const r = await api('/api/cameras/mode', {
    method: 'POST',
    body: JSON.stringify({ id: activeEntry.id, size, fps: Number(fps) }),
  });
  if (!r.ok) setStatus(`Mode: ${(await r.json()).error}`, true);
  else setStatus(`Camera mode: ${size} at ${fps} fps.`);
  await loadCameras();
  if (!r.ok) return;
  if (liveOn) {
    stopLive();
    startLive();
  } else if (!(Number($('stills').value) > 0)) autoSnapSoon(300);
}
$('modeSel').onchange = () => {
  // keep the fps if the new size offers it, else the nearest to 30
  const m = activeEntry.modes.find((x) => x.size === $('modeSel').value);
  const want = Number($('fpsSel').value);
  const fps = m.fps.includes(want)
    ? want
    : [...m.fps].sort((a, b) => Math.abs(a - 30) - Math.abs(b - 30))[0];
  pickMode($('modeSel').value, fps);
};
$('fpsSel').onchange = () => pickMode($('modeSel').value, $('fpsSel').value);
async function pickCamera(path, sel, label) {
  const r = await api(path, {
    method: 'POST',
    body: JSON.stringify({ id: sel.value }),
  });
  if (!r.ok) setStatus(`${label}: ${(await r.json()).error}`, true);
  await loadCameras();
  return r.ok;
}
$('camSel').onchange = async () => {
  if (!(await pickCamera('/api/cameras/active', $('camSel'), 'Camera'))) return;
  setStatus(`Camera: ${$('camSel').selectedOptions[0].textContent}.`);
  if (liveOn) {
    stopLive();
    startLive();
  } else if (!(Number($('stills').value) > 0)) autoSnapSoon(300);
};
$('micSel').onchange = async () => {
  if (await pickCamera('/api/converse/mic', $('micSel'), 'Mic'))
    setStatus(`Listening mic: ${$('micSel').selectedOptions[0].textContent}.`);
};

function updateArrows() {
  for (const b of pads) {
    const [rx, ry] = room(
      Math.sign(+b.dataset.dx) * 2,
      Math.sign(+b.dataset.dy) * 2,
    );
    const wall = !connected ? false : !rx && !ry;
    const sx = Math.sign(+b.dataset.dx),
      sy = Math.sign(+b.dataset.dy);
    const near =
      connected &&
      !wall &&
      limits &&
      ((sx > 0 && pan >= limits.panMax) ||
        (sx < 0 && pan <= limits.panMin) ||
        (sy > 0 && tilt >= limits.tiltMax) ||
        (sy < 0 && tilt <= limits.tiltMin));
    if (digitalPad()) {
      const [cx, cy, cw, ch] = crop,
        dx = +b.dataset.dx,
        dy = +b.dataset.dy;
      const edge =
        (dx > 0 && cx >= 1 - cw - 0.001) ||
        (dx < 0 && cx <= 0.001) ||
        (dy > 0 && cy <= 0.001) ||
        (dy < 0 && cy >= 1 - ch - 0.001);
      b.disabled = !connected || edge;
      b.classList.remove('near-wall');
      b.title = edge ? 'At the edge of the picture' : 'Pan the zoomed view';
      continue;
    }
    b.disabled = !connected || wall || (!ptzOn && !zoomed());
    b.classList.toggle('near-wall', !!near);
    b.title = !ptzOn
      ? 'This camera cannot pan or tilt (zoom in to pan the view)'
      : wall
        ? 'At the wall (the picture stopped changing twice)'
        : near
          ? 'Near the estimated wall: press to try anyway'
          : '';
  }
}
// Range indicator in the Eye header: where the estimate sits between the walls.
function showRange() {
  const el = $('range');
  el.hidden = !limits;
  if (!limits) return;
  const f = (v, lo, hi) =>
    `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  $('rangePan').style.setProperty('--at', f(pan, limits.panMin, limits.panMax));
  $('rangeTilt').style.setProperty(
    '--at',
    f(tilt, limits.tiltMin, limits.tiltMax),
  );
  el.setAttribute(
    'aria-label',
    `Pan range about ${PAN_DEGREES} degrees, estimated. Estimated pan ${Math.round(((pan - limits.panMin) / (limits.panMax - limits.panMin)) * 100)} percent across.`,
  );
}
// The state is kept per bridge address in this browser, and on the bridge for agents and other browsers.
const aimKey = () => `gm-aim:${base}`;
let aimSaveTimer = 0;
function saveAim(now) {
  clearTimeout(aimSaveTimer);
  aimSaveTimer = setTimeout(
    () => {
      store.set(aimKey(), JSON.stringify({ pan, tilt, limits, lens }));
      if (connected)
        api('/api/aim', {
          method: 'POST',
          body: JSON.stringify({ pan, tilt, ...limits, ...lens }),
        }).catch(() => {});
    },
    now ? 0 : 800,
  );
}
async function loadAim() {
  try {
    const mine = JSON.parse(store.get(aimKey(), 'null'));
    const r = await api('/api/aim');
    const theirs = r.ok ? await r.json() : null;
    // The bridge's copy wins when it has a range (shared), else this browser's.
    if (theirs && theirs.panMax !== undefined) {
      limits = {
        panMin: theirs.panMin,
        panMax: theirs.panMax,
        tiltMin: theirs.tiltMin,
        tiltMax: theirs.tiltMax,
      };
      lens =
        theirs.fovH > 0
          ? {
              fovH: theirs.fovH,
              fovV: theirs.fovV,
              tiltDegPerUnit: theirs.tiltDegPerUnit,
            }
          : (mine?.lens ?? null);
      pan = theirs.pan ?? 0;
      tilt = theirs.tilt ?? 0;
    } else if (mine) {
      limits = mine.limits;
      lens = mine.lens ?? null;
      pan = mine.pan ?? pan;
      tilt = mine.tilt ?? tilt;
    }
    await loadSphere();
    showPose(true);
  } catch {
    /* keep the estimate as it is */
  }
}
function showPose(instant) {
  const t = `Pan ${sgn(pan)} \u00b7 Tilt ${sgn(tilt)} (estimated${aim ? ', moving' : ''})`;
  $('pose').textContent = t;
  store.set('gm-pan', pan);
  store.set('gm-tilt', tilt);
  const mp = aim ? aim.p : pan,
    mt = aim ? aim.t : tilt,
    k = degPer(),
    kt = degPerTilt();
  scene?.setPose(
    Math.max(-175, Math.min(175, mp * k)),
    Math.max(-60, Math.min(60, mt * kt)),
    instant,
  );
  showRange();
  updateArrows();
  if (base) saveAim();
}
// Re-center: with a known range, move to the middle of it; otherwise just zero the estimate.
$('recenter').onclick = () => {
  if (limits && connected) return aimTo(0, 0, true);
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
let finding = false; // Find limits is running: no other moves
const STEP_MS = 1150; // the bridge allows one move a second
const TRAVEL_MS = 700; // a guess at how long one queued step takes to run

// When not live, show where the camera ended up: one quiet snapshot after the
// last move settles (held arrows reset the timer, so only the final position).
let autoSnapTimer = 0;
function autoSnapSoon(ms) {
  clearTimeout(autoSnapTimer);
  autoSnapTimer = setTimeout(() => {
    if (connected && !liveOn) snapshot(true);
  }, ms);
}
async function move(dx, dy, quiet) {
  closeGrid();
  if (!connected || finding || Date.now() - lastMove < 1100) return false;
  [dx, dy] = room(dx, dy);
  if (!dx && !dy) {
    if (!quiet) setStatus("That's the wall. The neck stops there (estimated).");
    return false;
  }
  lastMove = Date.now();
  const before = liveFrame();
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
    if (dx) {
      blocked.l = blocked.l && dx > 0 ? false : blocked.l;
      blocked.r = blocked.r && dx < 0 ? false : blocked.r;
    }
    if (dy) {
      blocked.d = blocked.d && dy > 0 ? false : blocked.d;
      blocked.u = blocked.u && dy < 0 ? false : blocked.u;
    }
    if (atSlot) {
      atSlot = 0; // moved off the saved shot
      renderKeys();
    }
    shiftRangeToFit();
    showPose();
    wallCheck(dx, dy, before);
    if (!liveOn) autoSnapSoon(TRAVEL_MS + 300);
    if (!quiet) setStatus('Nudged one small step.');
    return true;
  } catch (e) {
    setStatus(`Lost the angle. Move failed: ${e.message}`, true);
    return false;
  }
}
// Reading the picture cheaply: a 32 x 18 gray copy of the live video, when it is playing and readable.
const liveFrame = () =>
  liveOn && $('video').readyState >= 2 ? lim.gray($('video')) : null;
let liveNoise = 1;
// Edge detection in normal use: a real step that leaves the live picture unchanged hit the wall.
// Edge detection in normal use. A wall counts only when two moves in a row in
// the same direction leave the live picture unchanged (one can just be the
// video lagging), and never on a plain view (a blank wall looks the same
// moving or not).
const strikes = { l: 0, r: 0, u: 0, d: 0 };
const dirOf = (dx, dy) =>
  dx > 0 ? 'r' : dx < 0 ? 'l' : dy > 0 ? 'u' : dy < 0 ? 'd' : '';
function plain(frame) {
  let sum = 0,
    sq = 0;
  for (const v of frame) {
    sum += v;
    sq += v * v;
  }
  const mean = sum / frame.length;
  return Math.sqrt(sq / frame.length - mean * mean) < 12;
}
function wallCheck(dx, dy, before) {
  const k = dirOf(dx, dy);
  if (!k || !before || Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
  if (plain(before)) return;
  setTimeout(() => {
    const after = liveFrame();
    if (!after) return;
    if (!lim.same(lim.diff(before, after), liveNoise)) {
      strikes[k] = 0; // it moved: no wall here
      return;
    }
    if (++strikes[k] < 2) return;
    strikes[k] = 0;
    blocked[k] = true;
    if (limits) {
      // a confirmed wall pins that end of the range where the estimate is now
      const shift = {
        r: pan - limits.panMax,
        l: pan - limits.panMin,
        u: tilt - limits.tiltMax,
        d: tilt - limits.tiltMin,
      }[k];
      if (k === 'r' || k === 'l') {
        limits.panMin += shift;
        limits.panMax += shift;
      } else {
        limits.tiltMin += shift;
        limits.tiltMax += shift;
      }
    }
    showPose();
    setStatus(
      `${glass.line('wall')} Two moves and the picture didn't change (estimated).`,
    );
  }, TRAVEL_MS + 1500);
}
// The measured range keeps its width; if the estimate goes past an end and the
// camera still moved, the range was off, so slide it to fit.
function shiftRangeToFit() {
  if (!limits) return;
  if (pan > limits.panMax) {
    const d = pan - limits.panMax;
    limits.panMin += d;
    limits.panMax += d;
  } else if (pan < limits.panMin) {
    const d = pan - limits.panMin;
    limits.panMin += d;
    limits.panMax += d;
  }
  if (tilt > limits.tiltMax) {
    const d = tilt - limits.tiltMax;
    limits.tiltMin += d;
    limits.tiltMax += d;
  } else if (tilt < limits.tiltMin) {
    const d = tilt - limits.tiltMin;
    limits.tiltMin += d;
    limits.tiltMax += d;
  }
}

// Hold a control: one step now, then one more every STEP_MS until released. Moves queue in the camera
// and a stop does not cancel them, so steps stay small and nothing is sent after the release.
let holdTimer = 0;
function holdStart(dx, dy, digital = false) {
  holdStop();
  if (digital) {
    panStep(dx, dy);
    holdTimer = setInterval(() => {
      if (!panStep(dx, dy)) holdStop();
    }, 160);
    return;
  }
  move(dx, dy);
  holdTimer = setInterval(() => {
    const [rx, ry] = room(dx, dy);
    if (!rx && !ry) return holdStop(); // at the wall: stop sending
    move(dx, dy, true);
  }, STEP_MS);
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
    holdStart(...vec(), digitalPad());
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'])
    b.addEventListener(ev, holdStop);
  // Keyboard activation (Enter or Space on a focused arrow) has no pointer: one step.
  b.addEventListener('click', (e) => {
    if (e.detail === 0) digitalPad() ? panStep(...vec()) : move(...vec());
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
  // Shift or the focused picture pans a zoomed view on any camera; a camera that cannot move always does
  const digital = zoomed() && (!ptzOn || e.shiftKey || e.target === stage);
  holdStart(keys[e.key][0] * stepSize(), keys[e.key][1] * stepSize(), digital);
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
async function aimTo(tp, tt, fast) {
  const me = ++aimRun;
  if (limits) {
    tp = Math.max(limits.panMin, Math.min(limits.panMax, tp));
    tt = Math.max(limits.tiltMin, Math.min(limits.tiltMax, tt));
  }
  let rx = tp - pan,
    ry = tt - tilt;
  const st = stepSize();
  if (fast && Math.max(Math.abs(rx), Math.abs(ry)) > st)
    return travel(Math.round(rx), Math.round(ry), me);
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
// A travel move: one long step at full speed (re-center, saved shots). The
// camera can't stop it once sent, so nothing else moves until it should have
// arrived (the bridge's estimate of the trip).
async function travel(dx, dy, me, quiet) {
  if (!connected || finding) return;
  if (!dx && !dy) return; // already there (the bridge refuses an empty move)
  while (Date.now() - lastMove < 1100)
    await new Promise((r) => setTimeout(r, 100));
  if (me !== aimRun) return;
  aim = { p: pan + dx, t: tilt + dy };
  scene?.setMoving(true);
  showPose();
  if (!quiet) setStatus(glass.line('moveStart'));
  try {
    const r = await api('/api/travel', {
      method: 'POST',
      body: JSON.stringify({ dx, dy }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const { ms } = await r.json();
    const sentAt = Date.now();
    lastMove = Date.now() + ms - 1100;
    const k = degPer(),
      kt = degPerTilt(),
      units = tripUnits(dx, dy);
    scene?.travel(
      Math.max(-175, Math.min(175, (pan + dx) * k)),
      Math.max(-60, Math.min(60, (tilt + dy) * kt)),
      units * msPerUnit + 250,
    );
    foley.servo(Math.min(4, ms / 1000));
    pan += dx;
    tilt += dy;
    blocked.l = blocked.r = blocked.u = blocked.d = false;
    showPose();
    const settledAt = await waitArrival(ms, me);
    if (me !== aimRun) return; // a newer trip owns the model now
    scene?.arrive();
    learnSpeed(units, settledAt ? settledAt - sentAt : 0);
    lastMove = Date.now();
    api('/api/travel/done', { method: 'POST' }).catch(() => {});
    if (quiet) return;
    if (!liveOn) await snapshot(true);
    setStatus(glass.line('moveDone'));
  } catch (e) {
    if (me === aimRun) scene?.arrive();
    setStatus(`Lost the angle. Move failed: ${e.message}`, true);
  } finally {
    if (me === aimRun) {
      aim = null;
      scene?.setMoving(false);
    }
    showPose();
  }
}

// The trip estimate is only a ceiling. Watch for arrival instead: small
// frames (the live picture, or the camera's quick sub-stream snapshot) until
// two in a row match, which means the neck has stopped.
async function probeFrame() {
  if (liveOn) return liveFrame();
  try {
    const r = await api('/api/snapshot.jpg?profile=p1');
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    const g = lim.gray(bmp);
    bmp.close();
    return g;
  } catch {
    return null;
  }
}
async function waitArrival(ms, me) {
  const end = Date.now() + ms;
  const nap = (t) => new Promise((r) => setTimeout(r, t));
  await nap(500);
  let prevAt = Date.now(),
    prev = await probeFrame();
  while (Date.now() < end && me === aimRun) {
    await nap(liveOn ? 300 : 150);
    const at = Date.now(),
      cur = await probeFrame();
    if (prev && cur && lim.same(lim.diff(prev, cur), liveNoise)) return prevAt;
    prev = cur;
    prevAt = at;
  }
  return 0; // not seen: no picture, or the estimate ran out
}
// How fast the neck really travels, learned from trips that were seen to
// settle (milliseconds per move unit), so the model and its target ring
// predict the arrival. Remembered in this browser.
const tripUnits = (dx, dy) =>
  Math.max(Math.abs(dx), Math.abs(dy)) +
  Math.min(Math.abs(dx), Math.abs(dy)) / 2;
let msPerUnit = Number(store.get('gm-travel-mspu', 20)) || 20;
function learnSpeed(units, took) {
  if (!took || units < 30) return;
  const m = Math.min(100, Math.max(3, (took - 250) / units));
  msPerUnit = Math.round((msPerUnit * 0.6 + m * 0.4) * 10) / 10;
  store.set('gm-travel-mspu', msPerUnit);
}

// Saved shots: nine numbered slots like a camera controller's preset keypad.
// A number goes to that shot (pan, tilt and zoom); SET, then a number, saves
// the current view there. Keys: 1 to 9 (number row or numpad), S for SET.
// Kept on the bridge so agents and other browsers share them.
var shots = Array(9).fill(null);
var setting = false;
var atSlot = 0;
function renderKeys() {
  const box = $('keys');
  if (!box) return;
  box.classList.toggle('setting', setting);
  box.classList.toggle('names', keyLabel === 'names');
  box.classList.toggle('pics', keyLabel === 'pics');
  $('keySet').setAttribute('aria-pressed', String(setting));
  $('keySet').disabled = !connected;
  $('keyAll').disabled = !connected;
  for (const b of box.querySelectorAll('[data-slot]')) {
    const n = +b.dataset.slot,
      s = shots?.[n - 1];
    b.disabled = !connected;
    b.classList.toggle('has', !!s);
    b.style.backgroundImage =
      keyLabel === 'pics' && shotPics?.[n] ? `url(${shotPics[n].u})` : '';
    b.classList.toggle('at', n === atSlot);
    const what = s ? s.name : 'center (empty)';
    b.querySelector('span').textContent = setting
      ? 'save here'
      : s
        ? s.name
        : 'center';
    b.title = `${n}: ${what}`;
    b.setAttribute(
      'aria-label',
      setting
        ? `Save this view as shot ${n} (${what})`
        : `Go to shot ${n}: ${what}`,
    );
  }
}
async function loadShots() {
  try {
    const r = await api('/api/shots');
    if (!r.ok) return;
    const list = await r.json();
    shots = Array.from({ length: 9 }, (_, i) => list[i] ?? null);
  } catch {
    /* keep what we have */
  }
  renderKeys();
}
async function saveShots() {
  const r = await api('/api/shots', {
    method: 'POST',
    body: JSON.stringify(shots),
  });
  if (!r.ok) throw new Error((await r.json()).error);
}
function setMode(on) {
  setting = on;
  renderKeys();
  if (on) setStatus('SET: press a number to save this view there.');
}
async function pressSlot(n) {
  if (!connected) return;
  if (setting) {
    setMode(false);
    return askName(n);
  }
  closeGrid();
  // an empty slot is the center: pan 0, tilt 0, no zoom
  const s = shots[n - 1] ?? { name: 'center', pan: 0, tilt: 0, crop: null };
  atSlot = n;
  renderKeys();
  // zoom first, so the snapshot after the move is already framed
  crop = s.crop ? clampCrop(...s.crop) : null;
  viewChanged();
  setStatus(`Shot ${n}: ${s.name}.`);
  if (Math.abs(s.pan - pan) < 2 && Math.abs(s.tilt - tilt) < 2) {
    if (!liveOn) snapshot(true);
    return;
  }
  await aimTo(s.pan, s.tilt, true);
}
// All nine shots at once: visit every distinct shot (empty slots share the
// center) on the shortest route from here, take a small picture at each, and
// fill a 3 by 3 grid over the picture. With at most nine stops, trying every
// order is quick. Any other move or Esc stops it.
const CENTER = { name: 'center', pan: 0, tilt: 0, crop: null };
function shortestRoute(from, stops) {
  const cost = (a, b) => tripUnits(b.pan - a.pan, b.tilt - a.tilt);
  const idx = stops.map((_, i) => i);
  let best = idx.slice(),
    bestCost = Infinity;
  const used = Array(stops.length).fill(false),
    path = [];
  (function go(at, sum) {
    if (sum >= bestCost) return;
    if (path.length === stops.length) {
      bestCost = sum;
      best = path.slice();
      return;
    }
    for (const i of idx) {
      if (used[i]) continue;
      used[i] = true;
      path.push(i);
      go(stops[i], sum + cost(at, stops[i]));
      path.pop();
      used[i] = false;
    }
  })(from, 0);
  return best.map((i) => stops[i]);
}
function gridCell(n) {
  return document.querySelector(`#grid [data-cell="${n}"]`);
}
function closeGrid() {
  if ($('grid').hidden) return;
  $('grid').hidden = true;
  for (const b of document.querySelectorAll('#grid [data-cell]')) {
    const img = b.querySelector('img');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.removeAttribute('src');
    img.hidden = true;
    b.classList.remove('now', 'fresh', 'ir');
  }
}
async function survey() {
  if (!connected || finding) return;
  const me = ++aimRun;
  holdStop();
  stopLive();
  closeGrid();
  // distinct stops, each with the slots that share it
  const stops = [];
  for (let n = 1; n <= 9; n++) {
    let s = shots[n - 1] ?? CENTER;
    if (limits)
      s = {
        ...s,
        pan: Math.max(limits.panMin, Math.min(limits.panMax, s.pan)),
        tilt: Math.max(limits.tiltMin, Math.min(limits.tiltMax, s.tilt)),
      };
    const key = `${s.pan},${s.tilt},${s.crop ?? ''}`;
    const have = stops.find((x) => x.key === key);
    if (have) have.slots.push(n);
    else stops.push({ ...s, key, slots: [n] });
    const b = gridCell(n);
    b.querySelector('span').textContent =
      `${n} ${shots[n - 1]?.name ?? 'center'}`;
    b.setAttribute(
      'aria-label',
      `Go to shot ${n}: ${shots[n - 1]?.name ?? 'center'}`,
    );
  }
  for (let n = 1; n <= 9; n++) {
    const pic = shotPics[n],
      img = gridCell(n).querySelector('img');
    if (pic) {
      img.src = pic.u;
      img.hidden = false;
    }
  }
  $('grid').hidden = false;
  const route = shortestRoute({ pan, tilt }, stops);
  setStatus(`All shots: ${route.length} stops on the shortest route.`);
  for (const [k, st] of route.entries()) {
    if (me !== aimRun || !connected) return;
    for (const n of st.slots) gridCell(n).classList.add('now');
    const dx = Math.round(st.pan - pan),
      dy = Math.round(st.tilt - tilt);
    if (Math.abs(dx) >= 2 || Math.abs(dy) >= 2) {
      await travel(dx, dy, me, true);
      if (me !== aimRun) return;
    }
    try {
      const q = st.crop
        ? `&crop=${st.crop.map((v) => v.toFixed(4)).join(',')}`
        : '';
      const r = await api(`/api/snapshot.jpg?profile=p1${q}`);
      if (!r.ok) throw new Error((await r.json()).error);
      const blob = await r.blob();
      for (const n of st.slots) {
        const b = gridCell(n),
          img = b.querySelector('img');
        if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
        img.src = URL.createObjectURL(blob);
        img.hidden = false;
        b.classList.add('fresh');
        b.classList.toggle('ir', ir);
      }
      rememberShotPic(st.slots, blob);
      if (!st.crop) paintBlob(blob);
    } catch (e) {
      setStatus(`Lost the angle. Picture failed: ${e.message}`, true);
    }
    for (const n of st.slots) gridCell(n).classList.remove('now');
    setStatus(`All shots: ${k + 1} of ${route.length}.`);
  }
  if (me === aimRun) {
    atSlot = route.at(-1)?.slots[0] ?? 0;
    renderKeys();
    setStatus('All shots taken. Press one to go there.');
  }
}
$('keyAll').onclick = () => survey();
for (const b of document.querySelectorAll('#grid [data-cell]'))
  b.onclick = () => {
    const n = +b.dataset.cell;
    closeGrid();
    pressSlot(n);
  };
$('gridClose').onclick = () => {
  aimRun++; // stop a survey still running
  closeGrid();
  setStatus('Grid closed.');
};

// A small picture of each saved shot, kept in this browser per bridge, so the
// grid and the picture keys always have something to show. Refreshed whenever
// a snapshot is taken at a shot's pan, tilt and zoom, and by ALL.
var shotPics = {};
const picsKey = () => `gm-shotpics:${base}`;
function loadShotPics() {
  try {
    shotPics = JSON.parse(store.get(picsKey(), '{}')) || {};
  } catch {
    shotPics = {};
  }
}
function saveShotPics() {
  try {
    localStorage.setItem(picsKey(), JSON.stringify(shotPics));
  } catch {
    /* full or blocked: they stay in memory */
  }
}
async function thumbOf(blob) {
  const bmp = await createImageBitmap(blob);
  const w = 320,
    h = Math.round((bmp.height / bmp.width) * w);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.7);
}
async function rememberShotPic(slots, blob) {
  try {
    const u = await thumbOf(blob);
    for (const n of slots) shotPics[n] = { u, at: Date.now(), ir };
    saveShotPics();
    renderKeys();
  } catch {
    /* not a picture the browser can read */
  }
}
const sameCrop = (a, b) =>
  (!a && !b) || (a && b && a.every((v, i) => Math.abs(v - b[i]) < 0.002));
// After a snapshot: if the camera is at one or more shots, refresh them.
function rememberPose(blob) {
  if (aim) return; // still on its way
  const slots = [];
  for (let n = 1; n <= 9; n++) {
    const s = shots[n - 1] ?? CENTER;
    if (
      Math.abs(s.pan - pan) < 2 &&
      Math.abs(s.tilt - tilt) < 2 &&
      sameCrop(s.crop, crop)
    )
      slots.push(n);
  }
  if (slots.length) rememberShotPic(slots, blob);
}
// What the shot keys show: numbers (compact), names, or pictures.
var keyLabel = store.get('gm-keylabel', 'numbers');
for (const r of document.querySelectorAll('input[name="keylabel"]')) {
  r.checked = r.value === keyLabel;
  r.onchange = () => {
    keyLabel = r.value;
    store.set('gm-keylabel', keyLabel);
    renderKeys();
  };
}
// Night vision tint.
const TINTS = { red: '#ff2a2a', green: '#36ff6b', blue: '#2a8cff' };
function applyTint() {
  const t = store.get('gm-tint', 'red'),
    c = t === 'custom' ? store.get('gm-tint-color', '#ff2bd6') : TINTS[t];
  document.documentElement.style.setProperty('--tint', c || 'transparent');
}
for (const r of document.querySelectorAll('input[name="tint"]')) {
  r.checked = r.value === store.get('gm-tint', 'red');
  r.onchange = () => {
    store.set('gm-tint', r.value);
    applyTint();
  };
}
$('tintColor').value = store.get('gm-tint-color', '#ff2bd6');
$('tintColor').oninput = () => {
  store.set('gm-tint-color', $('tintColor').value);
  store.set('gm-tint', 'custom');
  document.querySelector('input[name="tint"][value="custom"]').checked = true;
  applyTint();
};
applyTint();
// The strip and the naming form are exactly as wide as the picture.
new ResizeObserver(() => {
  const w = `${$('stage').offsetWidth}px`;
  $('keys').style.width = w;
  $('shotForm').style.width = w;
}).observe($('stage'));

// Questions from agents (POST /api/ask): the open one shows over the picture
// with a key per choice and, when allowed, a box for another answer.
var askShown = null;
async function pollAsk() {
  if (!connected || document.hidden) return;
  try {
    const r = await api('/api/ask/pending');
    if (!r.ok) return;
    const a = await r.json();
    if (!a.id) {
      if (askShown) hideAsk();
      return;
    }
    if (askShown === a.id) return;
    showAsk(a);
  } catch {
    /* next time */
  }
}
function hideAsk() {
  askShown = null;
  $('askBar').hidden = true;
}
function showAsk(a) {
  askShown = a.id;
  $('askQ').textContent = a.question;
  const box = $('askChoices');
  box.replaceChildren();
  (a.choices || []).forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    const letter = 'ABCD'[i];
    b.textContent = `${letter}: ${c}`;
    b.onclick = () => answerAsk(a.id, letter.toLowerCase());
    box.append(b);
  });
  if (a.other) {
    const t = document.createElement('input');
    t.type = 'text';
    t.maxLength = 120;
    t.placeholder = 'Something else';
    t.setAttribute('aria-label', 'Another answer');
    const b = document.createElement('button');
    b.type = 'submit';
    b.textContent = 'Send';
    box.append(t, b);
    $('askBar').onsubmit = (e) => {
      e.preventDefault();
      if (t.value.trim()) answerAsk(a.id, 'other', t.value.trim());
    };
  } else $('askBar').onsubmit = (e) => e.preventDefault();
  $('askBar').hidden = false;
  setStatus(`A question for you: ${a.question}`);
}
async function answerAsk(id, choice, text) {
  try {
    const r = await api(`/api/ask/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify(text ? { choice, text } : { choice }),
    });
    setStatus(
      r.ok ? 'Answer sent.' : 'Already answered (by voice or another screen).',
    );
  } catch (e) {
    setStatus(`Answer not sent: ${e.message}`, true);
  }
  hideAsk();
}
setInterval(pollAsk, 2000);

// Conversation (POST /api/converse/start and /stop): the switch, a Listening light in the header that is
// on whenever the microphone is being heard, the live partial transcript, what is playing, what was heard
// and said, and where interruptions happened.
// Only touch the page when something changed: rebuilding every second made the panel flash and jump.
const cvLast = new Map();
const cvText = (id, text) => {
  if (cvLast.get(id) === text) return;
  cvLast.set(id, text);
  $(id).textContent = text;
};
const cvList = (id, rows, empty) => {
  const key = JSON.stringify(rows);
  if (cvLast.get(id) === key) return;
  cvLast.set(id, key);
  const ul = $(id);
  ul.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = empty;
    ul.append(li);
  }
  for (const t of rows) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.append(li);
  }
};
let cvBusy = false;
async function pollConverse() {
  if (!connected) return;
  try {
    const r = await api('/api/converse');
    if (!r.ok) return;
    const j = await r.json();
    const on = j.on;
    $('cvSwitch').checked = on;
    $('listenPill').classList.toggle('on', on);
    $('listenPill').textContent = on ? 'Listening' : 'Mic off';
    $('listenPill').setAttribute(
      'aria-label',
      on
        ? `Listening: on, ${j.state}. Open the Relay tab to turn it off`
        : 'Listening: off. Open the Relay tab to turn conversation on',
    );
    // one short line of icons instead of changing sentences (Lewis: "it would just be like icons")
    const st = String(j.state || '');
    const icons = !on
      ? '\u23fb Off'
      : [
          j.playing
            ? '\ud83d\udd0a Speaking'
            : st.includes('muted')
              ? '\ud83d\udd07 Muted'
              : '\ud83c\udf99\ufe0f Listening',
          j.partial ? '\ud83d\udcac Hearing you' : '',
          j.bargeActive ? '\u270b Cut in' : '',
          `\u23f1 ${Math.ceil(j.idleLeftSeconds / 60)} min`,
        ]
          .filter(Boolean)
          .join('  \u00b7  ');
    cvText('cvState', icons);
    $('cvState').title = on
      ? st
      : j.lastStop
        ? `Off (${j.lastStop.reason})`
        : 'Off';
    cvText('cvPartial', j.partial ? `Hearing: ${j.partial.text}` : '\u00a0');
    cvText('cvPlaying', j.playing ? `Speaking: ${j.playing.text}` : '\u00a0');
    cvList(
      'cvHeard',
      j.heard.map((e) => e.text),
      'Nothing yet.',
    );
    cvList(
      'cvReplies',
      j.replies.map((e) => e.text),
      'Nothing yet.',
    );
    cvList(
      'cvMarks',
      j.marks.map((m) =>
        m.type === 'barge'
          ? `You cut in. Heard: "${m.heardText || ''}". Not heard: "${m.unheardText || ''}"`
          : `Agent cut in${m.partialText ? ` after "${m.partialText}"` : ''}: ${m.text}`,
      ),
      'None.',
    );
  } catch {
    /* the bridge is away; the connection light says so */
  }
}
$('cvSwitch').onchange = async () => {
  if (cvBusy) return;
  cvBusy = true;
  try {
    const r = await api(
      `/api/converse/${$('cvSwitch').checked ? 'start' : 'stop'}`,
      { method: 'POST', body: '{}' },
    );
    if (!r.ok) setStatus(`Conversation: ${(await r.json()).error}`, true);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    cvBusy = false;
    pollConverse();
  }
};
$('listenPill').onclick = () => selectTab('glass', true);

// History: the conversation as a chat log. Entries come from /api/converse/history by cursor; the log is
// rebuilt only when new ones arrive, and keeps its scroll position unless it was already at the bottom.
const hist = { cursor: 0, entries: [], busy: false };
const histName = (e) =>
  e.who === 'you' ? 'You' : e.who === 'patchwork' ? 'Patchwork' : 'Note';
const histTime = (e) =>
  new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function histBody(e) {
  if (e.who !== 'mark') return e.text;
  const bits = [e.text];
  if (e.heard) bits.push(`Heard: "${e.heard}"`);
  if (e.unheard) bits.push(`Not heard: "${e.unheard}"`);
  if (e.partial) bits.push(`After: "${e.partial}"`);
  return bits.join('. ');
}
const histLine = (e) => `${histName(e)} ${histTime(e)}: ${histBody(e)}`;
async function copyText(text, note) {
  try {
    await navigator.clipboard.writeText(text);
    $('cvHistNote').textContent = note;
  } catch {
    $('cvHistNote').textContent = 'Copy blocked; select the text and copy it.';
  }
  setTimeout(() => ($('cvHistNote').textContent = '\u00a0'), 2500);
}
function histRow(e) {
  const row = document.createElement('div');
  row.className = `ent ${e.who}`;
  const p = document.createElement('p');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${histName(e)} ${histTime(e)}: `;
  p.append(who, histBody(e));
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = 'Copy';
  b.setAttribute('aria-label', `Copy: ${histLine(e).slice(0, 60)}`);
  b.onclick = () => copyText(histLine(e), 'Copied one line.');
  row.append(p, b);
  return row;
}
async function pollHistory() {
  if (hist.busy) return;
  hist.busy = true;
  try {
    const r = await api(
      `/api/converse/history?since=${hist.cursor}&limit=2000`,
    );
    if (!r.ok) return;
    const j = await r.json();
    hist.cursor = j.cursor;
    if (!j.entries.length) return;
    const log = $('cvLog');
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    if (!hist.entries.length) log.textContent = '';
    hist.entries.push(...j.entries);
    for (const e of j.entries) log.append(histRow(e));
    $('cvHistCount').textContent = `(${hist.entries.length})`;
    if (atEnd) log.scrollTop = log.scrollHeight;
  } catch {
    /* the bridge is away */
  } finally {
    hist.busy = false;
  }
}
$('cvHistOpen').onclick = () => {
  $('cvHist').showModal();
  pollHistory();
  const log = $('cvLog');
  log.scrollTop = log.scrollHeight;
};
$('cvHistClose').onclick = () => $('cvHist').close();
$('cvHistCopy').onclick = () =>
  hist.entries.length
    ? copyText(
        hist.entries.map(histLine).join('\n'),
        'Copied the whole history.',
      )
    : ($('cvHistNote').textContent = 'Nothing to copy yet.');
setInterval(pollHistory, 1500);

// Personas: who each agent speaks as. Lewis picks the default, assigns agents, locks the choice, edits the
// basic fields and the transcriber word list. Saved by the bridge in its untracked local file.
const pz = { data: null, voices: [] };
const pzNote = (t) => {
  $('pzNote').textContent = t;
  setTimeout(
    () => $('pzNote').textContent === t && ($('pzNote').textContent = '\u00a0'),
    4000,
  );
};
const pzCall = async (path, method, body) => {
  const r = await api(path, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `bridge said ${r.status}`);
  return j;
};
const pzList = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const opt = (v, t, sel) => {
  const o = document.createElement('option');
  o.value = v;
  o.textContent = t;
  o.selected = sel;
  return o;
};
function pzAgentRow(agent = '', persona = '') {
  const row = document.createElement('div');
  row.className = 'agentrow';
  const a = document.createElement('input');
  a.type = 'text';
  a.maxLength = 32;
  a.value = agent;
  a.setAttribute('aria-label', 'Agent name, like codex');
  a.placeholder = 'agent name';
  const s = document.createElement('select');
  s.setAttribute('aria-label', 'Persona for this agent');
  for (const p of pz.data.personas)
    s.append(opt(p.name, p.name, p.name === persona));
  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = 'Remove';
  x.setAttribute('aria-label', 'Remove this agent');
  x.onclick = () => row.remove();
  row.append(a, s, x);
  return row;
}
function pzFill(name) {
  const p = pz.data.personas.find((q) => q.name === name);
  const isNew = !p;
  $('pzName').value = p?.name ?? '';
  $('pzName').readOnly = !isNew;
  $('pzVoice').replaceChildren(
    opt('', 'System voice', !p?.voice),
    ...pz.voices.map((v) => opt(v, v, v === p?.voice)),
  );
  $('pzRate').value = p?.rate ?? 140;
  $('pzLevel').value = p?.level ?? 0.03;
  $('pzOutput').value = p?.output ?? 'camera';
  $('pzStyle').value = p?.style ?? 'netrunner';
  $('pzWake').value = (p?.wakeWords ?? []).join(', ');
  $('pzSayAs').value = (p?.sayAs ?? [])
    .map((x) => `${x.from} = ${x.to}`)
    .join('\n');
  $('pzPVocab').value = (p?.vocabulary ?? []).join(', ');
  $('pzWakeTone').checked = p?.tones?.wake === true;
  $('pzIntTone').checked = p?.tones?.interrupting === true;
  $('pzDelete').disabled = !p || p.source === 'shipped';
}
function pzRender() {
  const d = pz.data;
  $('pzDefault').textContent = `(${d.default})`;
  $('pzDef').replaceChildren(
    ...d.personas.map((p) => opt(p.name, p.name, p.name === d.default)),
  );
  $('pzLock').checked = d.lock;
  $('pzVocab').value = d.vocabulary.join(', ');
  $('pzAgents').replaceChildren(
    ...Object.entries(d.agents).map(([a, p]) => pzAgentRow(a, p)),
  );
  const keep = $('pzPick').value;
  $('pzPick').replaceChildren(
    ...d.personas.map((p) => opt(p.name, p.name, p.name === keep)),
    opt('', 'New persona...', false),
  );
  pzFill($('pzPick').value);
}
// Speakers: each slider and number pair stay in step; Test saves the value, then plays one line through that speaker.
const spPair = (range, num) => {
  $(range).oninput = () => ($(num).value = $(range).value);
  $(num).oninput = () => ($(range).value = $(num).value);
};
spPair('spCamRange', 'spCam');
spPair('spMacRange', 'spMac');
function spFill(d) {
  $('spCam').value = $('spCamRange').value =
    d.camera.level ?? d.defaults.cameraLevel;
  $('spMac').value = $('spMacRange').value = d.mac.gain;
  $('spMacNote').textContent = d.overrides.macGain
    ? 'GJ_MAC_GAIN is set on the bridge and overrides this. Plays through the Mac default output.'
    : "Plays through the Mac's default output (a different device cannot be chosen reliably).";
}
async function spTest(speaker, body) {
  try {
    await pzCall('/api/speakers', 'PUT', body);
    await pzCall('/api/speakers/test', 'POST', { speaker });
    pzNote('Saved. Playing: Testing, one two three.');
  } catch (e) {
    pzNote(`Speaker test failed: ${e.message}`);
  }
}
$('spCamTest').onclick = () =>
  spTest('camera', { camera: { level: Number($('spCam').value) } });
$('spMacTest').onclick = () =>
  spTest('mac', { mac: { gain: Number($('spMac').value) } });
async function pzLoad() {
  try {
    spFill(await pzCall('/api/speakers', 'GET'));
    pz.data = await pzCall('/api/personas', 'GET');
    if (!pz.voices.length)
      pz.voices = (await pzCall('/api/voices', 'GET')).voices ?? [];
    pzRender();
  } catch (e) {
    pzNote(`Could not load: ${e.message}`);
  }
}
$('pzOpen').onclick = async () => {
  $('pz').showModal();
  await pzLoad();
  $('pzDef').focus();
};
$('pzClose').onclick = () => $('pz').close();
$('pzPick').onchange = () => pzFill($('pzPick').value);
$('pzAddAgent').onclick = () => {
  const r = pzAgentRow();
  $('pzAgents').append(r);
  r.querySelector('input').focus();
};
$('pzSaveSettings').onclick = async () => {
  try {
    const agents = {};
    for (const row of $('pzAgents').children) {
      const a = row.querySelector('input').value.trim().toLowerCase();
      if (a) agents[a] = row.querySelector('select').value;
    }
    await pzCall('/api/personas/settings', 'POST', {
      default: $('pzDef').value,
      lock: $('pzLock').checked,
      agents,
      vocabulary: pzList($('pzVocab').value),
    });
    await pzLoad();
    pzNote('Saved. New calls use it now.');
  } catch (e) {
    pzNote(`Not saved: ${e.message}`);
  }
};
$('pzSave').onclick = async () => {
  try {
    const name = $('pzName').value.trim().toLowerCase();
    const sayAs = $('pzSayAs')
      .value.split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [from, ...to] = l.split('=');
        if (!to.length)
          throw new Error(`"${l}" needs = between written and spoken`);
        return { from: from.trim(), to: to.join('=').trim() };
      });
    const body = {
      name,
      voice: $('pzVoice').value,
      rate: Number($('pzRate').value),
      level: Number($('pzLevel').value),
      output: $('pzOutput').value,
      style: $('pzStyle').value.trim(),
      wakeWords: pzList($('pzWake').value),
      sayAs,
      vocabulary: pzList($('pzPVocab').value),
      tones: {
        wake: $('pzWakeTone').checked,
        interrupting: $('pzIntTone').checked,
      },
    };
    // keep what this form does not edit (glossary, greeting, signoff, the other tones)
    const old = pz.data.personas.find((p) => p.name === name);
    if (old) {
      body.glossary = old.glossary;
      body.greeting = old.greeting;
      body.signoff = old.signoff;
      body.tones = { ...old.tones, ...body.tones };
    }
    await pzCall(`/api/personas/${encodeURIComponent(name)}`, 'PUT', body);
    $('pzPick').value = name;
    await pzLoad();
    $('pzPick').value = name;
    pzFill(name);
    pzNote(`Saved ${name}.`);
  } catch (e) {
    pzNote(`Not saved: ${e.message}`);
  }
};
$('pzDelete').onclick = async () => {
  try {
    await pzCall(
      `/api/personas/${encodeURIComponent($('pzName').value)}`,
      'DELETE',
    );
    await pzLoad();
    pzNote('Removed.');
  } catch (e) {
    pzNote(`Not removed: ${e.message}`);
  }
};
setInterval(pollConverse, 1000);

// Name the shot in a small form that takes the strip's place (no pop-up).
var naming = 0;
function askName(n) {
  naming = n;
  $('shotLabel').textContent = `Shot ${n} name`;
  $('shotName').value = shots[n - 1]?.name ?? `Shot ${n}`;
  $('shotClear').hidden = !shots[n - 1];
  $('keys').hidden = true;
  $('shotForm').hidden = false;
  $('shotName').focus();
  $('shotName').select();
  setStatus(`Name shot ${n}, then Save (Enter). Esc cancels.`);
}
function closeName() {
  naming = 0;
  $('shotForm').hidden = true;
  $('keys').hidden = false;
}
async function storeShot(n, shot) {
  const old = shots[n - 1];
  shots[n - 1] = shot;
  try {
    await saveShots();
    delete shotPics[n];
    if (shot && lastShot) rememberShotPic([n], lastShot);
    else saveShotPics();
    atSlot = shot ? n : 0;
    setStatus(shot ? `Shot ${n} saved: ${shot.name}.` : `Shot ${n} cleared.`);
  } catch (e) {
    shots[n - 1] = old;
    setStatus(`Shot not saved: ${e.message}`, true);
  }
  renderKeys();
}
$('shotForm').onsubmit = (e) => {
  e.preventDefault();
  const n = naming,
    name = $('shotName').value.trim().slice(0, 24);
  closeName();
  if (n && name) storeShot(n, { name, pan, tilt, crop });
};
$('shotClear').onclick = () => {
  const n = naming;
  closeName();
  if (n) storeShot(n, null);
};
$('shotCancel').onclick = () => {
  closeName();
  setStatus('Nothing saved.');
};
$('shotName').onkeydown = (e) => {
  if (e.key === 'Escape') $('shotCancel').click();
};
for (const b of document.querySelectorAll('#keys [data-slot]'))
  b.onclick = () => pressSlot(+b.dataset.slot);
$('keySet').onclick = () => setMode(!setting);
document.addEventListener('keydown', (e) => {
  if (
    !connected ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)
  )
    return;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (m) {
    e.preventDefault();
    pressSlot(+m[1]);
  } else if (e.code === 'KeyA') {
    e.preventDefault();
    survey();
  } else if (e.key === 'Escape' && !$('grid').hidden) {
    $('gridClose').click();
  } else if (e.code === 'KeyS') {
    e.preventDefault();
    setMode(!setting);
  } else if (e.key === 'Escape' && setting) setMode(false);
});
{
  let from = null;
  const m = $('model'),
    PX_PER_STEP = 3; // pixels of drag for one step of aim
  const clampTo = (n, axis) =>
    limits
      ? Math.max(limits[axis + 'Min'], Math.min(limits[axis + 'Max'], n))
      : Math.max(
          axis === 'pan' ? -60 : -40,
          Math.min(axis === 'pan' ? 60 : 40, n),
        );
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
    p: clampTo(Math.round(from.p + (e.clientX - from.x) / PX_PER_STEP), 'pan'),
    t: clampTo(Math.round(from.t - (e.clientY - from.y) / PX_PER_STEP), 'tilt'),
  });
  m.addEventListener('pointermove', (e) => {
    if (!from) return;
    const t = target(e);
    scene?.setPose(t.p * degPer(), t.t * degPerTilt(), true);
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
  const mode = $('night').value;
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
      `${glass.line(j.mode === 'night' ? 'nightOn' : j.mode === 'day' ? 'nightOff' : 'nightAuto')} Vision: ${j.mode === 'day' ? 'color requested (experimental)' : j.mode}.`,
    );
  } catch (e) {
    $('night').value = lastNight;
    setStatus(`Night vision change failed: ${e.message}`, true);
  }
};

// Digital zoom: a slider (zoomed about the current center) or a dragged box on the picture; the bridge crops
// the 1080p snapshot. A zoomed view pans digitally: the move pad (cameras that cannot move), Shift or focused
// arrow keys, a drag or swipe on the picture, and a scroll. The window stays inside the frame; a minimap shows
// where it is; the view is remembered per camera.
function zoomed() {
  return !!crop && crop[2] < 1;
}
const clampCrop = (x, y, w, h) => [
  Math.min(1 - w, Math.max(0, x)),
  Math.min(1 - h, Math.max(0, y)),
  w,
  h,
];
const viewKey = () => `gj-view-${activeCam || 'default'}`;
// Sync everything that shows the view: slider, label, minimap, arrows; remember it for this camera.
function viewChanged() {
  const z = zoomed() ? 1 / crop[2] : 1;
  $('zoom').value = Math.min(4, Math.max(1, Math.round(z * 4) / 4));
  $('zoomOut').textContent = `${Number.isInteger(z) ? z : z.toFixed(1)}x`;
  const mini = $('mini');
  mini.hidden = !zoomed();
  if (zoomed()) {
    const [x, y, w, h] = crop;
    Object.assign(mini.firstElementChild.style, {
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      width: `${w * 100}%`,
      height: `${h * 100}%`,
    });
    const at = (v, size) =>
      size >= 1
        ? 'center'
        : v < 0.001
          ? 'start'
          : v > 1 - size - 0.001
            ? 'end'
            : 'middle';
    mini.setAttribute(
      'aria-label',
      `Zoomed ${z.toFixed(1)}x. View position: horizontal ${at(x, w)}, vertical ${at(y, h)}`,
    );
  }
  $('stage').tabIndex = zoomed() ? 0 : -1;
  store.set(viewKey(), crop ? JSON.stringify(crop) : '');
  updateArrows();
}
function restoreView() {
  let c = null;
  try {
    const v = JSON.parse(store.get(viewKey(), '') || 'null');
    if (
      Array.isArray(v) &&
      v.length === 4 &&
      v.every((n) => Number.isFinite(n)) &&
      v[2] > 0.2 &&
      v[2] < 1 &&
      v[3] > 0.2 &&
      v[3] < 1
    )
      c = clampCrop(...v);
  } catch {
    /* keep the full frame */
  }
  crop = c;
  viewChanged();
}
function setZoom(z) {
  if (z <= 1) crop = null;
  else {
    const [x, y, w, h] = crop ?? [0, 0, 1, 1],
      s = 1 / z;
    crop = clampCrop(x + w / 2 - s / 2, y + h / 2 - s / 2, s, s);
  }
  viewChanged();
}
// One snapshot at a time while panning: a move made during a fetch is picked up by the next one.
let panBusy = false,
  panAgain = false;
async function refreshView() {
  if (panBusy) {
    panAgain = true;
    return;
  }
  panBusy = true;
  try {
    do {
      panAgain = false;
      await snapshot(true);
    } while (panAgain);
  } finally {
    panBusy = false;
  }
}
// Pan the zoomed window by fractions of the frame.
function panBy(fx, fy) {
  if (!zoomed()) return false;
  const [x, y, w, h] = crop,
    n = clampCrop(x + fx, y + fy, w, h);
  if (n[0] === x && n[1] === y) return false;
  crop = n;
  viewChanged();
  refreshView();
  return true;
}
// Pad and key steps: a quarter of the window, in the pad's directions (up is tilt up).
const panStep = (dx, dy) =>
  panBy(Math.sign(dx) * crop[2] * 0.25, -Math.sign(dy) * crop[3] * 0.25);
// The pad pans the view when the camera cannot move; a camera that can keeps the pad for the camera.
function digitalPad() {
  return zoomed() && !ptzOn;
}
$('zoom').oninput = () => {
  setZoom(+$('zoom').value);
  snapshot();
};
$('zoomReset').onclick = () => {
  crop = null; // also recenters
  viewChanged();
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
  // controls over the picture (grid tiles, questions, arrows) keep their clicks
  if (e.target.closest('button, input, form, .shotgrid')) return;
  drag = { at: frac(e), pan: zoomed() };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = frac(e);
  if (drag.pan) {
    // the picture follows the pointer; the window moves on release
    const r = stage.getBoundingClientRect();
    $('snap').style.transform =
      `translate(${(x - drag.at[0]) * r.width}px, ${(y - drag.at[1]) * r.height}px)`;
    return;
  }
  const b = $('box');
  b.hidden = false;
  Object.assign(b.style, {
    left: `${Math.min(x, drag.at[0]) * 100}%`,
    top: `${Math.min(y, drag.at[1]) * 100}%`,
    width: `${Math.abs(x - drag.at[0]) * 100}%`,
    height: `${Math.abs(y - drag.at[1]) * 100}%`,
  });
});
stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const [x, y] = frac(e),
    d = drag;
  drag = null;
  if (d.pan) {
    $('snap').style.transform = '';
    if (zoomed()) panBy(-(x - d.at[0]) * crop[2], -(y - d.at[1]) * crop[3]);
    return;
  }
  const x0 = Math.min(x, d.at[0]),
    y0 = Math.min(y, d.at[1]),
    w = Math.abs(x - d.at[0]),
    h = Math.abs(y - d.at[1]);
  $('box').hidden = true;
  if (w < 0.04 || h < 0.04) return;
  zoomTo(x0, y0, w, h);
});
stage.addEventListener('pointercancel', () => {
  drag = null;
  $('snap').style.transform = '';
  $('box').hidden = true;
});
// Two-finger or trackpad scroll pans the zoomed view (a pinch, with Ctrl, is left to the page).
stage.addEventListener(
  'wheel',
  (e) => {
    if (!connected || !zoomed() || e.ctrlKey) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    panBy((e.deltaX / r.width) * crop[2], (e.deltaY / r.height) * crop[3]);
  },
  { passive: false },
);
function zoomTo(x0, y0, bw, bh) {
  const w = Math.min(1, Math.max(bw, bh * (16 / 9))),
    h = w * (9 / 16);
  const cx = x0 + bw / 2,
    cy = y0 + bh / 2;
  crop = clampCrop(cx - w / 2, cy - h / 2, w, h);
  viewChanged();
  snapshot();
}

// Info and settings: read-only facts, plus the safe writes (image, microphone, clock).
const sliders = {
  brightness: 's-brightness',
  contrast: 's-contrast',
  saturation: 's-saturation',
  sharpness: 's-sharpness',
};
function showInfoRows(rows) {
  $('infoList').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}
// The info sheet for a camera that is not Glasseye: what the bridge's camera list and the last full
// frame say (there is no camera-side settings page to read).
function fillOther(cam) {
  const kinds = { avfoundation: 'USB camera (macOS avfoundation)' };
  const caps = {
    video: 'picture',
    mic: 'microphone',
    speaker: 'speaker',
    ptz: 'pan and tilt',
  };
  showInfoRows([
    ['Type', kinds[cam.kind] ?? cam.kind],
    ['Model', cam.name],
    ...(cam.mode
      ? [
          [
            'Mode',
            `${cam.mode.size} at ${cam.mode.fps} fps (change it next to Camera)`,
          ],
        ]
      : []),
    [
      'Picture',
      frameSize
        ? `${frameSize[0]}x${frameSize[1]} (the last full frame)`
        : 'size shows after a full-frame snapshot',
    ],
    ['Can', cam.capabilities.map((c) => caps[c] ?? c).join(', ')],
    ['Pan and tilt', cam.capabilities.includes('ptz') ? 'yes' : 'no'],
  ]);
}
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
  showInfoRows(rows);
  if (i) for (const [k, id] of Object.entries(sliders)) setSlider(id, i[k]);
  if (i) {
    $('c-wdr').checked = i.wdr === 'On';
    $('c-backlight').checked = i.backlight === 'On';
  }
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
  if (activeEntry && !activeEntry.capabilities.includes('ptz')) {
    fillOther(activeEntry);
    setStatus(`Rig read: ${activeEntry.name}.`);
    return;
  }
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
for (const [k, id, label] of [
  ['wdr', 'c-wdr', 'Wide dynamic range'],
  ['backlight', 'c-backlight', 'Backlight fix'],
])
  $(id).onchange = () =>
    write(
      '/api/picture',
      { [k]: $(id).checked },
      `${label} ${$(id).checked ? 'on' : 'off'}.`,
    );
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

// The photo sphere (sphere.js, sphereView.js): every picture the camera takes is painted where it points,
// live while Find limits and Sweep run. Needs the lens Find limits measures; during a Find limits run it
// paints with a provisional lens (60 degrees wide, steps from the shifts so far) and repaints the run's
// pictures with the final one.
var sphereObj = null,
  sphereKeep = null,
  sphereView = null,
  runFrames = [], // Find limits' small pictures, held until the final lens is known
  liveLens = null, // the newest picture's pose and provisional lens during a run
  sweeping = false;
function sphereNow() {
  if (!sphereObj) {
    sphereObj = sph.createSphere();
    sphereKeep = sph.keep(sphereObj);
  }
  return sphereObj;
}
const calibNow = () =>
  lens && limits ? { ...lens, panDegPerUnit: degPer() } : null;
async function loadSphere() {
  const sp = sphereNow();
  sp.clear();
  await sphereKeep.use(`gm-sphere:${base}`);
  if (sp.calib && !lens && limits)
    lens = {
      fovH: sp.calib.fovH,
      fovV: sp.calib.fovV,
      tiltDegPerUnit: sp.calib.tiltDegPerUnit,
    };
}
// Paint a picture the camera just took at the estimated pose (not while it is moving, and not zoomed).
function paintBlob(blob) {
  if (aim || finding || !lens || !limits) return;
  const at = { p: pan, t: tilt };
  createImageBitmap(blob)
    .then((bmp) => {
      const sp = sphereNow();
      sp.calib = calibNow();
      sp.paint(bmp, at.p * degPer(), at.t * degPerTilt(), lens.fovH, lens.fovV);
      bmp.close();
    })
    .catch(() => {});
}
function runFrame(f, prov) {
  runFrames.push(f);
  liveLens = {
    yaw: f.pan * prov.panDegPerUnit,
    pitch: f.tilt * prov.tiltDegPerUnit,
    fovH: prov.fovH,
    fovV: prov.fovV,
  };
  sphereNow().paint(f.bmp, liveLens.yaw, liveLens.pitch, prov.fovH, prov.fovV);
}
// The final lens is known: paint the run's pictures again where they really point.
// for tools/fake-room-test.mjs: how many pictures the sphere holds
globalThis.gjSpherePainted = () => sphereObj?.painted ?? 0;
function repaintRun(res) {
  const sp = sphereNow(),
    k = res.lens.panDegPerUnit,
    kt = res.lens.tiltDegPerUnit;
  sp.clear();
  sp.calib = { ...lens, panDegPerUnit: k };
  for (const f of runFrames)
    sp.paint(
      f.bmp,
      (f.pan - res.center.pan) * k,
      (f.tilt - res.center.tilt) * kt,
      lens.fovH,
      lens.fovV,
    );
  for (const f of runFrames) f.bmp.close();
  runFrames = [];
}
async function openSphere() {
  if (!sphereView) {
    const m = await import('./sphereView.js');
    sphereView = m.createView($('stage'), {
      sphere: sphereNow(),
      reduced,
      pose: () => {
        if (stripping) return null; // its estimate is unreliable: leave the view where the person left it
        if (liveLens) return liveLens;
        if (!lens || !limits) return null;
        return {
          yaw: (aim ? aim.p : pan) * degPer(),
          pitch: (aim ? aim.t : tilt) * degPerTilt(),
          fovH: lens.fovH,
          fovV: lens.fovV,
        };
      },
      range: () =>
        lens && limits
          ? {
              yaw0: limits.panMin * degPer(),
              yaw1: limits.panMax * degPer(),
              pitch0: limits.tiltMin * degPerTilt(),
              pitch1: limits.tiltMax * degPerTilt(),
            }
          : null,
      goto: gotoSphere,
      sweep,
      stopSweep: () => aimRun++,
      stripScan: openStrips,
      exportJpg: downloadPanorama,
      close: closeSphere,
    });
  }
  await sphereView.show();
  $('keySphere').setAttribute('aria-pressed', 'true');
}
function closeSphere() {
  if (sweeping) aimRun++;
  sphereView?.hide();
  $('keySphere').setAttribute('aria-pressed', 'false');
  $('keySphere').focus();
}
function gotoSphere(yaw, pitch) {
  if (!connected) return setStatus('Jack in first to send the camera there.');
  if (finding) return;
  if (!lens || !limits)
    return setStatus('Run Find limits first, so the sphere knows its angles.');
  setStatus('Sending the camera to that spot in the sphere.');
  aimTo(Math.round(yaw / degPer()), Math.round(pitch / degPerTilt()), true);
}
async function downloadPanorama(full) {
  const sp = sphereNow();
  if (!sp.painted) return sphereView?.note('Nothing painted yet.');
  sp.calib ??= calibNow();
  const { blob, name } = await sph.exportPanorama(sp, limits, full);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  sphereView?.note(`Saved ${name}.`);
}
// Sweep: visit a grid of angles over the measured range, spaced 0.8 lens widths (and heights), serpentine,
// from the corner nearest the camera; one fast trip and one small picture each.
async function sweep() {
  if (!lens || !limits)
    return sphereView?.note('Sweep needs the lens: run Find limits first.');
  if (!connected || finding || sweeping || stripping) return;
  const me = ++aimRun;
  sweeping = true;
  sphereView?.setSweeping(true);
  holdStop();
  stopLive();
  const axis = (min, max, fov, k) => {
    const n = Math.max(1, Math.ceil((max - min) / ((0.8 * fov) / k)) + 1),
      out = [];
    for (let i = 0; i < n; i++)
      out.push(n === 1 ? (min + max) / 2 : min + ((max - min) * i) / (n - 1));
    return out;
  };
  const cols = axis(limits.panMin, limits.panMax, lens.fovH, degPer()),
    rows = axis(limits.tiltMin, limits.tiltMax, lens.fovV, degPerTilt());
  if (Math.abs(tilt - rows.at(-1)) < Math.abs(tilt - rows[0])) rows.reverse();
  if (Math.abs(pan - cols.at(-1)) < Math.abs(pan - cols[0])) cols.reverse();
  const total = cols.length * rows.length;
  let n = 0,
    at = { p: pan, t: tilt };
  try {
    for (const [r, t] of rows.entries()) {
      const row = r % 2 ? [...cols].reverse() : cols;
      for (const p of row) {
        // anyone else moving the camera (a pad key, a drag) ends the sweep
        if (me !== aimRun || !connected || pan !== at.p || tilt !== at.t)
          return;
        const dx = Math.round(p - pan),
          dy = Math.round(t - tilt);
        if (Math.abs(dx) >= 2 || Math.abs(dy) >= 2) {
          await travel(dx, dy, me, true);
          if (me !== aimRun) return;
        }
        at = { p: pan, t: tilt };
        const r2 = await api('/api/snapshot.jpg?profile=p1');
        if (!r2.ok) throw new Error((await r2.json()).error);
        const bmp = await createImageBitmap(await r2.blob());
        const sp = sphereNow();
        sp.calib = calibNow();
        sp.paint(
          bmp,
          pan * degPer(),
          tilt * degPerTilt(),
          lens.fovH,
          lens.fovV,
        );
        bmp.close();
        sphereView?.note(`Sweep: ${++n} of ${total}.`);
        setStatus(`Sweep: ${n} of ${total}.`);
      }
    }
    sphereView?.note('Sweep done: the sphere is filled.');
    setStatus('Sweep done. The sphere is filled.');
  } catch (e) {
    setStatus(`Lost the angle. Sweep failed: ${e.message}`, true);
  } finally {
    sweeping = false;
    sphereView?.setSweeping(false);
    if (me !== aimRun) sphereView?.note('Sweep stopped.');
  }
}
// Strip scan (strips.js, stripView.js): a panorama from thin slices of small steps; positions come from the
// pictures, not from the pose estimate.
var stripView = null,
  stripping = false;
globalThis.gjStrip = () => stripView?.panorama ?? null;
async function openStrips() {
  if (!stripView) {
    const [m, st] = await Promise.all([
      import('./stripView.js'),
      import('./strips.js'),
    ]);
    stripView = m.createStripView($('stage'), {
      start: (o) => stripScan(st, o),
      stop: () => aimRun++,
      download: downloadStrips,
      close: closeStrips,
    });
  }
  stripView.show();
}
function closeStrips() {
  if (stripping) aimRun++;
  stripView?.hide();
}
async function downloadStrips() {
  const c = stripView?.panorama;
  if (!c) return;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92)),
    d = new Date(),
    z = (n) => String(n).padStart(2, '0'),
    name = `ghostjack-strips-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.jpg`,
    a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  stripView.note(`Saved ${name}.`);
}
async function sendMove(dx, dy) {
  for (let tries = 0; tries < 5; tries++) {
    while (Date.now() - lastMove < 1100) await sleep(100);
    lastMove = Date.now();
    const r = await api('/api/move', {
      method: 'POST',
      body: JSON.stringify({ dx, dy, speed: 100 }),
    });
    if (r.status !== 429) {
      if (!r.ok) throw new Error((await r.json()).error);
      return;
    }
    await sleep(400);
  }
  throw new Error('the bridge kept refusing moves');
}
async function stripScan(st, o) {
  if (!connected || finding || sweeping || stripping) return;
  const ready = lens && limits; // only for painting the sphere
  const me = ++aimRun;
  stripping = true;
  stripView.setRunning(true);
  holdStop();
  stopLive();
  const profile = o.hd ? 'p0' : 'p1';
  const painted = new Map(); // row -> strips already on the sphere
  let lastRows = [];
  try {
    const res = await st.stripScan(
      {
        // the camera now and then sends a picture the browser can't decode;
        // ask again instead of ending the scan
        snap: async () => {
          let last;
          for (let i = 0; i < 4; i++) {
            try {
              const r = await api(`/api/snapshot.jpg?profile=${profile}`);
              if (!r.ok) throw new Error((await r.json()).error);
              return await createImageBitmap(await r.blob());
            } catch (e) {
              last = e;
              await sleep(300);
            }
          }
          throw last;
        },
        step: async (dx, dy) => {
          if (me !== aimRun) return;
          await sendMove(dx, dy);
        },
        pose: () => ({ pan, tilt }),
        moved: (dx, dy) => {
          pan += dx; // only steps that were seen to move the picture count
          tilt += dy;
        },
        travelBy: async (dx) => {
          if (me !== aimRun) return;
          await travel(Math.round(dx), 0, me, true);
        },
        cancelled: () => me !== aimRun || !connected,
        note: (t) => {
          stripView.note(t);
          setStatus(t);
        },
        update: (s) => {
          lastRows = s.rows;
          stripView.update(s.rows, false);
          // the sphere above the band fills in slice by slice
          if (o.paint && ready) paintStrips(s, o.step || 4, painted);
        },
      },
      {
        step: o.step || 4,
        multi: !!o.rows,
        maxRows: 8,
        hd: o.hd,
      },
    );
    stripView.update(res.rows, true);
    if (o.paint && ready) paintStrips(res, o.step || 4, painted);
  } catch (e) {
    setStatus(`Lost the angle. Strip scan failed: ${e.message}`, true);
    stripView.note(`Strip scan failed: ${e.message}`);
    stripView.update(lastRows, true); // keep what was scanned, ready to download
  } finally {
    stripping = false;
    stripView.setRunning(false);
  }
}
// Best effort: each strip is the center meridian of a pinhole picture at its step's pan, so it goes on the
// sphere as a thin picture that many degrees wide, with rows mapped to latitude through the lens.
function paintStrips(res, step, done = new Map()) {
  const rad = Math.PI / 180,
    sp = sphereNow(),
    th = Math.tan((lens.fovH * rad) / 2);
  sp.calib = calibNow();
  for (const row of res.rows) {
    if (!row.strips.length || row.firstPanUnits === undefined) continue;
    const from = done.get(row) || 0;
    done.set(row, row.strips.length);
    for (const s of row.strips.slice(from)) {
      const t = document.createElement('canvas');
      t.width = s.w;
      t.height = row.h;
      t.getContext('2d').drawImage(
        row.c,
        s.x,
        row.pad ?? 0,
        s.w,
        row.h,
        0,
        0,
        s.w,
        row.h,
      );
      const cx = s.srcX + s.w / 2, // where in its picture the strip's middle was
        yaw = (row.firstPanUnits + s.step * step) * degPer(),
        off = Math.atan(((cx - row.picW / 2) / (row.picW / 2)) * th) / rad;
      sp.paint(
        t,
        yaw + off,
        row.tilt * degPerTilt(),
        (2 * Math.atan((th * s.w) / (row.picW / 1))) / rad,
        lens.fovV,
      );
    }
  }
}
$('keySphere').onclick = () =>
  sphereView?.isOpen
    ? closeSphere()
    : openSphere().catch((e) => setStatus(e.message, true));
document.addEventListener('keydown', (e) => {
  if (
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)
  )
    return;
  if (e.code === 'KeyO') {
    e.preventDefault();
    $('keySphere').click();
  } else if (e.key === 'Escape' && stripView?.isOpen) stripView.escape();
  else if (e.key === 'Escape' && sphereView?.isOpen) closeSphere();
});

// Find limits: only on the button; steps to each end and back to the middle (limits.js).
const limitsText = () =>
  limits
    ? `Range measured (estimated): pan ${(limits.panMax - limits.panMin) / lim.STEP} steps of ${lim.STEP} (about ${PAN_DEGREES} degrees), tilt ${(limits.tiltMax - limits.tiltMin) / lim.STEP} steps.${lensText()} Find limits again if someone turned the neck by hand.`
    : 'Range not measured. Find limits steps the neck to each end in small steps and looks at the picture to see where it stops.';
const lensText = () =>
  lens
    ? ` Lens about ${Math.round(lens.fovH)}\u00b0 wide; tilt about ${(lens.tiltDegPerUnit * lim.STEP).toFixed(1)}\u00b0 a step.`
    : '';
function showLimitsInfo() {
  $('limitsInfo').textContent = limitsText();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// keep: hold the small picture (g.bmp) and its 160 x 90 gray (g.hi) for measuring and painting the sphere.
async function grabSmall(keep) {
  const r = await api('/api/snapshot.jpg?profile=p1');
  if (!r.ok) throw new Error((await r.json()).error);
  const bmp = await createImageBitmap(
    await r.blob(),
    keep ? { resizeWidth: 480, resizeHeight: 270 } : {},
  );
  const g = lim.gray(bmp);
  if (!g) throw new Error('the browser would not give the picture pixels');
  if (keep) {
    g.hi = lim.grayHi(bmp);
    g.bmp = bmp;
  } else bmp.close();
  return g;
}
async function sendStep(axis, dir) {
  for (let tries = 0; tries < 5; tries++) {
    const r = await api('/api/move', {
      method: 'POST',
      body: JSON.stringify({
        dx: axis === 'pan' ? dir * lim.STEP : 0,
        dy: axis === 'tilt' ? dir * lim.STEP : 0,
        speed: 100,
      }),
    });
    if (r.status !== 429) {
      if (!r.ok) throw new Error((await r.json()).error);
      return;
    }
    await sleep(400); // one move a second
  }
  throw new Error('the bridge kept refusing moves');
}
// One fast trip for Find limits (back over ground it already covered, and to
// the middle at the end); resolves once two small pictures in a row match.
async function travelFind(axis, units) {
  if (!units) return;
  while (Date.now() - lastMove < 1100) await sleep(100);
  const r = await api('/api/travel', {
    method: 'POST',
    body: JSON.stringify(axis === 'pan' ? { dx: units } : { dy: units }),
  });
  if (!r.ok) throw new Error((await r.json()).error);
  const { ms } = await r.json();
  const end = Date.now() + ms;
  await sleep(500);
  let prev = await grabSmall();
  while (Date.now() < end) {
    await sleep(150);
    const cur = await grabSmall();
    if (lim.same(lim.diff(prev, cur), 1)) break;
    prev = cur;
  }
  lastMove = Date.now();
  api('/api/travel/done', { method: 'POST' }).catch(() => {});
}
let cancelFind = false;
$('limitsSweep').checked = store.get('gm-limits-sweep', '1') === '1';
$('limitsSweep').onchange = () =>
  store.set('gm-limits-sweep', $('limitsSweep').checked ? '1' : '0');
$('limitsStop').onclick = () => {
  cancelFind = true;
};
$('limitsGo').onclick = async () => {
  if (!connected || finding) return;
  finding = true;
  cancelFind = false;
  liveLens = null;
  sphereNow().clear();
  openSphere().catch(() => {}); // watch the room come together
  holdStop();
  stopLive(); // the picture comes from small snapshots; the live view would only get in the way
  $('limitsGo').disabled = true;
  $('limitsStop').hidden = false;
  $('limitsBar').hidden = false;
  $('limitsBar').value = 0;
  setStatus(glass.line('limitsStart'));
  let res = null;
  try {
    res = await lim.findLimits({
      grab: () => grabSmall(true),
      frame: runFrame,
      send: sendStep,
      travel: travelFind,
      cancelled: () => cancelFind,
      wait: sleep,
      line: (e) => glass.line(e),
      progress: (t, f) => {
        $('limitsInfo').textContent = t;
        $('limitsBar').value = f;
      },
    });
  } catch (e) {
    setStatus(`Lost the angle. Mapping failed: ${e.message}`, true);
  }
  finding = false;
  liveLens = null;
  // the run's pictures stay until repaintRun has painted them with the final lens
  if (!res || !res.lens) {
    for (const f of runFrames) f.bmp.close();
    runFrames = [];
  }
  $('limitsGo').disabled = !connected;
  $('limitsStop').hidden = true;
  $('limitsBar').hidden = true;
  if (res) {
    limits = {
      panMin: res.pan.min,
      panMax: res.pan.max,
      tiltMin: res.tilt.min,
      tiltMax: res.tilt.max,
    };
    pan = tilt = 0;
    blocked.l = blocked.r = blocked.u = blocked.d = false;
    if (res.lens) {
      lens = {
        fovH: res.lens.fovH,
        fovV: res.lens.fovV,
        tiltDegPerUnit: res.lens.tiltDegPerUnit,
      };
      repaintRun(res);
    }
    setStatus(`${glass.line('limitsDone')} Estimated range saved.`);
    // Find limits only looks along a cross (one row, one column); fill the
    // rest of the sphere with a sweep unless switched off.
    if (res.lens && $('limitsSweep').checked) {
      await sleep(1500);
      if (connected && !finding) sweep();
    }
  } else if (cancelFind || !connected) {
    setStatus(
      `${glass.line('limitsStop')} The neck could be anywhere; the estimate is unchanged.`,
    );
  } else {
    setStatus(
      'Mapping gave up (a step or time cap, or it could not tell the ends). The estimate is unchanged.',
      true,
    );
  }
  showLimitsInfo();
  showPose(true);
  saveAim(true);
};
showLimitsInfo();

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

// Jack out: drop the line without forgetting anything; Forget the ICE: remove
// the saved token from this browser (for shared computers or a wrong paste).
$('jackOut').onclick = async () => {
  if (recorder.active) await recorder.stop();
  setConnected(false);
  setStatus('Jacked out. Line closed.');
};
$('forgetIce').onclick = () => {
  try {
    localStorage.removeItem('token');
  } catch {
    /* private window */
  }
  token = '';
  $('token').value = '';
  try {
    localStorage.removeItem('lastFrame');
  } catch {
    /* private window */
  }
  if (connected) setConnected(false);
  setStatus('ICE forgotten. This browser no longer holds the token.');
};

// Last known frame: a small copy of the latest snapshot, kept only in this
// browser, shown in grayscale under a SIGNAL LOST bar when the deck opens
// flatlined. Forget the ICE removes it too.

async function rememberFrame(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const w = 640;
    const h = Math.round((bmp.height / bmp.width) * w);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const data = c.toDataURL('image/jpeg', 0.7);
    localStorage.setItem('lastFrame', JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full or private window: just don't remember */
  }
}
function lastFrame() {
  try {
    return JSON.parse(localStorage.getItem('lastFrame') || 'null');
  } catch {
    return null;
  }
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
function showAge() {
  const f = lastFrame();
  $('lastAge').textContent = f ? `(${ago(Date.now() - f.at)})` : '';
}
function showLastFrame() {
  const f = lastFrame();
  if (!f || connected || !$('snap').hidden) return;
  $('snap').src = f.data;
  $('snap').hidden = false;
  $('placeholder').setAttribute('hidden', '');
  $('snap').alt = 'Last known camera frame, shown while not connected';
  showAge();
  $('lastBar').hidden = false;
}
showLastFrame();

// Stills (bank-camera mode): one quiet snapshot every N seconds while not live.
// Each still waits for the previous one, so slow cameras never pile up
// requests. Going live pauses it; jacking out stops it.
var stillsTimer = 0; // var: setConnected touches it during start-up
var stillsCount = 0;
function stillsTick() {
  clearTimeout(stillsTimer);
  const every = Number($('stills').value) * 1000;
  if (!every || !connected) return;
  if (liveOn) {
    stillsTimer = setTimeout(stillsTick, 1000);
    return;
  }
  const started = Date.now();
  snapshot(true).then(() => {
    stillsCount++;
    setStatus(
      `Stills every ${$('stills').selectedOptions[0].text}. Frame ${stillsCount}.`,
    );
    stillsTimer = setTimeout(
      stillsTick,
      Math.max(250, every - (Date.now() - started)),
    );
  });
}
$('stills').onchange = () => {
  stillsCount = 0;
  store.set('stills', $('stills').value);
  if ($('stills').value === '0') {
    clearTimeout(stillsTimer);
    setStatus('Stills off.');
  } else stillsTick();
};
$('stills').value = store.get('stills', '0');

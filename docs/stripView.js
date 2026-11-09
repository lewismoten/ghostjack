// The strip scan's panel over the picture area: the panorama grows strip by strip, scrolled to keep the newest
// strip in view, with Start/Stop (Esc), the options and Download panorama (strips.js makes the picture).
// ctl: { start(opts), stop(), download(), close(), canPaint() }. Pictures stay in memory only.
import { compose } from './strips.js';

export function createStripView(host, ctl) {
  const root = document.createElement('div');
  root.className = 'stripview';
  root.hidden = true;
  root.tabIndex = 0;
  root.setAttribute('role', 'region');
  root.setAttribute(
    'aria-label',
    'Strip scan: a panorama from thin slices. Left and right arrows scroll, Escape stops or closes.',
  );
  const canvas = document.createElement('canvas');
  canvas.className = 'stripcanvas';
  canvas.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('div');
  bar.className = 'stripbar';
  const btn = (label, aria, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = b.ariaLabel = aria;
    b.onclick = fn;
    bar.append(b);
    return b;
  };
  const check = (label, aria, on) => {
    const l = document.createElement('label'),
      i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = on;
    l.append(i, ` ${label}`);
    l.title = aria;
    bar.append(l);
    return i;
  };
  let running = false,
    pano = null,
    rowsRef = [],
    stale = false,
    scrollX = 0,
    follow = true,
    dirty = false,
    raf = 0,
    open = false;
  const go = btn(
    'Start',
    'Start the strip scan: the camera turns in small steps and thin slices of each picture are placed side by side',
    () => (running ? ctl.stop() : ctl.start(options())),
  );
  const dl = btn(
    'Download panorama',
    'Download the strip panorama as a JPEG',
    () => ctl.download(),
  );
  dl.disabled = true;
  btn('×', 'Close the strip scan view', () => view.escape(true));
  const rows = check(
    'Rows',
    'Rows: cover the measured tilt range with several rows (needs Find limits). Off: one row at the current tilt',
    false,
  );
  const hd = check(
    '1080p',
    'Use the full 1080p picture (slower) instead of the quick 640 by 360 one',
    false,
  );
  const paint = check(
    'Paint the sphere',
    'When done, also paint the strips onto the photo sphere (needs Find limits)',
    true,
  );
  const stepSel = document.createElement('select');
  stepSel.title = stepSel.ariaLabel =
    'Step size: fine moves 4 units a step, normal 10';
  for (const [v, t] of [
    ['4', 'Fine step'],
    ['10', 'Normal step'],
  ]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    stepSel.append(o);
  }
  bar.append(stepSel);
  const note = document.createElement('p');
  note.className = 'stripnote';
  note.setAttribute('role', 'status');
  root.append(canvas, bar, note);
  host.append(root);
  const options = () => ({
    rows: rows.checked,
    hd: hd.checked,
    paint: paint.checked,
    step: Number(stepSel.value),
  });

  function size() {
    const r = root.getBoundingClientRect(),
      dpr = Math.min(2, devicePixelRatio || 1),
      w = Math.max(1, Math.round(r.width * dpr)),
      h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  function draw() {
    raf = 0;
    if (!open) return;
    if (stale) {
      pano = compose(rowsRef);
      stale = false;
    }
    size();
    const g = canvas.getContext('2d');
    g.fillStyle = '#0b0f14';
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (!pano) return;
    const top = Math.round(canvas.height * 0.14),
      avail = canvas.height - top - Math.round(canvas.height * 0.1),
      k = Math.min(avail / pano.height, 2),
      pw = pano.width * k,
      max = Math.max(0, pw - canvas.width);
    if (follow) scrollX = max;
    scrollX = Math.max(0, Math.min(max, scrollX));
    g.imageSmoothingQuality = 'high';
    g.drawImage(
      pano,
      scrollX / k,
      0,
      Math.min(pano.width, canvas.width / k),
      pano.height,
      0,
      top,
      Math.min(pw, canvas.width),
      pano.height * k,
    );
  }
  const want = () => {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(draw);
  };
  addEventListener('resize', () => open && want());
  // scrolling by hand (drag, wheel, arrows) stops following the newest strip
  const by = (px) => {
    follow = false;
    scrollX += px;
    want();
  };
  let drag = null;
  canvas.parentElement.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.stripbar')) return;
    drag = e.clientX;
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', (e) => {
    if (drag === null) return;
    by(-(e.clientX - drag) * (devicePixelRatio || 1));
    drag = e.clientX;
  });
  root.addEventListener('pointerup', () => (drag = null));
  root.addEventListener('wheel', (e) => by(e.deltaX || e.deltaY), {
    passive: true,
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') by(-120);
    else if (e.key === 'ArrowRight') by(120);
    else return;
    e.preventDefault();
  });

  const view = {
    get isOpen() {
      return open;
    },
    get running() {
      return running;
    },
    show() {
      root.hidden = false;
      open = true;
      root.focus({ preventScroll: true });
      want();
    },
    hide() {
      root.hidden = true;
      open = false;
    },
    // Esc: stops a running scan first, then closes (the x button closes straight away)
    escape(closeNow) {
      if (running && !closeNow) ctl.stop();
      else {
        if (running) ctl.stop();
        ctl.close();
      }
    },
    setRunning(on) {
      running = on;
      go.textContent = on ? 'Stop' : pano ? 'Scan again' : 'Start';
      go.ariaLabel = on ? 'Stop the strip scan' : go.title;
      for (const el of [rows, hd, paint, stepSel]) el.disabled = on;
      if (on) {
        follow = true;
        pano = null;
        rowsRef = [];
        dl.disabled = true;
      }
    },
    // the scan's state has changed: recompose and redraw (at most once a frame)
    update(rowsNow, finished) {
      rowsRef = rowsNow;
      stale = true;
      if (finished) {
        pano = compose(rowsRef);
        stale = false;
        dl.disabled = !pano;
        follow = false;
        scrollX = 0;
      }
      want();
    },
    note(t) {
      note.textContent = t;
    },
    get panorama() {
      return pano;
    },
    get dirty() {
      return dirty;
    },
  };
  return view;
}

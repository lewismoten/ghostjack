// The sphere view: three.js from inside the photo sphere (sphere.js). Drag to look around, wheel or pinch to
// zoom, double-click or double-tap (or Enter on the crosshair, moved with the arrow keys) to send the camera
// there, Esc to close. A reticle marks where the camera points now (its lens footprint) and a faint dashed
// outline the measured range. Places never seen are a dark grid; old places are dimmed. While the camera
// moves the view follows its direction, unless the person has been looking around by hand.
import { AW, AH, EPOCH, W, H } from './sphere.js';

const rad = Math.PI / 180;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const DARK = '#0b0f14';

// host: the element to fill (the picture area). ctl: { sphere, pose(): {yaw, pitch, fovH, fovV} | null (degrees,
// where the camera points), range(): {yaw0, yaw1, pitch0, pitch1} | null, goto(yaw, pitch), reduced,
// sweep(), stopSweep(), exportJpg(full), close() }.
export function createView(host, ctl) {
  const root = document.createElement('div');
  root.className = 'sphereview';
  root.hidden = true;
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute(
    'aria-label',
    'Photo sphere of the room. Arrow keys move the crosshair, plus and minus zoom, Enter sends the camera to the crosshair, Escape closes.',
  );
  const overlay = document.createElement('canvas');
  overlay.className = 'sphereover';
  overlay.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('div');
  bar.className = 'spherebar';
  const btn = (label, aria, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = b.ariaLabel = aria;
    b.onclick = fn;
    bar.append(b);
    return b;
  };
  const sweepBtn = btn(
    'Sweep',
    'Sweep: fill the sphere. The camera visits every angle of its range and takes a small picture at each',
    () => (sweeping ? ctl.stopSweep() : ctl.sweep()),
  );
  btn('Panorama', 'Download panorama: the painted part as a picture', () =>
    ctl.exportJpg(false),
  );
  btn(
    '360°',
    'Download the whole sphere as a 2 to 1 picture that opens as a 360 degree photo in viewers',
    () => ctl.exportJpg(true),
  );
  btn('×', 'Close the sphere view', () => ctl.close());
  const note = document.createElement('p');
  note.className = 'spherenote';
  note.setAttribute('role', 'status');
  root.append(overlay, bar, note);
  host.append(root);

  const viewCanvas = document.createElement('canvas');
  viewCanvas.width = W;
  viewCanvas.height = H;
  const vg = viewCanvas.getContext('2d');
  const dimCanvas = document.createElement('canvas');
  dimCanvas.width = AW;
  dimCanvas.height = AH;
  const dg = dimCanvas.getContext('2d');
  const dimData = dg.createImageData(AW, AH);

  let T = null, // three.js
    renderer,
    camera,
    texture,
    sweeping = false,
    open = false,
    dirty = true,
    raf = 0,
    lastCompose = 0,
    lastHand = 0;
  const look = { yaw: 0, pitch: 0, fov: 60 }; // fov: vertical, degrees
  const cross = { yaw: 0, pitch: 0 };

  // The texture: dark grid, the painted sphere, then a dimming film over old places.
  function compose() {
    vg.fillStyle = DARK;
    vg.fillRect(0, 0, W, H);
    vg.strokeStyle = 'rgba(80,200,255,0.16)';
    vg.lineWidth = 2;
    vg.beginPath();
    for (let d = -180; d <= 180; d += 15) {
      const x = ((d + 180) / 360) * W;
      vg.moveTo(x, 0);
      vg.lineTo(x, H);
    }
    for (let d = -90; d <= 90; d += 15) {
      const y = ((90 - d) / 180) * H;
      vg.moveTo(0, y);
      vg.lineTo(W, y);
    }
    vg.stroke();
    vg.drawImage(ctl.sphere.canvas, 0, 0);
    const now = Date.now() / 1000 - EPOCH,
      a = ctl.sphere.ages,
      px = dimData.data;
    for (let i = 0; i < a.length; i++) {
      const age = a[i] ? now - a[i] : 0,
        t = a[i] ? clamp((age - 300) / 7200, 0, 1) : 0;
      px[i * 4 + 3] = Math.round(t * 150);
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 20;
    }
    dg.putImageData(dimData, 0, 0);
    vg.imageSmoothingEnabled = true;
    vg.drawImage(dimCanvas, 0, 0, W, H);
    if (texture) texture.needsUpdate = true;
    lastCompose = performance.now();
    dirty = false;
  }
  ctl.sphere.onChange(() => (dirty = true));

  const dirOf = (yaw, pitch) => {
    const cp = Math.cos(pitch * rad);
    return new T.Vector3(
      cp * Math.sin(yaw * rad),
      Math.sin(pitch * rad),
      -cp * Math.cos(yaw * rad),
    );
  };
  const size = () => {
    const w = Math.max(2, root.clientWidth),
      h = Math.max(2, root.clientHeight);
    if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()))
      renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    return { w, h };
  };
  // yaw/pitch (degrees) to a pixel in the view, or null when behind
  const project = (yaw, pitch, w, h) => {
    const d = dirOf(yaw, pitch);
    const fwd = new T.Vector3();
    camera.getWorldDirection(fwd);
    if (d.dot(fwd) <= 0.02) return null;
    const p = d.clone().project(camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  };
  const line = (g, pts, w, h) => {
    let on = false;
    g.beginPath();
    for (const [yaw, pitch] of pts) {
      const p = project(yaw, pitch, w, h);
      if (!p) {
        on = false;
        continue;
      }
      if (on) g.lineTo(p.x, p.y);
      else g.moveTo(p.x, p.y);
      on = true;
    }
    g.stroke();
  };
  const rect = (y0, y1, p0, p1) => {
    const pts = [];
    const seg = (a, b, f) => {
      for (let i = 0; i < 24; i++) pts.push(f(a + ((b - a) * i) / 24));
    };
    seg(y0, y1, (y) => [y, p1]);
    seg(p1, p0, (p) => [y1, p]);
    seg(y1, y0, (y) => [y, p0]);
    seg(p0, p1, (p) => [y0, p]);
    pts.push(pts[0]);
    return pts;
  };
  // The picture's own border (a pinhole camera turned to yaw, pitch), as yaw
  // and pitch points: the same basis sphere.js paints with, so the outline
  // hugs the painted picture instead of bowing along latitude lines.
  const lensFrame = (yaw, pitch, fovH, fovV) => {
    const y = yaw * rad,
      p = pitch * rad,
      th = Math.tan((fovH * rad) / 2),
      tv = Math.tan((fovV * rad) / 2);
    const f = [
        Math.cos(p) * Math.sin(y),
        Math.sin(p),
        Math.cos(p) * Math.cos(y),
      ],
      r = [Math.cos(y), 0, -Math.sin(y)],
      u = [-Math.sin(p) * Math.sin(y), Math.cos(p), -Math.sin(p) * Math.cos(y)];
    const pts = [];
    const corner = [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
      [-1, 1],
    ];
    for (let c = 0; c < 4; c++)
      for (let i = 0; i < 24; i++) {
        const t = i / 24,
          nx = corner[c][0] + (corner[c + 1][0] - corner[c][0]) * t,
          ny = corner[c][1] + (corner[c + 1][1] - corner[c][1]) * t;
        const d = [0, 1, 2].map((k) => f[k] + nx * th * r[k] + ny * tv * u[k]);
        const l = Math.hypot(...d);
        const a = Math.atan2(d[0], d[2]) / rad;
        // unwrapped around the picture's yaw, so the outline never jumps at 180
        const ya = yaw + ((((a - yaw + 180) % 360) + 360) % 360) - 180;
        pts.push([ya, Math.asin(d[1] / l) / rad]);
      }
    pts.push(pts[0]);
    return pts;
  };
  function drawOverlay() {
    const { w, h } = size(),
      g = overlay.getContext('2d');
    g.clearRect(0, 0, w, h);
    const r = ctl.range();
    if (r) {
      g.setLineDash([6, 6]);
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      g.lineWidth = 1;
      line(g, rect(r.yaw0, r.yaw1, r.pitch0, r.pitch1), w, h);
      g.setLineDash([]);
    }
    const p = ctl.pose();
    if (p) {
      g.strokeStyle = '#19e3ff';
      g.lineWidth = 2;
      line(g, lensFrame(p.yaw, p.pitch, p.fovH, p.fovV), w, h);
      const c = project(p.yaw, p.pitch, w, h);
      if (c) {
        g.beginPath();
        g.moveTo(c.x - 8, c.y);
        g.lineTo(c.x + 8, c.y);
        g.moveTo(c.x, c.y - 8);
        g.lineTo(c.x, c.y + 8);
        g.stroke();
      }
    }
    const x = project(cross.yaw, cross.pitch, w, h);
    if (x) {
      g.strokeStyle = '#ffb000';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x.x, x.y, 11, 0, 7);
      g.moveTo(x.x - 16, x.y);
      g.lineTo(x.x - 6, x.y);
      g.moveTo(x.x + 6, x.y);
      g.lineTo(x.x + 16, x.y);
      g.moveTo(x.x, x.y - 16);
      g.lineTo(x.x, x.y - 6);
      g.moveTo(x.x, x.y + 6);
      g.lineTo(x.x, x.y + 16);
      g.stroke();
    }
  }
  function frame(t) {
    raf = open ? requestAnimationFrame(frame) : 0;
    if (!open) return;
    if (dirty && t - lastCompose > 160) compose();
    const p = ctl.pose();
    // follow the camera unless the person is looking around by hand
    if (p && performance.now() - lastHand > 3500) {
      const k = ctl.reduced ? 1 : 0.08;
      look.yaw += wrap(p.yaw - look.yaw) * k;
      look.pitch += (p.pitch - look.pitch) * k;
    }
    look.pitch = clamp(look.pitch, -89, 89);
    camera.rotation.set(look.pitch * rad, -look.yaw * rad, 0, 'YXZ');
    camera.fov = look.fov;
    size();
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    drawOverlay();
  }
  let scene;
  async function boot() {
    T = await import('./vendor/three.module.js');
    renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    renderer.domElement.className = 'spherecanvas';
    root.prepend(renderer.domElement);
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(look.fov, 16 / 9, 0.1, 1000);
    texture = new T.CanvasTexture(viewCanvas);
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = 4;
    const SEG_X = 72,
      SEG_Y = 36,
      pos = [],
      uv = [],
      idx = [];
    for (let j = 0; j <= SEG_Y; j++)
      for (let i = 0; i <= SEG_X; i++) {
        const lon = (i / SEG_X - 0.5) * 360,
          lat = (0.5 - j / SEG_Y) * 180,
          d = dirOf(lon, lat);
        pos.push(d.x * 500, d.y * 500, d.z * 500);
        uv.push(i / SEG_X, 1 - j / SEG_Y);
      }
    for (let j = 0; j < SEG_Y; j++)
      for (let i = 0; i < SEG_X; i++) {
        const a = j * (SEG_X + 1) + i,
          b = a + SEG_X + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    scene.add(
      new T.Mesh(
        geo,
        new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide }),
      ),
    );
    wire();
  }

  // Where a pixel of the view points: yaw and pitch in degrees.
  function at(x, y) {
    const r = root.getBoundingClientRect(),
      v = new T.Vector3(
        ((x - r.left) / r.width) * 2 - 1,
        1 - ((y - r.top) / r.height) * 2,
        0.5,
      ).unproject(camera);
    v.normalize();
    return {
      yaw: Math.atan2(v.x, -v.z) / rad,
      pitch: Math.asin(clamp(v.y, -1, 1)) / rad,
    };
  }
  function wire() {
    const ptr = new Map();
    let pinch = 0,
      tap = { t: 0, x: 0, y: 0 },
      moved = 0;
    root.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target.closest('button')) return;
      root.setPointerCapture?.(e.pointerId);
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      pinch = 0;
      root.focus({ preventScroll: true });
    });
    root.addEventListener('pointermove', (e) => {
      const p = ptr.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x,
        dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastHand = performance.now();
      if (ptr.size === 2) {
        const [a, b] = [...ptr.values()],
          d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) look.fov = clamp((look.fov * pinch) / d, 15, 100);
        pinch = d;
        return;
      }
      const k = look.fov / Math.max(200, root.clientHeight);
      look.yaw = wrap(look.yaw - dx * k);
      look.pitch = clamp(look.pitch + dy * k, -89, 89);
    });
    const up = (e) => {
      e.stopPropagation();
      if (!ptr.delete(e.pointerId)) return;
      if (e.type === 'pointerup' && moved < 8 && !ptr.size) {
        const now = performance.now();
        if (
          now - tap.t < 400 &&
          Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 24
        ) {
          const d = at(e.clientX, e.clientY);
          cross.yaw = d.yaw;
          cross.pitch = d.pitch;
          ctl.goto(d.yaw, d.pitch);
          tap.t = 0;
        } else tap = { t: now, x: e.clientX, y: e.clientY };
      }
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        look.fov = clamp(look.fov * Math.exp(e.deltaY * 0.001), 15, 100);
        lastHand = performance.now();
      },
      { passive: false },
    );
    root.addEventListener('dblclick', (e) => e.stopPropagation());
    root.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = e.shiftKey ? 10 : 3;
      const move = {
        ArrowLeft: [-s, 0],
        ArrowRight: [s, 0],
        ArrowUp: [0, s],
        ArrowDown: [0, -s],
      }[e.key];
      if (move) {
        cross.yaw = wrap(cross.yaw + move[0]);
        cross.pitch = clamp(cross.pitch + move[1], -89, 89);
        look.yaw = cross.yaw;
        look.pitch = cross.pitch;
        lastHand = performance.now();
      } else if (e.key === 'Enter' && !e.target.closest?.('button'))
        ctl.goto(cross.yaw, cross.pitch);
      else if (e.key === '+' || e.key === '=')
        look.fov = clamp(look.fov * 0.85, 15, 100);
      else if (e.key === '-') look.fov = clamp(look.fov / 0.85, 15, 100);
      else if (e.key === 'Escape') ctl.close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  return {
    get isOpen() {
      return open;
    },
    async show() {
      root.hidden = false;
      open = true;
      try {
        if (!T) await boot();
      } catch {
        open = false;
        root.hidden = true;
        throw new Error(
          'the 3D view needs WebGL, which this browser would not start',
        );
      }
      const p = ctl.pose();
      if (p) {
        look.yaw = cross.yaw = p.yaw;
        look.pitch = cross.pitch = p.pitch;
      }
      lastHand = 0;
      dirty = true;
      if (!raf) raf = requestAnimationFrame(frame);
      root.focus({ preventScroll: true });
    },
    hide() {
      open = false;
      root.hidden = true;
    },
    setSweeping(on) {
      sweeping = on;
      sweepBtn.textContent = on ? 'Stop' : 'Sweep';
      sweepBtn.ariaLabel = on
        ? 'Stop the sweep'
        : 'Sweep: fill the sphere. The camera visits every angle of its range and takes a small picture at each';
    },
    note(text) {
      note.textContent = text;
    },
    root,
    // for checks: where the view looks
    get look() {
      return { ...look };
    },
  };
}

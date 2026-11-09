// The room as a photo sphere: an equirectangular canvas (2048 x 1024 = 360 x 180 degrees; yaw 0 is the
// estimated pan 0, pitch 0 the estimated tilt 0, yaw grows to the right, pitch grows upward). Every picture
// the camera takes is painted where it points: each canvas pixel in the picture's footprint is turned into
// a ray, rotated into the camera (pan = yaw, then tilt = pitch) and looked up in the picture through a
// pinhole lens (fovH, fovV degrees); newer pictures go over older ones, with a soft edge. A coarse age map
// (one cell per 4 x 4 pixels, seconds since 2020) remembers when each place was last seen, so the on-screen
// view can dim stale areas; exports never dim. The sphere is kept in IndexedDB per bridge address. It holds
// no camera data anywhere but this browser, and nothing leaves it unless the person downloads it.
export const W = 2048,
  H = 1024;
export const AW = 512,
  AH = 256;
export const EPOCH = 1577836800; // 2020-01-01
const rad = Math.PI / 180;
const SRC_W = 480,
  SRC_H = 270;

export function createSphere() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const ages = new Uint32Array(AW * AH);
  const src = document.createElement('canvas');
  src.width = SRC_W;
  src.height = SRC_H;
  const sx = src.getContext('2d', { willReadFrequently: true });
  const listeners = new Set();
  const changed = () => {
    for (const f of listeners) f();
  };
  const me = {
    canvas,
    ages,
    calib: null, // { fovH, fovV, panDegPerUnit, tiltDegPerUnit } once measured
    painted: 0,
    onChange: (fn) => listeners.add(fn),
    clear() {
      cx.clearRect(0, 0, W, H);
      ages.fill(0);
      me.painted = 0;
      changed();
    },
    // Paint one picture (anything drawImage takes). Returns false if it could not be read.
    paint(bitmap, panDeg, tiltDeg, fovH, fovV, takenAt = Date.now()) {
      let img;
      try {
        sx.drawImage(bitmap, 0, 0, SRC_W, SRC_H);
        img = sx.getImageData(0, 0, SRC_W, SRC_H).data;
      } catch {
        return false;
      }
      const yaw = panDeg * rad,
        pitch = tiltDeg * rad,
        th = Math.tan((fovH * rad) / 2),
        tv = Math.tan((fovV * rad) / 2);
      const cy = Math.cos(yaw),
        sy = Math.sin(yaw),
        cp = Math.cos(pitch),
        sp = Math.sin(pitch);
      // camera axes in the world (x right, y up, z ahead at yaw 0)
      const fx = cp * sy,
        fy = sp,
        fz = cp * cy,
        rx = cy,
        rz = -sy,
        ux = -sp * sy,
        uy = cp,
        uz = -sp * cy;
      // the footprint: rays through the picture's border give the rows and the sideways reach
      let latMin = 90,
        latMax = -90,
        reach = 0;
      for (let i = 0; i < 64; i++) {
        const t = i / 16,
          e = Math.floor(t) % 4,
          f = t - Math.floor(t);
        const nx =
            e === 0 ? -1 + 2 * f : e === 2 ? 1 - 2 * f : e === 1 ? 1 : -1,
          ny = e === 0 ? 1 : e === 2 ? -1 : e === 1 ? 1 - 2 * f : -1 + 2 * f;
        const ax = nx * th,
          ay = ny * tv;
        const dx = fx + ax * rx + ay * ux,
          dy = fy + ay * uy,
          dz = fz + ax * rz + ay * uz;
        const l = Math.hypot(dx, dy, dz),
          lat = Math.asin(dy / l) / rad;
        let dl = Math.atan2(dx, dz) / rad - panDeg;
        dl = ((((dl + 180) % 360) + 360) % 360) - 180;
        latMin = Math.min(latMin, lat);
        latMax = Math.max(latMax, lat);
        reach = Math.max(reach, Math.abs(dl));
      }
      if (Math.abs(tiltDeg) + fovV / 2 >= 89) {
        reach = 180;
        if (tiltDeg > 0) latMax = 90;
        else latMin = -90;
      }
      const y0 = Math.max(0, Math.floor((0.5 - (latMax + 1) / 180) * H)),
        y1 = Math.min(H, Math.ceil((0.5 - (latMin - 1) / 180) * H)),
        rows = y1 - y0;
      if (rows <= 0) return true;
      const band = cx.getImageData(0, y0, W, rows),
        out = band.data;
      const mid = Math.round(((((panDeg / 360 + 0.5) % 1) + 1) % 1) * W),
        half = Math.min(W / 2, Math.ceil(((reach + 1) / 360) * W));
      const stamp = Math.max(1, Math.round(takenAt / 1000) - EPOCH);
      for (let y = y0; y < y1; y++) {
        const lat = (0.5 - (y + 0.5) / H) * Math.PI,
          cl = Math.cos(lat),
          dy = Math.sin(lat);
        for (let k = -half; k <= half; k++) {
          const x = (((mid + k) % W) + W) % W;
          const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI,
            dx = cl * Math.sin(lon),
            dz = cl * Math.cos(lon);
          const cz = dx * fx + dy * fy + dz * fz;
          if (cz <= 1e-6) continue;
          const nx = (dx * rx + dz * rz) / cz / th,
            ny = (dx * ux + dy * uy + dz * uz) / cz / tv;
          if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
          const u = Math.min(SRC_W - 1, Math.floor(((nx + 1) / 2) * SRC_W)),
            v = Math.min(SRC_H - 1, Math.floor(((1 - ny) / 2) * SRC_H));
          const s = (v * SRC_W + u) * 4,
            o = ((y - y0) * W + x) * 4;
          const a = Math.min(1, (1 - Math.max(Math.abs(nx), Math.abs(ny))) * 8);
          if (out[o + 3] === 0 || a >= 1) {
            out[o] = img[s];
            out[o + 1] = img[s + 1];
            out[o + 2] = img[s + 2];
            out[o + 3] = 255;
          } else {
            out[o] += (img[s] - out[o]) * a;
            out[o + 1] += (img[s + 1] - out[o + 1]) * a;
            out[o + 2] += (img[s + 2] - out[o + 2]) * a;
          }
          ages[(y >> 2) * AW + (x >> 2)] = stamp;
        }
      }
      cx.putImageData(band, 0, y0);
      me.painted++;
      changed();
      return true;
    },
    // The canvas cropped to a yaw/pitch box in degrees (null: all of it), unpainted places dark.
    crop(box) {
      const x0 = box ? Math.max(0, Math.floor((box.yaw0 / 360 + 0.5) * W)) : 0,
        x1 = box ? Math.min(W, Math.ceil((box.yaw1 / 360 + 0.5) * W)) : W,
        y0 = box ? Math.max(0, Math.floor((0.5 - box.pitch1 / 180) * H)) : 0,
        y1 = box ? Math.min(H, Math.ceil((0.5 - box.pitch0 / 180) * H)) : H;
      const c = document.createElement('canvas');
      c.width = Math.max(1, x1 - x0);
      c.height = Math.max(1, y1 - y0);
      const g = c.getContext('2d');
      g.fillStyle = '#0b0f14';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(canvas, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
      return c;
    },
    // Saved form: a JPEG of the canvas plus the age map (so unpainted places stay empty).
    async pack() {
      const flat = document.createElement('canvas');
      flat.width = W;
      flat.height = H;
      const g = flat.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      g.drawImage(canvas, 0, 0);
      const blob = await new Promise((r) => flat.toBlob(r, 'image/jpeg', 0.85));
      return { blob, ages: new Uint32Array(ages), calib: me.calib };
    },
    async unpack(p) {
      const bmp = await createImageBitmap(p.blob);
      cx.clearRect(0, 0, W, H);
      cx.drawImage(bmp, 0, 0);
      bmp.close();
      ages.set(p.ages);
      const d = cx.getImageData(0, 0, W, H);
      let any = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const on = ages[(y >> 2) * AW + (x >> 2)] ? 255 : 0;
          d.data[(y * W + x) * 4 + 3] = on;
          any |= on;
        }
      cx.putImageData(d, 0, 0);
      me.calib = p.calib ?? null;
      me.painted = any ? 1 : 0;
      changed();
    },
  };
  return me;
}

// Keeping it: one record per bridge address, saved a moment after the last change.
const DB = 'ghostjack-sphere',
  STORE = 'spheres';
let dbp = null;
const open = () =>
  (dbp ??= new Promise((resolve, reject) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) {
      reject(e);
    }
  }));
const run = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
};
export function keep(sphere) {
  let key = '',
    timer = 0;
  const save = async () => {
    if (!key || !sphere.painted) return;
    try {
      const p = await sphere.pack();
      await run('readwrite', (s) => s.put(p, key));
    } catch {
      /* no storage here: the sphere lives until the page closes */
    }
  };
  sphere.onChange(() => {
    clearTimeout(timer);
    timer = setTimeout(save, 4000);
  });
  return {
    async use(k) {
      clearTimeout(timer);
      key = k;
      try {
        const p = await run('readonly', (s) => s.get(k));
        if (p) await sphere.unpack(p);
      } catch {
        /* nothing saved */
      }
    },
    save,
  };
}

export const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
// A download: the painted part (the measured range plus half a lens each side) as a JPEG, or the whole
// 2:1 sphere. Stale areas are exported at full color (the dimming is only on screen).
export async function exportPanorama(sphere, limits, full) {
  const c = sphere.calib;
  let box = null;
  if (!full && c && limits) {
    const dp = c.panDegPerUnit,
      dt = c.tiltDegPerUnit;
    box = {
      yaw0: Math.max(-180, limits.panMin * dp - c.fovH / 2),
      yaw1: Math.min(180, limits.panMax * dp + c.fovH / 2),
      pitch0: Math.max(-90, limits.tiltMin * dt - c.fovV / 2),
      pitch1: Math.min(90, limits.tiltMax * dt + c.fovV / 2),
    };
  }
  const cv = sphere.crop(box);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
  return {
    blob,
    name: `ghostjack-panorama-${stamp()}${full ? '-360' : ''}.jpg`,
  };
}

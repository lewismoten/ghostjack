// Finding the neck's ends. The camera cannot say where its pan and tilt stops are, so the page finds them
// by looking: step toward one end in small steps (10 at speed 100, waiting for each to finish), measure how
// far the picture slid (imageShift on 160 x 90), and when 3 steps in a row slide it by about nothing (after
// 2 steps that may be swallowed by backlash), that end is reached. The range and the lens come from the
// steps that really moved the picture. It only runs when the user presses "Find limits", and it can be cancelled. What it cannot see:
// a blank, featureless view looks the same moving or not (it can stop early), and a hand on the neck.
const W = 32,
  H = 18;
const cv = document.createElement('canvas');
cv.width = W;
cv.height = H;
const cx = cv.getContext('2d', { willReadFrequently: true });

// A 32 x 18 grayscale copy of a bitmap, video or image, or null if the browser will not give pixels.
export function gray(src) {
  try {
    cx.drawImage(src, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data,
      g = new Uint8Array(W * H);
    for (let i = 0; i < g.length; i++)
      g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    return g;
  } catch {
    return null; // a tainted canvas (a cross-origin <video src>) cannot be read
  }
}

// A 160 x 90 grayscale copy (the size used to measure how far a step moved the picture).
const HW = 160,
  HH = 90;
const cvHi = document.createElement('canvas');
cvHi.width = HW;
cvHi.height = HH;
const cxHi = cvHi.getContext('2d', { willReadFrequently: true });
export function grayHi(src) {
  try {
    cxHi.drawImage(src, 0, 0, HW, HH);
    const d = cxHi.getImageData(0, 0, HW, HH).data,
      g = new Uint8Array(HW * HH);
    for (let i = 0; i < g.length; i++)
      g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    return g;
  } catch {
    return null;
  }
}
const median = (a) => {
  const s = [...a].sort((x, y) => x - y),
    n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};
// How far the picture slid between two 160 x 90 grays, as fractions of the frame: { sx, sy } (signed,
// content movement), or null when the match is not clear. Brute force over offsets, mean absolute
// difference over the overlap (every other pixel); the main axis searches +-45 percent (opts.reach), the
// other +-8; opts.minOverlap (default 0.35) is the least overlap a candidate may have.
export function imageShift(a, b, axis, opts = {}) {
  const reach = opts.reach ?? 0.45,
    minOverlap = opts.minOverlap ?? 0.35;
  let mean = 0;
  for (let i = 0; i < a.length; i += 7) mean += a[i];
  mean /= Math.ceil(a.length / 7);
  let v = 0;
  for (let i = 0; i < a.length; i += 7) v += (a[i] - mean) ** 2;
  if (Math.sqrt(v / Math.ceil(a.length / 7)) < 6) return null; // a blank view: nothing to match
  const mx = Math.round(HW * (axis === 'pan' ? reach : 0.08)),
    my = Math.round(HH * (axis === 'tilt' ? reach : 0.08)),
    scores = [];
  let best = Infinity,
    bx = 0,
    by = 0;
  const at = new Map();
  for (let dy = -my; dy <= my; dy++)
    for (let dx = -mx; dx <= mx; dx++) {
      const x0 = Math.max(0, dx),
        x1 = Math.min(HW, HW + dx),
        y0 = Math.max(0, dy),
        y1 = Math.min(HH, HH + dy);
      if ((x1 - x0) * (y1 - y0) < HW * HH * minOverlap) continue;
      let sum = 0,
        n = 0;
      for (let y = y0; y < y1; y += 2) {
        const ra = y * HW,
          rb = (y - dy) * HW - dx;
        for (let x = x0; x < x1; x += 2) {
          sum += Math.abs(a[ra + x] - b[rb + x]);
          n++;
        }
      }
      const sc = sum / n;
      scores.push(sc);
      at.set(dy * 1000 + dx, sc);
      if (sc < best) {
        best = sc;
        bx = dx;
        by = dy;
      }
    }
  // a picture that slid by (bx, by): a point at x in the new frame was at x + bx... in the old one
  if (best > 0.6 * median(scores)) return null; // no clear winner
  const edge = Math.abs(bx) >= mx || Math.abs(by) >= my;
  if (edge) return null;
  // parabola through the neighbors for a sub-pixel answer along each axis
  const sub = (m, c, p) => {
    const d = m - 2 * c + p;
    return d > 1e-6 ? (0.5 * (m - p)) / d : 0;
  };
  const g = (x, y) => at.get(y * 1000 + x) ?? best;
  const fx = bx + sub(g(bx - 1, by), best, g(bx + 1, by)),
    fy = by + sub(g(bx, by - 1), best, g(bx, by + 1));
  return { sx: fx / HW, sy: fy / HH };
}
const rad = Math.PI / 180;
// The lens from the measured shifts. panShifts and tiltShifts are |fraction| per step of STEP units;
// panUnits is the whole pan range in units (350 degrees across it, from the maker's specification).
// A pinhole camera turned by t shifts the picture center by tan(t) / (2 tan(fov / 2)) of the frame
// width, so fovH = 2 atan(tan(step) / (2 sx)); fovV follows from the 16:9 frame, and a tilt step is
// atan(sy * 2 tan(fovV / 2)). Returns { fovH, fovV, panDegPerUnit, tiltDegPerUnit } or null.
export function calibrate(panShifts, tiltShifts, panUnits, panDegrees = 350) {
  const sx = median(panShifts);
  if (!(sx > 0.005) || !(panUnits > 0)) return null;
  const panDegPerUnit = panDegrees / panUnits,
    fovH =
      (2 * Math.atan(Math.tan(panDegPerUnit * STEP * rad) / (2 * sx))) / rad;
  if (!(fovH > 20 && fovH < 140)) return null;
  const tv = Math.tan((fovH * rad) / 2) * (9 / 16),
    fovV = (2 * Math.atan(tv)) / rad,
    sy = median(tiltShifts);
  const tiltDegPerUnit =
    sy > 0.005 ? Math.atan(sy * 2 * tv) / rad / STEP : panDegPerUnit;
  return { fovH, fovV, panDegPerUnit, tiltDegPerUnit };
}
// Mean absolute difference between two grays, 0 to 255.
export const diff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += Math.abs(a[i] - b[i]);
  return n / a.length;
};
// Same picture, within the camera's noise: noise is the diff of two pictures with nothing moving.
export const same = (d, noise) => d < Math.max(1.5, noise * 2 + 0.8);

export const STEP = 10; // units per step, speed 100: the safe step
export const STEP_MS = 1300; // wait after each step (the bridge allows one a second)
const STILL_PX = 0.5; // under this many px (of 160) a step's measured slide counts as still
const WALL_STILLS = 3; // consecutive still steps that mean a wall
const BACKLASH = 2; // steps after a turn-around that may move nothing
export const CAP_STEPS = 220; // most steps in one walk
export const CAP_MS = 20 * 60 * 1000; // most time for the whole search

// deps: { grab(): Promise<Uint8Array> (32 x 18 gray; may carry .hi, the 160 x 90 gray, and .bmp, the small
// picture), frame?(frame, lens): called with each settled picture { bmp, pan, tilt } (units from where the
// run began) and a provisional lens { fovH, fovV, panDegPerUnit, tiltDegPerUnit } so the page can paint it
// at once, send(axis, dir): Promise<void> (one step of STEP), travel?(axis, units):
// Promise<void> (one fast trip that resolves once the picture settles), cancelled(): bool,
// progress(text, fraction), line(event), wait(ms) }. Resolves { pan, tilt } ranges in units (each
// { min, max }, centered on 0), center { pan, tilt } (where the middle is, in units from the run's start),
// frames (every picture handed to frame()), lens (calibrate()'s answer or null) or null if cancelled or capped. The camera ends at the center of each range.
export async function findLimits(deps) {
  const t0 = Date.now();
  const over = () => deps.cancelled() || Date.now() - t0 > CAP_MS;
  deps.progress('Calibrating the noise.', 0);
  const a = await deps.grab();
  await deps.wait(1200);
  const b = await deps.grab();
  const noise = diff(a, b);
  const here = { pan: 0, tilt: 0 },
    shifts = { pan: [], tilt: [] },
    frames = [];
  // The provisional lens: 60 degrees wide until pictures say how far a step turns.
  const prov = () => {
    const sx = median(shifts.pan),
      sy = median(shifts.tilt),
      fovH = 60,
      tv = Math.tan((fovH * rad) / 2) * (9 / 16);
    return {
      fovH,
      fovV: (2 * Math.atan(tv)) / rad,
      panDegPerUnit:
        sx > 0
          ? Math.atan(sx * 2 * Math.tan((fovH * rad) / 2)) / rad / STEP
          : 0.7,
      tiltDegPerUnit: sy > 0 ? Math.atan(sy * 2 * tv) / rad / STEP : 0.6,
    };
  };
  const show = (g) => {
    if (!g?.bmp) return;
    const f = { bmp: g.bmp, pan: here.pan, tilt: here.tilt };
    frames.push(f);
    deps.frame?.(f, prov());
  };
  // Step one way until two steps in a row leave the picture the same. Returns the steps that moved.
  async function walk(axis, dir, label, from, already = 0) {
    let prev = await deps.grab(),
      still = 0,
      taken = 0,
      moved = already;
    show(prev);
    for (let i = 0; i < CAP_STEPS && !over(); i++) {
      await deps.send(axis, dir);
      await deps.wait(STEP_MS);
      const cur = await deps.grab();
      taken++;
      // How far the picture really slid along this axis (px of 160 x 90). Only a blank or unclear view
      // (no measurement) falls back to the old "same picture" test on the 32 x 18 grays.
      const m = prev.hi && cur.hi ? imageShift(prev.hi, cur.hi, axis) : null,
        px = m ? Math.abs(axis === 'pan' ? m.sx * HW : m.sy * HH) : null,
        isStill = px !== null ? px < STILL_PX : same(diff(prev, cur), noise);
      if (isStill) {
        // the first steps after a turn-around can move nothing (backlash): they never count
        if (taken > BACKLASH && ++still >= WALL_STILLS) return moved;
      } else {
        moved++;
        still = 0;
        here[axis] += dir * STEP;
        if (m) shifts[axis].push(Math.abs(axis === 'pan' ? m.sx : m.sy));
        show(cur);
      }
      prev = cur;
      deps.progress(
        `${label}: ${moved} steps.`,
        from + Math.min(0.2, moved / 600),
      );
    }
    return null; // capped or cancelled
  }
  const out = {};
  let base = 0,
    panUnits = 0;
  for (const axis of ['pan', 'tilt']) {
    const name = axis === 'pan' ? 'Pan' : 'Tilt';
    deps.progress(`${name}: finding the first wall.`, base);
    const first = await walk(axis, -1, `${name} to the first wall`, base);
    if (first === null) return null;
    deps.line('wall');
    deps.progress(`${name}: crossing to the other wall.`, base + 0.25);
    // The ground back to the start was just covered: cross it in one fast
    // trip when the bridge can, and take small steps only from there on.
    let skip = 0;
    if (deps.travel && first > 0) {
      deps.progress(`${name}: back to the start in one trip.`, base + 0.25);
      await deps.travel(axis, first * STEP);
      here[axis] += first * STEP; // dir is -1 on the first walk: back to the start
      if (over()) return null;
      skip = first;
    }
    const n = await walk(axis, 1, `${name} across`, base + 0.25, skip);
    if (n === null || n < 2) return null;
    deps.progress(
      `${name}: ${n} steps across. Back to the middle.`,
      base + 0.45,
    );
    if (deps.travel) await deps.travel(axis, -Math.floor(n / 2) * STEP);
    else
      for (let i = 0; i < Math.floor(n / 2) && !over(); i++) {
        await deps.send(axis, -1);
        await deps.wait(STEP_MS);
      }
    here[axis] -= Math.floor(n / 2) * STEP;
    if (over()) return null;
    const half = (n * STEP) / 2;
    out[axis] = { min: -half, max: half };
    if (axis === 'pan') panUnits = n * STEP;
    base += 0.5;
  }
  deps.progress('Done.', 1);
  out.center = { ...here };
  out.frames = frames;
  out.lens = calibrate(shifts.pan, shifts.tilt, panUnits);
  return out;
}

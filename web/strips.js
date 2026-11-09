// Strip scan: a panorama from thin slices (a slit-scan). The camera turns a little at a time; from each
// picture only a thin vertical strip from the middle is kept (the middle is the least bent by the lens), and
// the strips go side by side. Where each strip goes comes from the pictures: the sideways shift between two
// consecutive pictures is measured (coarse on 160 x 90 with limits.js imageShift, then refined at full size
// on the central band) and the strips' x positions are the sums of those shifts, so uneven steps still line
// up. Nothing here trusts the camera's own idea of where it points. Pictures stay in memory only.
// What it cannot see: a blank wall (no shift to measure), moving things, and a camera whose first steps after
// a turn-around move nothing (backlash), which is why a wall is only called after 3 still measurements.
import * as lim from './limits.js';

export const STRIP_WAIT_MS = 1100; // after each small step (the bridge allows one move a second)
export const MAX_UNITS = 1500; // most pan units in one row
const FEATHER = 3; // px blended at each strip's left edge (rows: at a row's top edge)
const STILL_PX_PER_640 = 1; // under this many px (at 640 wide) a measured shift counts as still
const WALL_STILLS = 3; // consecutive still measurements that mean a wall
const THROWAWAY = 2; // steps taken in the scan direction before the first picture of a row

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cvA = document.createElement('canvas');
const cxA = cvA.getContext('2d', { willReadFrequently: true });
// A picture's grays at three sizes (32 x 18, 160 x 90 and full) plus the bitmap itself for cutting strips.
export function analyze(bmp) {
  const w = bmp.width,
    h = bmp.height;
  if (cvA.width !== w || cvA.height !== h) {
    cvA.width = w;
    cvA.height = h;
  }
  cxA.drawImage(bmp, 0, 0);
  const d = cxA.getImageData(0, 0, w, h).data,
    full = new Uint8Array(w * h);
  for (let i = 0; i < full.length; i++)
    full[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return {
    bmp,
    w,
    h,
    full,
    small: lim.gray(bmp),
    hi: lim.grayHi(bmp),
  };
}

// Refine a shift at full size: try offsets within (rx, ry) of the estimate (ex, ey), mean absolute
// difference over the overlap restricted to a central band (band 'x': the middle 60 percent of the rows,
// 'y': the middle 60 percent of the columns). Same sign convention as imageShift: a (previous) at x pairs
// with b (new) at x - dx. Returns { sx, sy } with a sub-pixel step along each axis.
export function refine(a, b, w, h, ex, ey, rx, ry, band) {
  const cx0 = Math.round(ex),
    cy0 = Math.round(ey),
    at = new Map();
  let best = Infinity,
    bx = cx0,
    by = cy0;
  for (let dy = cy0 - ry; dy <= cy0 + ry; dy++)
    for (let dx = cx0 - rx; dx <= cx0 + rx; dx++) {
      let x0 = Math.max(0, dx),
        x1 = Math.min(w, w + dx),
        y0 = Math.max(0, dy),
        y1 = Math.min(h, h + dy);
      if (band === 'x') {
        y0 = Math.max(y0, Math.round(h * 0.2));
        y1 = Math.min(y1, Math.round(h * 0.8));
      } else {
        x0 = Math.max(x0, Math.round(w * 0.2));
        x1 = Math.min(x1, Math.round(w * 0.8));
      }
      if (x1 - x0 < 8 || y1 - y0 < 8) continue;
      let sum = 0,
        n = 0;
      for (let y = y0; y < y1; y += 2) {
        const ra = y * w,
          rb = (y - dy) * w - dx;
        for (let x = x0; x < x1; x += 2) {
          sum += Math.abs(a[ra + x] - b[rb + x]);
          n++;
        }
      }
      const sc = sum / n;
      at.set(dy * 100000 + dx, sc);
      if (sc < best) {
        best = sc;
        bx = dx;
        by = dy;
      }
    }
  const sub = (m, c, p) => {
    const d = m - 2 * c + p;
    return d > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / d)) : 0;
  };
  const g = (x, y) => at.get(y * 100000 + x) ?? best;
  return {
    sx: bx + sub(g(bx - 1, by), best, g(bx + 1, by)),
    sy: by + sub(g(bx, by - 1), best, g(bx, by + 1)),
    score: best,
  };
}

const mk = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
// A row: one long image that strips are appended to; its canvas doubles when it runs out.
function newRow(h) {
  const c = mk(2048, h);
  return {
    c,
    g: c.getContext('2d'),
    h,
    width: 0,
    origin: null, // where canvas x = 0 sits, relative to the first picture's center
    ox: 0, // canvas x = 0 in the panorama
    oy: 0, // canvas y = 0 in the panorama
    strips: [], // { x, w, step, srcX }
    firstGray: null,
  };
}
function room(row, width) {
  if (width <= row.c.width) return;
  const n = mk(Math.max(width, row.c.width * 2), row.h);
  n.getContext('2d').drawImage(row.c, 0, 0);
  row.c = n;
  row.g = n.getContext('2d');
}
// Cut the strip of `pic` (center at Xc) covering row positions B0 to B1 (relative to the first center).
function cut(row, pic, Xc, B0, B1, step) {
  const d0 = Math.round(B0 - row.origin),
    d1 = Math.round(B1 - row.origin),
    w = d1 - d0;
  if (w <= 0 || !pic.bmp) return;
  const s0 = Math.round(pic.w / 2 + (B0 - Xc)),
    f = d0 > 0 && s0 >= FEATHER ? FEATHER : 0,
    sw = Math.min(w + f, pic.w - (s0 - f));
  if (sw <= 0 || s0 - f < 0) return;
  const t = mk(sw, pic.h),
    tg = t.getContext('2d', { willReadFrequently: true });
  tg.drawImage(pic.bmp, s0 - f, 0, sw, pic.h, 0, 0, sw, pic.h);
  if (f) {
    const e = tg.getImageData(0, 0, f, pic.h);
    for (let y = 0; y < pic.h; y++)
      for (let x = 0; x < f; x++)
        e.data[(y * f + x) * 4 + 3] = ((x + 0.5) / (f + 1)) * 255;
    tg.putImageData(e, 0, 0);
  }
  room(row, d1);
  row.g.drawImage(t, d0 - f, 0);
  row.width = Math.max(row.width, d1);
  row.strips.push({ x: d0, w, step, srcX: s0 });
}

// The rows as one picture: sorted top to bottom, each row kept from the middle of its overlap with the
// neighbors, with a few rows of blend at each seam. Returns a canvas, or null with nothing yet.
export function compose(rows) {
  const rs = rows.filter((r) => r.width > 0).sort((a, b) => a.oy - b.oy);
  if (!rs.length) return null;
  const minX = Math.min(...rs.map((r) => r.ox)),
    maxX = Math.max(...rs.map((r) => r.ox + r.width)),
    minY = rs[0].oy,
    maxY = Math.max(...rs.map((r) => r.oy + r.h));
  const out = mk(Math.round(maxX - minX), Math.round(maxY - minY)),
    g = out.getContext('2d');
  rs.forEach((r, i) => {
    const top = i ? (rs[i - 1].oy + rs[i - 1].h + r.oy) / 2 : r.oy,
      bot = i < rs.length - 1 ? (r.oy + r.h + rs[i + 1].oy) / 2 : r.oy + r.h,
      s0 = Math.max(0, Math.round(top - r.oy)),
      s1 = Math.min(r.h, Math.round(bot - r.oy)),
      dx = Math.round(r.ox - minX),
      dy = Math.round(r.oy - minY);
    if (s1 <= s0) return;
    const f = i && s0 >= FEATHER ? FEATHER : 0;
    if (f) {
      const t = mk(r.width, f),
        tg = t.getContext('2d', { willReadFrequently: true });
      tg.drawImage(r.c, 0, s0 - f, r.width, f, 0, 0, r.width, f);
      const e = tg.getImageData(0, 0, r.width, f);
      for (let y = 0; y < f; y++)
        for (let x = 0; x < r.width; x++)
          e.data[(y * r.width + x) * 4 + 3] = ((y + 0.5) / (f + 1)) * 255;
      tg.putImageData(e, 0, 0);
      g.drawImage(t, dx, dy + s0 - f);
    }
    g.drawImage(r.c, 0, s0, r.width, s1 - s0, dx, dy + s0, r.width, s1 - s0);
  });
  return out;
}

// deps: { snap(): Promise<ImageBitmap> (the chosen picture size), step(dx, dy): Promise<void> (one small move,
// resolves once sent), pose(): { pan } (the page's estimate, only used to paint the sphere), moved(dx, dy) (a step that was seen to move the picture), travel(pan, tilt): Promise<void>
// (one fast trip to these absolute units, resolves once the picture settles), cancelled(), note(text), update(state) }.
// plan: { step (units), rows: [tilt units, ...], panStart (units) or null, hd, waitMs? }.
// Resolves { rows, steps, cancelled }.
export async function stripScan(d, plan) {
  const wait = plan.waitMs ?? STRIP_WAIT_MS,
    state = { rows: [], steps: 0, note: '' };
  const say = (t) => {
    state.note = t;
    d.note(t);
    d.update(state);
  };
  const over = () => d.cancelled();
  const first = analyze(await d.snap());
  await sleep(1200);
  let noise = 0;
  {
    const b = analyze(await d.snap());
    noise = lim.diff(first.small, b.small);
    first.bmp.close();
    b.bmp.close();
  }
  // a picture once the neck has settled: two consecutive small grays that match
  async function settle() {
    await sleep(wait);
    let prev = analyze(await d.snap());
    for (let k = 0; k < 6 && !over(); k++) {
      const cur = analyze(await d.snap());
      const ok = lim.same(lim.diff(prev.small, cur.small), noise);
      prev.bmp.close();
      prev = cur;
      if (ok) break;
    }
    return prev;
  }
  const stillPx = (pic) => (STILL_PX_PER_640 * pic.w) / 640;
  const expectPx = (w) => 0.043 * w * (plan.step / 4);
  // the sideways shift of `cur` against `prev`: px, positive when the camera turned toward +pan
  function measure(prev, cur, recent) {
    const c = lim.imageShift(prev.hi, cur.hi, 'pan'),
      est = c
        ? c.sx * prev.w
        : recent.length
          ? median(recent)
          : expectPx(prev.w);
    const r = refine(prev.full, cur.full, prev.w, prev.h, est, 0, 6, 1, 'x'),
      z = refine(prev.full, cur.full, prev.w, prev.h, 0, 0, 2, 1, 'x');
    // no movement fits as well as the movement found: a wall (or a swallowed step)
    if (z.score <= r.score * 1.05 + 0.3) return z.sx;
    let s = r.sx;
    if (recent.length >= 3) {
      const m = median(recent);
      if (m > stillPx(prev) && Math.abs(s - m) > 0.6 * m + 3) s = m; // a bad match
    }
    return s;
  }
  // Step toward -pan until the picture stops sliding (3 near-zero measurements in a row).
  async function seekWall() {
    say('Looking for the left wall.');
    let prev = await settle(),
      still = 0;
    for (let i = 0; i * plan.step < MAX_UNITS && !over(); i++) {
      await d.step(-plan.step, 0);
      const cur = await settle(),
        s = Math.abs(measure(prev, cur, []));
      prev.bmp.close();
      prev = cur;
      if (s < stillPx(cur)) {
        if (++still >= WALL_STILLS) break;
      } else {
        still = 0;
        d.moved(-plan.step, 0);
      }
      say(`Looking for the left wall (${i + 1} steps).`);
    }
    prev.bmp.close();
  }
  async function scanRow(r, tilt) {
    const row = newRow(first.h);
    state.rows.push(row);
    // a turn-around can swallow the first steps: take two before the first picture
    for (let k = 0; k < THROWAWAY && !over(); k++) {
      await d.step(plan.step, 0);
      await sleep(wait);
    }
    let prev = await settle(),
      Xc = 0,
      still = 0,
      pend = { pic: prev, Xc: 0, B: null, step: 0 },
      s = expectPx(prev.w);
    const recent = [];
    row.picW = prev.w;
    row.firstPanUnits = d.pose().pan;
    row.firstGray = { full: prev.full, hi: prev.hi, w: prev.w, h: prev.h };
    for (let i = 1; i * plan.step <= MAX_UNITS && !over(); i++) {
      await d.step(plan.step, 0);
      const cur = await settle(),
        m = measure(prev, cur, recent);
      if (m < stillPx(cur)) {
        cur.bmp.close();
        if (++still >= WALL_STILLS) break;
        continue;
      }
      still = 0;
      s = m;
      recent.push(s);
      d.moved(plan.step, 0);
      const mid = Xc + s / 2;
      if (pend.B === null) {
        pend.B = Xc - s / 2;
        row.origin = pend.B;
      }
      cut(row, pend.pic, pend.Xc, pend.B, mid, pend.step);
      pend.pic.bmp.close();
      pend = { pic: cur, Xc: Xc + s, B: mid, step: i };
      prev = cur;
      Xc += s;
      state.steps++;
      say(`Row ${r + 1} of ${plan.rows.length}: ${row.strips.length} strips.`);
    }
    if (pend.B !== null)
      cut(row, pend.pic, pend.Xc, pend.B, Xc + s / 2, pend.step);
    pend.pic.bmp.close();
    row.tilt = tilt;
    d.update(state);
    return row;
  }
  // where the first picture of this row sits against the first picture of the row before
  async function align(row, ref) {
    const cur = row.firstGray;
    const c = lim.imageShift(ref.hi, cur.hi, 'tilt', {
      reach: 0.75,
      minOverlap: 0.25,
    });
    if (!c) return null;
    const r = refine(
      ref.full,
      cur.full,
      cur.w,
      cur.h,
      c.sx * cur.w,
      c.sy * cur.h,
      6,
      6,
      'y',
    );
    return { sx: r.sx, sy: r.sy };
  }
  let ref = null,
    master = { x: 0, y: 0 };
  for (const [r, tilt] of plan.rows.entries()) {
    if (over()) break;
    if (r === 0 && plan.panStart === null) await seekWall();
    else if (plan.panStart !== null) {
      say(`Row ${r + 1}: a fast trip to the start.`);
      await d.travel(plan.panStart - 40, tilt, r);
      if (over()) break;
      await seekWall();
    }
    if (over()) break;
    const row = await scanRow(r, tilt);
    if (r > 0 && row.firstGray) {
      const a = ref && (await align(row, ref));
      if (a) {
        master = { x: master.x + a.sx, y: master.y + a.sy };
        row.alignedBy = a;
      } else {
        row.misaligned = true;
        master = { x: master.x, y: master.y + row.h * 0.68 };
      }
    }
    ref = row.firstGray;
    row.ox = master.x + row.firstGray.w / 2 + (row.origin ?? 0);
    row.oy = master.y;
    d.update(state);
  }
  say(over() ? 'Strip scan stopped.' : 'Strip scan done.');
  return { rows: state.rows, steps: state.steps, cancelled: over() };
}

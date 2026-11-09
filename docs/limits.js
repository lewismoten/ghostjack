// Finding the neck's ends. The camera cannot say where its pan and tilt stops are, so the page finds them
// by looking: step toward one end in small steps (10 at speed 100, waiting for each to finish), compare
// small pictures, and when two steps in a row change the picture no more than the noise does, that end is
// reached. It only runs when the user presses "Find limits", and it can be cancelled. What it cannot see:
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
export const CAP_STEPS = 220; // most steps in one walk
export const CAP_MS = 20 * 60 * 1000; // most time for the whole search

// deps: { grab(): Promise<Uint8Array>, send(axis, dir): Promise<void> (one step of STEP), cancelled(): bool,
// progress(text, fraction), line(event), wait(ms) }. Resolves { pan, tilt } ranges in units (each
// { min, max }, centered on 0) or null if cancelled or capped. The camera ends at the center of each range.
export async function findLimits(deps) {
  const t0 = Date.now();
  const over = () => deps.cancelled() || Date.now() - t0 > CAP_MS;
  deps.progress('Calibrating the noise.', 0);
  const a = await deps.grab();
  await deps.wait(1200);
  const b = await deps.grab();
  const noise = diff(a, b);
  // Step one way until two steps in a row leave the picture the same. Returns the steps that moved.
  async function walk(axis, dir, label, from) {
    let prev = await deps.grab(),
      still = 0,
      moved = 0;
    for (let i = 0; i < CAP_STEPS && !over(); i++) {
      await deps.send(axis, dir);
      await deps.wait(STEP_MS);
      const cur = await deps.grab();
      if (same(diff(prev, cur), noise)) {
        if (++still >= 2) return moved;
      } else {
        moved += 1 + still;
        still = 0;
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
  let base = 0;
  for (const axis of ['pan', 'tilt']) {
    const name = axis === 'pan' ? 'Pan' : 'Tilt';
    deps.progress(`${name}: finding the first wall.`, base);
    if ((await walk(axis, -1, `${name} to the first wall`, base)) === null)
      return null;
    deps.line('wall');
    deps.progress(`${name}: crossing to the other wall.`, base + 0.25);
    const n = await walk(axis, 1, `${name} across`, base + 0.25);
    if (n === null || n < 2) return null;
    deps.progress(
      `${name}: ${n} steps across. Back to the middle.`,
      base + 0.45,
    );
    for (let i = 0; i < Math.floor(n / 2) && !over(); i++) {
      await deps.send(axis, -1);
      await deps.wait(STEP_MS);
    }
    if (over()) return null;
    const half = (n * STEP) / 2;
    out[axis] = { min: -half, max: half };
    base += 0.5;
  }
  deps.progress('Done.', 1);
  return out;
}

// End-to-end check of Strip scan against tools/fake-room.mjs (never the real camera or the bridge on 8787):
// headless Chromium (Playwright's bundled one) opens the page with all non-local requests blocked, opens the
// sphere view, presses Strip scan > Start for one row (the fake has no limits yet, so the page finds the left
// wall by small steps, then scans to the right wall), and checks the finished panorama: its width against
// the pan travel (a flat picture is 640 / (2 tan(fov/2)) px per radian at its center, so that is the
// expectation; the plain travel / fov x width figure is printed too), that each landmark of the synthetic
// room that is in the row appears once (no repeats), no page errors and no outside requests. Screenshots of
// the live view and the finished one at 1440 and 390 wide go into the folder given as the first argument
// (default captures/strip-test, git-ignored; delete it after looking). Needs ffmpeg with v360.
// Run: node tools/strip-scan-test.mjs <outdir> [--rows [--quick]]   (--quick skips the Find limits part)
// --rows first runs Find limits and checks its range and lens against the fake's truth (3 still steps = a wall),
// then scans with Rows on (a bottom wall, rows stepped up by measured shifts, a top wall) and checks that the rows
// line up: height and width near the expected, each landmark once, and the landmarks in the right vertical order.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeRoom, TRUE } from './fake-room.mjs';

const rows = process.argv.includes('--rows');
const out =
  process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ||
  'captures/strip-test';
mkdirSync(out, { recursive: true });
const room = await startFakeRoom({ fast: true });
const url = `http://127.0.0.1:${room.port}/`;
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const blocked = [],
  fails = [],
  errors = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) fails.push(msg);
};
const clickBtn = (page, sel, text) =>
  page.evaluate(
    ([s, t]) =>
      [...document.querySelectorAll(s)]
        .find((b) => b.textContent === t)
        .click(),
    [sel, text],
  );
// count blobs of each landmark color in the panorama canvas (in the page)
const countLandmarks = () => {
  const c = globalThis.gjStrip();
  if (!c) return null;
  const d = c
    .getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, c.width, c.height).data;
  const cols = {
    magenta: [200, 60, 220],
    cyan: [30, 210, 210],
    blue: [50, 90, 240],
    green: [40, 200, 70],
    red: [230, 40, 40],
    yellow: [240, 220, 40],
    orange: [240, 120, 20],
  };
  const CELL = 8,
    cw = Math.ceil(c.width / CELL),
    ch = Math.ceil(c.height / CELL),
    found = {},
    cy = {};
  for (const [name, col] of Object.entries(cols)) {
    const cnt = new Uint16Array(cw * ch);
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (
          Math.abs(d[i] - col[0]) < 22 &&
          Math.abs(d[i + 1] - col[1]) < 22 &&
          Math.abs(d[i + 2] - col[2]) < 22
        )
          cnt[((y / CELL) | 0) * cw + ((x / CELL) | 0)]++;
      }
    const on = (i) => cnt[i] >= 50,
      seen = new Set();
    let blobs = 0;
    for (let i = 0; i < cnt.length; i++) {
      if (!on(i) || seen.has(i)) continue;
      let size = 0;
      const q = [i];
      seen.add(i);
      while (q.length) {
        const k = q.pop();
        size++;
        const kx = k % cw,
          ky = (k / cw) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = kx + dx,
              ny = ky + dy,
              n = ny * cw + nx;
            if (
              nx < 0 ||
              ny < 0 ||
              nx >= cw ||
              ny >= ch ||
              seen.has(n) ||
              !on(n)
            )
              continue;
            seen.add(n);
            q.push(n);
          }
      }
      if (size >= 20) blobs++;
    }
    found[name] = blobs;
    let sy = 0,
      sn = 0;
    for (let i = 0; i < cnt.length; i++)
      if (cnt[i] >= 50) {
        sy += ((i / cw) | 0) * cnt[i];
        sn += cnt[i];
      }
    cy[name] = sn ? (sy / sn) * CELL : null;
  }
  return { w: c.width, h: c.height, found, cy };
};
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (
      u.hostname === '127.0.0.1' ||
      u.protocol === 'data:' ||
      u.protocol === 'blob:'
    )
      return r.continue();
    blocked.push(u.href);
    return r.abort();
  });
  await ctx.addInitScript(
    ([u]) => {
      localStorage.setItem('bridge', u.replace(/\/$/, ''));
      localStorage.setItem('token', 'fake');
      localStorage.setItem('gm-theme', 'dark');
    },
    [url],
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => !document.getElementById('limitsGo').disabled,
    null,
    { timeout: 20000 },
  );
  if (rows && !process.argv.includes('--quick')) {
    // Find limits first: range and lens from real travel, against the fake's truth
    await page.evaluate(() => {
      document.getElementById('limitsSweep').checked = false;
    });
    await page.evaluate(() => document.getElementById('tab-rig')?.click());
    await page.evaluate(() => document.getElementById('limitsGo').click());
    await page.waitForFunction(
      () =>
        /Lens about/.test(document.getElementById('limitsInfo').textContent),
      null,
      { timeout: 15 * 60 * 1000, polling: 1000 },
    );
    const info = await page.evaluate(
      () => document.getElementById('limitsInfo').textContent,
    );
    console.log(info);
    await page.waitForTimeout(1500);
    const m = /pan (\d+) steps.*tilt (\d+) steps/.exec(info),
      aim = room.aim(),
      near = (v, t, tol) => Math.abs(v - t) / t <= tol;
    check(
      !!m && near(+m[1], TRUE.panUnits / 10, 0.1),
      `Find limits pan ${m?.[1]} steps vs true ${TRUE.panUnits / 10} (10%)`,
    );
    check(
      !!m && near(+m[2], TRUE.tiltUnits / 10, 0.1),
      `Find limits tilt ${m?.[2]} steps vs true ${TRUE.tiltUnits / 10} (10%)`,
    );
    check(near(aim.fovH, TRUE.fovH, 0.1), `fovH ${aim.fovH} vs ${TRUE.fovH}`);
    check(
      near(aim.fovV, TRUE.fovV, 0.1),
      `fovV ${aim.fovV} vs ${TRUE.fovV.toFixed(1)}`,
    );
    // the camera is back in the middle; the scan must find its own walls
  }
  if (!rows || process.argv.includes('--quick')) {
    await page.evaluate(() => document.getElementById('keySphere').click());
    await page.waitForTimeout(1500);
  }
  await clickBtn(page, '.spherebar button', 'Strip scan');
  await page.waitForSelector('.stripview', {
    state: 'visible',
    timeout: 10000,
  });
  check(
    await page.evaluate(() => !document.querySelector('.stripview').hidden),
    'Strip scan opens its view',
  );
  if (rows) {
    await page.evaluate(() => {
      const l = [...document.querySelectorAll('.stripbar label')].find((x) =>
        x.textContent.includes('Rows'),
      );
      l.querySelector('input').click();
      const sel = document.querySelector('.stripbar select');
      sel.value = '10';
      sel.dispatchEvent(new Event('change'));
    });
  }
  await clickBtn(page, '.stripbar button', 'Start');
  const t0 = Date.now();
  await page.waitForTimeout(25000);
  await page.screenshot({ path: join(out, 'live-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth - innerWidth,
  );
  check(scroll <= 0, `no horizontal scroll at 390 (${scroll})`);
  await page.locator('#stage').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'live-390.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(
    () =>
      /Strip scan (done|stopped|failed)/.test(
        document.querySelector('.stripnote')?.textContent,
      ),
    null,
    { timeout: 45 * 60 * 1000, polling: 1000 },
  );
  console.log(
    `scan took about ${Math.round((Date.now() - t0) / 1000)} s (fast waits)`,
  );
  console.log(
    await page.evaluate(() => document.querySelector('.stripnote').textContent),
  );
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'done-1440.png') });
  const stats = await page.evaluate(countLandmarks);
  check(!!stats, 'a panorama exists');
  if (stats) {
    const k =
        (640 / (2 * Math.tan((TRUE.fovH * Math.PI) / 360))) * (Math.PI / 180),
      expect = TRUE.panDegrees * k,
      plain = (TRUE.panDegrees / TRUE.fovH) * 640;
    console.log(
      `panorama ${stats.w} x ${stats.h}; expected ${Math.round(expect)} (flat-picture center scale), plain travel/fov*width ${Math.round(plain)}; landmarks`,
      JSON.stringify(stats.found),
    );
    check(
      Math.abs(stats.w - expect) / expect < 0.1,
      `width ${stats.w} within 10% of ${Math.round(expect)}`,
    );
    if (rows) {
      // rows: height from the tilt travel (the bottom wall to the top wall plus one picture), landmarks in order
      const kv =
          (360 / (2 * Math.tan((TRUE.fovV * Math.PI) / 360))) * (Math.PI / 180),
        eh = (TRUE.tiltUnits * TRUE.tiltDegPerUnit + TRUE.fovV) * kv;
      console.log(`height ${stats.h}, expected about ${Math.round(eh)}`);
      check(
        Math.abs(stats.h - eh) / eh < 0.15,
        `height ${stats.h} within 15% of ${Math.round(eh)} (bottom and top walls found)`,
      );
      const lat = {
          orange: 35,
          green: 10,
          red: 0,
          blue: -10,
          cyan: -25,
          magenta: -30,
        },
        got = Object.keys(lat).filter((c) => stats.cy[c] !== null);
      check(got.length >= 5, `${got.length} of 6 landmarks found`);
      const byY = [...got].sort((a, b) => stats.cy[a] - stats.cy[b]),
        byLat = [...got].sort((a, b) => lat[b] - lat[a]);
      check(
        byY.join() === byLat.join(),
        `landmarks top to bottom ${byY.join(' ')} (expected ${byLat.join(' ')})`,
      );
    }
    const total = Object.values(stats.found).reduce((a, b) => a + b, 0);
    check(
      total >= (rows ? 5 : 2) &&
        Object.values(stats.found).every((n) => n <= 1),
      `each landmark in the row appears at most once, ${total} found`,
    );
  }
  const dl = page.waitForEvent('download');
  await clickBtn(page, '.stripbar button', 'Download panorama');
  const d = await dl;
  await d.saveAs(join(out, d.suggestedFilename()));
  check(
    /^ghostjack-strips-\d{8}-\d{6}\.jpg$/.test(d.suggestedFilename()),
    `download named ${d.suggestedFilename()}`,
  );
  await page.keyboard.press('Escape');
  check(
    await page.evaluate(() => document.querySelector('.stripview').hidden),
    'Escape closes the strip view',
  );
  check(
    blocked.length === 0,
    `no outside requests (${blocked.slice(0, 3).join(', ')})`,
  );
  check(
    errors.length === 0,
    `no page errors (${errors.slice(0, 2).join(' | ')})`,
  );
} finally {
  await browser.close();
  await room.close();
}
process.exit(fails.length ? 1 : 0);

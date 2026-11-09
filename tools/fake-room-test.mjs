// End-to-end check of the photo sphere against tools/fake-room.mjs (never the real camera or the bridge on
// 8787): headless Chromium (Playwright's bundled one) opens the page with all non-local requests blocked,
// runs Find limits, checks the measured lens against the fake's truth, runs Sweep, downloads a panorama and
// screenshots the sphere view (1440 and 390 wide, dark and light) into the folder given as the first
// argument (default captures/sphere-test, git-ignored; delete it after looking). Needs ffmpeg with v360.
// Run: node tools/fake-room-test.mjs <outdir> [--slow]   (--slow waits the real 1.3 s per step)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeRoom, TRUE } from './fake-room.mjs';

const out = process.argv[2] || 'captures/sphere-test';
mkdirSync(out, { recursive: true });
const room = await startFakeRoom({ fast: !process.argv.includes('--slow') });
const url = `http://127.0.0.1:${room.port}/`;
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const blocked = [];
const fails = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) fails.push(msg);
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => !document.getElementById('limitsGo').disabled,
    null,
    { timeout: 20000 },
  );
  await page.evaluate(() => document.getElementById('tab-rig')?.click());
  // Find limits, watching the sphere assemble
  await page.evaluate(() => document.getElementById('limitsGo').click());
  await page.waitForTimeout(25000);
  await page.screenshot({ path: join(out, 'find-limits-midway.png') });
  await page.waitForFunction(
    () => /Lens about/.test(document.getElementById('limitsInfo').textContent),
    null,
    {
      timeout: 8 * 60 * 1000,
      polling: 1000,
    },
  );
  const info = await page.evaluate(
    () => document.getElementById('limitsInfo').textContent,
  );
  console.log(info);
  await page.waitForTimeout(1500);
  const aim = room.aim();
  console.log('bridge aim:', JSON.stringify(aim));
  const within = (v, t, tol) => Math.abs(v - t) / t <= tol;
  check(
    within(aim.fovH, TRUE.fovH, 0.1),
    `fovH ${aim.fovH} vs true ${TRUE.fovH} (10%)`,
  );
  check(
    within(aim.fovV, TRUE.fovV, 0.1),
    `fovV ${aim.fovV} vs true ${TRUE.fovV.toFixed(2)} (10%)`,
  );
  check(
    within(aim.tiltDegPerUnit, TRUE.tiltDegPerUnit, 0.15),
    `tiltDegPerUnit ${aim.tiltDegPerUnit} vs true ${TRUE.tiltDegPerUnit} (15%)`,
  );
  await page.screenshot({ path: join(out, 'find-limits-done-1440-dark.png') });
  // Sweep
  await page.evaluate(() =>
    [...document.querySelectorAll('.spherebar button')][0].click(),
  );
  await page.waitForFunction(
    () => /Sweep done/.test(document.querySelector('.spherenote')?.textContent),
    null,
    {
      timeout: 12 * 60 * 1000,
      polling: 1000,
    },
  );
  console.log(
    await page.evaluate(() => document.getElementById('status').textContent),
  );
  // download the panorama
  const dl = page.waitForEvent('download');
  await page.evaluate(() =>
    [...document.querySelectorAll('.spherebar button')][1].click(),
  );
  const d = await dl;
  await d.saveAs(join(out, d.suggestedFilename()));
  check(
    /^ghostjack-panorama-\d{8}-\d{6}\.jpg$/.test(d.suggestedFilename()),
    `download named ${d.suggestedFilename()}`,
  );
  const dl2 = page.waitForEvent('download');
  await page.evaluate(() =>
    [...document.querySelectorAll('.spherebar button')][2].click(),
  );
  await (await dl2).saveAs(join(out, 'full-360.jpg'));
  // look around: pitch the view a little toward the middle of the range, then shoot four themes/sizes
  for (const [w, h, theme] of [
    [1440, 900, 'dark'],
    [1440, 900, 'light'],
    [390, 844, 'dark'],
    [390, 844, 'light'],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(
      (t) =>
        document.getElementById('theme').getAttribute('aria-pressed') !==
          String(t === 'light') && document.getElementById('theme').click(),
      theme,
    );
    await page.waitForTimeout(800);
    const scroll = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    check(scroll <= 0, `no horizontal scroll at ${w} ${theme} (${scroll})`);
    await page.locator('#stage').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `sphere-${w}-${theme}.png`) });
  }
  // Escape closes
  await page.keyboard.press('Escape');
  check(
    await page.evaluate(() => document.querySelector('.sphereview').hidden),
    'Escape closes the sphere view',
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

// Ghost Jack tool.
// Signs in to the camera's own web page in a headless browser and records the requests the page
// makes afterwards (login, snapshot, stream setup), so the local API can be learned from the
// camera's real web app instead of reimplementing its key exchange.
//
// The device id and password come from the macOS Keychain item "tethys-camera"
// (security add-generic-password -s tethys-camera -a <device id> -w). Neither is printed or saved.
// Request values (session ids, tokens) go only to the output directory you pass; never commit it.
//
// Usage: PLAYWRIGHT=<path to playwright-core/index.mjs> node tools/web-login-probe.mjs <out dir> [camera ip]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
const ip = process.argv[3] || '192.168.187.254';
if (!out || !process.env.PLAYWRIGHT) {
  console.error(
    'usage: PLAYWRIGHT=<playwright-core/index.mjs> node tools/web-login-probe.mjs <out dir> [ip]',
  );
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const item = execFileSync(
  'security',
  ['find-generic-password', '-s', 'tethys-camera'],
  { encoding: 'utf8' },
);
const user = (item.match(/"acct"<blob>="([^"]*)"/) || [])[1];
const pass = execFileSync(
  'security',
  ['find-generic-password', '-s', 'tethys-camera', '-w'],
  { encoding: 'utf8' },
).trim();
if (!user || !pass)
  throw new Error(
    'Keychain item tethys-camera is missing its account or password',
  );

const { chromium } = await import(process.env.PLAYWRIGHT);
const browser = await chromium.launch();
const log = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  page.on('request', (r) =>
    log.push({ t: Date.now(), method: r.method(), url: r.url() }),
  );
  page.on('response', (r) => {
    const e = log.findLast((x) => x.url === r.url() && x.status === undefined);
    if (e) {
      e.status = r.status();
      e.type = r.headers()['content-type'] || '';
    }
  });
  await page.goto(`http://${ip}/`, { waitUntil: 'networkidle' });
  // The page fills in and locks the user name (the device id) itself on a direct connection.
  await page.waitForTimeout(1500);
  if (await page.isEnabled('#signin_name'))
    await page.fill('#signin_name', user);
  await page.click('#signin_show_pw');
  await page.fill('#signin_pw', pass);
  await page.click('#sign_in');
  await page.waitForTimeout(12000);
  await page.screenshot({ path: join(out, 'after-login.png') });
  writeFileSync(join(out, 'requests.json'), JSON.stringify(log, null, 1));
  writeFileSync(
    join(out, 'page-text.txt'),
    (await page.innerText('body')).replace(/\s+/g, ' '),
  );
  // Summary without values: path and parameter names only.
  const seen = new Map();
  for (const e of log) {
    const u = new URL(e.url);
    const key = `${e.method} ${u.pathname} ?${[...u.searchParams.keys()].join('&')} -> ${e.status ?? '?'} ${e.type ?? ''}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [k, n] of seen) console.log(`${n}x ${k}`);
} finally {
  await browser.close();
}

// Ghost Jack tool.
// Saves one JPEG snapshot from the camera over the local network: no cloud, no app.
// It signs in through the camera's own web page in a headless browser (so the page's key exchange
// and session math are reused), then sends ccm_snapshot with profile p0 and downloads the picture.
//
// Credentials: macOS Keychain item "tethys-camera" (account = device id, password = camera password):
//   security add-generic-password -s tethys-camera -a <device id> -w
// Nothing secret is printed or written.
//
// Usage: PLAYWRIGHT=<path to playwright-core/index.mjs> node tools/snapshot.mjs <out.jpg> [camera ip] [profile]
/* global acs, g_ref, window -- these run inside the camera's own web page (page.evaluate), where the page defines them */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const outFile = process.argv[2];
const ip = process.argv[3] || '192.168.187.254';
const profile = process.argv[4] || 'p0'; // p0 = main stream (1920x1080 seen), p1 = sub stream
if (!outFile || !process.env.PLAYWRIGHT) {
  console.error(
    'usage: PLAYWRIGHT=<playwright-core/index.mjs> node tools/snapshot.mjs <out.jpg> [ip] [profile]',
  );
  process.exit(2);
}
const item = execFileSync(
  'security',
  ['find-generic-password', '-s', 'tethys-camera'],
  { encoding: 'utf8' },
);
const deviceId = (item.match(/"acct"<blob>="([^"]*)"/) || [])[1];
const pass = execFileSync(
  'security',
  ['find-generic-password', '-s', 'tethys-camera', '-w'],
  { encoding: 'utf8' },
).trim();
if (!deviceId || !pass)
  throw new Error(
    'Keychain item tethys-camera needs an account (device id) and a password',
  );

const { chromium } = await import(process.env.PLAYWRIGHT);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://${ip}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // the page fills in and locks the device id itself
  if (await page.isEnabled('#signin_name'))
    await page.fill('#signin_name', deviceId);
  await page.click('#signin_show_pw');
  await page.fill('#signin_pw', pass);
  await page.click('#sign_in');
  await page
    .waitForFunction(
      () => window.acs && acs.ctrl && acs.ctrl({ type: 'get_info' }).sid,
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1500);

  // ccm_snapshot replies with { ret, uri: { url }, token }; ret.code "" means success. The bare uri.url
  // returns a short error; the picture must be fetched with the session attached, as the web app does.
  const reply = await page.evaluate(
    ([sn, token]) =>
      new Promise((resolve) => {
        const nid = () => acs.create_nid(acs.ctrl({ type: 'get_info' }));
        acs.send_msg(
          'ccm_snapshot',
          { sess: { nid: nid(), sn }, token },
          (_a, msg) => {
            if (!msg || !msg.token || (msg.ret && msg.ret.code))
              return resolve({
                error:
                  msg && msg.ret ? msg.ret.reason || msg.ret.code : 'no token',
              });
            resolve({
              url: `http://${g_ref.server_device}/ccm/ccm_pic_get.jpg?hfrom_handle=887330&dsess=1&dsess_nid=${nid()}&dsess_sn=${sn}&dtoken=${msg.token}`,
            });
          },
          { ip: g_ref.server_device, to: 'ccm' },
        );
        setTimeout(() => resolve({ error: 'no reply' }), 10000);
      }),
    [deviceId, profile],
  );
  if (!reply.url) throw new Error(`snapshot refused: ${reply.error}`);
  const res = await page.request.get(reply.url);
  const body = await res.body();
  if (res.status() !== 200 || body.length < 1000)
    throw new Error(
      `picture download failed: HTTP ${res.status()}, ${body.length} bytes`,
    );
  writeFileSync(outFile, body);
  console.log(
    `saved ${outFile} (${body.length} bytes, ${res.headers()['content-type']})`,
  );
} finally {
  await browser.close();
}

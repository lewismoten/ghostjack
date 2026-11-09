// Offline self-test for the agent endpoints (goto, snapshot width, clip, listen, play, ask).
// Starts the bridge on a private port with a fake camera (tools/fake-camera.mjs), a throwaway HOME for
// the token, aim and shots, and a fake whisper-cli, so it never touches the real camera or the owner's
// bridge. Generated media lives in captures/ (git-ignored) and is deleted at the end.
// Run: node tools/agent-api-selftest.mjs
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAP = join(ROOT, 'captures');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const PORT = 18790; // never the real bridge's 8787
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(CAP, { recursive: true });
const home = mkdtempSync(join(CAP, 'selftest-home-'));
const whisper = join(home, 'whisper');
writeFileSync(whisper, '#!/bin/sh\necho "$GJ_FAKE_HEARD"\n');
chmodSync(whisper, 0o755);
writeFileSync(join(home, 'model.bin'), 'x');

let failed = 0;
const ok = (cond, name, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${extra}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', [join(ROOT, 'src', 'server.mjs')], {
  env: {
    ...process.env,
    HOME: home,
    PORT: String(PORT),
    GJ_FAKE_CAMERA: join(ROOT, 'tools', 'fake-camera.mjs'),
    GJ_SAY_PACE: 'fast',
    GJ_WHISPER: whisper,
    GJ_WHISPER_MODEL: join(home, 'model.bin'),
    GJ_FAKE_HEARD: 'bee',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const probe = (file, entries) =>
  JSON.parse(
    execFileSync(FFPROBE, [
      '-v',
      'error',
      '-show_entries',
      entries,
      '-of',
      'json',
      file,
    ]),
  );
// JPEG width and height from its SOF marker.
function jpegSize(b) {
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3)
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
let token = '';
const api = async (method, path, body, headers = {}) => {
  const raw = Buffer.isBuffer(body);
  const r = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  return r;
};
const jsonOf = async (r) => r.json();
const tmp = (name) => join(home, name);
const gen = (name, ...args) => {
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...args,
    tmp(name),
  ]);
  return readFileSync(tmp(name));
};
async function waitStatus(path, done) {
  for (let i = 0; i < 120; i++) {
    const j = await jsonOf(await api('GET', path));
    if (done(j)) return j;
    await sleep(250);
  }
  return null;
}

try {
  for (let i = 0; i < 100 && !/bridge on/.test(log); i++) await sleep(100);
  if (!/bridge on/.test(log)) throw new Error(`bridge did not start: ${log}`);
  token = readFileSync(
    join(home, '.config', 'ghostjack', 'token'),
    'utf8',
  ).trim();

  // transcript mapping (pure function)
  process.env.GJ_FAKE_CAMERA = join(ROOT, 'tools', 'fake-camera.mjs');
  const { mapAnswer, promptText } = await import('../src/ask.mjs');
  const ch = ['Pretzels', 'Apples', 'Nothing'];
  const want = [
    ['A.', 'a'],
    ['Bee!', 'b'],
    ['see', 'c'],
    ['say dee', 'other'] /* only three choices */,
    ['apples', 'b'],
    ['I would like pretzels', 'a'],
    ['pizza please', 'other'],
    ['', null],
  ];
  for (const [t, c] of want)
    ok(
      mapAnswer(t, ch, true) === c,
      `maps "${t}" to ${c}`,
      String(mapAnswer(t, ch, true)),
    );
  ok(mapAnswer('pizza please', ch, false) === null, 'no other: null');
  ok(
    /Say ay for Pretzels, Say bee/.test(promptText('Snack?', ch, true)),
    'prompt text',
  );

  // auth
  const un = await fetch(`${BASE}/api/aim`);
  ok(un.status === 401, 'no token is refused');

  // snapshot width
  let b = Buffer.from(
    await (await api('GET', '/api/snapshot.jpg?width=320')).arrayBuffer(),
  );
  ok(jpegSize(b)?.[0] === 320, 'snapshot width=320', String(jpegSize(b)));
  b = Buffer.from(await (await api('GET', '/api/snapshot.jpg')).arrayBuffer());
  ok(jpegSize(b)?.[0] === 1920, 'snapshot untouched without width');
  b = Buffer.from(
    await (
      await api('GET', '/api/snapshot.jpg?crop=0.5,0.5,0.5,0.5')
    ).arrayBuffer(),
  );
  ok(jpegSize(b)?.[0] === 1280, 'crop alone still scales to 1280');

  // picture settings
  let r = await api('POST', '/api/picture', { wdr: 'off', sharpness: 4 });
  const pic = await jsonOf(r);
  ok(
    r.status === 200 && pic.wdr === 'Off' && pic.sharpness === 4,
    'picture sets wdr and sharpness',
    JSON.stringify(pic),
  );
  r = await api('POST', '/api/picture', { backlight: 'maybe' });
  ok(r.status === 400, 'picture rejects a bad on/off');
  r = await api('POST', '/api/picture', {});
  ok(r.status === 400, 'picture needs a field');
  r = await api('POST', '/api/image', { wdr: true, sharpness: 6 });
  ok((await jsonOf(r)).wdr === 'On', 'image still works and restores');
  r = await api('GET', '/api/picture');
  ok(r.status === 200 && (await jsonOf(r)).powerFreq === 1, 'picture reads');

  // goto
  r = await api('POST', '/api/goto', { pan: 50, tilt: -30, width: 400 });
  b = Buffer.from(await r.arrayBuffer());
  ok(
    r.status === 200 && r.headers.get('x-gj-pan') === '50',
    'goto pan header',
    String(r.status),
  );
  ok(r.headers.get('x-gj-tilt') === '-30', 'goto tilt header');
  ok(r.headers.get('x-gj-settled') === '1', 'goto settled');
  ok(jpegSize(b)?.[0] === 400, 'goto width');
  let aim = await jsonOf(await api('GET', '/api/aim'));
  ok(
    aim.pan === 50 && aim.tilt === -30,
    'aim.json updated',
    JSON.stringify(aim),
  );
  await api('POST', '/api/aim', {
    ...aim,
    panMin: -100,
    panMax: 100,
    tiltMin: -60,
    tiltMax: 60,
  });
  await sleep(1100); // one move a second
  r = await api('POST', '/api/goto', {
    pan: 900,
    tilt: 0,
    crop: [0, 0, 0.5, 0.5],
  });
  await r.arrayBuffer();
  ok(
    r.headers.get('x-gj-pan') === '100',
    'goto clamps to the range',
    r.status + ' ' + r.headers.get('x-gj-pan'),
  );
  r = await api('POST', '/api/goto', { pan: 0, tilt: 0 });
  await r.arrayBuffer();
  ok(
    r.status === 429,
    'goto inside a second of the last move is 429',
    String(r.status),
  );
  r = await api('POST', '/api/goto', { pan: 'x', tilt: 0 });
  ok(r.status === 400, 'goto bad numbers 400');
  await api('POST', '/api/shots', [
    { name: 'Desk', pan: -20, tilt: 10, crop: [0, 0, 0.5, 0.5] },
    null,
  ]);
  await sleep(1100);
  r = await api('POST', '/api/goto', { shot: 1, width: 200 });
  b = Buffer.from(await r.arrayBuffer());
  ok(
    r.headers.get('x-gj-pan') === '-20' && jpegSize(b)?.[0] === 200,
    'goto saved shot',
  );
  r = await api('POST', '/api/goto', { shot: 2 });
  ok(r.status === 404, 'goto empty shot 404');

  // clip and listen
  r = await api('POST', '/api/clip', { seconds: 2, width: 320, audio: true });
  writeFileSync(tmp('c.mp4'), Buffer.from(await r.arrayBuffer()));
  let pr = probe(tmp('c.mp4'), 'stream=codec_name,width');
  ok(
    r.status === 200 && r.headers.get('content-type') === 'video/mp4',
    'clip 200',
  );
  ok(
    pr.streams.some((s) => s.codec_name === 'h264' && s.width === 320) &&
      pr.streams.some((s) => s.codec_name === 'aac'),
    'clip scaled h264 with aac',
    JSON.stringify(pr),
  );
  r = await api('POST', '/api/clip', { seconds: 2, width: 1920 });
  writeFileSync(tmp('c2.mp4'), Buffer.from(await r.arrayBuffer()));
  pr = probe(tmp('c2.mp4'), 'stream=codec_name,width');
  ok(
    pr.streams.length === 1 && pr.streams[0].width === 1920,
    'clip 1920 copies, no audio by default',
    JSON.stringify(pr),
  );
  const two = await Promise.all([
    api('POST', '/api/clip', { seconds: 8, width: 640 }),
    sleep(60).then(() => api('POST', '/api/listen', { seconds: 1 })),
  ]);
  await Promise.all(two.map((x) => x.arrayBuffer()));
  ok(
    two[0].status === 200 && two[1].status === 409,
    'one capture at a time (409)',
    `${two[0].status} ${two[1].status}`,
  );
  r = await api('POST', '/api/clip', { seconds: 99 });
  ok(r.status === 400, 'clip seconds capped');
  r = await api('POST', '/api/listen', { seconds: 2 });
  writeFileSync(tmp('l.wav'), Buffer.from(await r.arrayBuffer()));
  pr = probe(tmp('l.wav'), 'stream=codec_name,sample_rate,channels');
  ok(
    r.status === 200 &&
      pr.streams[0].sample_rate === '16000' &&
      pr.streams[0].channels === 1,
    'listen wav 16k mono',
    JSON.stringify(pr),
  );
  r = await api('POST', '/api/listen', { seconds: 1, format: 'm4a' });
  writeFileSync(tmp('l.m4a'), Buffer.from(await r.arrayBuffer()));
  pr = probe(tmp('l.m4a'), 'stream=codec_name,codec_type');
  ok(
    r.status === 200 &&
      pr.streams.length === 1 &&
      pr.streams[0].codec_type === 'audio',
    'listen m4a audio only',
    JSON.stringify(pr),
  );

  // play
  const sine = gen('s.wav', '-f', 'lavfi', '-i', 'sine=f=600:d=2');
  r = await api('POST', '/api/play?level=1&chime=0', sine, {
    'Content-Type': 'audio/wav',
  });
  const pj = await jsonOf(r);
  ok(
    r.status === 202 && pj.level === 0.05 && pj.chimeLevel === null,
    'play queued, level capped',
    JSON.stringify(pj),
  );
  const st = await waitStatus(`/api/say/${pj.id}`, (j) =>
    ['done', 'failed'].includes(j.status),
  );
  ok(st?.status === 'done', 'play done', JSON.stringify(st));
  const mix = join(CAP, 'fake-talk-1.flv');
  ok(existsSync(mix), 'play published to the talk address');
  if (existsSync(mix)) {
    const e = spawnSync(
      FFMPEG,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        mix,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ],
      { encoding: 'utf8' },
    ).stderr;
    const peak = Number(/max_volume: (-?[\d.]+) dB/.exec(e)?.[1]);
    ok(peak < -25, `play peak held under the cap (${peak} dB)`);
  }
  r = await api('POST', '/api/play', sine, { 'Content-Type': 'text/plain' });
  ok(r.status === 415, 'play wrong type 415');
  r = await api('POST', '/api/play', Buffer.alloc(2 * 1024 * 1024 + 10), {
    'Content-Type': 'audio/wav',
  });
  ok(r.status === 413, 'play over 2 MB 413', String(r.status));
  const longWav = gen(
    'long.wav',
    '-f',
    'lavfi',
    '-i',
    'sine=f=300:d=40',
    '-ar',
    '8000',
    '-ac',
    '1',
  );
  r = await api('POST', '/api/play', longWav, { 'Content-Type': 'audio/wav' });
  ok(r.status === 400, 'play over 30 s 400', String(r.status));
  r = await api('POST', '/api/play', Buffer.from('not audio at all'), {
    'Content-Type': 'audio/wav',
  });
  ok(r.status === 400, 'play garbage 400', String(r.status));

  // ask by voice
  const q = {
    question: 'Which snack?',
    choices: ['Pretzels', 'Apples', 'Nothing'],
    listen: 1,
  };
  r = await api('POST', '/api/ask', q);
  let a = await jsonOf(r);
  ok(
    r.status === 202 && a.status === 'asking',
    'ask accepted',
    JSON.stringify(a),
  );
  const pend = await jsonOf(await api('GET', '/api/ask/pending'));
  ok(pend.id === a.id && pend.choices.length === 3, 'ask pending lists it');
  r = await api('POST', '/api/ask', q);
  ok(r.status === 409, 'second ask 409');
  a = await waitStatus(
    `/api/ask/${a.id}`,
    (j) => !['asking', 'listening'].includes(j.status),
  );
  ok(
    a?.status === 'answered' && a.choice === 'b' && a.transcript === 'bee',
    'ask heard "bee" as b',
    JSON.stringify(a),
  );
  // by choice text, with other
  r = await api('POST', '/api/ask', { ...q, other: true });
  a = await jsonOf(r);
  a = await waitStatus(
    `/api/ask/${a.id}`,
    (j) => !['asking', 'listening'].includes(j.status),
  );
  ok(a?.choice === 'b', 'repeat ask works', JSON.stringify(a));
  // by button, while asking
  r = await api('POST', '/api/ask', { ...q, other: true, listen: 5 });
  a = await jsonOf(r);
  r = await api('POST', `/api/ask/${a.id}/answer`, { choice: 'c' });
  const ans = await jsonOf(r);
  ok(
    r.status === 200 && ans.choice === 'c' && ans.source === 'button',
    'ask button answer',
    JSON.stringify(ans),
  );
  r = await api('POST', `/api/ask/${a.id}/answer`, { choice: 'a' });
  ok(r.status === 409, 'second answer 409');
  await sleep(2500); // the cancelled job winds down
  const fin = await jsonOf(await api('GET', `/api/ask/${a.id}`));
  ok(fin.choice === 'c', 'button answer stays', JSON.stringify(fin));
  r = await api('POST', '/api/ask', { question: 'x', choices: ['only one'] });
  ok(r.status === 400, 'ask needs 2 to 4 choices');
  const none = await jsonOf(await api('GET', '/api/ask/pending'));
  ok(none.id === null, 'nothing pending afterwards', JSON.stringify(none));
} catch (e) {
  failed++;
  console.log('FAIL', e.stack || e);
} finally {
  server.kill('SIGTERM');
  await sleep(300);
  server.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
  for (const f of readdirSync(CAP))
    if (/^(fake-|agent-|play-|say-)/.test(f))
      rmSync(join(CAP, f), { force: true });
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

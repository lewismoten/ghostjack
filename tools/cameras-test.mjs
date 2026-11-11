// Tests for the camera registry (node --test tools/cameras-test.mjs): parsing avfoundation's device
// list, the saved choices, capability checks and the per-device capture locks. Fake list text and a
// temp settings file only; no camera is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gj-cams-'));
const file = join(dir, 'cameras.local.json');
// a fake ffmpeg that only waits, so no real device is ever opened
writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\nexec sleep 30\n');
chmodSync(join(dir, 'ffmpeg'), 0o755);
process.env.FFMPEG = join(dir, 'ffmpeg');
process.env.GJ_CAMERAS_LOCAL = file;
const cameras = await import('../src/cameras.mjs');
const media = await import('../src/media.mjs');

const LIST = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] NexiGo N660P FHD Webcam
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] NexiGo N660P FHD Webcam Audio
[AVFoundation indev @ 0x1] [1] MacBook Pro Microphone
`;

test('parses video and audio devices by name, skipping screens', () => {
  const d = cameras.parseDevices(LIST);
  assert.deepEqual(
    d.map((e) => [e.id, e.capabilities]),
    [
      ['nexigo-n660p-fhd-webcam', ['video', 'mic']],
      ['macbook-pro-microphone', ['mic']],
    ],
  );
  assert.equal(d[0].device.audio, 'NexiGo N660P FHD Webcam Audio');
});

test('Glasseye is the default; choices are validated and saved 0600', async () => {
  cameras._reset({ lister: async () => LIST, file: false });
  let l = await cameras.list();
  assert.equal(l.active, 'glasseye');
  assert.equal(l.mic, 'glasseye');
  assert.equal(l.cameras[0].capabilities.includes('ptz'), true);
  await cameras.setActive('nexigo-n660p-fhd-webcam');
  await cameras.setMic('macbook-pro-microphone');
  await assert.rejects(cameras.setActive('macbook-pro-microphone'), {
    code: 400,
  });
  await assert.rejects(cameras.setMic('nope'), { code: 404 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).mic,
    'macbook-pro-microphone',
  );
  assert.equal(cameras.hasPtz(await cameras.pickVideo()), false);
  assert.equal(cameras.hasPtz(await cameras.pickVideo('glasseye')), true);
  l = await cameras.list();
  assert.equal(l.cameras.find((c) => c.active).id, 'nexigo-n660p-fhd-webcam');
  cameras._reset({ lister: async () => LIST, file: false });
});

test('a USB camera has its own capture lock, apart from Glasseye', async () => {
  cameras._reset({ lister: async () => LIST, file: false });
  await cameras.refresh(true);
  const cam = await cameras.pickVideo('nexigo-n660p-fhd-webcam');
  const mic = await cameras.pickMic('macbook-pro-microphone');
  const a = media.listenStream(mic);
  assert.throws(() => media.listenStream(mic), { code: 409 }); // same device
  const b = media.listenStream(cam); // the webcam's own mic
  b.cancel();
  a.cancel();
  const c = media.listenStream(mic); // freed again
  c.cancel();
});

const MODES = `[avfoundation @ 0x1] Selected framerate (1.000000) is not supported by the device.
[avfoundation @ 0x1] Supported modes:
[avfoundation @ 0x1]   640x360@[5.000000 5.000000]fps
[avfoundation @ 0x1]   640x480@[5.000000 5.000000]fps
[avfoundation @ 0x1]   640x480@[30.000000 30.000000]fps
[avfoundation @ 0x1]   1280x720@[30.000000 30.000000]fps
[avfoundation @ 0x1]   1280x720@[60.000000 60.000000]fps
[avfoundation @ 0x1]   1920x1080@[5.000000 5.000000]fps
[avfoundation @ 0x1]   1920x1080@[30.000000 30.000000]fps
[avfoundation @ 0x1]   1024x768@[30.000000 30.000000]fps
`;
const modeSetup = () => {
  const asked = [];
  cameras._reset({
    lister: async () => LIST,
    modeLister: async (n) => (asked.push(n), MODES),
    file: false,
  });
  return asked;
};

test('parses supported modes and picks the largest 16:9 at 30 fps', () => {
  const m = cameras.parseModes(MODES);
  assert.deepEqual(m.find((x) => x.size === '1920x1080').fps, [5, 30]);
  assert.deepEqual(cameras.defaultMode(m), { size: '1920x1080', fps: 30 });
  assert.equal(cameras.defaultMode([]), null);
});

test('list shows modes (cached per device) and the chosen mode', async () => {
  const asked = modeSetup();
  const nx = (await cameras.list()).cameras.find(
    (c) => c.id === 'nexigo-n660p-fhd-webcam',
  );
  assert.equal(nx.modes.length, 5);
  assert.deepEqual(nx.mode, { size: '1920x1080', fps: 30 });
  await cameras.list();
  assert.equal(asked.length, 1);
  await cameras.list(true);
  assert.equal(asked.length, 2);
});

test('setMode validates against the list, saves, and drives avfInput', async () => {
  modeSetup();
  await assert.rejects(
    cameras.setMode('nexigo-n660p-fhd-webcam', '800x600', 30),
    { code: 400 },
  );
  await assert.rejects(
    cameras.setMode('nexigo-n660p-fhd-webcam', '1280x720', 15),
    { code: 400 },
  );
  await assert.rejects(cameras.setMode('glasseye', '1280x720', 30), {
    code: 400,
  });
  await assert.rejects(cameras.setMode('nope', '1280x720', 30), { code: 404 });
  const r = await cameras.setMode('nexigo-n660p-fhd-webcam', '1280x720', 60);
  assert.deepEqual(
    r.cameras.find((c) => c.id === 'nexigo-n660p-fhd-webcam').mode,
    { size: '1280x720', fps: 60 },
  );
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')).modes['nexigo-n660p-fhd-webcam'],
    { size: '1280x720', fps: 60 },
  );
  const cam = await cameras.pickVideo('nexigo-n660p-fhd-webcam');
  const a = cameras.avfInput(cam, { video: true, size: '1920x1080' });
  assert.deepEqual(a.slice(2, 6), [
    '-framerate',
    '60',
    '-video_size',
    '1280x720',
  ]);
  assert.deepEqual(media.liveInput(cam).slice(2, 6), [
    '-framerate',
    '60',
    '-video_size',
    '1280x720',
  ]);
});

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

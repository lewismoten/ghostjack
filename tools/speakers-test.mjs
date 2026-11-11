// Tests for per-speaker setup (node --test tools/speakers-test.mjs): validation, persistence (mode 0600),
// the camera level deciding loudness, and the laptop gain reaching the player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gj-speakers-'));
process.env.GJ_SPEAKERS_LOCAL = join(dir, 'sub', 'speakers.local.json');
delete process.env.GJ_MAC_GAIN;
// a stand-in ffplay that records its arguments
const argsFile = join(dir, 'args.txt');
const fake = join(dir, 'ffplay');
writeFileSync(fake, `#!/bin/sh\necho "$@" > ${argsFile}\ncat > /dev/null\n`);
chmodSync(fake, 0o755);
process.env.FFPLAY = fake;
const sp = await import('../src/speakers.mjs');
const speech = await import('../src/say.mjs');

test('defaults, then save and read back with mode 0600', () => {
  assert.equal(sp.get().mac.gain, 14);
  assert.equal(sp.get().camera.level, null);
  sp.set({ camera: { level: 0.04 }, mac: { gain: 20 } });
  assert.equal(sp.cameraLevel(), 0.04);
  assert.equal(sp.macGain(), 20);
  assert.equal(statSync(sp.FILE()).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(sp.FILE(), 'utf8')).mac.gain, 20);
});

test('validation refuses bad values and unknown speakers', () => {
  assert.throws(() => sp.set({ camera: { level: 0.5 } }), { code: 400 });
  assert.throws(() => sp.set({ mac: { gain: 'loud' } }), { code: 400 });
  assert.throws(() => sp.set({ mac: { gain: 0 } }), { code: 400 });
  assert.throws(() => sp.set({ kitchen: {} }), { code: 400 });
  assert.equal(sp.macGain(), 20);
});

test('GJ_MAC_GAIN overrides the file; null clears the camera level', () => {
  process.env.GJ_MAC_GAIN = '9';
  assert.equal(sp.get().mac.gain, 9);
  assert.equal(sp.get().overrides.macGain, true);
  delete process.env.GJ_MAC_GAIN;
  sp.set({ camera: { level: null } });
  assert.equal(sp.cameraLevel(), null);
});

test('the laptop player is started with the saved gain', async () => {
  sp.set({ mac: { gain: 7 } });
  const s = speech.openStream({ output: 'mac', label: 'test' });
  s.add({ text: 'x', pcm: Buffer.alloc(3200) });
  s.end();
  for (let i = 0; i < 100 && !existsSync(argsFile); i++)
    await new Promise((r) => setTimeout(r, 50));
  speech.stopAll();
  assert.match(readFileSync(argsFile, 'utf8'), /volume=7/);
});

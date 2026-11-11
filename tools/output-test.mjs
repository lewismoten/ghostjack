// Tests for the speech output target (node --test tools/output-test.mjs): "mac" plays through a local player
// (a fake here) with no camera link, still counts as speaking, and stopAll cuts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as speech from '../src/say.mjs';

const fakePlayer = () => {
  const f = { writes: 0, bytes: 0, killed: false, ended: false, started: 0 };
  let done;
  const exited = new Promise((r) => (done = r));
  f.make = (onProgress) => {
    f.started++;
    setTimeout(() => onProgress(0, Date.now()), 5);
    return {
      canWrite: () => true,
      write: (b) => {
        f.writes++;
        f.bytes += b.length;
      },
      end: () => {
        f.ended = true;
        setTimeout(() => done(0), 5);
      },
      kill: () => {
        f.killed = true;
        done(-1);
      },
      exited,
    };
  };
  return f;
};

test('cleanOutput and resolveOutput', () => {
  assert.equal(speech.cleanOutput('mac'), 'mac');
  assert.equal(speech.cleanOutput('x'), null);
  speech.setOutputResolver(() => 'mac');
  assert.equal(speech.resolveOutput(), 'mac');
  assert.equal(speech.resolveOutput('camera'), 'camera');
  speech.setOutputResolver(() => undefined);
  assert.equal(speech.resolveOutput(), 'camera');
});

test('mac output: no camera link, speaking true, then cut by stopAll', async () => {
  let talk = 0;
  const orig = console.log;
  console.log = (m = '') => {
    if (String(m).includes('"ev":"talk"')) talk++;
  };
  const f = fakePlayer();
  speech.setMacPlayer(f.make);
  const pcm = Buffer.alloc(32000 * 3); // 3 s of silence
  const s = speech.openStream({ label: 'reply', output: 'mac' });
  s.add({ pcm, chime: false, band: false });
  assert.equal(speech.activity().speaking, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(talk, 0, 'no talk link for the laptop');
  assert.equal(f.started, 1);
  assert.ok(f.writes > 0);
  assert.equal(speech.activity().speaking, true);
  speech.stopAll();
  await new Promise((r) => setTimeout(r, 100));
  console.log = orig;
  assert.equal(f.killed, true);
  assert.equal(speech.activity().speaking, false);
  speech.setMacPlayer(null);
});

test('mac output ends cleanly when the stream finishes', async () => {
  const f = fakePlayer();
  speech.setMacPlayer(f.make);
  const r = speech.say({
    pcm: Buffer.alloc(3200),
    chime: false,
    band: false,
    output: 'mac',
  });
  await new Promise((r2) => setTimeout(r2, 1500));
  assert.equal(f.ended, true);
  assert.equal(speech.activity().speaking, false);
  assert.ok(r.id);
  speech.setMacPlayer(null);
});

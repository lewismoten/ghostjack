// Tests for the wake acknowledgment (node --test tools/wake-test.mjs): the wake word seen in partial text,
// one bleep per utterance, the wake-word-only utterance, and the filter that removes the bleep's own sound
// from the microphone without muting it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWakeOnly,
  matchWake,
  WakeAck,
  BleepFilter,
  DEFAULT_WAKE,
  RATE,
} from '../src/converse-core.mjs';
import { toneWav, TONES } from '../src/converse-turns.mjs';

const wake = ['patchwork', 'glasseye'];

test('a wake word is found in a partial transcript, early in the words', () => {
  for (const t of [
    'Patchwork',
    'Hey Patchwork, what',
    'patchwork.',
    'glass eye are you',
  ])
    assert.ok(matchWake(t, wake), t);
  assert.ok(!matchWake('what time is it', wake));
});

test('only the wake word: with or without a greeting', () => {
  for (const t of [
    'Patchwork.',
    'Hey, Patchwork!',
    'glass eye',
    'ok patchwork',
  ])
    assert.equal(isWakeOnly(t, wake), true, t);
  for (const t of [
    'Patchwork what time is it',
    'turn left patchwork please',
    'hello there',
  ])
    assert.equal(isWakeOnly(t, wake), false, t);
  assert.ok(DEFAULT_WAKE.length);
});

test('one bleep per utterance', () => {
  const a = new WakeAck();
  assert.equal(a.ack('u1'), true); // the partial
  assert.equal(a.ack('u1'), false); // the final of the same utterance
  assert.equal(a.ack('u2'), true);
  const small = new WakeAck(2);
  small.ack('a');
  small.ack('b');
  small.ack('c');
  assert.equal(small.ack('a'), true); // forgotten after the keep limit
});

test('the wake tone is short, quiet and unlike the others', () => {
  const ms = TONES.wake.notes.reduce((s, [, sec]) => s + sec * 1000, 0);
  assert.ok(ms <= 150);
  const hz = (k) => TONES[k].notes.map((n) => n[0]);
  for (const k of Object.keys(TONES))
    if (k !== 'wake') assert.notDeepEqual(hz(k), hz('wake'));
  assert.ok(toneWav('wake').length > 44);
});

const sine = (hz, ms, amp = 8000, t0 = 0) => {
  const n = Math.round((RATE * ms) / 1000),
    b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * hz * (i + t0)) / RATE) * amp),
      i * 2,
    );
  return b;
};
const energy = (b, skip = 0) => {
  let s = 0;
  for (let i = skip; i < b.length / 2; i++) s += b.readInt16LE(i * 2) ** 2;
  return Math.sqrt(s / (b.length / 2 - skip));
};

test('the filter removes the bleep pitch inside its window and passes speech pitch', () => {
  const f = new BleepFilter();
  f.arm(1000, 1200, 150, 250); // expected at the mic 2200 ms on, window 1950..2600
  const now = 2300;
  const beep = sine(1600, 100);
  const out = f.apply(beep, now);
  assert.ok(
    energy(out, 1000) < energy(beep, 1000) * 0.1,
    'bleep pitch is removed',
  );
  const f2 = new BleepFilter();
  f2.arm(1000, 1200);
  const voice = sine(300, 100);
  const kept = f2.apply(voice, now);
  assert.ok(
    energy(kept, 800) > energy(voice, 800) * 0.9,
    'a speech pitch passes',
  );
  const f3 = new BleepFilter();
  f3.arm(1000, 1200);
  const outside = sine(1600, 100);
  assert.equal(
    f3.apply(outside, 5000),
    outside,
    'outside the window nothing changes',
  );
});

test('whisper silence phrases: dropped over quiet sound or a quick repeat, kept when real and loud', async () => {
  const { silenceHallucination, medianRms } =
    await import('../src/converse-core.mjs');
  const now = 100000;
  assert.match(
    silenceHallucination('Thank you.', 120, null, now),
    /quiet sound/,
  );
  assert.match(
    silenceHallucination('Thanks for watching!', 300, null, now),
    /quiet sound/,
  );
  assert.match(silenceHallucination('you', 0, null, now), /quiet/);
  // loud, first time: a real thank-you after a reply stays
  assert.equal(silenceHallucination('Thank you.', 3000, null, now), null);
  // repeated within 20 s at middling level: dropped; clearly loud: kept; long ago: kept
  const last = { text: 'thank you', at: now - 10000 };
  assert.match(
    silenceHallucination('Thank you.', 900, last, now),
    /again within 10 s/,
  );
  assert.equal(silenceHallucination('Thank you.', 3000, last, now), null);
  assert.equal(
    silenceHallucination('Thank you.', 900, { ...last, at: now - 25000 }, now),
    null,
  );
  // a sentence that contains the phrase is never a hallucination
  assert.equal(
    silenceHallucination('thank you patchwork', 100, null, now),
    null,
  );
  // the median is of the whole utterance: noise stays low, speech is high
  assert.ok(medianRms(sine(300, 500, 100)) < 120);
  assert.ok(medianRms(sine(300, 500, 8000)) > 4000);
});

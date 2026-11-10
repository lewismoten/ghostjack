// Tests for full-duplex conversation parts (node --test tools/converse-turns-test.mjs): reply segmenting,
// the what-was-heard report, the echo gate, lag estimate, tones, tone switches. No camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  takeSegments,
  wordTimes,
  playbackReport,
  EchoGate,
  estimateLag,
  toneWav,
  TONE_KINDS,
} from '../src/converse-turns.mjs';
import { setTones, tones } from '../src/reply.mjs';

test('segments: a sentence is cut as soon as it is complete', () => {
  let r = takeSegments('Hello there, my friend. How are', { first: true });
  assert.deepEqual(r.segments, ['Hello there, my friend.']);
  assert.equal(r.rest, 'How are');
  r = takeSegments('How are you today?', { final: true });
  assert.deepEqual(r.segments, ['How are you today?']);
  assert.equal(r.rest, '');
});

test('segments: the first one may stop at a comma so speech starts early', () => {
  const r = takeSegments(
    'Well, I looked at the logs and found the cause, which is odd',
    { first: true },
  );
  assert.equal(
    r.segments[0],
    'Well, I looked at the logs and found the cause,',
  );
  const later = takeSegments(
    'Well, I looked at the logs and found the cause, which is odd',
    { first: false },
  );
  assert.equal(later.segments.length, 0); // not 70 characters yet: wait for more
});

test('segments: pieces arriving word by word give the same lines in order', () => {
  const text =
    'First sentence is here. Second one follows it, with a clause that runs long enough to count, then ends. Third!';
  let buf = '';
  const got = [];
  for (const w of text.split(' ')) {
    buf += (buf ? ' ' : '') + w;
    const r = takeSegments(buf, { first: got.length === 0 });
    got.push(...r.segments);
    buf = r.rest;
  }
  got.push(...takeSegments(buf, { final: true }).segments);
  assert.equal(got.join(' '), text);
  assert.ok(got.length >= 3);
  assert.ok(got.every((g) => g.length <= 280));
});

test('segments: nothing is longer than 280 characters', () => {
  const r = takeSegments('word '.repeat(200), { final: true });
  assert.ok(r.segments.length >= 4);
  assert.ok(r.segments.every((s) => s.length <= 280));
});

test('word times follow letters and cover the segment', () => {
  const w = wordTimes('a bb cccc', 900);
  assert.equal(w.length, 3);
  assert.equal(w[0].startMs, 0);
  assert.ok(Math.abs(w[2].endMs - 900) < 1e-6);
  assert.ok(w[2].endMs - w[2].startMs > w[0].endMs - w[0].startMs);
});

test('barge-in report: heard, cut mid-word, never played', () => {
  const segs = [
    { id: 'a', text: 'One two three four.', startMs: 0, durMs: 2000 },
    { id: 'b', text: 'Five six seven eight.', startMs: 2000, durMs: 2000 },
    { id: 'c', text: 'Nine ten.', startMs: Infinity, durMs: 0 },
  ];
  const r = playbackReport(segs, 2700);
  assert.deepEqual(r.heard, ['a']);
  assert.deepEqual(r.unplayed, ['c']);
  assert.equal(r.cut.id, 'b');
  assert.ok(r.cut.wordsHeard.length >= 1 && r.cut.cutWord);
  assert.equal(r.heardText.startsWith('One two three four.'), true);
  assert.ok(r.unheardText.endsWith('Nine ten.'));
  // cut before anything played, and after everything
  assert.deepEqual(playbackReport(segs, -5).heard, []);
  assert.deepEqual(playbackReport(segs.slice(0, 2), 9999).heard, ['a', 'b']);
  assert.equal(playbackReport(segs.slice(0, 2), 9999).cut, null);
});

// A speech-like reference envelope (20 ms frames) and the microphone's echo of it.
const ref = Array.from({ length: 300 }, (_, i) =>
  i % 25 < 15 ? 6000 + 2000 * Math.sin(i) : 300,
);
const echo = (gain, delay) =>
  ref.map((_, i) => gain * (ref[i - delay] ?? 0) + 60);

test('echo gate: the camera hearing itself never triggers, even when the echo level differs', () => {
  for (const gain of [0.1, 0.3, 0.8]) {
    const g = new EchoGate();
    const mic = echo(gain, 0);
    let hit = -1;
    for (let i = 0; i < ref.length && hit < 0; i++)
      if (g.push(mic[i], ref[i])) hit = i;
    assert.equal(hit, -1, `gain ${gain}`);
  }
});

test('echo gate: a voice over the echo triggers within about 300 ms', () => {
  const g = new EchoGate();
  const mic = echo(0.3, 0);
  const talkFrom = 100;
  for (let i = talkFrom; i < ref.length; i++) mic[i] += 3500; // Lewis, steady
  let hit = -1;
  for (let i = 0; i < ref.length && hit < 0; i++)
    if (g.push(mic[i], ref[i])) hit = i;
  assert.ok(hit >= talkFrom, 'no false trigger before he spoke');
  assert.ok((hit - talkFrom) * 20 <= 300, `took ${(hit - talkFrom) * 20} ms`);
});

test('echo gate: a voice in a quiet gap of the reply triggers too', () => {
  const g = new EchoGate();
  const mic = echo(0.3, 0).map((v) => v);
  for (let i = 15; i < 25; i++) mic[i] += 3000; // the first pause in the reply
  let hit = -1;
  for (let i = 0; i < 40 && hit < 0; i++) if (g.push(mic[i], ref[i])) hit = i;
  assert.ok(hit >= 15 && hit < 25, String(hit));
});

test('lag estimate finds the delay between played and heard', () => {
  const mic = echo(0.3, 37);
  assert.equal(estimateLag(ref, mic, 100).lag, 37);
});

test('tones are short, distinct and quiet', () => {
  const sizes = new Set();
  for (const k of TONE_KINDS) {
    const w = toneWav(k);
    assert.ok(w.length < 16000 * 2 * 0.4, `${k} is under 0.4 s`);
    sizes.add(w.toString('hex'));
    let peak = 0;
    for (let i = 44; i < w.length; i += 2)
      peak = Math.max(peak, Math.abs(w.readInt16LE(i)));
    assert.ok(peak <= 0.51 * 32767);
  }
  assert.equal(sizes.size, TONE_KINDS.length);
});

test('tone switches: quiet by default except the interruption cue; unknown kinds refused', () => {
  assert.deepEqual(
    { ...tones },
    { start: false, done: false, interrupting: true, heard: false },
  );
  assert.equal(setTones({ done: true }).done, true);
  setTones({ done: false });
  assert.throws(() => setTones({ siren: true }), /unknown tone/);
});

// Tests for the page-voice echo filter (node --test tools/page-voice-test.mjs): the page's own spoken
// lines heard by the microphone are dropped by window, trimmed at an end, or removed by text. No sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageVoice } from '../src/page-voice.mjs';
import { LINES } from '../web/lines.js';

const T0 = 1_000_000;
const voice = () => {
  const p = new PageVoice();
  p.set(true, 'Hold on.', T0);
  p.set(false, 'Hold on.', T0 + 900);
  return p;
};

test('LINES are readable by the bridge', () => {
  assert.ok(LINES.snapshot.includes('Hold on.'));
});

test('an utterance inside the window and its tail is dropped', () => {
  const r = voice().filter('Hold on.', T0 + 100, T0 + 1200, T0 + 3000);
  assert.equal(r.text, '');
  assert.match(r.why, /page voice/);
});

test('an utterance far from the window is untouched', () => {
  const r = voice().filter('what time is it', T0 + 6000, T0 + 7500, T0 + 8000);
  assert.deepEqual(r, { text: 'what time is it', why: '' });
});

test('words overlapping only the end of the utterance are trimmed', () => {
  const p = new PageVoice();
  p.set(true, 'Closing the eye.', T0 + 2000);
  // Lewis speaks 0..2.4 s; the last words fall inside the page line
  const r = p.filter(
    'turn the lamp on closing the eye',
    T0,
    T0 + 3600,
    T0 + 4500,
  );
  assert.equal(r.text, 'turn the lamp on');
  assert.equal(r.why, 'page voice at an end');
});

test('words overlapping only the start are trimmed', () => {
  const p = voice();
  const r = p.filter(
    'hold on what is the weather',
    T0 + 200,
    T0 + 7200,
    T0 + 7300,
  );
  assert.equal(r.text, 'what is the weather');
});

test('text filter: a recent line equal to or ending the text is removed', () => {
  const p = voice();
  const far = T0 + 20000; // audio times well outside the window
  p.set(true, 'Easy now.', far - 3000);
  p.set(false, 'Easy now.', far - 2000);
  assert.equal(
    p.filter('easy now', far + 1000, far + 2000, far + 3000).text,
    '',
  );
  assert.equal(
    p.filter('Lights off. Easy now!', far + 1000, far + 2500, far + 3000).text,
    'Lights off.',
  );
});

test('text filter ignores a line spoken long ago', () => {
  const p = voice();
  const late = T0 + 30000;
  assert.equal(
    p.filter('Hold on.', late, late + 800, late + 900).text,
    'Hold on.',
  );
});

// Tests for the wake decision (node --test tools/say-fast-test.mjs): a stream that opens within the awake
// window of the last publish ending skips the wake pulse; later ones get the full lead-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAwake, leadIn, AWAKE_MS } from '../src/say.mjs';

test('awake inside the window, asleep once it has passed', () => {
  assert.equal(isAwake(10000, 10000 + AWAKE_MS - 1), true);
  assert.equal(isAwake(10000, 10000 + AWAKE_MS), false);
  assert.equal(isAwake(0, 60000), false);
});
test('an awake lead is short; a cold lead has the pulse and is longer', () => {
  const awake = leadIn({ awake: true, level: 0.03, chime: false });
  const cold = leadIn({ awake: false, level: 0.03, chime: false });
  assert.equal(awake.length / 32, 350);
  assert.ok(cold.length / 32 > 1600);
  assert.ok(
    cold.some((b) => b !== 0),
    'the pulse is not silence',
  );
  assert.ok(awake.every((b) => b === 0));
});

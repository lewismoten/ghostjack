// Tests for the fast-line decision (node --test tools/say-fast-test.mjs): a line queued as fast is mixed again
// with the wake pulse when its publish starts after the camera's amp may have gone to sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleFast, AWAKE_MS } from '../src/say.mjs';

test('a fast line stays fast inside the awake window', () => {
  assert.equal(staleFast({ fast: true }, 10000, 10000 + AWAKE_MS - 1), false);
});
test('a fast line is stale once the window has passed', () => {
  assert.equal(staleFast({ fast: true }, 10000, 10000 + AWAKE_MS), true);
  assert.equal(staleFast({ fast: true }, 0, 60000), true);
});
test('a normal line is never stale', () => {
  assert.equal(staleFast({ fast: false }, 0, 60000), false);
});

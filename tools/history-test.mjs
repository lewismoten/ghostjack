// Tests for the conversation history store (node --test tools/history-test.mjs): order, bounds, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History } from '../src/history.mjs';

const file = () =>
  join(mkdtempSync(join(tmpdir(), 'gj-hist-')), 'h', 'history.jsonl');

test('keeps both sides in order, with flags, and skips empty text', () => {
  const h = new History(file());
  h.add('you', 'hello patchwork', { followUp: true });
  h.add('patchwork', 'hi there');
  h.add('mark', 'Lewis talked over Patchwork', {
    heard: 'hi',
    unheard: 'there',
  });
  assert.equal(h.add('you', '   '), null);
  const { cursor, entries } = h.since(0);
  assert.equal(cursor, 3);
  assert.deepEqual(
    entries.map((e) => e.who),
    ['you', 'patchwork', 'mark'],
  );
  assert.equal(entries[0].followUp, true);
  assert.deepEqual(
    h.since(2).entries.map((e) => e.n),
    [3],
  );
  assert.deepEqual(
    h.since(0, 2).entries.map((e) => e.n),
    [2, 3],
  );
});

test('is bounded by count, and by age', () => {
  let t = Date.parse('2026-11-10T12:00:00Z');
  const h = new History(null, { max: 3, maxAgeMs: 1000, now: () => t });
  for (let i = 1; i <= 5; i++) h.add('you', `line ${i}`);
  assert.deepEqual(
    h.entries.map((e) => e.text),
    ['line 3', 'line 4', 'line 5'],
  );
  t += 5000;
  h.add('you', 'fresh');
  assert.deepEqual(
    h.entries.map((e) => e.text),
    ['fresh'],
  );
});

test('persists across a restart, privately, and keeps counting', () => {
  const f = file();
  const a = new History(f);
  a.add('you', 'one');
  a.add('patchwork', 'two');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const b = new History(f);
  assert.deepEqual(
    b.entries.map((e) => e.text),
    ['one', 'two'],
  );
  assert.equal(b.add('you', 'three').n, 3);
});

test('rewrites a file that has grown well past its bound', () => {
  const f = file();
  const h = new History(f, { max: 5 });
  for (let i = 0; i < 400; i++) h.add('you', `l${i}`);
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  assert.ok(lines.length < 250);
  assert.equal(new History(f, { max: 5 }).entries.length, 5);
});

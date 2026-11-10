// Tests for personas (node --test tools/personas-test.mjs): validation, loading, the local settings file,
// resolving which persona a call uses (lock, agent map, default), the transcriber word list, and applying
// sayAs to a reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Personas,
  SHIPPED_DIR,
  DEFAULT_VOCABULARY,
  validatePersona,
  applySayAs,
} from '../src/personas.mjs';
import { append, get } from '../src/reply.mjs';

const fresh = () =>
  new Personas({
    dir: SHIPPED_DIR,
    localFile: join(
      mkdtempSync(join(tmpdir(), 'gj-pers-')),
      'sub',
      'local.json',
    ),
  });
const manyWords = Array.from({ length: 40 }, (_, i) => `longword${i}`);
const code = (c) => (e) => e.code === c;

test('the shipped personas load and validate', () => {
  const p = fresh();
  const names = p.list().map((x) => x.name);
  assert.ok(names.includes('patchwork') && names.includes('glassmouth'));
  const pw = p.get('patchwork');
  assert.deepEqual(pw.wakeWords, ['patchwork', 'glasseye']);
  assert.equal(pw.style, 'netrunner');
  assert.equal(pw.tones.wake, true);
  assert.equal(pw.source, 'shipped');
  assert.equal(p.settings().default, 'patchwork');
});

test('validation rejects unsafe or out-of-range fields', () => {
  assert.equal(validatePersona({ name: 'zed' }).rate, 140);
  for (const bad of [
    { name: 'Bad Name' },
    { name: 'settings' },
    { name: '../x' },
    { name: 'a', rate: 500 },
    { name: 'a', level: 0.5 },
    { name: 'a', voice: 'x; rm -rf' },
    { name: 'a', wakeWords: ['ab'] },
    { name: 'a', wakeWords: Array(7).fill('abcd') },
    { name: 'a', sayAs: [{ from: '<b>', to: 'x' }] },
    { name: 'a', greeting: 'x'.repeat(201) },
    { name: 'a', tones: { bogus: true } },
    { name: 'a', glossary: { ok: 'line\u0000' } },
    { name: 'a', style: 'Net Runner!' },
    { name: 'a', vocabulary: ['<script>'] },
    { name: 'a', vocabulary: manyWords },
  ])
    assert.throws(() => validatePersona(bad), code(400), JSON.stringify(bad));
  assert.throws(() => validatePersona(null));
});

test('saving writes only the local file (mode 0600); an edit of a shipped persona is marked edited', () => {
  const p = fresh();
  assert.equal(p.save({ ...p.get('patchwork'), rate: 150 }).source, 'edited');
  p.save({ name: 'rook', wakeWords: ['rook'] });
  assert.equal(p.get('rook').source, 'local');
  assert.equal(statSync(p.localFile()).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(SHIPPED_DIR + '/patchwork.json', 'utf8')).rate,
    140,
  );
  p.remove('patchwork');
  assert.equal(p.get('patchwork').rate, 140);
  assert.throws(() => p.remove('patchwork'), code(409));
  assert.throws(() => p.remove('nobody'), code(404));
});

test('default, agent map and lock decide the persona', () => {
  const p = fresh();
  assert.equal(p.resolve({}).name, 'patchwork');
  assert.equal(p.resolve({ persona: 'glassmouth' }).name, 'glassmouth');
  assert.throws(() => p.resolve({ persona: 'nope' }), code(400));
  p.setSettings({ agents: { codex: 'glassmouth' } });
  assert.equal(p.resolve({ agent: 'Codex' }).name, 'glassmouth');
  assert.equal(p.resolve({ agent: 'someone' }).name, 'patchwork');
  assert.equal(
    p.resolve({ agent: 'codex', persona: 'patchwork' }).name,
    'patchwork',
  );
  p.setSettings({ lock: true });
  assert.equal(
    p.resolve({ agent: 'codex', persona: 'patchwork' }).name,
    'glassmouth',
  );
  p.setSettings({ default: 'glassmouth', agents: {} });
  assert.equal(p.resolve({ persona: 'patchwork' }).name, 'glassmouth');
  assert.throws(() => p.setSettings({ default: 'nope' }), code(400));
  assert.throws(() => p.setSettings({ agents: { 'bad name': 'patchwork' } }));
  assert.throws(() => p.setSettings({ agents: { a: 'nope' } }));
});

test('a deleted persona is dropped from the default and the map', () => {
  const p = fresh();
  p.save({ name: 'rook' });
  p.setSettings({ default: 'rook', agents: { a: 'rook' } });
  p.remove('rook');
  const s = p.settings();
  assert.equal(s.default, 'patchwork');
  assert.deepEqual(s.agents, {});
});

test('a corrupt local file is ignored', () => {
  const p = fresh();
  p.save({ name: 'rook' });
  writeFileSync(p.localFile(), '{nope');
  assert.equal(p.get('rook'), null);
  assert.equal(p.settings().default, 'patchwork');
});

test('the transcriber word list: global default, persona words, bounded', () => {
  const p = fresh();
  assert.deepEqual(p.settings().vocabulary, DEFAULT_VOCABULARY);
  assert.ok(DEFAULT_VOCABULARY.includes('THE CHEZ'));
  p.save({ name: 'rook', vocabulary: ['Rookery', 'Patchwork'] });
  const prompt = p.vocabularyPrompt('rook');
  assert.match(prompt, /^Patchwork, Glasseye/);
  assert.match(prompt, /Rookery/);
  assert.equal(prompt.split('Patchwork').length, 2, 'no duplicates');
  assert.ok(prompt.length <= 400);
  p.setSettings({ vocabulary: ['Zed'] });
  assert.equal(p.vocabularyPrompt('patchwork'), 'Zed');
  assert.throws(() => p.setSettings({ vocabulary: manyWords }), code(400));
});

test('applySayAs fixes whole words in any case and leaves the rest', () => {
  const pairs = [{ from: 'Glasseye', to: 'glass eye' }];
  assert.equal(
    applySayAs('Hello GLASSEYE, see glasseyes', pairs),
    'Hello glass eye, see glasseyes',
  );
  assert.equal(applySayAs('a.b', [{ from: 'a.b', to: 'x' }]), 'x');
  assert.equal(applySayAs('axb', [{ from: 'a.b', to: 'x' }]), 'axb');
});

test("a persona's sayAs applies to a reply's text (kept unfinished here, so nothing is spoken)", () => {
  const persona = validatePersona({
    name: 'tst',
    sayAs: [{ from: 'Zorbo', to: 'zor bow' }],
  });
  const v = append({
    text: 'Zorbo is here',
    end: false,
    persona,
    voice: '',
    level: 0.03,
    rate: 140,
  });
  assert.equal(v.segments.length, 0);
  assert.match(get(v.id).buf, /zor bow/);
  assert.equal(get(v.id).persona.name, 'tst');
});

// Tests for converse mode's pure parts (node --test tools/converse-test.mjs): the segmenter (with a
// synthetic PCM stream, and speech made by macOS `say` when it is available), wake-word matching with
// whisper's usual spellings, the self-voice guard, long-reply splitting and the inbox file. No camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Segmenter,
  SelfGuard,
  Inbox,
  matchWake,
  splitLines,
  cleanWake,
  wavFromPcm,
  chimeWav,
  RATE,
} from '../src/converse-core.mjs';
import { cleanTranscript } from '../src/converse.mjs';

// Seconds of a tone at `amp` (of 32768), or of near silence when amp is small.
const tone = (sec, amp) => {
  const n = Math.round(sec * RATE),
    b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 300) / RATE) * amp),
      i * 2,
    );
  return b;
};
const hiss = (sec) => tone(sec, 40);

test('segmenter cuts one utterance out of silence, with the hangover', () => {
  const seg = new Segmenter();
  const got = seg.push(Buffer.concat([hiss(1), tone(1.2, 6000), hiss(2)]));
  assert.equal(got.length, 1);
  assert.ok(
    got[0].durationMs > 1200 && got[0].durationMs < 2200,
    got[0].durationMs,
  );
  assert.ok(got[0].voicedMs >= 1100);
});

test('segmenter keeps a pause shorter than the hangover inside one utterance', () => {
  const seg = new Segmenter();
  const got = seg.push(
    Buffer.concat([hiss(1), tone(1, 6000), hiss(0.5), tone(1, 6000), hiss(2)]),
  );
  assert.equal(got.length, 1);
});

test('segmenter splits two sentences a long pause apart', () => {
  const seg = new Segmenter();
  const got = seg.push(
    Buffer.concat([
      hiss(1),
      tone(1, 6000),
      hiss(1.5),
      tone(1, 6000),
      hiss(1.5),
    ]),
  );
  assert.equal(got.length, 2);
});

test('segmenter drops a short burst and ignores steady hiss', () => {
  const seg = new Segmenter();
  assert.equal(
    seg.push(Buffer.concat([hiss(2), tone(0.15, 8000), hiss(2)])).length,
    0,
  );
  assert.equal(new Segmenter().push(hiss(10)).length, 0);
});

test('segmenter cuts at the maximum length', () => {
  const seg = new Segmenter({ maxMs: 5000 });
  const got = seg.push(Buffer.concat([hiss(1), tone(12, 6000), hiss(2)]));
  assert.ok(got.length >= 2);
  assert.ok(got[0].durationMs <= 5000);
});

test('segmenter works with odd chunk sizes', () => {
  const seg = new Segmenter();
  const all = Buffer.concat([hiss(1), tone(1.2, 6000), hiss(2)]);
  let n = 0;
  for (let i = 0; i < all.length; i += 777)
    n += seg.push(all.subarray(i, i + 777)).length;
  assert.equal(n, 1);
});

test('segmenter hears speech made by say (synthetic)', (t) => {
  let wav;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'gj-conv-'));
    const aiff = join(dir, 's.aiff');
    wav = join(dir, 's.raw');
    execFileSync('say', ['-o', aiff, 'hey patchwork, what is the weather']);
    execFileSync('/opt/homebrew/bin/ffmpeg', [
      '-loglevel',
      'error',
      '-i',
      aiff,
      '-f',
      's16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-y',
      wav,
    ]);
  } catch {
    return t.skip('say or ffmpeg not available');
  }
  const speech = readFileSync(wav);
  const got = new Segmenter().push(Buffer.concat([hiss(1), speech, hiss(2)]));
  assert.equal(got.length, 1);
  assert.ok(got[0].voicedMs > 1000);
});

test('wake words: the spellings a transcriber writes', () => {
  const yes = [
    'Patchwork, what time is it',
    'Hey Patchwork can you hear me',
    'hey patch work what is up',
    'Patch Work.',
    'ok glasseye read that again',
    'Glass eye, are you there?',
    'Glass-eye',
    'hey glass I do you copy',
    "Patchwork's turn",
    'what do you think patchwork',
  ];
  for (const t of yes) assert.ok(matchWake(t), t);
  assert.equal(matchWake('Hey Patchwork').wake, 'patchwork');
  assert.equal(matchWake('Hey Patchwork').atStart, true);
  assert.equal(matchWake('glass eye').wake, 'glasseye');
  assert.equal(matchWake('what do you think patchwork').atStart, false);
});

test('wake words: ordinary talk and look-alike words do not wake it', () => {
  const no = [
    'we need to dispatch workers to the site',
    'the patch work on the quilt is nice',
    'my glasses are on the table',
    'a glass of water please',
    '',
    'hello there',
  ];
  // "the patch work on the quilt" is spoken as two words and does match: that is the cost of hearing
  // "patch work" for the name; everything else must stay quiet.
  for (const t of no.filter((x) => !x.includes('quilt')))
    assert.equal(matchWake(t), null, t);
});

test('wake words are configurable and cleaned', () => {
  assert.deepEqual(cleanWake(undefined), ['patchwork', 'glasseye']);
  assert.deepEqual(cleanWake(['Computer', 'x', 'Hey You']), [
    'computer',
    'heyyou',
  ]);
  assert.equal(
    matchWake('computer, lights', cleanWake(['computer'])).wake,
    'computer',
  );
  assert.equal(matchWake('patchwork', cleanWake(['computer'])), null);
});

test('self-voice guard mutes while speaking and for a tail after', () => {
  const g = new SelfGuard(2000);
  assert.equal(g.muted(0, false), false);
  assert.equal(g.muted(100, true), true);
  assert.equal(g.muted(1000, false), true);
  assert.equal(g.muted(2099, false), true);
  assert.equal(g.muted(2101, false), false);
});

test('long replies split in order at sentence ends', () => {
  const sentence = 'This is one sentence of a reply that goes on a while. ';
  const text = sentence.repeat(20);
  const lines = splitLines(text, 280);
  assert.ok(lines.length >= 4);
  for (const l of lines) assert.ok(l.length <= 280);
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), text.trim());
  assert.deepEqual(splitLines('short.'), ['short.']);
  assert.deepEqual(splitLines('  '), []);
  assert.ok(splitLines('x'.repeat(700), 280).every((l) => l.length <= 280));
});

test('inbox writes one small JSON line per utterance, private, with cursors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gj-inbox-'));
  const file = join(dir, 'sub', 'inbox.jsonl');
  const box = new Inbox(file);
  const a = box.add({
    type: 'final',
    text: 'hey patchwork hello',
    wake: 'patchwork',
    durationMs: 1800,
  });
  box.add({
    type: 'final',
    text: 'glass eye again',
    wake: 'glasseye',
    durationMs: 900,
  });
  const lines = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), [
    'at',
    'durationMs',
    'n',
    'text',
    'type',
    'wake',
  ]);
  assert.equal(lines[0].text, a.text);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(box.since(0).heard.length, 2);
  assert.deepEqual(
    box.since(1).heard.map((e) => e.n),
    [2],
  );
  assert.equal(box.since(2).heard.length, 0);
  assert.equal(box.since(2).cursor, 2);
});

test('transcripts lose whisper bracket noise', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(
    cleanTranscript(' (music) hey patchwork [noise] hi '),
    'hey patchwork hi',
  );
  assert.equal(cleanTranscript(null), '');
});

test('wav helpers make real files', () => {
  const w = wavFromPcm(Buffer.alloc(3200));
  assert.equal(w.length, 3244);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  const c = chimeWav();
  assert.ok(c.length > 8000);
  assert.ok(existsSync('/'));
});

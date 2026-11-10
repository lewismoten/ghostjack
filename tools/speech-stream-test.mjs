// Tests for the one-publish-per-reply stream (node --test tools/speech-stream-test.mjs), with a fake publisher
// and simulated time: offsets, pauses, filler when a sentence is late, the tail, idle end and teardown on stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpeechStream,
  BYTES_PER_MS,
  silence,
  sine,
} from '../src/speech-stream.mjs';

const tone = (ms) => sine(500, ms, 0.2, 0);
const nonzero = (b) => b.some((x) => x !== 0);

function setup(cfg = {}) {
  const sent = [];
  const h = { killed: false, ended: false };
  const handle = {
    canWrite: () => true,
    write: (b) => sent.push(b),
    end: () => (h.ended = true),
    kill: () => (h.killed = true),
  };
  const logs = [];
  const st = new SpeechStream({
    openPublish: () => handle,
    log: (o) => logs.push(o),
    cfg: {
      aheadMs: 1000,
      pauseMs: 300,
      tailMs: 1000,
      closeSlackMs: 200,
      idleEndMs: 5000,
      ...cfg,
    },
    id: 's1',
  });
  const job = (id, ms) => ({
    id,
    text: id,
    status: 'queued',
    pcm: ms ? tone(ms) : null,
  });
  // run simulated time from `from` to `to` in 20 ms ticks
  const run = (from, to) => {
    for (let t = from; t <= to; t += 20) st.tick(t);
  };
  const all = () => Buffer.concat(sent);
  return { st, h, logs, job, run, all, sent };
}

test('lead, then sentences with pauses; offsets are exact byte positions', () => {
  const { st, job, run, all } = setup();
  st.add(job('a', 500));
  st.add(job('b', 400));
  st.end();
  st.begin('u', silence(600), 0);
  st.started(100, 0); // byte 0 plays at t=100
  run(100, 4000);
  const [a, b] = st.jobs;
  assert.equal(a.offsetMs, 0);
  assert.equal(a.ref.leadMs, 600);
  assert.equal(a.ref.speechMs, 500);
  // b's region begins when a's speech ended (600+500), then a 300 ms pause
  assert.equal(b.offsetMs, 1100);
  assert.equal(b.ref.leadMs, 300);
  assert.equal(a.publishAt, 100);
  assert.equal(b.publishAt, 1200);
  // the stream really holds the speech at those offsets
  const out = all();
  assert.ok(nonzero(out.subarray(600 * 32, 1100 * 32)));
  assert.ok(!nonzero(out.subarray(1100 * 32, 1400 * 32)));
  assert.ok(nonzero(out.subarray(1400 * 32, 1800 * 32)));
});

test('a late sentence is covered by filler, never an underrun, and its region includes the filler', () => {
  const { st, job, run, all } = setup();
  const a = job('a', 300),
    b = job('b', null);
  st.add(a);
  st.add(b);
  st.begin('u', silence(200), 0);
  st.started(0, 0);
  run(0, 3000); // b not ready for 3 s
  const writtenSilent = all().length / BYTES_PER_MS;
  assert.ok(
    writtenSilent >= 3000 - 100,
    `stream kept ahead of playback (${writtenSilent} ms)`,
  );
  b.pcm = tone(400);
  st.end();
  run(3020, 7000);
  assert.ok(b.offsetMs >= 500, 'b starts after a long filler');
  assert.ok(b.ref.leadMs > 2000, 'the filler is its lead');
  assert.equal(b.ref.speechMs, 400);
  assert.ok(nonzero(all().subarray((b.offsetMs + b.ref.leadMs) * 32)));
});

test('keepalive tone fills the gap when asked; default is silence', () => {
  const t = setup({ keepalive: 'tone' });
  t.st.add(t.job('a', 200));
  t.st.add(t.job('b', null));
  t.st.begin('u', silence(100), 0);
  t.st.started(0, 0);
  t.run(0, 1500);
  const gap = t.all().subarray(600 * 32, 1000 * 32);
  assert.ok(nonzero(gap));
  assert.ok(
    Math.max(
      ...Array.from({ length: gap.length / 2 }, (_, i) =>
        Math.abs(gap.readInt16LE(i * 2)),
      ),
    ) < 400,
  );
  const s = setup();
  s.st.add(s.job('a', 200));
  s.st.add(s.job('b', null));
  s.st.begin('u', silence(100), 0);
  s.st.started(0, 0);
  s.run(0, 1500);
  assert.ok(!nonzero(s.all().subarray(600 * 32, 1000 * 32)));
});

test('the tail follows the last sentence and the publish closes near the end of it', () => {
  const { st, h, job, run, all } = setup();
  st.add(job('a', 500));
  st.end();
  st.begin('u', silence(300), 0);
  st.started(0, 0);
  run(0, 700);
  assert.equal(h.ended, false, 'still open while the sentence plays');
  run(720, 3000);
  assert.equal(h.ended, true);
  assert.equal(
    all().length / BYTES_PER_MS,
    300 + 500 + 1000,
    'lead + speech + tail, nothing else',
  );
  assert.ok(!nonzero(all().subarray(800 * 32)));
});

test('a reply nobody closes ends itself after the idle limit, with its tail', () => {
  const { st, h, logs, job, run } = setup({ idleEndMs: 2000 });
  st.add(job('a', 300));
  st.begin('u', silence(100), 0);
  st.started(0, 0);
  run(0, 1500);
  assert.equal(h.ended, false);
  run(1520, 6000);
  assert.ok(logs.some((l) => l.ev === 'idle-end'));
  assert.equal(h.ended, true);
});

test('stop kills the publish, names the sentence on air and cancels the rest', () => {
  const { st, h, job, run } = setup();
  st.add(job('a', 500));
  st.add(job('b', 500));
  st.add(job('c', 500));
  st.begin('u', silence(200), 0);
  st.started(0, 0);
  run(0, 1000); // playing: a is 200..700, b region starts 700; at 1000 b is on air
  const cut = st.stop(1000);
  assert.equal(h.killed, true);
  assert.equal(cut.id, 'b');
  assert.equal(cut.stoppedAt, 1000);
  assert.equal(cut.status, 'cancelled');
  assert.equal(st.jobs[2].status, 'cancelled');
  st.finish(1010);
  assert.equal(st.finished, true);
  st.tick(1100); // nothing more is written after a stop
  assert.equal(st.stop(1200).id, 'b', 'a second stop is harmless');
});

test('stopped in the lead-in: the first sentence is the cut one', () => {
  const { st, job } = setup();
  st.add(job('a', 500));
  st.begin('u', silence(1600), 0);
  st.started(0, 0);
  st.tick(100);
  assert.equal(st.stop(200).id, 'a');
});

test('log lines: open, first byte with setup time, one per sentence, end', async () => {
  const { st, logs, job, run } = setup();
  st.add(job('a', 200));
  st.add(job('b', 200));
  st.end();
  st.begin('u', silence(100), 1000);
  st.started(1700, 150);
  run(1700, 6000);
  st.finish(6000);
  await st.done;
  const evs = logs.map((l) => l.ev);
  assert.deepEqual(
    evs.filter((e) => e !== 'sentence'),
    ['stream-open', 'first-byte', 'stream-end'],
  );
  assert.equal(evs.filter((e) => e === 'sentence').length, 2);
  const fb = logs.find((l) => l.ev === 'first-byte');
  assert.equal(fb.publishAt, 1550);
  assert.equal(fb.setupMs, 550);
  const end = logs.find((l) => l.ev === 'stream-end');
  assert.equal(end.sentences.length, 2);
});

test('a failed sentence is skipped', () => {
  const { st, job, run } = setup();
  const bad = job('x', null);
  bad.failed = true;
  st.add(job('a', 200));
  st.add(bad);
  st.add(job('b', 200));
  st.end();
  st.begin('u', silence(100), 0);
  st.started(0, 0);
  run(0, 3000);
  assert.equal(st.jobs[2].ref.speechMs, 200);
  assert.equal(bad.offsetMs, undefined);
});

test('filler stays close to playback, so a late sentence waits little and the stream never underruns', () => {
  const { st, job, sent } = setup();
  const b = job('b', null);
  st.add(job('a', 300));
  st.add(b);
  st.begin('u', silence(200), 0);
  st.started(0, 0);
  for (let t = 0; t <= 3000; t += 20) {
    st.tick(t);
    const written = sent.reduce((n, x) => n + x.length, 0) / BYTES_PER_MS;
    assert.ok(written >= t, `underrun at ${t} ms (written ${written})`);
  }
  b.pcm = tone(300);
  let readyAt = 3000;
  for (let t = 3020; t <= 5000; t += 20) {
    st.tick(t);
    if (b.offsetMs != null && b.ref.leadMs >= 0) {
      const speechStart = b.offsetMs + b.ref.leadMs;
      assert.ok(
        speechStart - readyAt <= 500,
        `late sentence waited ${speechStart - readyAt} ms`,
      );
      return;
    }
  }
  assert.fail('b never started');
});

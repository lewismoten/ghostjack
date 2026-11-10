// Tests for the fast wake bleep (node --test tools/wake-fast-test.mjs): when WakeTrigger asks for a quick look,
// and the warm link (a stream with nothing to say yet) taking a tone and handing over, with a fake publisher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WakeTrigger } from '../src/converse-core.mjs';
import { SpeechStream, silence, sine } from '../src/speech-stream.mjs';
import { tonePcm } from '../src/reply.mjs';

const m = (o) => ({
  id: 1,
  voicedMs: 0,
  quietMs: 0,
  lengthMs: 0,
  now: 0,
  ...o,
});

test('no look before half a second is voiced', () => {
  const t = new WakeTrigger();
  assert.equal(t.check(m({ voicedMs: 400, lengthMs: 600, now: 100 })), null);
});
test('first look at 0.5 s voiced, then none until a burst goes quiet', () => {
  const t = new WakeTrigger();
  assert.equal(
    t.check(m({ voicedMs: 520, lengthMs: 700, now: 100 })),
    'voiced',
  );
  assert.equal(t.check(m({ voicedMs: 540, lengthMs: 800, now: 500 })), null);
  // quiet for 250 ms after more voice: the burst check
  assert.equal(
    t.check(m({ voicedMs: 700, quietMs: 260, lengthMs: 1100, now: 900 })),
    'burst',
  );
  // quiet again with no new voice: nothing more
  assert.equal(
    t.check(m({ voicedMs: 700, quietMs: 400, lengthMs: 1300, now: 1300 })),
    null,
  );
});
test('a wake word alone that is already quiet at the first look is a burst; spacing is kept', () => {
  const t = new WakeTrigger();
  assert.equal(
    t.check(m({ voicedMs: 600, quietMs: 300, lengthMs: 1000, now: 0 })),
    'burst',
  );
  assert.equal(
    t.check(m({ voicedMs: 800, quietMs: 300, lengthMs: 1200, now: 100 })),
    null,
  ); // inside the 300 ms spacing
});
test('long utterances are left to the ordinary partials; a new utterance resets', () => {
  const t = new WakeTrigger();
  assert.equal(t.check(m({ voicedMs: 3000, lengthMs: 4000, now: 0 })), null);
  assert.equal(
    t.check(m({ id: 2, voicedMs: 600, lengthMs: 800, now: 10 })),
    'voiced',
  );
  assert.equal(
    t.check(m({ id: 3, voicedMs: 600, lengthMs: 800, now: 400 })),
    'voiced',
  );
});

// a warm stream is a SpeechStream with no jobs yet
function warm() {
  const sent = [];
  const h = { ended: false };
  const st = new SpeechStream({
    openPublish: () => ({
      canWrite: () => true,
      write: (b) => sent.push(b),
      end: () => (h.ended = true),
      kill: () => {},
    }),
    cfg: {
      aheadMs: 600,
      fillAheadMs: 120,
      tailMs: 150,
      closeSlackMs: 300,
      idleEndMs: 4000,
      keepalive: 'tone',
      keepalivePeak: 0.003,
    },
    id: 'w',
  });
  st.begin('x', silence(40), 0);
  st.started(100, 100);
  return { st, sent, h };
}
const peak = (b) => {
  let p = 0;
  for (let i = 0; i + 1 < b.length; i += 2)
    p = Math.max(p, Math.abs(b.readInt16LE(i)));
  return p / 32767;
};

test('a warm stream with nothing to say stays open on a very quiet tone', () => {
  const { st, sent, h } = warm();
  for (let t = 100; t < 3000; t += 20) st.tick(t);
  assert.equal(h.ended, false);
  assert.ok(peak(Buffer.concat(sent)) <= 0.0031);
});
test('a tone added to the warm stream starts within the filler ahead, then the stream closes', () => {
  const { st, sent, h } = warm();
  for (let t = 100; t < 1000; t += 20) st.tick(t);
  const tone = sine(1000, 120, 0.02, 5);
  const job = { id: 'b', text: '', pcm: tone, fast: true };
  st.add(job);
  st.end();
  for (let t = 1000; t < 3000; t += 20) st.tick(t);
  assert.ok(job.offsetMs != null, 'the tone was written');
  // the tone's start is at most fillAhead (120 ms) + a tick after it was added, from the playing position
  assert.ok(
    job.publishAt + job.offsetMs - 0 <= 1000 + 160 + 100,
    `starts ${job.offsetMs}`,
  );
  assert.equal(h.ended, true);
  assert.ok(peak(Buffer.concat(sent)) >= 0.019);
});
test('a warm stream nobody uses ends itself after the idle limit', () => {
  const { st, h } = warm();
  for (let t = 100; t < 6500; t += 20) st.tick(t);
  assert.equal(st.ended, true);
  assert.equal(h.ended, true);
});
test('tonePcm is raw 16 kHz PCM scaled to the level', () => {
  const p = tonePcm('wake', 0.03);
  assert.equal(p.length % 2, 0);
  assert.ok(Math.abs(peak(p) - 0.7079 * 0.03) < 0.001);
});

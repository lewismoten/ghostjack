// One continuous publish for a whole reply. The camera's talk session costs 1.6 to 5.5 s to set up and its amp
// sleeps in gaps (2026-11-10 filmed test), so a reply is NOT one publish per sentence: this stream opens one
// publish, writes a wake pulse and lead once, then each sentence's PCM as soon as it is synthesized, with a
// short pause between sentences and filler (silence, or a barely audible tone) when the next one is not ready,
// and a tail at the end. It knows no ffmpeg and no clock: a publisher (say.mjs) and tick(now) drive it, so
// tests run it with a fake publisher and simulated time. Offsets are exact sample positions in the stream.
//
// publisher handle (what begin() opens): { canWrite(): bool, write(buf), end(), kill() }
// The owner calls tick(now) every ~20 ms and started(now, outMs) when the publish has really begun.

export const BYTES_PER_MS = 32; // 16 kHz, 16-bit, mono
const MS = (ms) => Math.round(ms * 16) * 2; // milliseconds to a whole number of samples, in bytes

export const DEFAULTS = {
  aheadMs: 1500, // how far ahead of playback to keep the camera's buffer
  pauseMs: 350, // natural pause between sentences
  tailMs: 1200, // silence at the end, after the last sentence
  closeSlackMs: 300, // close the publish when playback is this close to the end of the tail
  fillAheadMs: 400, // filler (a sentence not ready yet) is written only this far ahead, so a late sentence waits little
  startFallbackMs: 3000, // if the publisher never reports progress, treat the publish as begun after this long
  keepalive: 'silence', // 'silence' or 'tone' (a barely audible tone between sentences)
  keepalivePeak: 0.003, // tone amplitude, fraction of full scale (about -50 dBFS)
  idleEndMs: 8000, // a reply nobody closed ends itself after this long with nothing left to say
};

export const silence = (ms) => Buffer.alloc(MS(ms));
export function sine(hz, ms, peak, fadeMs = 10, startSample = 0) {
  const n = MS(ms) / 2,
    b = Buffer.alloc(n * 2),
    fade = (fadeMs * 16) | 0;
  for (let i = 0; i < n; i++) {
    let a = peak;
    if (fade) a *= Math.min(1, i / fade, (n - 1 - i) / fade);
    b.writeInt16LE(
      Math.round(
        a * 32767 * Math.sin((2 * Math.PI * hz * (startSample + i)) / 16000),
      ),
      i * 2,
    );
  }
  return b;
}
// 20 ms RMS frames, the same shape converse.mjs's echo gate reads.
export function envelope(pcm) {
  const env = [];
  for (let i = 0; i + 640 <= pcm.length; i += 640) {
    let sum = 0;
    for (let j = 0; j < 640; j += 2) sum += pcm.readInt16LE(i + j) ** 2;
    env.push(Math.sqrt(sum / 320));
  }
  return env;
}

export class SpeechStream {
  // opts: { openPublish(url, onProgress) -> handle, log(obj), now(), cfg }
  constructor({ openPublish, log = () => {}, cfg = {}, id = '', label = '' }) {
    this.openPublish = openPublish;
    this.log = log;
    this.cfg = { ...DEFAULTS, ...cfg };
    this.id = id;
    this.label = label;
    this.jobs = []; // { id, text, status, pcm: Buffer|null, ... }
    this.ended = false;
    this.stopped = false;
    this.finished = false;
    this.handle = null;
    this.written = 0; // bytes
    this.lead = null; // Buffer still to write
    this.cur = null; // { job, pos } speech being written
    this.next = 0; // index of the next job to start
    this.regionStart = 0; // byte where the next sentence's region begins (after the last sentence's speech)
    this.region = []; // buffers written since regionStart
    this.lastSpeechEnd = 0;
    this.tailLeft = null;
    this.t0 = null; // wall time of stream byte 0, known once the publish has begun (started())
    this.closing = false;
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  add(job) {
    job.pcm ??= null;
    this.jobs.push(job);
    this.drainedSince = null;
  }
  end() {
    this.ended = true;
  }

  // Open the publish. `lead` is the wake pulse and lead-in (Buffer), written first, once.
  begin(url, lead, now) {
    this.lead = lead;
    this.openedAt = now;
    this.drainedSince = now;
    if (this.jobs[0]) this.jobs[0].status = 'speaking'; // the lead-in is its lead
    this.handle = this.openPublish(url, (lagMs, at) => this.started(at, lagMs));
    this.log({
      ev: 'stream-open',
      stream: this.id,
      at: now,
      leadMs: lead.length / BYTES_PER_MS,
    });
  }

  // The publish has begun (the first progress report at `at`, which comes about `lagMs` after byte 0 went out).
  started(at, lagMs = 0) {
    if (this.firstByteAt) return;
    this.firstByteAt = at;
    this.t0 = at - lagMs;
    this.publishAt = this.t0;
    this.log({
      ev: 'first-byte',
      stream: this.id,
      at,
      publishAt: this.t0,
      setupMs: this.t0 - this.openedAt,
    });
    this.applyTimes();
  }

  applyTimes() {
    for (const j of this.jobs)
      if (j.offsetMs != null) j.publishAt = this.t0 + j.offsetMs;
  }
  playPos(now) {
    return this.t0 == null ? 0 : Math.max(0, (now - this.t0) * BYTES_PER_MS);
  }

  // The sentence on air at `now`: the last one whose region has begun (the first one during the lead-in).
  currentJob(now) {
    const pos = this.playPos(now);
    let cur = null;
    for (const j of this.jobs)
      if (j.offsetMs != null && j.offsetMs * BYTES_PER_MS <= pos) cur = j;
    return cur ?? this.jobs[0] ?? null;
  }

  emit(buf) {
    this.written += buf.length;
    this.region.push(buf);
    this.handle.write(buf);
  }

  filler(n) {
    n = Math.min(n, Math.max(0, this.fillTarget - this.written));
    n -= n % 2;
    if (!n) return Buffer.alloc(0);
    if (this.cfg.keepalive === 'tone')
      return sine(
        1000,
        n / BYTES_PER_MS,
        this.cfg.keepalivePeak,
        0,
        this.written / 2,
      );
    return Buffer.alloc(n);
  }

  // Next chunk of at most n bytes, or null when the whole stream (tail included) is written.
  nextChunk(n) {
    n -= n % 2;
    if (this.lead?.length) {
      const c = this.lead.subarray(0, n);
      this.lead = this.lead.subarray(n);
      return c;
    }
    if (this.cur) {
      const { job } = this.cur;
      const c = job.pcm.subarray(this.cur.pos, this.cur.pos + n);
      this.cur.pos += c.length;
      if (this.cur.pos >= job.pcm.length) {
        this.cur = null;
        this.lastSpeechEnd = this.written + c.length;
        this.regionStart = this.lastSpeechEnd;
        this.region = [];
        this.lastEnded = job;
      }
      this.spokeChunk = true;
      return c;
    }
    // skip sentences that failed or were cancelled
    while (this.next < this.jobs.length && this.jobs[this.next].failed)
      this.next++;
    const job = this.jobs[this.next];
    if (job) {
      if (!job.pcm) return this.filler(n); // not ready: keep the stream alive
      const pauseLeft = this.next
        ? MS(this.cfg.pauseMs) - (this.written - this.lastSpeechEnd)
        : 0;
      if (pauseLeft > 0) return Buffer.alloc(Math.min(n, pauseLeft));
      // speech starts here: its region runs from the end of the last sentence's speech
      const region = Buffer.concat(this.region);
      const speechAt = this.written;
      job.offsetMs = this.regionStart / BYTES_PER_MS;
      job.ref = {
        env: envelope(Buffer.concat([region, job.pcm])),
        leadMs: (speechAt - this.regionStart) / BYTES_PER_MS,
        speechMs: job.pcm.length / BYTES_PER_MS,
      };
      this.applyTimes();
      job.status = 'speaking';
      this.log({
        ev: 'sentence',
        stream: this.id,
        job: job.id,
        offsetMs: job.offsetMs,
        leadMs: job.ref.leadMs,
        speechMs: job.ref.speechMs,
        publishAt: job.publishAt,
        chars: job.text?.length ?? 0,
      });
      this.cur = { job, pos: 0 };
      this.next++;
      return this.nextChunk(n);
    }
    if (!this.ended) return this.filler(n);
    this.tailLeft ??= MS(this.cfg.tailMs);
    if (this.tailLeft <= 0) return null;
    const c = Buffer.alloc(Math.min(n, this.tailLeft));
    this.tailLeft -= c.length;
    return c;
  }

  tick(now) {
    if (!this.handle || this.finished || this.closing) return;
    if (this.t0 == null && now - this.openedAt > this.cfg.startFallbackMs)
      this.started(now, 100);
    const play = this.playPos(now);
    this.fillTarget = play + this.cfg.fillAheadMs * BYTES_PER_MS;
    const target = play + this.cfg.aheadMs * BYTES_PER_MS;
    let wroteAll = false;
    while (this.written < target && this.handle.canWrite()) {
      const c = this.nextChunk(Math.min(target - this.written, MS(100)));
      if (c === null) {
        wroteAll = true;
        break;
      }
      if (!c.length) break;
      this.emit(c);
    }
    // a reply nobody closed: end it when nothing has been left to say for a while
    const drained =
      !this.cur &&
      !this.lead?.length &&
      !this.jobs.slice(this.next).some((j) => !j.failed);
    if (!drained) this.drainedSince = null;
    else if (!this.ended) {
      this.drainedSince ??= now;
      if (now - this.drainedSince > this.cfg.idleEndMs) {
        this.ended = true;
        this.log({ ev: 'idle-end', stream: this.id, at: now });
      }
    }
    // statuses follow playback
    for (const j of this.jobs)
      if (j.status === 'speaking' && j.offsetMs != null) {
        const end = j.offsetMs + j.ref.leadMs + j.ref.speechMs;
        if (play >= end * BYTES_PER_MS) j.status = 'done';
      }
    if (
      (wroteAll || (this.tailLeft === 0 && this.ended)) &&
      play >= this.written - MS(this.cfg.closeSlackMs)
    ) {
      this.closing = true;
      this.handle.end();
    }
  }

  // Called by the owner when the publish process ends (or fails to start).
  finish(now, error) {
    if (this.finished) return;
    this.finished = true;
    this.endedAt = now;
    for (const j of this.jobs)
      if (j.status === 'speaking' || j.status === 'queued')
        j.status = this.stopped ? 'cancelled' : error ? 'failed' : 'done';
    this.log({
      ev: 'stream-end',
      stream: this.id,
      at: now,
      stopped: this.stopped,
      ...(error ? { error: String(error).slice(0, 120) } : {}),
      writtenMs: this.written / BYTES_PER_MS,
      sentences: this.jobs.map((j) => ({
        job: j.id,
        offsetMs: j.offsetMs ?? null,
        status: j.status,
      })),
    });
    this.resolveDone();
  }

  // Barge-in or stopAll: cut now. Returns the sentence that was on air (or null). The caller then frees the
  // speaker (say.mjs sends a short silent publish, as the single-line path did).
  stop(now) {
    if (this.stopped || this.finished) return this.currentJob(now);
    this.stopped = true;
    const cut = this.currentJob(now);
    for (const j of this.jobs) {
      if (j === cut) {
        j.status = 'cancelled';
        j.stoppedAt = now;
      } else if (
        j.status === 'queued' ||
        j.status === 'speaking' ||
        j.offsetMs == null
      )
        j.status = 'cancelled';
    }
    this.handle?.kill();
    return cut;
  }
}

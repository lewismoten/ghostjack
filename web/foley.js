// Glassmouth's foley: shutter, film projector, CRT warm-up, relay clacks, static, servo whir.
// All made with the Web Audio API (noise, oscillators, filters); no samples. Everything is gated by the
// "Sound effects" switch and has its own small level under the page's master gain.
import { audio, masterNode, state, tone } from './sound.js';

const LEVEL = 0.8;
let bus = null,
  noiseBuf = null;
function out() {
  const c = audio();
  if (!bus) {
    bus = c.createGain();
    bus.gain.value = LEVEL;
    bus.connect(masterNode());
    const len = c.sampleRate * 2;
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return c;
}
// A burst of filtered noise: a click, a thump, a scrape or a hiss, depending on the filter.
function burst(at, dur, { freq = 2000, q = 1, type = 'bandpass', gain = 0.2 }) {
  const c = out(),
    t = c.currentTime + at,
    n = c.createBufferSource(),
    f = c.createBiquadFilter(),
    g = c.createGain();
  n.buffer = noiseBuf;
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(f);
  f.connect(g);
  g.connect(bus);
  n.start(t, Math.random());
  n.stop(t + dur + 0.02);
}
// A looping noise or tone you can fade out; returns { stop(seconds) }.
function loop(build) {
  const c = out(),
    g = c.createGain(),
    nodes = [];
  g.gain.value = 0.0001;
  g.connect(bus);
  build(c, g, nodes);
  return {
    stop(sec = 0.6) {
      const t = c.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + sec);
      for (const n of nodes) n.stop(t + sec + 0.05);
    },
  };
}
const noop = { stop() {} };
const on = () => state.sfx;
const noiseSrc = (c, nodes, dest) => {
  const n = c.createBufferSource();
  n.buffer = noiseBuf;
  n.loop = true;
  n.connect(dest);
  n.start();
  nodes.push(n);
  return n;
};

export const foley = {
  // A mechanical shutter (two clicks) and a short film-advance whir.
  shutter() {
    if (!on()) return;
    burst(0, 0.03, { freq: 3200, q: 2, gain: 0.35 });
    tone(140, 0, 0.06, {
      type: 'triangle',
      gain: 0.2,
      to: 70,
      dest: (out(), bus),
    });
    burst(0.07, 0.04, { freq: 2400, q: 2, gain: 0.28 });
    for (let i = 0; i < 6; i++)
      burst(0.18 + i * 0.045, 0.02, { freq: 1800, q: 3, gain: 0.08 });
  },
  // Someone handling gear: a few muffled thumps and scrapes at uneven spacing.
  shuffle() {
    if (!on()) return;
    let t = 0;
    for (let i = 0; i < 4; i++) {
      burst(t, 0.09, { freq: 350 + Math.random() * 300, q: 1, gain: 0.3 });
      burst(t + 0.03, 0.12, { freq: 1200, q: 0.7, gain: 0.07 });
      t += 0.1 + Math.random() * 0.17;
    }
  },
  // An old film projector: motor whir, sprocket clatter that settles into a rhythm.
  projector() {
    if (!on()) return noop;
    return loop((c, g, nodes) => {
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.5, c.currentTime + 0.5);
      const motor = c.createOscillator(),
        mf = c.createBiquadFilter(),
        mg = c.createGain();
      motor.type = 'sawtooth';
      motor.frequency.setValueAtTime(40, c.currentTime);
      motor.frequency.exponentialRampToValueAtTime(96, c.currentTime + 1.1);
      mf.type = 'lowpass';
      mf.frequency.value = 500;
      mg.gain.value = 0.1;
      motor.connect(mf);
      mf.connect(mg);
      mg.connect(g);
      motor.start();
      nodes.push(motor);
      // Clatter: noise gated by a square wave that speeds up, then holds at 18 beats a second.
      const gate = c.createGain(),
        hp = c.createBiquadFilter(),
        lfo = c.createOscillator(),
        lg = c.createGain();
      gate.gain.value = 0;
      hp.type = 'bandpass';
      hp.frequency.value = 2200;
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(3, c.currentTime);
      lfo.frequency.exponentialRampToValueAtTime(18, c.currentTime + 1.3);
      lg.gain.value = 0.12;
      lfo.connect(lg);
      lg.connect(gate.gain);
      noiseSrc(c, nodes, hp);
      hp.connect(gate);
      gate.connect(g);
      lfo.start();
      nodes.push(lfo);
    });
  },
  // An old CRT TV warming up: power thunk, a high whine fading in, static hiss.
  crt() {
    if (!on()) return noop;
    tone(60, 0, 0.18, { type: 'sine', gain: 0.35, to: 40, dest: (out(), bus) });
    burst(0, 0.05, { freq: 1500, q: 1, gain: 0.3 });
    return loop((c, g, nodes) => {
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.5, c.currentTime + 0.9);
      const w = c.createOscillator(),
        wg = c.createGain();
      w.type = 'sine';
      w.frequency.setValueAtTime(5000, c.currentTime);
      w.frequency.exponentialRampToValueAtTime(8200, c.currentTime + 1.6);
      wg.gain.value = 0.035;
      w.connect(wg);
      wg.connect(g);
      w.start();
      nodes.push(w);
      const hp = c.createBiquadFilter(),
        hg = c.createGain();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      hg.gain.value = 0.05;
      noiseSrc(c, nodes, hp);
      hp.connect(hg);
      hg.connect(g);
    });
  },
  // The line closing: relay clack. Opening a line also gets one.
  clack() {
    if (!on()) return;
    burst(0, 0.025, { freq: 2600, q: 2, gain: 0.35 });
    tone(180, 0, 0.05, {
      type: 'square',
      gain: 0.1,
      to: 90,
      dest: (out(), bus),
    });
    burst(0.07, 0.03, { freq: 1900, q: 2, gain: 0.25 });
  },
  staticBurst(sec = 0.35) {
    if (!on()) return;
    burst(0, sec, { freq: 2500, q: 0.4, type: 'highpass', gain: 0.22 });
  },
  softClick() {
    if (on()) burst(0, 0.02, { freq: 1500, q: 1.5, gain: 0.14 });
  },
  // A subtle servo whir for a pan or tilt step lasting about `sec` seconds.
  servo(sec = 0.7) {
    if (!on()) return;
    const c = out(),
      t = c.currentTime,
      o = c.createOscillator(),
      f = c.createBiquadFilter(),
      g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(150, t);
    o.frequency.linearRampToValueAtTime(190, t + sec * 0.4);
    o.frequency.linearRampToValueAtTime(130, t + sec);
    f.type = 'bandpass';
    f.frequency.value = 700;
    f.Q.value = 2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.035, t + 0.08);
    g.gain.setValueAtTime(0.035, t + sec - 0.12);
    g.gain.linearRampToValueAtTime(0.0001, t + sec);
    o.connect(f);
    f.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + sec + 0.05);
  },
  // A soft "light traveling" whoosh: filtered noise sweeping across the stereo field in the pulse's
  // direction (dir 1 = left to right), with an echo tail (delay + feedback + lowpass). Quiet and rare.
  whoosh(dir = 1) {
    if (!on()) return;
    const c = out(),
      t = c.currentTime,
      n = c.createBufferSource(),
      f = c.createBiquadFilter(),
      g = c.createGain(),
      p = c.createStereoPanner(),
      d = c.createDelay(1),
      fb = c.createGain(),
      lp = c.createBiquadFilter(),
      wet = c.createGain();
    n.buffer = noiseBuf;
    f.type = 'bandpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(3200, t + 0.5);
    f.frequency.exponentialRampToValueAtTime(900, t + 1.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    p.pan.setValueAtTime(-0.7 * dir, t);
    p.pan.linearRampToValueAtTime(0.7 * dir, t + 1.3);
    d.delayTime.value = 0.28;
    fb.gain.value = 0.35;
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    wet.gain.value = 0.5;
    n.connect(f);
    f.connect(g);
    g.connect(p);
    p.connect(bus);
    p.connect(d);
    d.connect(lp);
    lp.connect(fb);
    fb.connect(d);
    lp.connect(wet);
    wet.connect(bus);
    n.start(t, Math.random());
    n.stop(t + 1.5);
    // Let the echo ring out, then drop the delay loop.
    setTimeout(() => {
      fb.disconnect();
      wet.disconnect();
    }, 3500);
  },
  // Tape reel: a motor thunk and a short spin-up (start) or a spin-down and clunk (stop).
  reel(start = true) {
    if (!on()) return;
    out();
    burst(0, 0.04, { freq: 900, q: 1, gain: 0.3 });
    tone(start ? 70 : 120, 0, 0.5, {
      type: 'sawtooth',
      gain: 0.05,
      to: start ? 140 : 40,
      dest: (out(), bus),
    });
    for (let i = 0; i < 5; i++)
      burst(0.1 + i * (start ? 0.07 : 0.1), 0.03, {
        freq: 1600,
        q: 3,
        gain: 0.07,
      });
    if (!start) burst(0.6, 0.05, { freq: 500, q: 1, gain: 0.25 });
  },
};

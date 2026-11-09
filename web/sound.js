// Optional sound, all made with the Web Audio API (no samples). Both switches are off until the user
// turns them on, and nothing starts before a click. Settings are remembered in localStorage.
let ctx = null, master = null, musicNodes = null;
const get = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const put = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private window */ } };
export const state = { sfx: get('gm-sfx'), music: get('gm-music') };

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function tone(freq, start, dur, { type = 'sine', gain = 0.12, to = freq, dest } = {}) {
  const c = audio(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime + start;
  o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest || master); o.start(t); o.stop(t + dur + 0.05);
}
export const sfx = {
  blip() { if (state.sfx) tone(880, 0, 0.07, { type: 'square', gain: 0.05, to: 1320 }); },
  relay() { if (state.sfx) { tone(2200, 0, 0.03, { type: 'square', gain: 0.07, to: 300 }); tone(1400, 0.07, 0.04, { type: 'square', gain: 0.05, to: 200 }); } },
  powerUp() { if (state.sfx) { tone(110, 0, 0.9, { type: 'sawtooth', gain: 0.07, to: 880 }); tone(660, 0.5, 0.4, { gain: 0.08, to: 1760 }); } },
  error() { if (state.sfx) { tone(900, 0, 0.12, { type: 'square', gain: 0.06 }); tone(600, 0.16, 0.18, { type: 'square', gain: 0.06 }); } },
};
export function setSfx(on) { state.sfx = on; put('gm-sfx', on); if (on) { audio(); sfx.blip(); } }
export function setMusic(on) {
  state.music = on; put('gm-music', on);
  if (on && !musicNodes) {
    const c = audio(), g = c.createGain(), f = c.createBiquadFilter(), lfo = c.createOscillator(), lg = c.createGain();
    g.gain.value = 0.0001; g.gain.exponentialRampToValueAtTime(0.06, c.currentTime + 2);
    f.type = 'lowpass'; f.frequency.value = 600; lfo.frequency.value = 0.08; lg.gain.value = 300; lfo.connect(lg); lg.connect(f.frequency);
    f.connect(g); g.connect(master);
    const oscs = [55, 82.4, 110, 165, 220.5].map((fr, i) => { const o = c.createOscillator(); o.type = i % 2 ? 'sawtooth' : 'triangle'; o.frequency.value = fr; o.detune.value = (i - 2) * 6; o.connect(f); o.start(); return o; });
    lfo.start(); musicNodes = { g, oscs: [...oscs, lfo] };
  } else if (!on && musicNodes) {
    const { g, oscs } = musicNodes; musicNodes = null;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
    setTimeout(() => oscs.forEach((o) => o.stop()), 900);
  }
}

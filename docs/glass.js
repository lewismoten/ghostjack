// Glassmouth's browser-side voice: short dry night-shift-guard lines for page events (docs/glassmouth.md,
// "Lines"). line(event) always returns the text (the page shows it in the status line, so nothing depends
// on sound). If the "Voice" switch is on it also speaks it with the browser's own local voices
// (speechSynthesis): lower, older-sounding English voice if one exists, a little slow, one line at a
// time (a new line cancels a stale one), ambient music ducked meanwhile. Nothing speaks before a click.
import * as snd from './sound.js';

// Wording rules (so a text-to-speech voice cannot misread or mishear a line): no heteronyms (live, read,
// lead, record, close, wind, tear, minute, object, present, content, use), no abbreviations or symbols,
// no words that run together into something rude when spoken fast (no "shift" or "duck"), and none that
// sound like the camera speaker's alarms. Keep lines short and plain.
export const LINES = {
  jackIn: ["Clocked in. Line's open.", 'On the air.', "Line's hot."],
  jackFail: [
    'No carrier.',
    'Nothing on the line.',
    'No carrier. Check the cable.',
  ],
  lost: ['Lost the line.', 'Line went flat. Lost it.'],
  snapshot: ['Hold on.', 'Hold still.', 'Easy now.'],
  live: ['Warming up the eye.', 'Shuffling the reels.', 'Give it a second.'],
  liveOpen: ["Eye's open.", "There's the eye.", "Eye's open. Nobody blink."],
  liveStop: ["Eye's shut.", 'Closing the eye.'],
  nightOn: ['Lights out. Going infrared.', 'Lights out. Infrared it is.'],
  nightAuto: [
    'Lights back on. Auto mode.',
    'Back to auto. The lights are my own again.',
  ],
  moveStart: ['On my way.', 'Turning. Hang on.'],
  moveDone: ['There.', 'There. That is the angle.'],
  recStart: ["Tape's rolling.", 'Rolling tape.'],
  recStop: ["Tape's in the can.", "That's a wrap. Tape's in the can."],
  recCap: ['Out of tape.', 'Out of tape. The reel is full.'],
  wall: ["That's the wall.", "That's the end of the neck."],
  limitsStart: ['Mapping the walls.', 'Walking the walls. Hold still.'],
  limitsDone: [
    'Walls mapped. Back to center.',
    'Got the walls. Back to center.',
  ],
  limitsStop: ['Mapping stopped.', 'Standing down. Mapping stopped.'],
  say: ['Patching you through.', 'Opening the speaker line.'],
};
// Safety net: spoken text only (the status line keeps the original). Lines should not need it.
const PRONOUNCE = [[/\blive\b/gi, 'lyve']];
const forVoice = (t) => PRONOUNCE.reduce((x, [re, to]) => x.replace(re, to), t);
const pick = (list, avoid) => {
  const pool = list.length > 1 ? list.filter((l) => l !== avoid) : list;
  return pool[Math.floor(Math.random() * pool.length)];
};
const lastLine = {};
let voice = null;
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
// Lower, older-sounding English voices first (names of macOS, Windows and Android voices).
const OLD =
  /daniel|fred|ralph|alex|bruce|reed|eddy|grandpa|george|david|mark|lee|rocko|junior/i;
function chooseVoice() {
  const en = (synth?.getVoices() || []).filter((v) => /^en[-_]/i.test(v.lang));
  const local = en.filter((v) => v.localService);
  const pool = local.length ? local : en;
  voice = pool.find((v) => OLD.test(v.name)) || pool[0] || null;
}
if (synth) {
  chooseVoice();
  synth.addEventListener?.('voiceschanged', chooseVoice);
}
function speak(text) {
  if (!synth || !snd.state.voice) return;
  synth.cancel(); // never more than one line queued: a stale one is dropped
  const u = new SpeechSynthesisUtterance(forVoice(text));
  if (voice) u.voice = voice;
  u.lang = voice?.lang || 'en-US';
  u.rate = 0.88;
  u.pitch = 0.75;
  u.volume = 0.8;
  u.onstart = () => snd.duck(true);
  u.onend = u.onerror = () => snd.duck(false);
  synth.speak(u);
}
// Pick a variant at random (never the same one twice running), speak it if Voice is on, return it.
export function line(event) {
  const text = pick(LINES[event], lastLine[event]);
  lastLine[event] = text;
  speak(text);
  return text;
}
export const hasVoice = () => !!synth;

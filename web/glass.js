// Glassmouth's browser-side voice: short dry night-shift-guard lines for page events (docs/glassmouth.md,
// "Lines"). line(event) always returns the text (the page shows it in the status line, so nothing depends
// on sound). If the "Voice" switch is on it also speaks it with the browser's own local voices
// (speechSynthesis): lower, older-sounding English voice if one exists, a little slow, one line at a
// time (a new line cancels a stale one), ambient music ducked meanwhile. Nothing speaks before a click.
import * as snd from './sound.js';
import { LINES } from './lines.js';
export { LINES };
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
let report = null;
// fn(speaking, text) is called as each spoken line starts and ends (app.js sends it to the bridge).
export const onSpeech = (fn) => (report = fn);
function speak(text) {
  if (!synth || !snd.state.voice) return;
  synth.cancel(); // never more than one line queued: a stale one is dropped
  const u = new SpeechSynthesisUtterance(forVoice(text));
  if (voice) u.voice = voice;
  u.lang = voice?.lang || 'en-US';
  u.rate = 0.88;
  u.pitch = 0.75;
  u.volume = 0.8;
  // Tell the bridge when the line is in the room (its microphone would hear it as Lewis). Each line reports
  // its end once: onend, onerror, or a timeout if the browser never fires either.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(guard);
    snd.duck(false);
    report?.(false, text);
  };
  const guard = setTimeout(finish, 3000 + text.length * 120);
  u.onstart = () => {
    snd.duck(true);
    report?.(true, text);
  };
  u.onend = u.onerror = finish;
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

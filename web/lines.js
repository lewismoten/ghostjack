// Glassmouth's spoken lines (docs/glassmouth.md, "Lines"). Plain data with no DOM, so the page (glass.js) and
// the bridge (src/page-voice.mjs, which must know them to drop them from the microphone) both import it.

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
  nightOff: [
    'Infrared off. Color only.',
    'No infrared. I will take what light there is.',
  ],
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

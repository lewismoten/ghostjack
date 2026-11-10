// Measure the speaker-to-microphone delay and echo ratio on the real camera (run with the bridge up and
// Lewis in the room, no one talking): plays three 0.5 s tone bursts with POST /api/play, records the
// microphone with POST /api/listen at the same time, and prints the delay (for GJ_ECHO_DELAY_MS) and how
// loud the echo is. Quiet bursts only (level 0.02). Usage: node tools/echo-calibrate.mjs [base] (token
// from ~/.config/ghostjack/token). Not run in CI: it needs a camera.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { estimateLag } from '../src/converse-turns.mjs';
import { wavFromPcm, RATE, rms } from '../src/converse-core.mjs';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const token = readFileSync(
  homedir() + '/.config/ghostjack/token',
  'utf8',
).trim();
const H = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

// 0.5 s bursts at 800 Hz, 1.5 s apart, 7 s long
const pcm = Buffer.alloc(RATE * 2 * 7);
const refEnv = [];
for (let i = 0; i < RATE * 7; i++) {
  const t = i / RATE;
  const on = t % 1.5 < 0.5 && t > 0.5;
  pcm.writeInt16LE(
    on ? Math.round(Math.sin(2 * Math.PI * 800 * t) * 14000) : 0,
    i * 2,
  );
}
for (let i = 0; i + 640 <= pcm.length; i += 640) refEnv.push(rms(pcm, i, 640));

const listen = fetch(`${base}/api/listen`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ seconds: 14 }),
});
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 500));
const played = await fetch(
  `${base}/api/play?level=0.02&chime=false&band=false`,
  {
    method: 'POST',
    headers: { Authorization: H.Authorization, 'Content-Type': 'audio/wav' },
    body: wavFromPcm(pcm),
  },
);
const playStart = Date.now();
const rec = Buffer.from(await (await listen).arrayBuffer());
if (!played.ok || !rec.length) throw new Error('play or listen failed');
const raw = execFileSync(
  '/opt/homebrew/bin/ffmpeg',
  [
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    'pipe:1',
  ],
  { input: rec, maxBuffer: 1 << 26 },
);
const micEnv = [];
for (let i = 0; i + 640 <= raw.length; i += 640) micEnv.push(rms(raw, i, 640));
// the tone starts 1 s lead + wake pulse etc. into the publish: the file here is the lead-in plus the bursts
const { lag } = estimateLag(refEnv, micEnv, 400);
const peak = (a) => Math.max(...a);
console.log(`publish started ${playStart - t0} ms after recording began`);
console.log(
  `best match: microphone envelope lags the played file by ${lag * 20} ms (includes the 1 s lead-in the bridge adds)`,
);
console.log(
  `echo ratio (mic peak / played peak): ${(peak(micEnv) / peak(refEnv)).toFixed(3)}`,
);
console.log(
  'Subtract the publish lead-in (1.63 s for a plain say; 0.1 s for fast) to get GJ_ECHO_DELAY_MS.',
);

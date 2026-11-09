// Speak through the camera's speaker. One talker at a time: requests wait in a queue.
// Speech comes from synthesize() (macOS `say` today; swap in Pocket TTS or Kokoro by replacing that one function:
// it must write an audio file ffmpeg can read and return its path). See docs/bridge.md.
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as camera from './camera.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const TMP = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
const CHAIN = (level) => `highpass=f=300,lowpass=f=3000,acompressor=threshold=-20dB:ratio=3:attack=5:release=100,volume=${level}`;
const jobs = new Map(); // id -> { status, text, error? }
const queue = [];
let busy = false;

export function voices() {
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], (err, out) => {
      if (err) return resolve([]);
      resolve(out.split('\n').map((l) => /^(.+?)\s{2,}([a-z]{2}[_-][A-Za-z]+)/.exec(l)).filter((m) => m && /^en[_-]/.test(m[2])).map((m) => m[1].trim()));
    });
  });
}

// Boundary for other voices: (text, {voice, rate}) -> path of an audio file.
async function synthesize(text, { voice, rate }) {
  const file = join(TMP, `say-${randomBytes(6).toString('hex')}.aiff`);
  const args = ['-o', file, '-r', String(rate)];
  if (voice) args.push('-v', voice);
  await new Promise((resolve, reject) => {
    const p = spawn('say', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('close', (c) => (c ? reject(new Error('speech synthesis failed')) : resolve()));
    p.stdin.end(text);
  });
  return file;
}

function publish(inputArgs, url) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-re', ...inputArgs, '-c:a', 'aac', '-ar', '16000', '-ac', '1', '-b:a', '64k', '-f', 'flv', url], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (c) => (c ? reject(new Error('publish failed')) : resolve()));
  });
}

// 3 s of silence first: the camera starts playing late and clips the first seconds.
const silence = (s) => ['-f', 'lavfi', '-t', String(s), '-i', 'anullsrc=r=16000:cl=mono'];

async function speak(job) {
  mkdirSync(TMP, { recursive: true });
  let file = null;
  try {
    file = await synthesize(job.text, job);
    job.status = 'speaking';
    const url = await camera.talkUrl();
    try {
      await publish([...silence(3), '-i', file, '-filter_complex', `[0:a]aresample=16000[a0];[1:a]aresample=16000,${CHAIN(job.level)}[a1];[a0][a1]concat=n=2:v=0:a=1[o]`, '-map', '[o]'], url);
    } catch (e) {
      // Free the slot with a short silent publish to the same address.
      await publish(silence(1), url).catch(() => {});
      throw e;
    }
    job.status = 'done';
  } catch (e) {
    job.status = 'failed'; job.error = String(e.message || e).slice(0, 120);
  } finally {
    if (file && existsSync(file)) rmSync(file, { force: true });
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await speak(queue.shift());
  busy = false;
}

export function say({ text, voice, level, rate }) {
  const id = randomBytes(6).toString('hex');
  const job = { id, status: 'queued', text, voice: voice || '', level, rate };
  jobs.set(id, job);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  queue.push(job);
  pump();
  return { id, status: job.status };
}

export const sayStatus = (id) => { const j = jobs.get(id); return j && { id, status: j.status, ahead: queue.indexOf(j), ...(j.error ? { error: j.error } : {}) }; };
export const queueLength = () => queue.length;

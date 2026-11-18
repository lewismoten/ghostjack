// Review regressions: simulated subprocesses and temporary files only; no devices or bridge.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';

const dir = fs.mkdtempSync(join(tmpdir(), 'gj-review-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const source = (file) =>
  fs.readFileSync(new URL(file, import.meta.url), 'utf8');
// Execute the production module with explicit dependencies. No native programs run.
function load(file, dependencies, names, transform = (code) => code) {
  const code = source(file)
    .replace(/^import[\s\S]*?from '[^']+';\n/gm, '')
    .replace(/\bexport /g, '')
    .replaceAll(
      'import.meta.url',
      JSON.stringify(new URL(file, import.meta.url).href),
    );
  return runInNewContext(`${transform(code)}\n;({${names}})`, {
    ...fs,
    dirname,
    join,
    fileURLToPath,
    randomBytes,
    Buffer,
    setTimeout,
    clearTimeout,
    process: { env: { GJ_CAPTURES: dir } },
    ...dependencies,
  });
}

process.env.GJ_SETTINGS_FILE = join(dir, 'settings.json');
process.env.GJ_CONVERSE_HISTORY = join(dir, 'history.jsonl');
const { setAgentVoice } = await import('../src/settings.mjs');
const reply = await import('../src/reply.mjs');
setAgentVoice(false);

test('GJ-03 rejected continuation leaves the reply character budget intact', () => {
  const r = reply.append({ text: 'a'.repeat(2390) });
  assert.throws(() => reply.append({ id: r.id, text: 'b'.repeat(20) }), {
    code: 400,
  });
  assert.doesNotThrow(() => reply.append({ id: r.id, text: 'c'.repeat(5) }));
  assert.equal(reply.append({ id: r.id, end: true }).closed, true);
});

test('GJ-04 rejected tone keys and values leave all tones unchanged', () => {
  const before = { ...reply.tones };
  try {
    assert.throws(() => reply.setTones({ done: true, bogus: 1 }), {
      code: 400,
    });
    assert.deepEqual(reply.tones, before);
    assert.throws(() => reply.setTones({ done: true, wake: 'yes' }), {
      code: 400,
    });
    assert.deepEqual(reply.tones, before);
  } finally {
    Object.assign(reply.tones, before);
  }
});

function recording(env = {}) {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.end = () => proc.emit('close', 0);
  proc.kill = () => {};
  const rec = load(
    '../src/record.mjs',
    {
      process: { env: { GJ_CAPTURES: dir, ...env } },
      camera: { streamUrl: async () => 'simulated-input' },
      spawn: () => proc,
      // Fail closed if the production code attempts any access outside our temp directory.
      mkdirSync: (p, opts) => {
        assert.equal(p, dir);
        fs.mkdirSync(p, opts);
      },
      existsSync: (p) => {
        assert.equal(p, dir);
        return fs.existsSync(p);
      },
    },
    'start, stop, get, sweep, cleanup',
    // Directory configuration has its own regression; isolate lifecycle tests even on old code.
    (code) =>
      code.replace(
        /const DIR = [\s\S]*?;/,
        'const DIR = process.env.GJ_CAPTURES;',
      ),
  );
  return { rec, proc };
}

test('GJ-01 sweep removes stale agent captures and both upload files only', () => {
  const files = [
    'agent-abcdef123456.mp4',
    'agent-abcdef123456.wav',
    'agent-abcdef123456.m4a',
    'play-abcdef123456.in',
    'play-abcdef123456.wav',
  ];
  const keep = ['other.wav', 'agent-not-ours.wav', 'play-not-ours.in'];
  for (const f of [...files, ...keep])
    fs.writeFileSync(join(dir, f), 'fixture');
  recording().rec.sweep();
  for (const f of files) assert.equal(fs.existsSync(join(dir, f)), false, f);
  for (const f of keep) assert.equal(fs.existsSync(join(dir, f)), true, f);
});

test('GJ-08 nonzero recording exit fails even with a large file', async () => {
  const { rec, proc } = recording();
  const r = await rec.start();
  fs.writeFileSync(rec.get(r.id).file, Buffer.alloc(2000));
  proc.emit('close', 1);
  assert.equal(rec.get(r.id).status, 'failed');
  assert.equal(fs.existsSync(rec.get(r.id).file), false);
});

test('GJ-08 successful and deliberately stopped recordings remain usable', async () => {
  for (const stop of [false, true]) {
    const { rec, proc } = recording();
    const r = await rec.start();
    fs.writeFileSync(rec.get(r.id).file, Buffer.alloc(2000));
    if (stop) await rec.stop();
    else proc.emit('close', 0);
    assert.equal(rec.get(r.id).status, 'ready');
    rec.cleanup();
  }
});

test('GJ-09 fake-camera sweep preserves existing recordings', () => {
  const file = join(dir, 'rec-abcdef123456.mp4');
  fs.writeFileSync(file, 'fixture');
  recording({ GJ_FAKE_CAMERA: 'simulated-camera' }).rec.sweep();
  assert.equal(fs.existsSync(file), true);
  recording().rec.sweep();
  assert.equal(fs.existsSync(file), false);
});

test('GJ-09 all media directories honor the capture override', () => {
  for (const [file, name] of [
    ['record', 'DIR'],
    ['media', 'DIR'],
    ['say', 'TMP'],
    ['paths', 'TMP'],
    ['../tools/fake-camera', 'DIR'],
  ]) {
    const text = source(`../src/${file}.mjs`);
    const declaration = text.match(
      new RegExp(`(?:export )?const ${name} =\\s*[\\s\\S]*?;`),
    )[0];
    const value = runInNewContext(
      `${declaration.replace('export ', '').replaceAll('import.meta.url', "'file:///simulated/src/module.mjs'")}\n${name}`,
      {
        process: { env: { GJ_CAPTURES: dir } },
        dirname,
        join,
        fileURLToPath,
      },
    );
    assert.equal(value, dir, file);
  }
});

test('GJ-09 selftest isolates captures, settings, and fake camera output', () => {
  // Evaluate only setup, with an entirely virtual filesystem and spawn spy.
  let childEnv;
  let code = source('./agent-api-selftest.mjs').split("let log = '';")[0];
  code = code
    .replace(/^import[\s\S]*?from '[^']+';\n/gm, '')
    .replaceAll(
      'import.meta.url',
      "'file:///simulated/tools/agent-api-selftest.mjs'",
    );
  runInNewContext(code, {
    dirname,
    join,
    tmpdir: () => '/temporary',
    fileURLToPath,
    process: { env: {} },
    mkdirSync() {},
    writeFileSync() {},
    chmodSync() {},
    mkdtempSync: (prefix) => `${prefix}unique`,
    spawn: (_exe, _args, opts) => {
      childEnv = opts.env;
    },
  });
  assert.ok(childEnv.GJ_CAPTURES?.startsWith('/temporary/'));
  assert.ok(childEnv.GJ_SPEAKERS_LOCAL.startsWith('/temporary/'));
});

test('GJ-02 snapshot conversion failure reaches the HTTP 502 catch', async () => {
  const server = source('../src/server.mjs');
  const route = server.slice(
    server.indexOf("    if (route === 'GET /api/snapshot.jpg')"),
    server.indexOf("    if (route === 'POST /api/goto')"),
  );
  const catcher = server.slice(
    server.lastIndexOf('  } catch (e) {'),
    server.indexOf('\n});\n\nfunction stop()'),
  );
  const res = {
    headersSent: false,
    status: null,
    writeHead(status) {
      this.headersSent = true;
      this.status = status;
    },
    end() {},
  };
  await runInNewContext(`(async () => { try { ${route} ${catcher} })()`, {
    route: 'GET /api/snapshot.jpg',
    url: { searchParams: new URLSearchParams('width=320') },
    cameras: { pickVideo: async () => ({}), isTethys: () => true },
    camera: { snapshot: async () => Buffer.from('fixture') },
    media: {
      parseCrop: () => null,
      clampWidth: () => 320,
      reshapeJpeg: async () => {
        throw new Error('simulated conversion failure');
      },
    },
    res,
    json: (r, status) => r.writeHead(status),
  });
  assert.equal(res.status, 502);
});

test('GJ-06 transcription rejects redirects without sending a second request', async () => {
  let requests = 0;
  const file = join(dir, 'fixture.wav');
  fs.writeFileSync(file, Buffer.alloc(44));
  const ask = load(
    '../src/ask.mjs',
    {
      process: { env: { GJ_WHISPER_SERVER: 'http://localhost:8178' } },
      URL,
      FormData,
      Blob,
      AbortSignal,
      homedir: () => dir,
      // Simulate a method-preserving 307: a following fetch would upload again.
      fetch: async (_url, options) => {
        requests++;
        if (options.redirect === 'error')
          throw new TypeError('redirect rejected');
        requests++;
        return { ok: true, text: async () => 'unexpected transcript' };
      },
    },
    'transcribe',
  );
  assert.equal(await ask.transcribe(file), null);
  assert.equal(requests, 1);
});

test('GJ-11 automatic mode prefers widescreen supporting 30 fps before area', () => {
  const cameras = load(
    '../src/cameras.mjs',
    { homedir: () => dir },
    'defaultMode',
  );
  const mode = cameras.defaultMode([
    { size: '3840x2160', fps: [5] },
    { size: '1920x1080', fps: [15, 30] },
  ]);
  assert.equal(mode.size, '1920x1080');
  assert.equal(mode.fps, 30);
  assert.equal(cameras.defaultMode([{ size: '3840x2160', fps: [5] }]).fps, 5);
});

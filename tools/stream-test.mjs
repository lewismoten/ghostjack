// Regression test for the live stream (node --test tools/stream-test.mjs): a client that leaves while
// the camera call is pending must not leave ffmpeg running, and a bad ffmpeg path must answer 502.
// Uses a fake camera and a fake ffmpeg script on 127.0.0.1; never contacts a real camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamVideo } from '../src/stream.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function rig({ ffmpeg, delay }) {
  const children = new Set();
  const camera = { streamUrl: async () => (await wait(delay), 'rtsp://fake') };
  const server = createServer((req, res) =>
    streamVideo({ camera, ffmpeg, children, req, res }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, children, port: server.address().port };
}

test('client leaving during the camera call leaves no ffmpeg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gj-stream-'));
  const marker = join(dir, 'ran');
  const fake = join(dir, 'ffmpeg');
  writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nexec sleep 30\n`);
  chmodSync(fake, 0o755);
  const { server, children, port } = await rig({ ffmpeg: fake, delay: 400 });
  try {
    await new Promise((resolve) => {
      const r = get({ host: '127.0.0.1', port, path: '/' });
      r.on('error', resolve);
      setTimeout(() => r.destroy(), 100);
    });
    await wait(900);
    assert.equal(
      existsSync(marker),
      false,
      'ffmpeg was spawned for a gone client',
    );
    assert.equal(children.size, 0);
  } finally {
    for (const c of children) c.kill('SIGKILL');
    server.closeAllConnections();
    server.close();
  }
});

test('a missing ffmpeg answers 502 instead of crashing', async () => {
  const { server, children, port } = await rig({
    ffmpeg: '/nonexistent/ffmpeg',
    delay: 0,
  });
  try {
    const status = await new Promise((resolve, reject) =>
      get({ host: '127.0.0.1', port, path: '/' }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }).on('error', reject),
    );
    assert.equal(status, 502);
    assert.equal(children.size, 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

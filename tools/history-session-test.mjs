// Run the page's actual history and connection handlers in Node with a small DOM stub.
// No browser, networking, storage, sound, or device access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (from, to) =>
  source.slice(source.indexOf(from), source.indexOf(to));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function page() {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        value: '',
        hidden: false,
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
        classList: { toggle() {} },
        setAttribute() {},
        append() {},
      });
    return elements.get(id);
  };
  let calls = 0;
  let response = async () => ({
    ok: true,
    json: async () => ({ cursor: 7, entries: [] }),
  });
  const noop = () => {};
  const context = {
    $,
    setTimeout: noop,
    clearTimeout: noop,
    setInterval: noop,
    api: (...args) => {
      calls++;
      return response(...args);
    },
    fetch: () => new Promise(() => {}),
    controls: [],
    updateArrowsSoon: noop,
    loadCameras: noop,
    renderKeys: noop,
    stillsTick: noop,
    stillsTimer: 0,
    showAge: noop,
    finding: false,
    loadVoices: noop,
    stopLive: noop,
    setEye: noop,
    reduced: true,
    snd: { sfx: { powerUp: noop } },
    localStorage: { removeItem: noop },
    recorder: { active: false },
    setStatus: noop,
    store: { set: noop },
    net: { start: noop },
  };
  const script = `let connected = false, base = '', token = '';
    ${section('function setConnected(on)', '// A fetch that fails outright')}
    ${section('async function connect(e)', '// Who has the eye:')}
    ${section('const hist =', '// Personas:')}
    ${section("$('jackOut').onclick =", '// Last known frame:')}
    ({ hist, pollHistory, setConnected, connect,
       forget: $('forgetIce').onclick, jackOut: $('jackOut').onclick });`;
  const p = runInNewContext(script, context);
  return { ...p, $, calls: () => calls, respond: (fn) => (response = fn) };
}
function seed(p) {
  p.hist.cursor = 99;
  p.hist.entries.push({ text: 'old private transcript' });
  p.$('cvLog').textContent = 'old private transcript';
  p.$('cvHistCount').textContent = '(1)';
}
function empty(p) {
  assert.equal(p.hist.cursor, 0);
  assert.equal(p.hist.entries.length, 0);
  assert.equal(p.$('cvLog').textContent, '');
  assert.equal(p.$('cvHistCount').textContent, '');
}

test('GJ-05 forget clears the cursor, entries, and rendered history even when disconnected', () => {
  const p = page();
  seed(p);
  p.forget();
  empty(p);
});

test('GJ-05 connect and bridge switch clear previous history before any request finishes', () => {
  const p = page();
  p.setConnected(true);
  seed(p);
  void p.connect(); // hello stays pending; no network is used
  empty(p);
});

test('GJ-07 history never polls before connect or after jack out', async () => {
  const p = page();
  await p.pollHistory();
  assert.equal(p.calls(), 0);
  p.setConnected(true);
  await p.pollHistory();
  assert.equal(p.calls(), 1);
  await p.jackOut();
  await p.pollHistory();
  assert.equal(p.calls(), 1);
});

test('GJ-05 stale JSON cannot restore history or release a new session poll', async () => {
  const p = page();
  p.setConnected(true);
  const oldJson = deferred();
  const jsonStarted = deferred();
  p.respond(async () => ({
    ok: true,
    json: () => {
      jsonStarted.resolve();
      return oldJson.promise;
    },
  }));
  const old = p.pollHistory();
  await jsonStarted.promise;
  p.forget();
  p.setConnected(true);
  const currentResponse = deferred();
  p.respond(() => currentResponse.promise);
  const current = p.pollHistory();
  oldJson.resolve({ cursor: 99, entries: [{ text: 'private old response' }] });
  await old;
  empty(p);
  assert.equal(p.hist.busy, true);
  currentResponse.resolve({
    ok: true,
    json: async () => ({ cursor: 3, entries: [] }),
  });
  await current;
  assert.equal(p.hist.cursor, 3);
  assert.equal(p.hist.busy, false);
});

test('GJ-07 a response arriving after disconnect cannot change the cursor', async () => {
  const p = page();
  p.setConnected(true);
  const response = deferred();
  p.respond(() => response.promise);
  const pending = p.pollHistory();
  p.setConnected(false);
  let parsed = false;
  response.resolve({
    ok: true,
    json: async () => {
      parsed = true;
      return { cursor: 88, entries: [] };
    },
  });
  await pending;
  assert.equal(p.hist.cursor, 0);
  assert.equal(parsed, false);
});

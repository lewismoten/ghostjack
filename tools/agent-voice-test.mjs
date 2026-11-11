// Tests for the "Agent voice" switch (node --test tools/agent-voice-test.mjs): saved in a settings file,
// default on, and with it off a reply keeps its text (segments marked muted) and nothing is played.
// Nothing here makes sound: muted replies never reach the speaker, and the on case is not exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gj-settings-'));
process.env.GJ_SETTINGS_FILE = join(dir, 'sub', 'settings.json');
process.env.GJ_CONVERSE_HISTORY = join(dir, 'history.jsonl');
const { agentVoiceOn, setAgentVoice } = await import('../src/settings.mjs');
const reply = await import('../src/reply.mjs');

test('agent voice defaults on and persists in a private file', () => {
  assert.equal(agentVoiceOn(), true);
  assert.equal(setAgentVoice(false), false);
  assert.equal(agentVoiceOn(), false);
  assert.equal(
    JSON.parse(readFileSync(process.env.GJ_SETTINGS_FILE)).agentVoice,
    false,
  );
  assert.equal(statSync(process.env.GJ_SETTINGS_FILE).mode & 0o077, 0);
  assert.equal(setAgentVoice(true), true);
  assert.equal(agentVoiceOn(), true);
});

test('a reply with the agent voice off keeps its text and plays nothing', () => {
  setAgentVoice(false);
  const v = reply.append({
    text: 'Hello there. How are you today?',
    end: true,
  });
  assert.equal(v.closed, true);
  assert.ok(v.segments.length >= 1);
  assert.ok(v.segments.every((s) => s.status === 'muted'));
  assert.match(v.segments.map((s) => s.text).join(' '), /Hello there/);
  assert.ok(reply.recentLines().some((l) => /Hello there/.test(l.text)));
});

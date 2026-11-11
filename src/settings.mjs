// Bridge settings that must survive a restart and a page reload, kept in ~/.config/ghostjack/settings.json
// (GJ_SETTINGS_FILE overrides it, for tests). Today: agentVoice, whether the bridge plays the agent's
// spoken replies (off: replies still arrive as text and history, but nothing is played). Default on.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const file = () =>
  process.env.GJ_SETTINGS_FILE ||
  join(homedir(), '.config', 'ghostjack', 'settings.json');

function read() {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export const agentVoiceOn = () => read().agentVoice !== false;

export function setAgentVoice(on) {
  const f = file();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify({ ...read(), agentVoice: on === true }), {
    mode: 0o600,
  });
  chmodSync(f, 0o600);
  return agentVoiceOn();
}

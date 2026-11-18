// Scratch audio uses GJ_CAPTURES, defaulting to captures/ (git-ignored), and is deleted after use.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TMP =
  process.env.GJ_CAPTURES ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');

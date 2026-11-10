// Where scratch audio goes: captures/ (git-ignored), deleted as soon as it has been used.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TMP = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'captures',
);

// Copies web/ (the source of the control page) into docs/ so GitHub Pages can serve it from "main, /docs".
// Run `npm run pages` after changing anything in web/. docs/ keeps its Markdown notes beside the copy.
import { cpSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of readdirSync(join(root, 'web'))) cpSync(join(root, 'web', f), join(root, 'docs', f));
console.log('web/ copied into docs/');

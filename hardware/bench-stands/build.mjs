// Ghost Jack bench stands: writes laser-cut SVG sheets (Glowforge bed),
// PNG previews and an assembly diagram to hardware/bench-stands/out/.
//   node hardware/bench-stands/build.mjs [--thickness 3.1 --fitOffset 0.1 ...]
// See README.md for every setting.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseParams } from './params.mjs';
import { buildParts } from './parts.mjs';
import { pack, sheetSvg } from './sheets.mjs';
import { runChecks } from './check.mjs';
import { assemblySvg } from './diagram.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const P = parseParams(process.argv.slice(2));
const outDir = resolve(P.out ?? join(here, 'out'));

const { parts, geos } = buildParts(P);
const sheets = pack(parts);
const stats = runChecks(sheets, P, geos);

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) {
  if (/\.(svg|png)$/.test(f)) rmSync(join(outDir, f));
}
for (const s of sheets) writeFileSync(join(outDir, s.file), sheetSvg(s, P));
const diagram = 'assembly.svg';
writeFileSync(
  join(outDir, diagram),
  assemblySvg(P, P.devices.cyd28, geos.cyd28),
);

// Previews: load each SVG in the repo's playwright-core Chromium (the bundled
// one, no channel) and screenshot it on white at 3 pixels per millimeter.
if (!P['no-png']) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 495, height: 300 },
      deviceScaleFactor: 3,
    });
    for (const file of [...sheets.map((s) => s.file), diagram]) {
      const h = file === diagram ? 300 : 279;
      await page.setViewportSize({ width: 495, height: h });
      await page.goto('file://' + join(outDir, file));
      await page.evaluate((hh) => {
        const svg = document.documentElement;
        svg.setAttribute('width', '495px');
        svg.setAttribute('height', hh + 'px');
        svg.style.background = '#fff';
      }, h);
      await page.screenshot({
        path: join(outDir, file.replace('.svg', '.png')),
      });
    }
  } finally {
    await browser.close();
  }
}

for (const s of sheets) {
  console.log(
    `${s.file.padEnd(26)} ${String(s.placed.length).padStart(3)} parts  ${s.title}`,
  );
}
console.log(
  `total ${parts.length} parts on ${sheets.length} sheets; ` +
    `${stats.slots} slots, ${stats.engraved} engraved labels; self-check passed`,
);

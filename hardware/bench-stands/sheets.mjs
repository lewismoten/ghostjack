// Packs parts onto Glowforge-bed sheets and writes each sheet as an SVG in
// millimeters. CUT = red stroke, no fill; ENGRAVE = blue fill, no stroke.

export const BED = { w: 495, h: 279, margin: 10, gap: 5 };

const TITLES = {
  coupon: 'Fit test coupon',
  pi: 'Pi Zero W + e-Paper',
  cyd28: 'CYD 2.8 inch',
  cyd35: 'CYD 3.5 inch',
  shelf: 'Stepped shelf',
};

/** Row packer: tall parts first, new row when the width runs out. */
export function pack(parts) {
  const groups = [...new Set(parts.map((p) => p.group))];
  const sheets = [];
  for (const group of groups) {
    const todo = parts
      .filter((p) => p.group === group)
      .sort((a, b) => b.h - a.h || b.w - a.w);
    let sheet = null;
    const fresh = () => {
      const n = sheets.filter((s) => s.group === group).length + 1;
      sheet = {
        group,
        name: `${group}-${n}`,
        placed: [],
        x: BED.margin,
        y: BED.margin,
        rowH: 0,
      };
      sheets.push(sheet);
    };
    fresh();
    for (const p of todo) {
      const right = BED.w - BED.margin;
      const bottom = BED.h - BED.margin;
      if (sheet.x + p.w > right) {
        sheet.x = BED.margin;
        sheet.y += sheet.rowH + BED.gap;
        sheet.rowH = 0;
      }
      if (sheet.y + p.h > bottom) {
        if (!sheet.placed.length)
          throw new Error(`${p.id} does not fit a sheet`);
        fresh();
      }
      sheet.placed.push({ part: p, x: sheet.x, y: sheet.y });
      sheet.x += p.w + BED.gap;
      sheet.rowH = Math.max(sheet.rowH, p.h);
    }
  }
  sheets.forEach((s, i) => {
    s.file = `${String(i + 1).padStart(2, '0')}-${s.name}.svg`;
    s.title = TITLES[s.group];
  });
  return sheets;
}

const f = (n) => +n.toFixed(3);

/** Sheet coordinates of a part-local point (flips y: SVG is y down). */
export const toSheet = (pl, [x, y]) => [pl.x + x, pl.y + pl.part.h - y];

function poly(pl, pts) {
  return 'M' + pts.map((q) => toSheet(pl, q).map(f).join(' ')).join('L') + 'Z';
}

function rects(pl, list) {
  return list
    .map(([a, b, c, d]) =>
      poly(pl, [
        [a, b],
        [c, b],
        [c, d],
        [a, d],
      ]),
    )
    .join('');
}

export function sheetSvg(sheet, P) {
  const body = sheet.placed.map((pl) => {
    const cut = [
      poly(pl, pl.part.outline),
      ...pl.part.holes.map((h) => poly(pl, h.pts)),
    ].join('');
    const eng = pl.part.labels
      .map(
        (l) => `<path fill="#0000FF" stroke="none" d="${rects(pl, l.rects)}"/>`,
      )
      .join('');
    return `<g id="${pl.part.id}"><path fill="none" stroke="#FF0000" stroke-width="0.15" d="${cut}"/>${eng}</g>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${BED.w}mm" height="${BED.h}mm" viewBox="0 0 ${BED.w} ${BED.h}">
<title>Ghost Jack bench: ${sheet.title} (${sheet.name})</title>
<desc>Cut red (#FF0000, thin), engrave blue (#0000FF fill). Plywood ${P.thickness} mm, kerf ${P.kerf} mm, fit offset ${P.fitOffset} mm. Cut the fit test coupon first.</desc>
${body.join('\n')}
</svg>
`;
}

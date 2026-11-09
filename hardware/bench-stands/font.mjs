// A 5x7 pixel font drawn as filled rectangles, so engraved labels are plain
// vector shapes (no text objects for the laser software to interpret).
// label() fits lines of text into a box and returns the rectangles.

const G = {
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110',
  1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111',
  3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010',
  5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110',
  7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00010 01100',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '+': '00000 00100 00100 11111 00100 00100 00000',
  '/': '00001 00001 00010 00100 01000 10000 10000',
  ' ': '00000 00000 00000 00000 00000 00000 00000',
};

const GAP = 1; // blank pixel columns between characters
const LINE_GAP = 2; // blank pixel rows between lines

function layout(lines, p) {
  const w = Math.max(...lines.map((l) => l.length * 6 - GAP)) * p;
  const h = (lines.length * 7 + (lines.length - 1) * LINE_GAP) * p;
  return { w, h };
}

/** Rectangles [x0,y0,x1,y1] (y up), centered lines, in a w-wide frame. */
function draw(lines, p, w) {
  const rects = [];
  lines.forEach((line, li) => {
    const top =
      (lines.length - li) * 7 * p + (lines.length - 1 - li) * LINE_GAP * p;
    const lw = (line.length * 6 - GAP) * p;
    const x0 = (w - lw) / 2;
    [...line.toUpperCase()].forEach((ch, ci) => {
      const rows = (G[ch] ?? G[' ']).split(' ');
      rows.forEach((row, r) => {
        let c = 0;
        while (c < 5) {
          if (row[c] !== '1') {
            c++;
            continue;
          }
          let e = c;
          while (e < 5 && row[e] === '1') e++;
          const x = x0 + (ci * 6 + c) * p;
          rects.push([x, top - (r + 1) * p, x + (e - c) * p, top - r * p]);
          c = e;
        }
      });
    });
  });
  return rects;
}

/**
 * Fit text into the first box that holds it. `options` is a list of line sets
 * (full words first, shorter ones after); `boxes` are [x0,y0,x1,y1] in the
 * part's coordinates (y up). Tries bigger pixels first, then 90 degree turns.
 * Returns { rects, box } (box = the text's own bounds) or throws.
 */
export function label(options, boxes, { pMax = 0.5, pMin = 0.33 } = {}) {
  for (const lines of options) {
    for (let p = pMax; p >= pMin - 1e-9; p -= 0.025) {
      for (const [x0, y0, x1, y1] of boxes) {
        for (const rot of [0, 90]) {
          const { w, h } = layout(lines, p);
          const tw = rot ? h : w;
          const th = rot ? w : h;
          if (tw > x1 - x0 || th > y1 - y0) continue;
          const ox = x0 + (x1 - x0 - tw) / 2;
          const oy = y0 + (y1 - y0 - th) / 2;
          const rects = draw(lines, p, w).map(([a, b, c, d]) =>
            rot
              ? [ox + h - d, oy + a, ox + h - b, oy + c]
              : [ox + a, oy + b, ox + c, oy + d],
          );
          return { rects, box: [ox, oy, ox + tw, oy + th] };
        }
      }
    }
  }
  throw new Error(`label does not fit: ${options[0].join(' / ')}`);
}

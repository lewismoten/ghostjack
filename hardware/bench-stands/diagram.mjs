// Assembly diagram (not a cutting file): the cradle on a deck seen from the
// side at every angle, and an exploded view. Drawn from the same geometry as
// the parts, in millimeters. Forward (toward the screen's viewer) is right.

const rad = (d) => (d * Math.PI) / 180;
const FILL = { wood: '#e6c79a', ghost: 'none', key: '#c0392b' };

function sideView(P, d, g, deg, ox, oy, ex = {}) {
  const th = rad(deg);
  const u = [-Math.sin(th), Math.cos(th)];
  const nf = [Math.cos(th), Math.sin(th)];
  const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
  const P2 = (pts) =>
    pts
      .map(([x, y]) => `${(ox + x).toFixed(2)},${(oy - y).toFixed(2)}`)
      .join(' ');
  const poly = (pts, fill, extra = '') =>
    `<polygon points="${P2(pts)}" fill="${fill}" ${extra.includes('stroke="') ? '' : 'stroke="#333"'} stroke-width="0.4" ${extra}/>`;
  const shift = (pts, k, dir) => pts.map((p) => add(p, dir, k));
  const t = g.t;
  const B0 = [0, 0];
  const C = add(B0, nf, t);
  const out = [];
  const ang = P.angles.indexOf(deg);
  const h = g.hs[ang >= 0 ? ang : 0];
  const nb = [-nf[0], -nf[1]];
  // deck, stop bar
  const front = g.front;
  if (!ex.explode) {
    out.push(
      poly(
        [
          [front, 0],
          [front - g.deckDepth, 0],
          [front - g.deckDepth, -t],
          [front, -t],
        ],
        FILL.wood,
      ),
    );
    const bx = front - 4;
    out.push(
      poly(
        [
          [bx, 0],
          [bx - t, 0],
          [bx - t, P.stopHeight],
          [bx, P.stopHeight],
        ],
        FILL.wood,
      ),
    );
  }
  // plate
  const plateP = [B0, C, add(C, u, g.Bh), add(B0, u, g.Bh)];
  out.push(poly(shift(plateP, ex.plate ?? 0, nf), FILL.wood));
  // ledge
  const L0 = add(C, u, P.ledgeHeight);
  const ledgeP = [
    L0,
    add(L0, nf, g.D),
    add(add(L0, nf, g.D), u, t),
    add(L0, u, t),
  ];
  out.push(poly(shift(ledgeP, ex.ledge ?? 0, nf), FILL.wood));
  // board (dashed outline)
  const S0 = add(C, u, P.ledgeHeight + t);
  const board = [
    S0,
    add(S0, nf, d.stack),
    add(add(S0, nf, d.stack), u, d.width),
    add(S0, u, d.width),
  ];
  out.push(
    poly(
      shift(board, ex.board ?? 0, nf),
      'rgba(31,111,235,0.12)',
      'stroke-dasharray="1.5 1" stroke="#1f6feb"',
    ),
  );
  // rail (the near rail seen flat)
  const R0 = add(C, u, P.ledgeHeight);
  const railP = [
    R0,
    add(R0, nf, g.D),
    add(add(R0, nf, g.D), u, g.Rh),
    add(R0, u, g.Rh),
  ];
  out.push(
    poly(
      shift(railP, ex.rail ?? 0, nf),
      'rgba(230,199,154,0.35)',
      'stroke-dasharray="3 1"',
    ),
  );
  // strut: body behind the plate, tab through it, key in front
  const A = add(B0, u, h);
  const sw = g.Sw / 2;
  const bodyP = [
    add(A, u, sw),
    add(A, u, -sw),
    add(add(A, u, -sw), nb, g.s0),
    add(add(A, u, sw), nb, g.s0),
  ];
  out.push(poly(shift(bodyP, ex.strut ?? 0, nb), FILL.wood));
  const ts = P.strutTabWidth / 2;
  const tl = t + P.keyHole + 3;
  const tabP = [
    add(A, u, ts),
    add(A, u, -ts),
    add(add(A, u, -ts), nf, tl),
    add(add(A, u, ts), nf, tl),
  ];
  out.push(poly(shift(tabP, ex.strut ?? 0, nb), FILL.wood));
  const k0 = add(A, nf, t);
  const keyP = [
    add(k0, u, ts),
    add(k0, u, -ts),
    add(add(k0, u, -ts), nf, P.keyHole),
    add(add(k0, u, ts), nf, P.keyHole),
  ];
  out.push(poly(shift(keyP, ex.key ?? 0, nf), FILL.key));
  if (ex.explode) {
    const tag = (ref, k, dir, name) => {
      const a = [ox + ref[0], oy - ref[1]];
      const b = [ox + ref[0] + dir[0] * k, oy - ref[1] - dir[1] * k];
      out.push(
        `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="#555" stroke-width="0.5" stroke-dasharray="1.5 1"/>`,
      );
      out.push(text(b[0] + 2, b[1] - 2, name, 4));
    };
    const mid = (p, v, k) => add(p, v, k);
    tag(mid(mid(L0, nf, g.D / 2), u, t / 2), ex.ledge, nf, '2 ledge');
    tag(
      mid(mid(R0, nf, g.D), u, g.Rh),
      ex.rail - 0,
      nf,
      '3 rails (both sides)',
    );
    tag(mid(mid(S0, nf, d.stack), u, d.width), ex.board, nf, '4 board');
    tag(mid(A, nb, g.s0), ex.strut, nb, '1 strut, from behind');
    tag(mid(k0, nf, P.keyHole / 2), ex.key, nf, '5 wedge keys');
  }
  return out.join('\n');
}

const text = (x, y, s, size = 4.5, extra = '') =>
  `<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="#222" ${extra}>${s}</text>`;

export function assemblySvg(P, d, g) {
  const W = 540;
  const H = 300;
  const out = [];
  out.push(
    text(
      10,
      14,
      `Ghost Jack bench: ${d.name} cradle on a deck, side view (screen faces right)`,
      6,
      'font-weight="bold"',
    ),
  );
  out.push(
    text(
      10,
      22,
      'Wood tan, board blue dashed, near rail ghosted, wedge key red. One strut notch per angle; the strut tab goes through the plate slot beside that angle number.',
      3.6,
    ),
  );
  const colW = (W - 20) / P.angles.length;
  P.angles.forEach((a, i) => {
    const ox = 20 + i * colW + g.deckDepth - 12;
    out.push(sideView(P, d, g, a, ox, 140));
    out.push(
      text(
        ox - g.deckDepth + 20,
        156,
        `${a} deg from vertical`,
        5,
        'font-weight="bold"',
      ),
    );
  });
  out.push(
    text(
      10,
      176,
      'Exploded view at 45 degrees (slide each part along its arrow; the wedge key slides across the tab hole, thin end first):',
      4,
    ),
  );
  const ex = {
    ledge: 14,
    rail: 30,
    board: 56,
    strut: 26,
    plate: 0,
    key: 70,
    explode: true,
  };
  out.push(sideView(P, d, g, 45, 150, 285, ex));
  out.push(
    text(
      300,
      215,
      'Order: strut into plate, ledge, both rails, board, wedge keys.',
      4,
    ),
  );
  out.push(
    text(
      300,
      222,
      `Measure and confirm: board ${d.length} x ${d.width} mm, stack ${d.stack} mm (see README).`,
      4,
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
<title>Ghost Jack bench: assembly diagram</title>
<rect width="${W}" height="${H}" fill="#ffffff"/>
${out.join('\n')}
</svg>
`;
}

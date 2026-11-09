// Every flat part of the bench stands as polygons (millimeters, y up, each
// part moved so its outline starts at 0,0). A part is
//   { id, name, group, outline, holes: [{pts, role, narrow?}],
//     labels: [{rects, box}], w, h }.
// Joints are tab-and-slot: slot narrow side = thickness + fitOffset - kerf.

import { bbox, rectPoly } from './geom.mjs';
import { label } from './font.mjs';

export const LM = 1.8; // clear space between engraving and any cut
export const slotWidth = (P, off = P.fitOffset) => P.thickness + off - P.kerf;

const rad = (deg) => (deg * Math.PI) / 180;
const STOP_FRONT = 4; // stop bar slot distance from a deck's front edge

/** Derived sizes of one device's cradle (also used by the diagram). */
export function cradleGeo(P, d) {
  const t = P.thickness;
  const slotW = slotWidth(P);
  const s0 = P.strutLength;
  const Sw = P.strutWidth;
  const D = d.stack + 1;
  const railU = d.length / 2 + P.boardClear + t / 2;
  const strutU = railU + 14;
  const Bw = 2 * (strutU + slotW / 2 + 5);
  const Rh = t + d.width + 6;
  const hs = P.angles.map((a) => s0 * Math.tan(rad(a)) + Sw / 2);
  const Bh = Math.max(
    P.ledgeHeight + t + d.width + 8,
    Math.max(...hs) + P.strutTabWidth / 2 + 6,
  );
  const rear = Math.max(
    ...P.angles.map(
      (a, i) => (hs[i] + Sw / 2) * Math.sin(rad(a)) + s0 * Math.cos(rad(a)),
    ),
  );
  const front = STOP_FRONT + slotW + 0.5 + t;
  return {
    t,
    slotW,
    s0,
    Sw,
    D,
    railU,
    strutU,
    Bw,
    Rh,
    hs,
    Bh,
    rear,
    front,
    Lw: d.length + 2 * P.boardClear,
    deckDepth: front + rear + 8,
    footW: Bw + 12,
  };
}

const lines = (name, dev) => [
  [name, dev, 'GHOST JACK BENCH'],
  [name, dev, 'GJ BENCH'],
  [name, 'GJ BENCH'],
  [name],
];

const slot = (x0, y0, x1, y1, narrow) => ({
  pts: rectPoly(x0, y0, x1, y1),
  role: 'slot',
  narrow,
});

const inset = (b) => [b[0] + LM, b[1] + LM, b[2] - LM, b[3] - LM];

/** Place labels, move the part to the origin and return it. */
function finish(id, name, group, outline, holes, labelSpecs) {
  const labels = labelSpecs.map((s) =>
    label(s.options, s.boxes, { pMax: s.pMax }),
  );
  const [x0, y0, x1, y1] = bbox(outline);
  const mv = ([x, y]) => [x - x0, y - y0];
  const mvR = ([a, b, c, e]) => [a - x0, b - y0, c - x0, e - y0];
  return {
    id,
    name,
    group,
    outline: outline.map(mv),
    holes: holes.map((h) => ({ ...h, pts: h.pts.map(mv) })),
    labels: labels.map((l) => ({ rects: l.rects.map(mvR), box: mvR(l.box) })),
    w: x1 - x0,
    h: y1 - y0,
  };
}

function plate(P, d, g, id) {
  const { slotW, railU, strutU, Bw, Bh } = g;
  const tab = P.tabWidth;
  const cx = Bw / 2;
  const holes = [];
  const off = d.length / 2 - 14;
  for (const s of [-1, 1]) {
    const c = cx + s * off;
    holes.push(
      slot(
        c - tab / 2,
        P.ledgeHeight,
        c + tab / 2,
        P.ledgeHeight + slotW,
        slotW,
      ),
    );
    const rx = cx + s * railU;
    for (const y of [4, g.Rh - 4 - tab]) {
      const y0 = P.ledgeHeight + y;
      holes.push(slot(rx - slotW / 2, y0, rx + slotW / 2, y0 + tab, slotW));
    }
  }
  const specs = [];
  P.angles.forEach((a, i) => {
    const h = g.hs[i];
    for (const s of [-1, 1]) {
      const sx = cx + s * strutU;
      const ts = P.strutTabWidth;
      holes.push(
        slot(sx - slotW / 2, h - ts / 2, sx + slotW / 2, h + ts / 2, slotW),
      );
      const a0 = cx + s * (railU + slotW / 2 + LM);
      const a1 = cx + s * (strutU - slotW / 2 - LM);
      specs.push({
        options: [[String(a)]],
        boxes: [[Math.min(a0, a1), h - 1.75, Math.max(a0, a1), h + 1.75]],
      });
    }
  });
  const half = railU - slotW / 2 - LM - 0.7;
  specs.push({
    options: lines('BACK PLATE', d.short),
    boxes: [[cx - half, P.ledgeHeight + slotW + 6, cx + half, Bh - LM - 2]],
  });
  return finish(id, 'BACK PLATE', d.id, rectPoly(0, 0, Bw, Bh), holes, specs);
}

function ledge(P, d, g, id) {
  const { t, D, Lw } = g;
  const tab = P.tabWidth;
  const c = Lw / 2;
  const off = d.length / 2 - 14;
  const pts = [[0, 0]];
  for (const x of [c - off, c + off]) {
    pts.push(
      [x - tab / 2, 0],
      [x - tab / 2, -t],
      [x + tab / 2, -t],
      [x + tab / 2, 0],
    );
  }
  pts.push([Lw, 0], [Lw, D]);
  const cuts = d.ledgeNotches.map(([a, b]) => [
    P.boardClear + a,
    P.boardClear + b,
  ]);
  const nd = D - 4;
  for (const [a, b] of [...cuts].sort((p, q) => q[0] - p[0])) {
    pts.push([b, D], [b, D - nd], [a, D - nd], [a, D]);
  }
  pts.push([0, D]);
  const edges = [0, ...cuts.flat(), Lw];
  const boxes = [];
  for (let i = 0; i < edges.length; i += 2) {
    boxes.push([edges[i], 0, edges[i + 1], D]);
  }
  boxes.sort((p, q) => q[2] - q[0] - (p[2] - p[0]));
  return finish(
    id,
    'LEDGE',
    d.id,
    pts,
    [],
    [{ options: lines('LEDGE', d.short), boxes: boxes.map(inset) }],
  );
}

function rail(P, d, g, id, notched) {
  const { t, D, Rh } = g;
  const tab = P.tabWidth;
  const pts = [
    [0, 0],
    [D, 0],
  ];
  const boxes = [];
  const n = d.railNotch;
  if (notched && n) {
    const yc = t + n.center;
    const a = yc - n.width / 2;
    const b = yc + n.width / 2;
    pts.push([D, a], [5, a], [5, b], [D, b]);
    boxes.push([0, b, D, Rh], [0, 0, D, a]);
  } else {
    boxes.push([0, 0, D, Rh]);
  }
  pts.push([D, Rh], [0, Rh]);
  pts.push([0, Rh - 4], [-t, Rh - 4], [-t, Rh - 4 - tab], [0, Rh - 4 - tab]);
  pts.push([0, 4 + tab], [-t, 4 + tab], [-t, 4], [0, 4]);
  const name = notched && n ? 'RAIL USB' : 'RAIL';
  boxes.sort((p, q) => q[3] - q[1] - (p[3] - p[1]));
  return finish(
    id,
    name,
    d.id,
    pts,
    [],
    [{ options: lines(name, d.short), boxes: boxes.map(inset) }],
  );
}

function strut(P, d, g, id) {
  const { t, slotW, s0, Sw } = g;
  const ts = P.strutTabWidth;
  const tl = t + P.keyHole + 3;
  const x0 = (Sw - ts) / 2;
  const pts = [
    [0, 0],
    [Sw, 0],
    [Sw, s0],
    [x0 + ts, s0],
    [x0 + ts, s0 + tl],
    [x0, s0 + tl],
    [x0, s0],
    [0, s0],
  ];
  const hole = slot(
    Sw / 2 - slotW / 2,
    s0 + t,
    Sw / 2 + slotW / 2,
    s0 + t + P.keyHole,
    slotW,
  );
  return finish(
    id,
    'STRUT',
    d.id,
    pts,
    [hole],
    [
      {
        options: lines('STRUT', d.short),
        boxes: [inset([0, 0, Sw, s0])],
        pMax: 0.4,
      },
    ],
  );
}

function key(P, d, id) {
  const H = P.keyHole;
  const w0 = H - 1.4;
  const w1 = H + 1.6;
  const wl = 16;
  const pts = [
    [0, -w0 / 2],
    [wl, -w1 / 2],
    [wl, -7],
    [wl + 10, -7],
    [wl + 10, 7],
    [wl, 7],
    [wl, w1 / 2],
    [0, w0 / 2],
  ];
  return finish(
    id,
    'KEY',
    d.id,
    pts,
    [],
    [{ options: [['KEY']], boxes: [inset([wl, -7, wl + 10, 7])] }],
  );
}

function stopBar(P, W, group, devShort, g, id) {
  const { t } = g;
  const tab = P.tabWidth;
  const H = P.stopHeight;
  const pts = [[0, 0]];
  for (const c of [W / 6, W / 2, (5 * W) / 6]) {
    pts.push(
      [c - tab / 2, 0],
      [c - tab / 2, -t],
      [c + tab / 2, -t],
      [c + tab / 2, 0],
    );
  }
  pts.push([W, 0], [W, H], [0, H]);
  return finish(
    id,
    'STOP BAR',
    group,
    pts,
    [],
    [
      {
        options: [
          ['STOP BAR ' + devShort + ' GHOST JACK BENCH'],
          ['STOP BAR ' + devShort + ' GJ BENCH'],
          ['STOP BAR'],
        ],
        boxes: [inset([0, 0, W, H])],
        pMax: 0.4,
      },
    ],
  );
}

/** A flat deck (tread or foot); sideTabs adds the shelf cheek tabs. */
function deck(P, W, TD, g, id, name, group, devName, sideTabs) {
  const { t, slotW } = g;
  const tab = P.tabWidth;
  const pts = [
    [0, 0],
    [W, 0],
  ];
  const edge = (x, dir) => {
    const ys = [8, 8 + tab, TD - 8 - tab, TD - 8];
    const out = [];
    for (const [a, b] of [
      [ys[0], ys[1]],
      [ys[2], ys[3]],
    ]) {
      out.push([x, a], [x + dir * t, a], [x + dir * t, b], [x, b]);
    }
    return out;
  };
  if (sideTabs) pts.push(...edge(W, 1));
  pts.push([W, TD], [0, TD]);
  if (sideTabs) pts.push(...edge(0, -1).reverse());
  const holes = [];
  for (const c of [W / 6, W / 2, (5 * W) / 6]) {
    holes.push(
      slot(c - tab / 2, STOP_FRONT, c + tab / 2, STOP_FRONT + slotW, slotW),
    );
  }
  return finish(id, name, group, pts, holes, [
    {
      options: lines(name, devName),
      boxes: [[LM, STOP_FRONT + slotW + LM, W - LM, TD - LM]],
    },
  ]);
}

function cheek(P, g, TD, id) {
  const { t, slotW } = g;
  const tab = P.tabWidth;
  const yL = P.shelfBase;
  const yH = yL + P.stepHeight;
  const gd = 4;
  const pts = [
    [0, 0],
    [2 * TD, 0],
    [2 * TD, yH + gd],
    [TD, yH + gd],
    [TD, yL + gd],
    [0, yL + gd],
  ];
  const holes = [];
  [0, 1].forEach((k) => {
    const yt = yL + k * P.stepHeight - t / 2;
    for (const x of [k * TD + 8, k * TD + TD - 8 - tab]) {
      holes.push(slot(x, yt - slotW / 2, x + tab, yt + slotW / 2, slotW));
    }
  });
  holes.push(slot(TD - slotW / 2, 6, TD + slotW / 2, 6 + tab, slotW));
  const top = yL - t / 2 - slotW / 2 - LM - 1;
  return finish(id, 'SHELF SIDE', 'shelf', pts, holes, [
    {
      options: lines('SHELF SIDE', 'STEPS'),
      boxes: [
        [LM, LM, TD - 12, top],
        [TD + 12, LM, 2 * TD - LM, top],
      ],
    },
  ]);
}

function tie(P, g, W, id) {
  const { t } = g;
  const tab = P.tabWidth;
  const pts = [
    [0, 0],
    [W, 0],
    [W, 4],
    [W + t, 4],
    [W + t, 4 + tab],
    [W, 4 + tab],
    [W, 20],
    [0, 20],
    [0, 4 + tab],
    [-t, 4 + tab],
    [-t, 4],
    [0, 4],
  ];
  return finish(
    id,
    'TIE BAR',
    'shelf',
    pts,
    [],
    [{ options: lines('TIE BAR', 'STEPS'), boxes: [inset([0, 0, W, 20])] }],
  );
}

function coupon(P) {
  const t = P.thickness;
  const tab = P.tabWidth;
  const offs = [-0.1, 0, 0.1, 0.2];
  const fmt = (o) => (o > 0 ? '+' : '') + o.toFixed(1);
  const W = offs.length * 28 + 8;
  const holes = [];
  const specs = [];
  offs.forEach((o, i) => {
    const c = 18 + i * 28;
    const narrow = slotWidth(P, o);
    holes.push(
      slot(c - tab / 2, 24 - narrow / 2, c + tab / 2, 24 + narrow / 2, narrow),
    );
    specs.push({ options: [[fmt(o)]], boxes: [[c - 10, 4, c + 10, 15]] });
  });
  specs.push({
    options: [[`THICK ${t} KERF ${P.kerf}`, 'FIT TEST GHOST JACK BENCH']],
    boxes: [[LM, 31, W - LM, 44 - LM]],
  });
  const parts = [
    finish(
      'coupon-bar',
      'FIT BAR',
      'coupon',
      rectPoly(0, 0, W, 44),
      holes,
      specs,
    ),
  ];
  for (const o of offs) {
    const tl = t + 2;
    const pts = [
      [0, 0],
      [26, 0],
      [26, 18],
      [19, 18],
      [19, 18 + tl],
      [7, 18 + tl],
      [7, 18],
      [0, 18],
    ];
    parts.push(
      finish(
        `coupon-card${fmt(o)}`,
        'FIT CARD ' + fmt(o),
        'coupon',
        pts,
        [],
        [
          {
            options: [[fmt(o), 'GJ BENCH'], [fmt(o)]],
            boxes: [inset([0, 0, 26, 18])],
          },
        ],
      ),
    );
  }
  return parts;
}

/** All parts, grouped by sheet group. */
export function buildParts(P) {
  const parts = [...coupon(P)];
  const devs = Object.entries(P.devices).map(([k, v]) => ({ ...v, id: k }));
  const geos = {};
  for (const d of devs) {
    const g = cradleGeo(P, d);
    geos[d.id] = g;
    parts.push(
      plate(P, d, g, `${d.id}-plate`),
      ledge(P, d, g, `${d.id}-ledge`),
    );
    parts.push(
      rail(P, d, g, `${d.id}-railA`, true),
      rail(P, d, g, `${d.id}-railB`, false),
    );
    for (let i = 1; i <= 2; i++)
      parts.push(strut(P, d, g, `${d.id}-strut${i}`));
    for (let i = 1; i <= 3; i++) parts.push(key(P, d, `${d.id}-key${i}`));
    parts.push(
      deck(
        P,
        g.footW,
        g.deckDepth,
        g,
        `${d.id}-foot`,
        'FOOT',
        d.id,
        d.short,
        false,
      ),
    );
    parts.push(stopBar(P, g.footW, d.id, d.short, g, `${d.id}-footbar`));
  }
  const gAll = Object.values(geos);
  const TD = Math.max(...gAll.map((g) => g.deckDepth));
  const W = gAll.reduce((s, g) => s + g.Bw, 0) + (gAll.length + 1) * P.shelfGap;
  const gs = gAll[0];
  parts.push(cheek(P, gs, TD, 'shelf-sideA'), cheek(P, gs, TD, 'shelf-sideB'));
  parts.push(
    deck(P, W, TD, gs, 'shelf-lowtread', 'LOW TREAD', 'shelf', 'STEPS', true),
  );
  parts.push(
    deck(P, W, TD, gs, 'shelf-hightread', 'HIGH TREAD', 'shelf', 'STEPS', true),
  );
  parts.push(
    stopBar(P, W, 'shelf', 'STEPS', gs, 'shelf-lowbar'),
    stopBar(P, W, 'shelf', 'STEPS', gs, 'shelf-highbar'),
  );
  parts.push(tie(P, gs, W, 'shelf-tie'));
  return { parts, geos, shelf: { W, TD } };
}

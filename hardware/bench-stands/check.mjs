// Self-check for the generated sheets: nothing overlaps or touches, engraving
// stays clear of every cut, everything is inside the bed margins, and every
// slot is thickness + fitOffset - kerf wide. Throws on the first failure list.

import { bbox, edgeDist, pointInPoly, polyGap, rectPoly } from './geom.mjs';
import { BED, toSheet } from './sheets.mjs';
import { LM, slotWidth } from './parts.mjs';

const MIN_WEB = 2.0; // least material between two cuts
const PART_GAP = 3.0; // least space between two parts on a sheet
const near = (a, b) => Math.abs(a - b) < 1e-9;

export function runChecks(sheets, P, geos) {
  const errs = [];
  const bad = (m) => errs.push(m);
  const couponWidths = [-0.1, 0, 0.1, 0.2].map((o) => slotWidth(P, o));
  let slots = 0;
  let engraved = 0;

  for (const sheet of sheets) {
    const polys = sheet.placed.map((pl) => ({
      id: pl.part.id,
      pts: pl.part.outline.map((q) => toSheet(pl, q)),
    }));
    for (const pl of sheet.placed) {
      const p = pl.part;
      const w = `${sheet.name}/${p.id}`;
      for (const h of p.holes) {
        if (h.role === 'slot') {
          slots++;
          const [x0, y0, x1, y1] = bbox(h.pts);
          const narrow = Math.min(x1 - x0, y1 - y0);
          if (
            !near(narrow, h.narrow) ||
            !(sheet.group === 'coupon' ? couponWidths : [slotWidth(P)]).some(
              (v) => near(v, narrow),
            )
          ) {
            bad(
              `${w}: slot width ${narrow} is not thickness + fitOffset - kerf`,
            );
          }
        }
        if (!h.pts.every((q) => pointInPoly(q, p.outline)))
          bad(`${w}: hole outside its part`);
        else if (edgeDist(h.pts, p.outline) < MIN_WEB)
          bad(`${w}: a hole is within ${MIN_WEB} mm of the edge`);
      }
      p.holes.forEach((a, i) =>
        p.holes.slice(i + 1).forEach((b) => {
          if (polyGap(a.pts, b.pts) < MIN_WEB)
            bad(`${w}: two holes closer than ${MIN_WEB} mm`);
        }),
      );
      p.labels.forEach((l, i) => {
        engraved++;
        const box = rectPoly(...l.box);
        if (!box.every((q) => pointInPoly(q, p.outline)))
          bad(`${w}: label ${i} leaves its part`);
        if (edgeDist(box, p.outline) < LM - 0.01)
          bad(`${w}: label ${i} touches an edge`);
        for (const h of p.holes) {
          if (polyGap(box, h.pts) < LM - 0.01)
            bad(`${w}: label ${i} too close to a cut hole`);
        }
        p.labels.slice(i + 1).forEach((m) => {
          if (polyGap(box, rectPoly(...m.box)) < 1)
            bad(`${w}: two labels touch`);
        });
      });
      const [x0, y0, x1, y1] = bbox(polys.find((q) => q.id === p.id).pts);
      if (
        x0 < BED.margin - 1e-9 ||
        y0 < BED.margin - 1e-9 ||
        x1 > BED.w - BED.margin + 1e-9 ||
        y1 > BED.h - BED.margin + 1e-9
      ) {
        bad(`${w}: outside the ${BED.margin} mm bed margin`);
      }
    }
    polys.forEach((a, i) =>
      polys.slice(i + 1).forEach((b) => {
        if (polyGap(a.pts, b.pts) < PART_GAP)
          bad(`${sheet.name}: ${a.id} and ${b.id} closer than ${PART_GAP} mm`);
      }),
    );
  }

  // The stop bar must clear the ledge at every angle (side view).
  for (const [id, g] of Object.entries(geos)) {
    for (const a of P.angles) {
      const th = (a * Math.PI) / 180;
      const barX = g.t * Math.cos(th) + 0.3; // from the plate's back-bottom corner
      const ledgeX = g.t * Math.cos(th) - P.ledgeHeight * Math.sin(th);
      const under =
        g.t * Math.sin(th) +
        P.ledgeHeight * Math.cos(th) +
        (barX - ledgeX) * Math.tan(th);
      if (under - P.stopHeight < 1)
        bad(
          `${id} at ${a} deg: ledge only ${(under - P.stopHeight).toFixed(1)} mm above the stop bar`,
        );
    }
  }

  if (errs.length)
    throw new Error('self-check failed:\n  ' + errs.join('\n  '));
  return { slots, engraved };
}

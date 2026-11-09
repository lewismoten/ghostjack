// Small 2D geometry helpers for the bench-stand generator: polygons are arrays
// of [x, y] points in millimeters. Used by the parts and by the self-check.

export const rectPoly = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

export function bbox(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function segDist(a, b, c, d) {
  // Minimum distance between segments ab and cd (0 when they cross).
  const cross = (o, p, q) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  const pt = (p, s, e) => {
    const dx = e[0] - s[0];
    const dy = e[1] - s[1];
    const l2 = dx * dx + dy * dy;
    const u = l2
      ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2))
      : 0;
    return Math.hypot(p[0] - s[0] - u * dx, p[1] - s[1] - u * dy);
  };
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}

/** Minimum distance between two polygon outlines (edges only). */
export function edgeDist(A, B) {
  let best = Infinity;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      best = Math.min(
        best,
        segDist(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]),
      );
    }
  }
  return best;
}

/** Distance between two shapes: 0 if one contains the other or they cross. */
export function polyGap(A, B) {
  const d = edgeDist(A, B);
  if (d === 0) return 0;
  if (pointInPoly(A[0], B) || pointInPoly(B[0], A)) return 0;
  return d;
}

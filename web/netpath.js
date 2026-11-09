// The connecting animation: a neon signal traces a winding circuit-board route from the deck (left) to the
// camera (right), with sharp 45-degree bends, then flashes "JACKED IN" (or "NO CARRIER" in magenta/gray).
// Canvas 2D, about 30 fps, drawn only while connecting. Reduced motion: a plain labeled progress bar.
const CYAN = '#19e3ff',
  MAGENTA = '#ff2bd6',
  AMBER = '#ffb000';
const MIN_MS = 2200; // the trace takes at least this long, so the route can be seen
const FLASH_MS = 700;

// Route: waypoints stepping right across the width, wandering up and down, as 45-degree and straight runs.
function route(w, h) {
  const pts = [[w * 0.06, h * 0.5]];
  let [x, y] = pts[0];
  const cols = 9;
  const dx = (w * 0.88) / cols;
  for (let i = 0; i < cols; i++) {
    const ty = h * (0.18 + 0.64 * ((Math.sin(i * 2.3 + 1) + 1) / 2));
    const run = Math.abs(ty - y);
    const diag = Math.min(run, dx * 0.6); // a 45-degree stretch
    const dirY = ty >= y ? 1 : -1;
    x += (dx - diag) / 2;
    pts.push([x, y]);
    x += diag;
    y += dirY * diag;
    pts.push([x, y]);
    x += (dx - diag) / 2;
    pts.push([x, y]);
  }
  pts.push([w * 0.94, y]);
  return pts;
}
function lengths(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++)
    acc.push(
      acc[i - 1] +
        Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
    );
  return acc;
}
function at(pts, acc, d) {
  let i = 1;
  while (i < acc.length - 1 && acc[i] < d) i++;
  const k = (d - acc[i - 1]) / (acc[i] - acc[i - 1] || 1);
  return [
    pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k,
    pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k,
    i,
  ];
}

export function netpath(host, reduced) {
  const cv = document.createElement('canvas');
  cv.width = 640;
  cv.height = 360;
  cv.setAttribute('aria-hidden', 'true');
  host.replaceChildren(cv);
  const label = document.createElement('div');
  label.className = 'netlabel';
  label.setAttribute('role', 'status');
  host.append(label);
  const ctx = cv.getContext('2d');
  const pts = route(cv.width, cv.height),
    acc = lengths(pts),
    total = acc[acc.length - 1];
  let t0 = 0,
    raf = 0,
    result = null, // null while connecting, then true or false
    doneAt = 0;
  let resolveDone = null;

  function draw(now) {
    const e = now - t0;
    // The head races ahead while connecting, waits near the end until the answer comes.
    const prog = Math.min(1, e / MIN_MS);
    const head = result === null ? Math.min(prog, 0.92) : prog;
    const d = total * head;
    ctx.clearRect(0, 0, cv.width, cv.height);
    // Faint full route (the board's copper).
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(25,227,255,0.18)';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    // Lit part, with glow.
    const [hx, hy, hi] = at(pts, acc, d);
    const color = result === false ? MAGENTA : CYAN;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.beginPath();
    pts
      .slice(0, hi)
      .forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(hx, hy);
    ctx.stroke();
    // Junction pads along the lit route, and the bright head.
    ctx.fillStyle = AMBER;
    for (let i = 3; i < hi; i += 3)
      ctx.fillRect(pts[i][0] - 3, pts[i][1] - 3, 6, 6);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, 7);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Endpoints: deck and camera.
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 2;
    ctx.strokeRect(pts[0][0] - 14, pts[0][1] - 10, 20, 20);
    const [ex, ey] = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(ex + 6, ey, 11, 0, 7);
    ctx.stroke();
    if (result !== null && head >= 1) {
      // The "jacked in" moment: a ring bursts from the camera end.
      const f = Math.min(1, Math.max(0, (now - doneAt) / FLASH_MS));
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = result ? '#fff' : MAGENTA;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(ex + 6, ey, 11 + f * 90, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = 1;
      label.textContent = result ? 'JACKED IN' : 'NO CARRIER';
      label.classList.toggle('bad', !result);
      if (f >= 1) return finish();
    }
    raf = requestAnimationFrame(draw);
  }
  function finish() {
    cancelAnimationFrame(raf);
    host.hidden = true;
    resolveDone?.();
  }
  return {
    start() {
      host.hidden = false;
      result = null;
      label.classList.remove('bad');
      label.textContent = 'TRACING ROUTE';
      if (reduced) {
        cv.hidden = true;
        host.classList.add('static');
        return;
      }
      host.classList.remove('static');
      cv.hidden = false;
      t0 = performance.now();
      raf = requestAnimationFrame(draw);
    },
    // ok: true shows the jacked-in moment, false the no-carrier one. Resolves when it has played.
    end(ok) {
      result = ok;
      if (reduced) {
        label.textContent = ok ? 'JACKED IN' : 'NO CARRIER';
        return new Promise((r) =>
          setTimeout(() => {
            host.hidden = true;
            r();
          }, 500),
        );
      }
      const wait = Math.max(0, MIN_MS - (performance.now() - t0));
      return new Promise((r) => {
        resolveDone = r;
        doneAt = performance.now() + wait;
      });
    },
  };
}

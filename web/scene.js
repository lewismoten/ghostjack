// Decorative 3D (three.js, loaded lazily from a CDN): a neon grid-floor background and a wireframe model of
// the camera (ball on a pedestal) that turns to the estimated pan/tilt. Renders at most ~30 fps and stops
// when the tab is hidden or the model is off screen. Any failure leaves the CSS-only look in place.
const THREE_URL =
  'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

export async function start({ bg, model, reduced }) {
  const THREE = await import(THREE_URL);
  const cyan = 0x19e3ff,
    magenta = 0xff2bd6,
    amber = 0xffb000;
  const mk = (canvas, w, h, alpha = true) => {
    const r = new THREE.WebGLRenderer({
      canvas,
      alpha,
      antialias: false,
      powerPreference: 'low-power',
    });
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    r.setClearColor(0x000000, 0);
    return r;
  };

  // Background: perspective grid floor drifting toward the viewer, plus a few slow particles.
  const bgW = () => Math.ceil(innerWidth / 2),
    bgH = () => Math.ceil(innerHeight / 2);
  const bgR = mk(bg, bgW(), bgH());
  const bgS = new THREE.Scene(),
    bgC = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
  bgC.position.set(0, 1.2, 4);
  bgC.lookAt(0, 0.6, -10);
  const grid = new THREE.GridHelper(80, 80, magenta, cyan);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  bgS.add(grid);
  const pts = new Float32Array(150),
    seed = (i) => (Math.sin(i * 12.9898) * 43758.5453) % 1;
  for (let i = 0; i < 50; i++) {
    pts[i * 3] = seed(i) * 20;
    pts[i * 3 + 1] = Math.abs(seed(i + 99)) * 8 + 0.3;
    pts[i * 3 + 2] = -Math.abs(seed(i + 7)) * 40;
  }
  const dust = new THREE.Points(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(pts, 3),
    ),
    new THREE.PointsMaterial({
      color: amber,
      size: 0.06,
      transparent: true,
      opacity: 0.7,
    }),
  );
  bgS.add(dust);

  // Camera model: sphere with a lens on a short pedestal, in wireframe.
  const mR = mk(model, model.width, model.height);
  const mS = new THREE.Scene(),
    mC = new THREE.PerspectiveCamera(40, model.width / model.height, 0.1, 50);
  mC.position.set(0, 1.1, 5);
  mC.lookAt(0, 0.4, 0);
  const line = (geo, color) =>
    new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color }),
    );
  const base = line(new THREE.CylinderGeometry(1.1, 1.3, 0.35, 20, 1), magenta);
  base.position.y = -0.2;
  mS.add(base);
  const neck = line(new THREE.CylinderGeometry(0.4, 0.5, 0.35, 12, 1), amber);
  neck.position.y = 0.15;
  mS.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.95;
  head.add(line(new THREE.SphereGeometry(0.9, 16, 12), cyan));
  const lens = line(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 14, 1), amber);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = 0.95;
  head.add(lens);
  const eye = new THREE.Mesh(
    new THREE.CircleGeometry(0.2, 16),
    new THREE.MeshBasicMaterial({ color: magenta }),
  );
  eye.position.z = 1.21;
  head.add(eye);
  mS.add(head);

  let pan = 0,
    tilt = 0,
    tp = 0,
    tt = 0; // radians
  const DEG = Math.PI / 180;
  const api = {
    // pan, tilt in degrees of illustration; instant skips the glide (reduced motion)
    setPose(p, t, instant) {
      tp = p * DEG;
      tt = t * DEG;
      if (instant || reduced) {
        pan = tp;
        tilt = tt;
        dirty = true;
      }
    },
  };
  let dirty = true,
    modelVisible = true,
    last = 0,
    z = 0;
  new IntersectionObserver((e) => {
    modelVisible = e[0].isIntersecting;
  }).observe(model);
  addEventListener('resize', () => {
    bgR.setSize(bgW(), bgH(), false);
    bgC.aspect = innerWidth / innerHeight;
    bgC.updateProjectionMatrix();
    dirty = true;
  });

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || now - last < 33) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const moving = Math.abs(tp - pan) + Math.abs(tt - tilt) > 0.002;
    if (moving) {
      const k = 1 - Math.exp(-6 * dt);
      pan += (tp - pan) * k;
      tilt += (tt - tilt) * k;
      dirty = true;
    }
    if (!reduced) {
      z = (z + dt * 0.6) % 1;
      grid.position.z = z;
      dust.rotation.y += dt * 0.02;
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;
    bgR.render(bgS, bgC);
    if (modelVisible) {
      head.rotation.set(-tilt, pan, 0, 'YXZ');
      base.rotation.y = neck.rotation.y = 0;
      mR.render(mS, mC);
    }
  }
  requestAnimationFrame(frame);
  return api;
}

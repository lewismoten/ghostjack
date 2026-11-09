// Decorative 3D (three.js, vendored in web/vendor, loaded lazily): a neon grid-floor background and a wireframe model of
// the camera (ball on a pedestal) that turns to the estimated pan/tilt. Renders at most ~30 fps and stops
// when the tab is hidden or the model is off screen. Any failure leaves the CSS-only look in place.
const THREE_URL = './vendor/three.module.js';

export async function start({ bg, model, reduced, onPulse, canPulse }) {
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

  // Floating cables above the grid: curved tubes that drift and twist (a vertex shader, so the geometry
  // is built once), with pulses of light traveling along them (fragment shader). Five draw calls.
  // Reduced motion: still wires, no pulses. Every few seconds one fast bright pulse runs along a wire
  // and onPulse(pan, direction) lets the page play a soft whoosh (Sound effects switch).
  const wires = [
    [cyan, 0.045, 0.07, 3.6, -12, 0.6],
    [magenta, 0.03, -0.11, 5.2, -18, 1.9],
    [amber, 0.06, 0.05, 2.7, -8, 3.1],
    [cyan, 0.025, -0.15, 6.2, -26, 4.4],
    [magenta, 0.04, 0.09, 4.4, -22, 5.8],
  ].map(([color, radius, speed, y, z, ph], i) => {
    const wob = (k) => Math.sin(i * 7.7 + k * 1.3);
    const curve = new THREE.CatmullRomCurve3(
      [-18, -10, -3, 4, 11, 18].map(
        (x, k) => new THREE.Vector3(x, y + wob(k) * 1.1, z + wob(k + 9) * 3),
      ),
    );
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uT: { value: 0 },
        uAmp: { value: reduced ? 0 : 1 },
        uPh: { value: ph },
        uSpeed: { value: speed },
        uCol: { value: new THREE.Color(color) },
        uBase: { value: 0.22 },
        uPulse: { value: reduced ? 0 : 1.1 },
        uBurst: { value: -1 },
      },
      vertexShader: `uniform float uT,uAmp,uPh; varying float vU;
        void main(){ vU=uv.x; vec3 p=position;
          p.y+=sin(p.x*0.55+uT*0.35+uPh)*0.35*uAmp+sin(p.z*0.8+uT*0.5)*0.1*uAmp;
          p.z+=cos(p.x*0.4+uT*0.27+uPh*1.7)*0.5*uAmp;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); }`,
      fragmentShader: `uniform vec3 uCol; uniform float uT,uSpeed,uPh,uBase,uPulse,uBurst; varying float vU;
        float bump(float u,float c,float w){ float d=u-c; return exp(-d*d/(w*w)); }
        void main(){ float c=fract(uT*uSpeed+uPh);
          float a=uBase+uPulse*bump(vU,c,0.03);
          if(uBurst>=0.0) a+=1.3*bump(vU,uBurst,0.022);
          gl_FragColor=vec4(uCol*(0.5+a),clamp(a,0.0,1.0)*0.85); }`,
    });
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 90, radius, 5),
      mat,
    );
    bgS.add(mesh);
    return { mat, curve, burst: null };
  });
  let wireT = 0,
    nextPulse = 6 + Math.random() * 6; // seconds; then 8 to 20 s apart
  function launchPulse() {
    const w = wires[Math.floor(Math.random() * wires.length)];
    if (w.burst) return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    w.burst = { u: dir > 0 ? 0 : 1, dir };
  }

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
  const ball = line(new THREE.SphereGeometry(0.9, 16, 12), cyan);
  head.add(ball);
  const lens = line(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 14, 1), amber);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = 0.95;
  lens.name = 'lens';
  head.add(lens);
  const eye = new THREE.Mesh(
    new THREE.CircleGeometry(0.2, 16),
    new THREE.MeshBasicMaterial({ color: magenta }),
  );
  eye.position.z = 1.21;
  head.add(eye);
  mS.add(head);

  // Travel target: a reticle where the camera is headed, a thin line to it
  // from the lens, and a ring that fills as the trip goes (the predicted time).
  const ringPts = (n, r) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = Math.PI / 2 - (i / n) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0);
    });
  const lineOf = (pts, color, opacity = 1) =>
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    );
  const reticle = new THREE.Group();
  const RING_N = 48;
  reticle.add(lineOf(ringPts(RING_N, 0.26), magenta, 0.35));
  const fill = lineOf(ringPts(RING_N, 0.33), amber);
  reticle.add(fill);
  reticle.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(
        [
          [-0.4, 0, -0.12, 0],
          [0.12, 0, 0.4, 0],
          [0, -0.4, 0, -0.12],
          [0, 0.12, 0, 0.4],
        ].flatMap(([a, b, c, d]) => [
          new THREE.Vector3(a, b, 0),
          new THREE.Vector3(c, d, 0),
        ]),
      ),
      new THREE.LineBasicMaterial({ color: magenta }),
    ),
  );
  reticle.scale.setScalar(0.75);
  // always drawn on top, so a target behind the camera still shows
  const onTop = (o) => {
    o.renderOrder = 10;
    o.material.depthTest = false;
  };
  reticle.children.forEach(onTop);
  reticle.visible = false;
  mS.add(reticle);
  const tether = lineOf(
    [new THREE.Vector3(), new THREE.Vector3()],
    magenta,
    0.6,
  );
  tether.visible = false;
  onTop(tether);
  mS.add(tether);
  const dirOf = (p, t) =>
    new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(-t, p, 0, 'YXZ'));
  let trip = null; // { p0, t0, p1, t1, start, ms }

  let pan = 0,
    tilt = 0,
    tp = 0,
    tt = 0; // radians
  const DEG = Math.PI / 180;
  const api = {
    // pan, tilt in degrees of illustration; instant skips the glide (reduced motion)
    // amber while the camera is on its way to a commanded aim ("moving"), cyan otherwise
    setMoving(on) {
      ball.material.color.setHex(on ? amber : cyan);
      lens.material.color.setHex(on ? magenta : amber);
      dirty = true;
    },
    // while live video plays, drop to about 15 fps so the picture never competes for the main thread
    setLive(on) {
      minGap = on ? 66 : 33;
    },
    // a travel move: glide from where the model is to (p, t) degrees over the
    // predicted ms, with the target reticle showing; arrive() ends it
    travel(p, t, ms) {
      trip = {
        p0: pan,
        t0: tilt,
        p1: p * DEG,
        t1: t * DEG,
        start: performance.now(),
        ms: Math.max(200, ms),
      };
      tp = trip.p1;
      tt = trip.t1;
      dirty = true;
    },
    arrive() {
      trip = null;
      reticle.visible = tether.visible = false;
      dirty = true;
    },
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
    minGap = 33,
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
    if (document.hidden || now - last < minGap) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const moving = Math.abs(tp - pan) + Math.abs(tt - tilt) > 0.002;
    if (trip) {
      const f = Math.min(1, (now - trip.start) / trip.ms);
      const e = reduced ? 1 : f < 0.5 ? 2 * f * f : 1 - (2 - 2 * f) ** 2 / 2;
      pan = trip.p0 + (trip.p1 - trip.p0) * e;
      tilt = trip.t0 + (trip.t1 - trip.t0) * e;
      const d = dirOf(trip.p1, trip.t1);
      reticle.position.copy(head.position).addScaledVector(d, 1.4);
      reticle.quaternion.copy(mC.quaternion);
      fill.geometry.setDrawRange(0, Math.max(1, Math.round(f * RING_N) + 1));
      // past the prediction and not there yet: the ring blinks
      fill.visible = f < 1 || Math.floor(now / 300) % 2 === 0;
      const a = tether.geometry.attributes.position;
      const from = head.position
        .clone()
        .addScaledVector(dirOf(pan, tilt), 1.21);
      a.setXYZ(0, from.x, from.y, from.z);
      a.setXYZ(1, reticle.position.x, reticle.position.y, reticle.position.z);
      a.needsUpdate = true;
      reticle.visible = tether.visible = true;
      dirty = true;
    } else if (moving) {
      const k = 1 - Math.exp(-6 * dt);
      pan += (tp - pan) * k;
      tilt += (tt - tilt) * k;
      dirty = true;
    }
    if (!reduced) {
      wireT += dt;
      for (const w of wires) {
        w.mat.uniforms.uT.value = wireT;
        const b = w.burst;
        if (b) {
          b.u += b.dir * dt * 0.45;
          w.mat.uniforms.uBurst.value = b.u;
          if (b.u < -0.05 || b.u > 1.05) {
            w.burst = null;
            w.mat.uniforms.uBurst.value = -1;
          }
        }
      }
      nextPulse -= dt;
      if (nextPulse <= 0) {
        nextPulse = 8 + Math.random() * 12;
        if (!canPulse || canPulse()) {
          launchPulse();
          const w = wires.find((x) => x.burst);
          if (w) onPulse?.(w.burst.dir);
        }
      }
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

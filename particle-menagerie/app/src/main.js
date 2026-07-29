// Integrator — Phase C board. WebGL2 gate, renderer, camera with a 1:1
// CSS-pixel z=0 plane, the full 9-archetype menagerie (registry + lexicon),
// board spawn/disperse with staggered formation, per-class motion (swimmers
// roam, rooted anchor to a seabed line, drifters wander + idle spin),
// same-species schooling, ambient plankton, URL-hash persistence, injectable
// clock, and the window.__menagerie test surface. Phase B spike scenes
// (?scene=duo|eel|ray|pileup) are preserved verbatim for the harness.

import * as THREE from 'three';
import { createPipeline } from './render/pipeline.js';
import { createGlobalUniforms, createDotMaterial } from './shaders/dots.js';
import { mulberry32, hashName } from './geometry/rng.js';
import { REGISTRY } from './creatures.js';
import { resolveName, colorFromHue } from './lexicon.js';

const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const FOV = 55;
const FORM_TIME = 1.5; // seconds, uFormation 0 -> 1
const EASE_RATE = 4.5; // 1/s; same coefficient eases positions AND normals
const MAXC = 14; // board population cap
const SPAWN_STAGGER = 0.35; // s between formation starts in a batch
const DIE_TIME = 1.3; // s disperse fade
const TAU = Math.PI * 2;

const params = new URLSearchParams(location.search);

// ---- WebGL2 gate ----------------------------------------------------------
const probe = document.createElement('canvas');
if (!probe.getContext('webgl2')) {
  document.getElementById('webgl-required').style.display = 'flex';
} else {
  boot();
}

function boot() {
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: false, // frame-graph hard rule 6
    powerPreference: 'high-performance',
  });

  // Camera: z=0 plane maps 1:1 to CSS pixels — camDist = (cssH/2)/tan(fov/2).
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 5000);
  let camDist = 1;
  let camYaw = 0;
  function applyCamera() {
    camera.position.set(Math.sin(camYaw) * camDist, 0, Math.cos(camYaw) * camDist);
    camera.lookAt(0, 0, 0);
  }
  function updateCameraDistance(cssH) {
    camDist = cssH / 2 / Math.tan((FOV * Math.PI) / 360);
    applyCamera();
  }
  updateCameraDistance(window.innerHeight || 540);

  const scene = new THREE.Scene();

  // ---- global lighting / medium: cool abyssal water -----------------------
  // (tuning pass: monochrome-by-default cool-cyan cast — light is a cold
  // white-blue instead of the spike's warm lamp)
  const globalUniforms = createGlobalUniforms(renderer);
  globalUniforms.uLightDir.value.set(-0.45, 0.75, 0.4).normalize();
  globalUniforms.uLightColor.value.setRGB(0.8, 0.94, 1.05);
  globalUniforms.uRim.value = 1.25;
  globalUniforms.uFogDensity.value = 0.0015;
  globalUniforms.uAperture.value = 0.0016;
  globalUniforms.uFocusZ.value = camDist;

  // ---- state --------------------------------------------------------------
  const state = {
    sway: parseFloatOr(params.get('sway'), 1.0),
    simT: 0,
    creatures: [],
    pending: [], // { due, spec } — staggered formation ramp
    focus: null, // creature whose depth drives uFocusZ (spike scenes)
    boardMode: false,
    spawnSlot: 0, // deterministic placement counter
    W: window.innerWidth || 960,
    H: window.innerHeight || 540,
  };

  function parseFloatOr(v, d) {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : d;
  }

  // ---- creature -----------------------------------------------------------
  class Creature {
    constructor(spec) {
      this.spec = spec;
      const entry = REGISTRY[spec.arch];
      this.klass = spec.klass; // 'legacy' | 'swimmer' | 'rooted' | 'drifter'
      this.gen = entry.maker(spec.seed);
      const n = this.gen.count;
      this.tpos = new Float32Array(n * 3);
      this.tnor = new Float32Array(n * 3);

      const pos = new Float32Array(n * 3);
      const nor = new Float32Array(n * 3);
      const aSize = new Float32Array(n);
      const aTw = new Float32Array(n);
      const aRing = new Float32Array(n);
      this.gen.init({ aSize, aTw, aRing });
      // aSize is authored ~[0.4..1.25]; rescale so a dot at this creature's
      // depth renders ~spec.dotPx CSS px (shader: px = aSize*REF_DIST/viewDist)
      const viewDist0 = camDist - spec.base[2];
      const sizeScale = (spec.dotPx * viewDist0) / REF_DIST;
      for (let i = 0; i < n; i++) aSize[i] *= sizeScale;

      // formation start: scattered cloud in local space, random normals; the
      // shared easing pulls both toward targets while uFormation ramps.
      const rng = mulberry32(spec.seed ^ 0x5f356495);
      const R = spec.scatterR;
      for (let i = 0; i < n * 3; i++) pos[i] = (rng() * 2 - 1) * R;
      for (let i = 0; i < n * 3; i++) nor[i] = rng() * 2 - 1;

      const g = new THREE.BufferGeometry();
      this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
      this.norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', this.posAttr);
      g.setAttribute('normal', this.norAttr);
      g.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
      g.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
      g.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));
      // fixed local bounding sphere (geometry-spec section 10) — never recomputed
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), spec.boundR);
      // lean school members: render-fraction only (geometry-spec section 9);
      // the build-time cross-ring shuffle makes any prefix a uniform subsample
      if (spec.drawFrac < 1) g.setDrawRange(0, Math.floor(n * spec.drawFrac));
      this.geometry = g;

      this.material = createDotMaterial(globalUniforms);
      this.material.uniforms.uColor.value.setRGB(...spec.color);
      this.material.uniforms.uAlpha.value = spec.alpha;
      this.material.uniforms.uFormation.value = 0;

      this.points = new THREE.Points(g, this.material);
      this.points.rotation.order = 'YXZ'; // yaw, then pitch, then bank
      this.points.scale.setScalar(spec.scale);
      this.spawnT = state.simT;
      this.state = 'alive';
      this.dieT = 0;
      this.d0 = rng() * TAU;
      this.d1 = rng() * TAU;
      this.d2 = rng() * TAU;
      // anchor position + heading (board classes move the anchor)
      this.px = spec.base[0];
      this.py = spec.base[1];
      this.pz = spec.base[2];
      this.heading = spec.heading ?? 0;
      this.speed = spec.speed ?? 0;
      this.rad = spec.boundR * spec.scale; // world-px interaction radius
      this.applyMotion(state.simT, 0);
    }

    // legacy spike drift — byte-for-byte the Phase B behavior
    applyDrift(t) {
      const s = this.spec;
      const o = this.points;
      o.position.set(
        s.base[0] + s.driftAmp[0] * Math.sin(0.11 * t + this.d0),
        s.base[1] + s.driftAmp[1] * Math.sin(0.07 * t + this.d1),
        s.base[2] + s.driftAmp[2] * Math.sin(0.045 * t + this.d2),
      );
      o.rotation.set(
        s.rot[0] + 0.06 * Math.sin(0.05 * t + this.d1),
        s.rot[1] + s.yawAmp * Math.sin(0.08 * t + this.d0),
        s.rot[2] + 0.05 * Math.sin(0.06 * t + this.d2),
      );
    }

    applyMotion(t, dt) {
      const s = this.spec;
      const o = this.points;
      if (this.klass === 'legacy') {
        this.applyDrift(t);
        return;
      }
      if (this.klass === 'rooted') {
        // anchored to the seabed; only a gentle current wobble in the frame
        o.position.set(this.px, this.py, this.pz);
        o.rotation.set(
          0.03 * Math.sin(0.05 * t + this.d1),
          s.rot[1] + 0.06 * Math.sin(0.04 * t + this.d0),
          0.03 * Math.sin(0.06 * t + this.d2),
        );
        return;
      }
      if (this.klass === 'drifter') {
        // slow closed-form wander around the anchor + idle spin
        o.position.set(
          this.px + s.driftAmp[0] * Math.sin(0.055 * t + this.d0),
          this.py + s.driftAmp[1] * Math.sin(0.04 * t + this.d1),
          this.pz + s.driftAmp[2] * Math.sin(0.03 * t + this.d2),
        );
        o.rotation.set(
          s.rot[0] + 0.08 * Math.sin(0.05 * t + this.d1),
          s.rot[1] + s.spin * (t - this.spawnT) + 0.1 * Math.sin(0.06 * t + this.d0),
          0.06 * Math.sin(0.045 * t + this.d2),
        );
        return;
      }
      // swimmer: v2's two-sine heading wander, integrated in 3D (yaw through
      // depth — no 2D flip), with soft steering back into the water volume.
      // A gentle restoring term biases headings toward the cross-screen axes
      // (heading ≡ 0 or π) so bodies read side-on more than end-on — an
      // end-on creature is both unreadable and an additive hot spot.
      const turn =
        Math.sin(t * 0.31 + this.d0) * 0.35 +
        Math.sin(t * 0.13 + this.d1) * 0.25 -
        0.4 * Math.sin(2 * this.heading);
      this.heading += turn * dt;
      const hw = state.W / 2 - 140;
      const hh = state.H / 2 - 120;
      const out =
        Math.abs(this.px) > hw || this.pz < Z_MIN + 40 || this.pz > Z_MAX - 30;
      if (out) {
        const ta = Math.atan2(-(Z_MID - this.pz), 0 - this.px);
        let diff = ta - this.heading;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        this.heading += diff * 1.4 * dt;
      }
      this.px += Math.cos(this.heading) * this.speed * dt;
      this.pz += -Math.sin(this.heading) * this.speed * dt;
      this.py += Math.sin(t * 0.09 + this.d2) * this.speed * 0.3 * dt;
      if (Math.abs(this.py) > hh) this.py += (0 - this.py) * 0.4 * dt;
      o.position.set(this.px, this.py, this.pz);
      o.rotation.set(
        s.rot[0] + 0.05 * Math.sin(0.07 * t + this.d1),
        this.heading + s.yawOffset,
        -turn * 0.35, // bank into the turn
      );
    }

    update(simT, dt, sway) {
      this.gen.updateTargets(simT + this.spec.phase, sway, this.spec.tempo, this.tpos, this.tnor);
      const c = 1 - Math.exp(-EASE_RATE * dt);
      const p = this.posAttr.array;
      const q = this.norAttr.array;
      const tp = this.tpos;
      const tn = this.tnor;
      for (let i = 0; i < p.length; i++) {
        p[i] += (tp[i] - p[i]) * c;
        q[i] += (tn[i] - q[i]) * c;
      }
      this.posAttr.needsUpdate = true;
      this.norAttr.needsUpdate = true;
      const u = this.material.uniforms;
      u.uTime.value = simT;
      u.uFormation.value = Math.min(Math.max((simT - this.spawnT) / FORM_TIME, 0), 1);
      if (this.state === 'dying') {
        this.dieT += dt;
        const f = Math.max(0, 1 - this.dieT / DIE_TIME);
        u.uAlpha.value = this.spec.alpha * f * f;
        this.py += 14 * dt; // released creatures loosen upward as they fade
      }
      this.applyMotion(simT, dt);
      return !(this.state === 'dying' && this.dieT >= DIE_TIME);
    }

    disperse() {
      if (this.state === 'alive') {
        this.state = 'dying';
        this.dieT = 0;
      }
    }

    dispose() {
      this.geometry.dispose();
      this.material.dispose();
    }
  }

  // ---- water volume (world px; z band shared by placement + steering) -----
  const Z_MIN = -340;
  const Z_MAX = 40;
  const Z_MID = -130;

  // ---- Phase B spike scenes (verbatim from the spike — harness contract) --
  function eelSpec(over) {
    return {
      kind: 'eel',
      arch: 'eel',
      klass: 'legacy',
      seed: 1337,
      base: [0, 15, -20],
      rot: [0, -0.45, 0.06],
      scale: 60,
      dotPx: 5.0,
      color: [0.7, 0.87, 1.0],
      alpha: 1.0,
      tempo: 1.0,
      phase: 0,
      boundR: 4.2,
      scatterR: 3.0,
      driftAmp: [26, 16, 10],
      yawAmp: 0.28,
      drawFrac: 1,
      focus: false,
      ...over,
    };
  }

  function raySpec(over) {
    return {
      kind: 'ray',
      arch: 'ray',
      klass: 'legacy',
      seed: 4242,
      base: [0, -10, -60],
      rot: [-1.05, 0.4, 0],
      scale: 95,
      dotPx: 4.6,
      color: [0.85, 0.88, 1.0],
      alpha: 1.35,
      tempo: 1.0,
      phase: 0,
      boundR: 3.4,
      scatterR: 2.6,
      driftAmp: [24, 12, 14],
      yawAmp: 0.18,
      drawFrac: 1,
      focus: false,
      ...over,
    };
  }

  function sceneSpecs(name) {
    switch (name) {
      case 'eel':
        return [eelSpec({ focus: true, scale: 72 })];
      case 'ray':
        return [raySpec({ focus: true, rot: [-1.0, 0.35, 0] })];
      case 'pileup': {
        const specs = [];
        for (let i = 0; i < 10; i++) {
          specs.push(
            eelSpec({
              seed: 7000 + i,
              base: [0, 10, -30],
              scale: 55,
              phase: i * 0.77,
              focus: i === 0,
            }),
          );
        }
        return specs;
      }
      case 'duo':
      default:
        return [
          // eel mid-frame coiling, in focus; ray deeper, dimmed + defocused
          eelSpec({ base: [-120, 60, -10], rot: [0, -0.35, 0.08], scale: 78, focus: true }),
          raySpec({ base: [185, -100, -280], rot: [-1.05, 0.5, 0], scale: 95 }),
        ];
    }
  }

  // ---- board: lexicon spec -> placed creature spec ------------------------
  function boardSpec(res, instance) {
    const entry = REGISTRY[res.arch];
    const slot = state.spawnSlot++;
    const prng = mulberry32((res.seed ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0);
    const school = res.count > 1;
    const scale = entry.scale * res.scale * (0.88 + 0.24 * prng()) * (school ? 0.82 : 1);
    const klass = entry.class;
    let base;
    let heading = prng() * TAU;
    if (klass === 'rooted') {
      const px = (prng() * 2 - 1) * (state.W / 2 - 120);
      const pz = -280 + prng() * 260;
      const vd = (camDist - pz) / camDist;
      const lift = 4 + prng() * 36; // px above the projected bottom edge
      base = [px, -(state.H / 2 - lift) * vd, pz];
    } else {
      base = [
        (prng() * 2 - 1) * (state.W / 2 - 180),
        (prng() * 2 - 1) * (state.H / 2 - 150),
        Z_MIN + 20 + prng() * (Z_MAX - Z_MIN - 40),
      ];
    }
    return {
      kind: res.arch,
      arch: res.arch,
      klass,
      name: res.name,
      count: res.count,
      instance,
      seed: res.seed,
      base,
      heading,
      rot: [entry.pitch, klass === 'rooted' || klass === 'drifter' ? prng() * TAU : 0, 0],
      scale,
      dotPx: entry.dotPx,
      color: colorFromHue(res.hue),
      alpha: entry.alpha * (res.ghost ? 0.45 : 1),
      tempo: res.tempo * (0.85 + 0.3 * prng()),
      phase: prng() * TAU + instance * 0.77,
      boundR: entry.boundR,
      scatterR: entry.boundR * 0.8,
      driftAmp: klass === 'drifter' ? [44, 26, 30] : [0, 0, 0],
      yawAmp: 0,
      yawOffset: entry.yawOffset,
      spin: entry.spin,
      speed: entry.speed * res.speed * (0.8 + 0.4 * prng()),
      drawFrac: school ? 0.55 : 1,
      focus: false,
    };
  }

  function aliveCount() {
    let n = 0;
    for (const c of state.creatures) if (c.state === 'alive') n++;
    return n + state.pending.length;
  }

  function spawnName(raw, opts = {}) {
    const res = resolveName(raw);
    if (!res.name) return null;
    state.boardMode = true;
    const n = Math.min(res.count, 6);
    // over cap: disperse oldest alive (v2 rule)
    for (let over = aliveCount() + n - MAXC; over > 0; over--) {
      const oldest = state.creatures.find((c) => c.state === 'alive');
      if (!oldest) break;
      oldest.disperse();
    }
    for (let i = 0; i < n; i++) {
      const spec = boardSpec(res, i);
      if (opts.center && n === 1) {
        // museum pose for solo shots: centered, side-on, no roaming
        spec.base = [0, klassCenterY(spec), -60];
        spec.heading = Math.PI * 0.08;
        spec.speed = 0;
      }
      state.pending.push({ due: state.simT + i * SPAWN_STAGGER * (opts.now ? 0 : 1), spec });
    }
    saveHash();
    return res;
  }

  function klassCenterY(spec) {
    if (spec.klass !== 'rooted') return 0;
    const vd = (camDist + 60) / camDist;
    return -(state.H / 2 - 34) * vd;
  }

  // Hash derives from live state (same hash → identical board, spec §8-10):
  // one entry per species batch, count re-prefixed like v2 ("school of fish"
  // round-trips as "5 fish").
  const NUM_WORDS = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
  function saveHash() {
    if (!state.boardMode) return;
    const names = [];
    const seen = new Set();
    const add = (spec) => {
      if (spec.instance !== 0 || seen.has(spec.name)) return;
      seen.add(spec.name);
      names.push(spec.count > 1 ? `${NUM_WORDS[spec.count]} ${spec.name}` : spec.name);
    };
    for (const c of state.creatures) if (c.state === 'alive' && c.klass !== 'legacy') add(c.spec);
    for (const p of state.pending) add(p.spec);
    try {
      history.replaceState(null, '', names.length ? '#' + encodeURIComponent(names.join(',')) : location.pathname + location.search);
    } catch {
      /* about:blank / file contexts */
    }
  }

  function loadBoard(csv, opts = {}) {
    releaseAll();
    state.spawnSlot = 0;
    state.boardMode = true;
    const names = String(csv)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAXC);
    for (const n of names) spawnName(n, opts);
  }

  function releaseAll() {
    for (const c of state.creatures) {
      scene.remove(c.points);
      c.dispose();
    }
    state.creatures = [];
    state.pending = [];
    state.focus = null;
  }

  function setScene(name) {
    releaseAll();
    state.boardMode = false;
    for (const spec of sceneSpecs(name)) {
      const c = new Creature(spec);
      state.creatures.push(c);
      scene.add(c.points);
      if (spec.focus) state.focus = c;
    }
    if (!state.focus && state.creatures.length) state.focus = state.creatures[0];
  }

  // ---- ambient plankton: one 400-dot Points, drifting ---------------------
  // Board-mode only: the Phase B spike scenes (?scene=) are a pixel-level
  // harness contract (soak decay-to-black, pileup blowout bound) and must not
  // gain a persistent emitter.
  const plankton = (() => {
    const N = 400;
    const rng = mulberry32(0xabad1dea);
    const bx = new Float32Array(N);
    const by = new Float32Array(N);
    const bz = new Float32Array(N);
    const vx = new Float32Array(N);
    const vy = new Float32Array(N);
    const ph = new Float32Array(N);
    const hw = state.W / 2 + 150;
    const hh = state.H / 2 + 100;
    for (let i = 0; i < N; i++) {
      bx[i] = (rng() * 2 - 1) * hw;
      by[i] = (rng() * 2 - 1) * hh;
      bz[i] = Z_MIN - 60 + rng() * (Z_MAX - Z_MIN + 90);
      vx[i] = 3 + 7 * rng();
      vy[i] = (rng() * 2 - 1) * 2.5;
      ph[i] = rng() * TAU;
    }
    const pos = new Float32Array(N * 3);
    const nor = new Float32Array(N * 3);
    const aSize = new Float32Array(N);
    const aTw = new Float32Array(N);
    const aRing = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let nx = rng() * 2 - 1;
      let ny = rng() * 2 - 1;
      let nz = rng() * 2 - 1;
      const il = 1 / Math.max(Math.hypot(nx, ny, nz), 1e-4);
      nor[i * 3] = nx * il;
      nor[i * 3 + 1] = ny * il;
      nor[i * 3 + 2] = nz * il;
      const vd = (camDist - bz[i]) / REF_DIST;
      aSize[i] = (1.6 + 1.6 * rng()) * vd;
      aTw[i] = rng();
      aRing[i] = rng();
    }
    const g = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', posAttr);
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    g.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
    g.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));
    const material = createDotMaterial(globalUniforms);
    material.uniforms.uColor.value.setRGB(0.62, 0.84, 1.0);
    material.uniforms.uAlpha.value = 0.4;
    material.uniforms.uFormation.value = 1;
    const points = new THREE.Points(g, material);
    points.frustumCulled = false;
    const wrap = (v, half) => {
      const span = half * 2;
      let m = (v + half) % span;
      if (m < 0) m += span;
      return m - half;
    };
    function update(t) {
      for (let i = 0; i < N; i++) {
        pos[i * 3] = wrap(bx[i] + vx[i] * t, hw);
        pos[i * 3 + 1] = wrap(by[i] + vy[i] * t + 9 * Math.sin(0.4 * t + ph[i]), hh);
        pos[i * 3 + 2] = bz[i];
      }
      posAttr.needsUpdate = true;
      material.uniforms.uTime.value = t;
    }
    update(0);
    return { points, update };
  })();
  plankton.enabled = !params.get('scene');
  if (plankton.enabled) scene.add(plankton.points);

  // ---- same-species schooling (v2 rule, in 3D): always separate, pull
  // toward same-name neighbors; anchors move, sine-wander rides on top ------
  function applySchooling(dt) {
    const sw = [];
    for (const c of state.creatures) {
      if (c.state === 'alive' && c.klass !== 'rooted' && c.klass !== 'legacy') sw.push(c);
    }
    for (let i = 0; i < sw.length; i++) {
      for (let j = i + 1; j < sw.length; j++) {
        const a = sw[i];
        const b = sw[j];
        const dx = b.px - a.px;
        const dy = b.py - a.py;
        const dz = b.pz - a.pz;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const min = (a.rad + b.rad) * 0.72;
        const ux = dx / dist;
        const uy = dy / dist;
        const uz = dz / dist;
        if (dist < min) {
          const push = ((min - dist) / min) * 22 * dt;
          a.px -= ux * push;
          a.py -= uy * push;
          a.pz -= uz * push;
          b.px += ux * push;
          b.py += uy * push;
          b.pz += uz * push;
        } else if (a.spec.name && a.spec.name === b.spec.name && dist < 560) {
          const pull = 7 * dt;
          a.px += ux * pull;
          a.py += uy * pull;
          a.pz += uz * pull;
          b.px -= ux * pull;
          b.py -= uy * pull;
          b.pz -= uz * pull;
        }
      }
    }
  }

  // ---- boot mode: ?scene= (Phase B spike) > ?board= > #hash > default -----
  const sceneParam = params.get('scene');
  const boardParam = params.get('board');
  const hashBoard = decodeURIComponent(location.hash.slice(1));
  if (sceneParam) {
    setScene(sceneParam);
  } else if (boardParam) {
    loadBoard(boardParam);
  } else if (hashBoard.trim()) {
    loadBoard(hashBoard);
  } else {
    loadBoard('jellyfish,kelp,eel');
  }

  // ---- summon input (temporary v2-style bare underline; Bathyscaphe chrome
  // replaces this in Phase D) — hidden in spike-scene mode to keep the Phase
  // B screenshots pixel-clean --------------------------------------------
  const form = document.getElementById('summon');
  const inp = document.getElementById('summon-input');
  if (form && inp) {
    if (sceneParam) form.style.display = 'none';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      if (v) {
        spawnName(v);
        inp.value = '';
      }
    });
    document.addEventListener('keydown', (e) => {
      if (document.activeElement !== inp && e.key.length === 1 && !e.metaKey && !e.ctrlKey) inp.focus();
    });
  }

  // ---- pipeline (created after creatures exist so compile() prewarms) -----
  // exposure trimmed 4.2 -> 3.4 so a 12-creature board glows without washing
  // out (tuning pass; single-creature scenes stay clearly readable)
  const pipeline = createPipeline(renderer, scene, camera, {
    exposure: parseFloatOr(params.get('exposure'), 3.4),
    trailsK: parseFloatOr(params.get('trails'), 0.25),
  });

  function onResize() {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    state.W = w;
    state.H = h;
    updateCameraDistance(h);
    pipeline.resize(w, h);
    globalUniforms.uDpr.value = renderer.getPixelRatio();
  }
  window.addEventListener('resize', onResize);
  onResize();

  // ---- HUD (dev only, ?hud=1) --------------------------------------------
  let hudEl = null;
  if (params.get('hud') === '1') {
    hudEl = document.createElement('div');
    hudEl.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:9;color:rgba(220,235,255,.75);' +
      'font:11px ui-monospace,Menlo,monospace;white-space:pre;pointer-events:none';
    document.body.appendChild(hudEl);
  }
  function updateHud() {
    if (!hudEl) return;
    hudEl.textContent =
      `${stats.lastFrameCpuMs.toFixed(2)} ms cpu  ` +
      `${state.creatures.length} creatures\n${pipeline.info.rendererString}`;
  }

  // ---- clock (frame-graph rule 11: the ONE place wall time is read) -------
  const nowMs = () => performance.now();
  const fixedStep = params.get('fixedstep') === '1';
  const stats = { lastFrameCpuMs: 0 };

  function frame(dt) {
    const t0 = nowMs();
    // staggered formation ramp: promote due pending spawns
    while (state.pending.length && state.pending[0].due <= state.simT) {
      const { spec } = state.pending.shift();
      const c = new Creature(spec);
      state.creatures.push(c);
      scene.add(c.points);
    }
    for (let i = state.creatures.length - 1; i >= 0; i--) {
      const c = state.creatures[i];
      if (!c.update(state.simT, dt, state.sway)) {
        scene.remove(c.points);
        c.dispose();
        state.creatures.splice(i, 1);
        if (state.focus === c) state.focus = null;
      }
    }
    if (state.boardMode) applySchooling(dt);
    if (plankton.enabled) plankton.update(state.simT);
    globalUniforms.uFocusZ.value = state.focus
      ? camDist - state.focus.points.position.z
      : state.boardMode
        ? camDist - Z_MID * 0.5
        : camDist;
    pipeline.render(dt, 0); // camera is stationary per-frame: camDeltaPx = 0
    stats.lastFrameCpuMs = nowMs() - t0;
    updateHud();
  }

  function stepMany(n, dt) {
    for (let i = 0; i < n; i++) {
      state.simT += dt;
      frame(dt);
    }
  }

  if (!fixedStep) {
    let prev = nowMs();
    const tick = () => {
      const t = nowMs();
      const dt = Math.min((t - prev) / 1000, 0.05);
      prev = t;
      state.simT += dt;
      frame(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } else {
    frame(0); // one settled frame so the canvas is composited before stepping
  }

  // ---- test surface -------------------------------------------------------
  window.__menagerie = {
    rendererString: pipeline.info.rendererString,
    clock: { fixed: fixedStep, stepMany },
    test: {
      setScene,
      spawn: (name) => spawnName(name),
      board: (csv) => loadBoard(csv),
      solo: (name) => {
        releaseAll();
        state.boardMode = true;
        spawnName(name, { center: true, now: true });
      },
      setSway: (v) => {
        state.sway = v;
      },
      setTrails: (k) => pipeline.setTrails(k),
      releaseAll,
      setCameraYaw: (rad) => {
        camYaw = rad;
        applyCamera();
      },
      setLightAzimuth: (az) => {
        const el = 0.85;
        globalUniforms.uLightDir.value
          .set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
          .normalize();
      },
    },
    stats,
  };
}

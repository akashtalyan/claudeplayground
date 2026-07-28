// Integrator — boots the Phase B spike: WebGL2 gate, renderer, camera with a
// 1:1 CSS-pixel z=0 plane, creature registry (geometry -> Points), injectable
// clock, scenes, and the window.__menagerie test surface.

import * as THREE from 'three';
import { createPipeline } from './render/pipeline.js';
import { createGlobalUniforms, createDotMaterial } from './shaders/dots.js';
import { makeEel } from './geometry/eel.js';
import { makeRay } from './geometry/ray.js';
import { mulberry32 } from './geometry/rng.js';

const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const FOV = 55;
const FORM_TIME = 1.5; // seconds, uFormation 0 -> 1
const EASE_RATE = 4.5; // 1/s; same coefficient eases positions AND normals

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
  function updateCameraDistance(cssH) {
    camDist = cssH / 2 / Math.tan((FOV * Math.PI) / 360);
    camera.position.set(0, 0, camDist);
  }
  updateCameraDistance(window.innerHeight || 540);

  const scene = new THREE.Scene();

  // ---- global lighting / medium defaults (up-left, warm-white) ------------
  const globalUniforms = createGlobalUniforms(renderer);
  globalUniforms.uLightDir.value.set(-0.45, 0.75, 0.4).normalize();
  globalUniforms.uLightColor.value.setRGB(1.0, 0.93, 0.82);
  globalUniforms.uRim.value = 1.1;
  // tuned so the deeper creature dims noticeably vs the focus plane
  globalUniforms.uFogDensity.value = 0.0015;
  globalUniforms.uAperture.value = 0.0016;
  globalUniforms.uFocusZ.value = camDist;

  // ---- state --------------------------------------------------------------
  const state = {
    sway: parseFloatOr(params.get('sway'), 1.0),
    simT: 0,
    creatures: [],
    focus: null, // creature whose depth drives uFocusZ
  };

  function parseFloatOr(v, d) {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : d;
  }

  // ---- creature -----------------------------------------------------------
  class Creature {
    constructor(spec) {
      this.spec = spec;
      this.gen = spec.kind === 'eel' ? makeEel(spec.seed) : makeRay(spec.seed);
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
      this.geometry = g;

      this.material = createDotMaterial(globalUniforms);
      this.material.uniforms.uColor.value.setRGB(...spec.color);
      this.material.uniforms.uAlpha.value = spec.alpha;
      this.material.uniforms.uFormation.value = 0;

      this.points = new THREE.Points(g, this.material);
      this.points.scale.setScalar(spec.scale);
      this.spawnT = state.simT;
      this.d0 = rng() * 6.283;
      this.d1 = rng() * 6.283;
      this.d2 = rng() * 6.283;
      this.applyDrift(state.simT);
    }

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
      this.applyDrift(simT);
    }

    dispose() {
      this.geometry.dispose();
      this.material.dispose();
    }
  }

  // ---- scene registry -----------------------------------------------------
  function eelSpec(over) {
    return {
      kind: 'eel',
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
      focus: false,
      ...over,
    };
  }

  function raySpec(over) {
    return {
      kind: 'ray',
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

  function releaseAll() {
    for (const c of state.creatures) {
      scene.remove(c.points);
      c.dispose();
    }
    state.creatures = [];
    state.focus = null;
  }

  function setScene(name) {
    releaseAll();
    for (const spec of sceneSpecs(name)) {
      const c = new Creature(spec);
      state.creatures.push(c);
      scene.add(c.points);
      if (spec.focus) state.focus = c;
    }
    if (!state.focus && state.creatures.length) state.focus = state.creatures[0];
  }

  setScene(params.get('scene') || 'duo');

  // ---- pipeline (created after creatures exist so compile() prewarms all) --
  const pipeline = createPipeline(renderer, scene, camera, {
    exposure: 4.2,
    trailsK: parseFloatOr(params.get('trails'), 0.25),
  });

  function onResize() {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
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
    hudEl.textContent = `${stats.lastFrameCpuMs.toFixed(2)} ms cpu\n${pipeline.info.rendererString}`;
  }

  // ---- clock (frame-graph rule 11: the ONE place wall time is read) -------
  const nowMs = () => performance.now();
  const fixedStep = params.get('fixedstep') === '1';
  const stats = { lastFrameCpuMs: 0 };

  function frame(dt) {
    const t0 = nowMs();
    for (const c of state.creatures) c.update(state.simT, dt, state.sway);
    if (state.focus) {
      globalUniforms.uFocusZ.value = camDist - state.focus.points.position.z;
    }
    pipeline.render(dt, 0); // camera is stationary: camDeltaPx = 0
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
      setSway: (v) => {
        state.sway = v;
      },
      setTrails: (k) => pipeline.setTrails(k),
      releaseAll,
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

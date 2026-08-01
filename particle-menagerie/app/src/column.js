// The water column — v3.4. The world stops being one flat screen-sized slice
// and becomes a TALL VERTICAL COLUMN of ocean: a bright rippling surface
// overhead, 1200 m of water, an abyssal seabed at the bottom. The camera is a
// vessel that travels vertically through it; creatures live at their species'
// natural depth and STAY there.
//
// This module is the SINGLE SOURCE OF TRUTH for the vertical world:
//
//   * the metre <-> world-px scale (METRES_PER_PX / PX_PER_METRE) and the two
//     boundary planes (SURFACE_Y, SEABED_Y). Every other module — atmosphere,
//     species depth bands, the console's depth gauge, background — imports its
//     numbers FROM HERE and never re-derives them.
//   * the camera's vertical position and its navigation (wheel, arrow keys,
//     PageUp/PageDown, Home/End), with critically-damped motion: a submarine
//     has mass, so the porthole eases to a new depth, it never snaps.
//   * the two scene layers that make the column read as a bounded volume: a
//     dotted seabed plane at the bottom and a shimmering surface ceiling at
//     the top, both drawn with the ONE dot shader program (frame-graph rule 7)
//     — no new GLSL, no terrain mesh.
//   * culling info, so the integrator can skip target math for creatures far
//     outside the visible band (the real perf win once the world is tall).
//
// Contracts honoured:
//   * frame-graph rule 7  — layers reuse createDotMaterial; no new program.
//   * frame-graph rule 11 — no wall-clock reads anywhere; update(dt) takes the
//     injectable clock's delta and the layers' shimmer rides an accumulator.
//   * frame-graph rule 4  — deltaPx() reports the camera's per-frame vertical
//     travel in world px so the integrator can feed the trails' camera×fade
//     coupling instead of the hardcoded 0.
//   * geometry-spec 8     — every RNG draw comes from one mulberry32 stream in
//     a frozen order; resize() re-derives positions arithmetically and draws
//     NOTHING, so the column is byte-identical across viewports and reloads.
//   * no allocation in the frame loop — all layer state is preallocated typed
//     arrays; range()/visibleBand()/info() return shared objects (read, don't
//     retain).

import * as THREE from 'three';
import { mulberry32 } from './geometry/rng.js';
import { createDotMaterial } from './shaders/dots.js';

// ---------------------------------------------------------------------------
// The scale. ONE constant, defined here, imported everywhere.
// ---------------------------------------------------------------------------

/** Metres of ocean per world pixel. The z=0 plane is 1:1 with CSS px, so this
 *  is also metres per CSS pixel of vertical screen travel at that plane. */
export const METRES_PER_PX = 0.2;
/** World px per metre — 1 / METRES_PER_PX, precomputed (5 px = 1 m). */
export const PX_PER_METRE = 1 / METRES_PER_PX;

/** World Y of the water surface. Depth is measured DOWN from here. */
export const SURFACE_Y = 0;
/** Depth of the seabed, in metres below the surface. */
export const SEABED_DEPTH_M = 1200;
/** Height of the column in world px (1200 m x 5 px/m = 6000 px ≈ 7–11 screens). */
export const COLUMN_PX = SEABED_DEPTH_M * PX_PER_METRE;
/** World Y of the abyssal seabed's mean plane (ridges undulate about it). */
export const SEABED_Y = SURFACE_Y - COLUMN_PX;

/** Where a fresh session surfaces: upper twilight, with the shimmering
 *  ceiling still overhead — you start near the light and dive. Advisory; the
 *  integrator may boot anywhere and setDepth() clamps into range(). */
export const DEFAULT_DEPTH_M = 120;

// Ocean zones, real boundaries compressed onto a 1200 m column. The gauge
// reads these next to the metre value; atmosphere can key its weather to them.
export const ZONES = [
  { id: 'sunlit', label: 'sunlit', from: 0, to: 200 },
  { id: 'twilight', label: 'twilight', from: 200, to: 600 },
  { id: 'midnight', label: 'midnight', from: 600, to: 1000 },
  { id: 'abyssal', label: 'abyssal', from: 1000, to: SEABED_DEPTH_M },
];

// ---------------------------------------------------------------------------
// Pure conversions — usable without an instance (species bands, atmosphere).
// ---------------------------------------------------------------------------

/** World Y -> metres below the surface (positive down). */
export function worldYToMetres(y) {
  return (SURFACE_Y - y) * METRES_PER_PX;
}

/** Metres below the surface -> world Y. */
export function metresToWorldY(m) {
  return SURFACE_Y - m * PX_PER_METRE;
}

/** Clamp a depth in metres into [0, SEABED_DEPTH_M] (the WATER, not the
 *  navigable camera range — see column.range() for that). */
export function clampDepth(m) {
  return m < 0 ? 0 : m > SEABED_DEPTH_M ? SEABED_DEPTH_M : m;
}

/** Clamp a world Y into the column [SEABED_Y, SURFACE_Y]. */
export function clampWorldY(y) {
  return y > SURFACE_Y ? SURFACE_Y : y < SEABED_Y ? SEABED_Y : y;
}

/** The zone entry containing a depth (never null; clamps at both ends). */
export function zoneAt(m) {
  const d = clampDepth(m);
  for (let i = 0; i < ZONES.length; i++) if (d < ZONES[i].to) return ZONES[i];
  return ZONES[ZONES.length - 1];
}

/** Surface light reaching a depth, normalised 0..1. Beer–Lambert with the
 *  column's own scale height; ~0.43 at 200 m, ~0.08 at 600 m, ~0.007 at the
 *  seabed. Atmosphere/background may scale intensities by this. */
export function lightAt(m) {
  return Math.exp(-Math.max(m, 0) / 240);
}

// ---- seabed relief --------------------------------------------------------
// A pure, deterministic dune field: three incommensurate sines, no storage, no
// RNG. Rooted flora are planted ON it (seabedYAt(x, z)) so plants and the dot
// floor agree exactly. Amplitude ±86 px ≈ ±17 m of gentle relief.
// Wavelengths (~2400 / 900 / 400 world px) are sized to the strip of floor the
// porthole actually frames — longer ones read as a flat plateau, not dunes.
const RIDGE = [
  { a: 42, kx: 0.0026, kz: 0.0017, ph: 0.7 },
  { a: 22, kx: 0.0068, kz: -0.0031, ph: 2.3 },
  { a: 11, kx: 0.0155, kz: 0.0, ph: 1.1 },
];

/** World Y of the seabed surface under a world (x, z). */
export function seabedYAt(x, z) {
  let y = SEABED_Y;
  for (let i = 0; i < RIDGE.length; i++) {
    const r = RIDGE[i];
    y += r.a * Math.sin(x * r.kx + z * r.kz + r.ph);
  }
  return y;
}

/** Max relief above/below the mean plane — placement guards and layer culling. */
export const RIDGE_AMP = RIDGE[0].a + RIDGE[1].a + RIDGE[2].a;

// ---------------------------------------------------------------------------
// Camera motion + layer tuning
// ---------------------------------------------------------------------------

const FOV = 55; // must match FOV in main.js
const REF_DIST = 10; // must match REF_DIST in shaders/dots.js
const TAU = Math.PI * 2;

// Critically damped approach: x'' = -2w x' - w^2 (x - target), stepped with
// the exact analytic solution so it is stable and identical at any dt.
const OMEGA = 3.4; // 1/s — settles to ~2% in ~1.8 s
const FLANK_MPS = 300; // dive-speed cap (m/s = 1500 world px/s) so a jump
// across the whole column reads as travel (~5.4 s surface->seabed, ~3 screens
// a second) rather than a teleport blur
const SETTLE_M = 0.02; // below this offset AND velocity the motion is parked
const SETTLE_V = 0.05;

// Navigation gains.
const WHEEL_GAIN = 2.6; // world px of dive per wheel pixel (a dive, not a bar)
const WHEEL_LINE_PX = 16; // deltaMode 1 (lines) -> px
const KEY_STEP_M = 26; // arrow key
const PAGE_FRAC = 0.8; // PageUp/Down = this fraction of the visible band

// Where the boundaries are allowed to sit at the ends of the travel, as a
// fraction of the half-band. The vessel is always submerged: it can never put
// the porthole above the waterline or below the floor, which is why the gauge
// bottoms out a little short of 0 m (range().min) rather than at 0. At min
// depth the surface hangs 20% down from the top edge — you are just under the
// waterline looking up through it; at max depth the vessel hovers 1.15 x the
// half-band above the floor, which puts the ridge line ~74% down the frame and
// runs the near floor off the bottom edge — the geometry of hovering over a
// plane, at any viewport size (both terms scale with CSS height).
const SURFACE_STOP = 0.6;
const SEABED_STOP = 1.15;

// Layer extents, expressed as VIEW DISTANCE as a fraction of camDist — not as
// absolute z. A ground plane's near edge has to come close enough to the lens
// to run off the bottom of the frame (at 0.38x camDist the floor projects ~355
// px below the axis, comfortably past the edge); pinning it to an absolute z
// left the floor as a thin band floating at mid-screen. Fractions also make
// both sheets viewport-invariant for free: camDist scales with CSS height, so
// the floor covers the same screen area on any display.
const VD_NEAR = 0.38; // z = +0.62 x camDist — in front of the creature plane
const VD_FAR = 2.4; // z = -1.4 x camDist — far enough to haze, near enough to
// survive the abyss preset's fog
const HORIZON_BIAS = 1.35; // >1 crowds samples toward the far end, which is
// what turns a scatter into a ridge line at the horizon
const LAYER_MARGIN_PX = 140; // relief/ripple slack on the visibility test

const SEABED_ALPHA = 0.8;
const SURFACE_ALPHA = 0.85;

// ---------------------------------------------------------------------------
// A dotted sheet: one Points object lying on a horizontal plane, sampled so it
// fills the frustum at every depth and crowds toward the horizon (which is why
// it reads as a floor/ceiling and not a scatter). Shared by seabed + surface.
// ---------------------------------------------------------------------------

function buildSheet(scene, globalUniforms, cfg) {
  const N = cfg.count;
  const sizeFar = cfg.sizeFar ?? 0.3;
  const rng = mulberry32(cfg.seed >>> 0);

  // ---- frozen draw order: per-dot block, append only ----
  const u = new Float32Array(N); // -1..1 across the frustum at that dot's z
  const sn = new Float32Array(N); // 0 = horizon, 1 = right under the lens
  const rel = new Float32Array(N); // per-dot offset off the plane (px)
  const sz0 = new Float32Array(N); // authored CSS px at its own depth
  const ph1 = new Float32Array(N);
  const ph2 = new Float32Array(N);
  const tw = new Float32Array(N);
  const rg = new Float32Array(N);
  const nx = new Float32Array(N);
  const ny = new Float32Array(N);
  const nz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    u[i] = rng() * 2 - 1;
    // Uniform in 1/viewDist == uniform in SCREEN Y for a plane, so the sheet
    // covers the frame evenly instead of piling up somewhere; the pow bias
    // then crowds it toward the horizon, which is what closes the far edge
    // into a ridge line.
    sn[i] = Math.pow(rng(), HORIZON_BIAS);
    rel[i] = cfg.relLo + (cfg.relHi - cfg.relLo) * rng();
    // every ~10th dot is a bright fleck (surface glitter / a shell on the floor)
    sz0[i] = (cfg.sizeLo + (cfg.sizeHi - cfg.sizeLo) * rng()) * (i % 10 === 0 ? 2.05 : 1);
    ph1[i] = rng() * TAU;
    ph2[i] = rng() * TAU;
    tw[i] = rng();
    rg[i] = rng();
    // random unit normal: these are omnidirectional specks, lit by the dot
    // shader's wrap-Lambert ambient floor from any light azimuth
    let a = rng() * 2 - 1;
    let b = rng() * 2 - 1;
    let c = rng() * 2 - 1;
    const il = 1 / Math.max(Math.hypot(a, b, c), 1e-4);
    nx[i] = a * il;
    ny[i] = b * il;
    nz[i] = c * il;
  }
  // ---- end frozen draw order ----

  const pos = new Float32Array(N * 3);
  const nor = new Float32Array(N * 3);
  const aSize = new Float32Array(N);
  const aTw = new Float32Array(N);
  const aRing = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    nor[i * 3] = nx[i];
    nor[i * 3 + 1] = ny[i];
    nor[i * 3 + 2] = nz[i];
    aTw[i] = tw[i];
    aRing[i] = rg[i];
  }
  // resting Y of each dot (plane + relief + per-dot offset); the ripple rides
  // on top of this, so nothing recomputes the plane per frame
  const restY = new Float32Array(N);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(aSize, 1);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute('aSize', sizeAttr);
  geometry.setAttribute('aTw', new THREE.BufferAttribute(aTw, 1));
  geometry.setAttribute('aRing', new THREE.BufferAttribute(aRing, 1));

  const material = createDotMaterial(globalUniforms);
  material.uniforms.uColor.value.setRGB(cfg.color[0], cfg.color[1], cfg.color[2]);
  material.uniforms.uAlpha.value = cfg.alpha;
  material.uniforms.uFormation.value = 1;
  material.uniforms.uTwk.value.set(cfg.twk[0], cfg.twk[1]);
  // uSmall stays 0 — the merge correction is for creatures, not scenery.

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false; // visibility is driven by the column's band test
  scene.add(points);

  let intensity = 1;

  // Deterministic rebuild: a pure arithmetic function of (w, h, camDist). No
  // RNG, no reallocation — the sheet is never rebuilt from draws.
  function rebuild(w, h, camDist) {
    const halfW = w / 2 + 140;
    const invNear = 1 / (VD_NEAR * camDist);
    const invFar = 1 / (VD_FAR * camDist);
    for (let i = 0; i < N; i++) {
      const vd = 1 / (invFar + (invNear - invFar) * sn[i]);
      const z = camDist - vd;
      // frustum half-width at this z, so the sheet fills the screen edge to
      // edge at every depth instead of tapering into a wedge
      const x = u[i] * halfW * (vd / camDist);
      const y = cfg.planeYAt(x, z) + rel[i];
      restY[i] = y;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      // px = aSize * REF_DIST / viewDist (shaders/dots.js): authored CSS px at
      // this dot's own depth, shrinking a little into the haze of the horizon.
      // The far end stays just above the shader's 1.5-raster-px fade, or the
      // ridge line the crowding builds would be alpha'd away to nothing.
      aSize[i] = sz0[i] * (1 - sizeFar * (1 - sn[i])) * (vd / REF_DIST);
    }
    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }

  // Ripple: two incommensurate traveling waves so the ceiling never repeats.
  // Only ever called while the layer is visible.
  function ripple(t) {
    const r = cfg.ripple;
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 1] =
        restY[i] +
        r.amp * Math.sin(r.w1 * t + ph1[i]) +
        r.amp * 0.55 * Math.sin(r.w2 * t + ph2[i]);
    }
    posAttr.needsUpdate = true;
  }

  return {
    points,
    material,
    rebuild,
    ripple: cfg.ripple ? ripple : null,
    setIntensity(v) {
      intensity = Math.min(Math.max(v, 0), 1);
      material.uniforms.uAlpha.value = cfg.alpha * intensity;
    },
    getIntensity: () => intensity,
    setTime(t) {
      material.uniforms.uTime.value = t;
    },
    dispose() {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// createColumn
// ---------------------------------------------------------------------------

/**
 * Build the water column: the vertical world model, the camera's place in it,
 * the seabed + surface layers, and the navigation bindings.
 *
 * @param {THREE.Scene} scene
 * @param {object} globalUniforms  from shaders/dots.js createGlobalUniforms
 * @param {object} [opts]
 *   canvas      HTMLCanvasElement — wheel navigation binds here (optional;
 *               omit for a headless/model-only column)
 *   keyTarget   EventTarget for arrow/page keys (default: window). Keys are
 *               ignored while any input/textarea/contentEditable has focus,
 *               so the summon field always wins.
 *   width/height CSS viewport (default: window / 960x540)
 *   camDist     camera distance to the z=0 plane (default: derived from height)
 *   depth       initial depth in metres (default DEFAULT_DEPTH_M)
 *   seed        RNG seed for the two layers
 *   layers      false to skip the seabed/surface geometry entirely (spike
 *               scenes stay pixel-clean and emitter-free, like the plankton)
 *   nav         false to skip wheel/key bindings (model-only)
 *   onCamera    (worldY) => void, called whenever the camera's Y changes
 *   onDepth     (targetM, source) => void, called when the TARGET changes
 * @returns the column API (see the bottom of this function)
 */
export function createColumn(scene, globalUniforms, opts = {}) {
  const canvas = opts.canvas ?? null;
  const keyTarget = opts.keyTarget ?? (typeof window !== 'undefined' ? window : null);

  let W = opts.width ?? (typeof window !== 'undefined' ? window.innerWidth || 960 : 960);
  let H = opts.height ?? (typeof window !== 'undefined' ? window.innerHeight || 540 : 540);
  let camDist = opts.camDist ?? H / 2 / Math.tan((FOV * Math.PI) / 360);

  // ---- vertical state ----------------------------------------------------
  let targetM = DEFAULT_DEPTH_M;
  let curM = DEFAULT_DEPTH_M;
  let velM = 0; // m/s, the vessel's vertical rate
  let camYCur = metresToWorldY(curM);
  let camYPrev = camYCur;
  let simT = 0; // accumulated from dt — never a wall-clock read

  // ---- navigable range ---------------------------------------------------
  // Half the visible band at the z=0 plane, in metres. The vessel cannot push
  // the porthole above the waterline or below the floor.
  let halfBandM = 1; // recomputeRange() below is the real assignment
  let minM = 0;
  let maxM = SEABED_DEPTH_M;

  function recomputeRange() {
    halfBandM = (H / 2) * METRES_PER_PX;
    let lo = SURFACE_STOP * halfBandM;
    let hi = SEABED_DEPTH_M - SEABED_STOP * halfBandM;
    if (hi < lo) {
      // pathological viewport taller than the whole column: park in the middle
      lo = hi = SEABED_DEPTH_M / 2;
    }
    minM = lo;
    maxM = hi;
  }
  recomputeRange();

  function clampNav(m) {
    return m < minM ? minM : m > maxM ? maxM : m;
  }

  // ---- listeners ---------------------------------------------------------
  const depthListeners = [];
  function emitDepth(source) {
    for (let i = 0; i < depthListeners.length; i++) depthListeners[i](targetM, source);
  }

  function setDepth(m, options) {
    const v = clampNav(Number(m) || 0);
    const instant = options ? options.instant === true : false;
    const changed = v !== targetM;
    targetM = v;
    if (instant) {
      curM = v;
      velM = 0;
      camYCur = metresToWorldY(curM);
      camYPrev = camYCur;
      if (opts.onCamera) opts.onCamera(camYCur);
    }
    if (changed || instant) emitDepth(options && options.source ? options.source : 'set');
    return targetM;
  }

  function nudge(dm, options) {
    return setDepth(targetM + (Number(dm) || 0), options);
  }

  // ---- layers ------------------------------------------------------------
  const baseSeed = (opts.seed ?? 0x0c010b3d) >>> 0;
  const wantLayers = opts.layers !== false;

  const seabed = wantLayers
    ? buildSheet(scene, globalUniforms, {
        count: opts.seabedCount ?? 620,
        seed: baseSeed ^ 0x5eab3d00,
        planeYAt: seabedYAt,
        relLo: 0,
        relHi: 26, // a little loft: silt sitting proud of the floor
        sizeLo: 2.2,
        sizeHi: 3.8,
        // warm-neutral silt against the cool water, still near-monochrome
        color: [0.7, 0.74, 0.78],
        alpha: SEABED_ALPHA,
        twk: [0.9, 0.3], // barely-there — the floor is still, the water is not
        ripple: null,
      })
    : null;

  const surface = wantLayers
    ? buildSheet(scene, globalUniforms, {
        count: opts.surfaceCount ?? 460,
        seed: baseSeed ^ 0x51f4ace0,
        planeYAt: () => SURFACE_Y,
        relLo: -22, // the boundary has thickness: dots hang just under it
        relHi: -3,
        sizeLo: 2.2,
        sizeHi: 3.8,
        // daylight coming through: the one warm-cool-white in the water
        color: [0.9, 0.96, 1.0],
        alpha: SURFACE_ALPHA,
        twk: [2.6, 0.55], // fast, deep shimmer — sun glitter on the underside
        ripple: { amp: 11, w1: 0.9, w2: 1.41 }, // incommensurate: never repeats
      })
    : null;

  if (seabed) seabed.rebuild(W, H, camDist);
  if (surface) surface.rebuild(W, H, camDist);

  // ---- geometry helpers --------------------------------------------------

  /** Frustum half-height in world px at a given z (the z=0 plane is 1:1 CSS). */
  function viewHalfPx(z) {
    return (H / 2) * (Math.max(camDist - (z || 0), 1) / camDist);
  }

  const bandOut = { topM: 0, bottomM: 0, spanM: 0, topY: 0, bottomY: 0, centreM: 0 };
  /**
   * The metre band currently framed by the porthole (at the z=0 plane).
   * Returns a SHARED object — read it, don't retain it.
   */
  function visibleBand(cssH) {
    const half = (cssH != null ? cssH / 2 : H / 2) * METRES_PER_PX;
    bandOut.centreM = curM;
    bandOut.topM = curM - half;
    bandOut.bottomM = curM + half;
    bandOut.spanM = half * 2;
    bandOut.topY = metresToWorldY(bandOut.topM);
    bandOut.bottomY = metresToWorldY(bandOut.bottomM);
    return bandOut;
  }

  /**
   * How far (world px) a point is OUTSIDE the visible band — 0 when visible.
   * Accounts for the frustum widening with depth, so a creature far behind the
   * z=0 plane is correctly still on screen.
   *
   * @param {number} y world Y
   * @param {number} [z] world Z (default 0)
   * @param {number} [radiusPx] the creature's own radius, kept on screen
   */
  function outOfBandPx(y, z, radiusPx) {
    const half = viewHalfPx(z) + (radiusPx || 0);
    const d = Math.abs(y - camYCur) - half;
    return d > 0 ? d : 0;
  }

  /**
   * The culling predicate the integrator wants:
   *   if (!column.inView(c.py, c.pz, c.rad, SIM_MARGIN)) continue;
   * Pass a margin (one screen height is a good default) so creatures just off
   * frame keep simulating and nothing pops when you arrive.
   */
  function inView(y, z, radiusPx, marginPx) {
    return outOfBandPx(y, z, radiusPx) <= (marginPx || 0);
  }

  // ---- per-frame ---------------------------------------------------------

  // Exact analytic step of a critically damped spring; unconditionally stable.
  function stepDepth(dt) {
    let x = curM - targetM;
    if (x === 0 && velM === 0) return;
    const e = Math.exp(-OMEGA * dt);
    const B = velM + OMEGA * x;
    const lin = x + B * dt;
    let nx = lin * e;
    let nv = (B - OMEGA * lin) * e;
    // Flank speed: the vessel has a maximum rate of ascent/descent, so a jump
    // across the whole column is a journey and not a smear. Velocity is handed
    // to the spring at exactly the cap, so the handover has no discontinuity.
    const move = nx - x;
    const maxMove = FLANK_MPS * dt;
    if (move > maxMove) {
      nx = x + maxMove;
      nv = FLANK_MPS;
    } else if (move < -maxMove) {
      nx = x - maxMove;
      nv = -FLANK_MPS;
    }
    if (Math.abs(nx) < SETTLE_M && Math.abs(nv) < SETTLE_V) {
      nx = 0;
      nv = 0;
    }
    curM = targetM + nx;
    velM = nv;
  }

  /**
   * One frame. dt is the injectable clock's delta in seconds; timeSec is the
   * optional sim time to hand the layers (defaults to an internal accumulator
   * so the module never reads a wall clock either way).
   */
  function update(dt, timeSec) {
    const d = dt > 0 ? dt : 0;
    simT = timeSec != null ? timeSec : simT + d;
    camYPrev = camYCur;
    stepDepth(d);
    camYCur = metresToWorldY(curM);
    if (camYCur !== camYPrev && opts.onCamera) opts.onCamera(camYCur);

    // The sheet's tallest reach on screen is at its far edge, where the
    // frustum half-height is VD_FAR x the half-height at the z=0 plane.
    const layerReach = (H / 2) * VD_FAR + LAYER_MARGIN_PX;
    if (seabed) {
      // Real perf win: the far layer is skipped whole when the porthole is
      // nowhere near it — no draw call, no buffer upload, no ripple loop.
      const vis = Math.abs(SEABED_Y - camYCur) <= layerReach + RIDGE_AMP;
      seabed.points.visible = vis;
      if (vis) seabed.setTime(simT);
    }
    if (surface) {
      const vis = Math.abs(SURFACE_Y - camYCur) <= layerReach;
      surface.points.visible = vis;
      if (vis) {
        surface.ripple(simT);
        surface.setTime(simT);
      }
    }
  }

  // ---- camera ------------------------------------------------------------

  /**
   * Drop-in for the integrator's applyCamera(): place the camera on its yaw
   * arc at the column's current height, gazing horizontally.
   */
  function applyTo(camera, dist, yaw) {
    const d = dist != null ? dist : camDist;
    const a = yaw || 0;
    camera.position.set(Math.sin(a) * d, camYCur, Math.cos(a) * d);
    camera.lookAt(0, camYCur, 0);
  }

  // ---- navigation bindings ----------------------------------------------

  function typingInField() {
    if (typeof document === 'undefined') return false;
    const a = document.activeElement;
    if (!a) return false;
    return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true;
  }

  const onWheel = (e) => {
    if (typingInField()) return;
    e.preventDefault(); // this is a dive control, not a scrollbar
    let px = e.deltaY;
    if (e.deltaMode === 1) px *= WHEEL_LINE_PX;
    else if (e.deltaMode === 2) px *= H;
    // wheel px -> world px of dive -> metres. Positive deltaY descends.
    nudge(px * WHEEL_GAIN * METRES_PER_PX, { source: 'wheel' });
  };

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typingInField()) return;
    const band = halfBandM * 2;
    switch (e.key) {
      case 'ArrowDown':
        nudge(KEY_STEP_M, { source: 'key' });
        break;
      case 'ArrowUp':
        nudge(-KEY_STEP_M, { source: 'key' });
        break;
      case 'PageDown':
        nudge(band * PAGE_FRAC, { source: 'key' });
        break;
      case 'PageUp':
        nudge(-band * PAGE_FRAC, { source: 'key' });
        break;
      case 'Home':
        setDepth(minM, { source: 'key' });
        break;
      case 'End':
        setDepth(maxM, { source: 'key' });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const navOn = opts.nav !== false;
  if (navOn && canvas) canvas.addEventListener('wheel', onWheel, { passive: false });
  if (navOn && keyTarget) keyTarget.addEventListener('keydown', onKey);

  // ---- resize ------------------------------------------------------------

  function resize(w, h, dist) {
    W = Math.max(1, w);
    H = Math.max(1, h);
    camDist = dist != null ? dist : H / 2 / Math.tan((FOV * Math.PI) / 360);
    recomputeRange();
    // the navigable range moved under us — re-clamp both target and position
    targetM = clampNav(targetM);
    curM = clampNav(curM);
    camYCur = metresToWorldY(curM);
    camYPrev = camYCur;
    if (seabed) seabed.rebuild(W, H, camDist);
    if (surface) surface.rebuild(W, H, camDist);
    if (opts.onCamera) opts.onCamera(camYCur);
  }

  // ---- boot depth --------------------------------------------------------
  setDepth(opts.depth != null ? opts.depth : DEFAULT_DEPTH_M, { instant: true, source: 'boot' });

  // ---- shared read-only outputs (no per-frame allocation) ----------------
  const rangeOut = {
    min: 0,
    max: 0,
    surface: 0,
    seabed: SEABED_DEPTH_M,
    span: SEABED_DEPTH_M,
  };
  function range() {
    rangeOut.min = minM;
    rangeOut.max = maxM;
    rangeOut.surface = 0;
    rangeOut.seabed = SEABED_DEPTH_M;
    rangeOut.span = SEABED_DEPTH_M;
    return rangeOut; // shared object — read, don't retain
  }

  const infoOut = {
    depth: 0,
    target: 0,
    rate: 0,
    camY: 0,
    deltaPx: 0,
    zone: 'sunlit',
    light: 1,
    seabedVisible: false,
    surfaceVisible: false,
  };
  function info() {
    infoOut.depth = curM;
    infoOut.target = targetM;
    infoOut.rate = velM;
    infoOut.camY = camYCur;
    infoOut.deltaPx = camYCur - camYPrev;
    infoOut.zone = zoneAt(curM).id;
    infoOut.light = lightAt(curM);
    infoOut.seabedVisible = seabed ? seabed.points.visible : false;
    infoOut.surfaceVisible = surface ? surface.points.visible : false;
    return infoOut; // shared object — read, don't retain
  }

  const api = {
    // ---- navigation ------------------------------------------------------
    setDepth, // setDepth(metres, { instant?: bool, source?: string }) -> clamped m
    nudge, // nudge(deltaMetres, opts?) — relative to the TARGET, so wheel accumulates
    depth: () => curM, // eased, live position (what the gauge needle reads)
    targetDepth: () => targetM, // commanded depth (what the URL hash stores)
    rate: () => velM, // m/s, signed (+ = descending) — a rate-of-dive readout
    range, // shared { min, max, surface, seabed, span } in metres
    onDepthChange(cb) {
      depthListeners.push(cb);
      return () => {
        const i = depthListeners.indexOf(cb);
        if (i >= 0) depthListeners.splice(i, 1);
      };
    },

    // ---- per-frame -------------------------------------------------------
    update, // update(dt, timeSec?) — injectable clock only
    resize, // resize(cssW, cssH, camDist?)

    // ---- the camera ------------------------------------------------------
    camY: () => camYCur, // world Y the camera should sit at THIS frame
    /** World px the camera travelled vertically last update — feed this to
     *  pipeline.render(dt, camDeltaPx) for frame-graph rule 4. */
    deltaPx: () => camYCur - camYPrev,
    applyTo, // applyTo(camera, camDist?, yaw?) — drop-in applyCamera body

    // ---- the world model (instance mirrors of the module constants) ------
    worldYToMetres,
    metresToWorldY,
    clampDepth,
    clampWorldY,
    seabedYAt,
    zoneAt,
    lightAt,
    METRES_PER_PX,
    PX_PER_METRE,
    SURFACE_Y,
    SEABED_Y,
    SEABED_DEPTH_M,
    COLUMN_PX,
    ZONES,

    // ---- culling ---------------------------------------------------------
    visibleBand, // visibleBand(cssH?) -> shared band object
    viewHalfPx, // viewHalfPx(z) -> frustum half-height in world px at that z
    inView, // inView(y, z?, radiusPx?, marginPx?) -> bool
    outOfBandPx, // outOfBandPx(y, z?, radiusPx?) -> px outside the band (0 = in)

    // ---- the two boundary layers ----------------------------------------
    seabed, // { points, setIntensity, getIntensity, ... } or null
    surface,
    setIntensity(v) {
      if (seabed) seabed.setIntensity(v);
      if (surface) surface.setIntensity(v);
    },

    info, // shared telemetry object

    dispose() {
      if (navOn && canvas) canvas.removeEventListener('wheel', onWheel);
      if (navOn && keyTarget) keyTarget.removeEventListener('keydown', onKey);
      depthListeners.length = 0;
      if (seabed) seabed.dispose();
      if (surface) surface.dispose();
    },
  };

  // Test/dev hook, registered exactly the way shaders/dots.js and ui/ambient.js
  // register theirs (main.js spreads pre-existing __menagerie keys, so nothing
  // is clobbered whichever order modules load in).
  if (typeof window !== 'undefined') {
    window.__menagerie = window.__menagerie || {};
    window.__menagerie.column = api;
  }

  return api;
}

export default createColumn;

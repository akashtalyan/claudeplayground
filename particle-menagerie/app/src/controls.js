// Bathyscaphe control plumbing — Phase D engine-side API. The UI chrome
// (gauge plate, weather rotary, summon line) codes against exactly this
// surface; nothing here draws DOM. createControls(engine) receives the
// integrator's engine object (see main.js) and returns the contract:
//
//   select / getSelected / onSelectionChange / screenAnchor
//   setParam / getParam / paramRange
//   setIntent / getIntent / intentAxes      <- v3.2 intent layer
//   setPreset / getPreset / presetNames
//   summon / reform / release / onSummon
//   serialize / restore
//
// plus tick(dt), the per-frame hook main.js drives (preset crossfade,
// current drift, selection liveness).
//
// v3.2: the console speaks in INTENTS, not numbers. setParam is still the
// only thing that touches a creature (the harness, the URL hash and the
// presets all ride it); the intent layer sits strictly on top, mapping one
// named choice to the several engine params it really means. Because intents
// are derived from params (nearestOption), a raw setParam from anywhere
// leaves the plate reading the nearest intent instead of going stale.

import * as THREE from 'three';

// ---- per-creature control state ------------------------------------------
// One overlay object per creature; base spec values stay untouched so a
// creature's identity (name -> shape) is never mutated by the console.
export function defaultCtrl() {
  return {
    color: null, // hue 0..360 or null = the name's own color
    glow: 1, // uAlpha scale
    tempo: 1, // animation tempo multiplier
    sway: 1, // per-creature sway multiplier
    size: 1, // eased whole-body scale
    twinkle: 1, // rate/depth of the per-dot shimmer (1 = Phase C look)
    iridescence: 0, // uIrid 0..1 — view-angle hue shift
    density: 1, // drawRange fraction over the cross-ring shuffle
    depth: 0, // -1..1 eased z-band offset (parallax layer)
    behavior: 'drift', // drift | patrol | follow | school | sleep
  };
}

export const BEHAVIORS = ['drift', 'patrol', 'follow', 'school', 'sleep'];

// fmt maps engine value -> gauge readout string (mock shows glow 62 / tempo 40
// / sway 25 / size 3.1 — integers except size, which reads as one decimal).
export const PARAM_RANGES = {
  color: { min: 0, max: 360, step: 1, fmt: (v) => (v == null ? '—' : String(Math.round(v))) },
  glow: { min: 0, max: 2, step: 0.01, fmt: (v) => String(Math.round(v * 50)) },
  tempo: { min: 0.25, max: 2.5, step: 0.01, fmt: (v) => String(Math.round(v * 40)) },
  sway: { min: 0, max: 2.4, step: 0.01, fmt: (v) => String(Math.round(v * 25)) },
  size: { min: 0.4, max: 3.2, step: 0.05, fmt: (v) => v.toFixed(1) },
  twinkle: { min: 0, max: 2, step: 0.01, fmt: (v) => String(Math.round(v * 50)) },
  iridescence: { min: 0, max: 1, step: 0.01, fmt: (v) => String(Math.round(v * 100)) },
  density: { min: 0.15, max: 1, step: 0.01, fmt: (v) => String(Math.round(v * 100)) },
  depth: { min: -1, max: 1, step: 0.01, fmt: (v) => String(Math.round(v * 100)) },
  behavior: { min: 0, max: 4, step: 1, options: BEHAVIORS, fmt: (v) => String(v) },
};

function clampParam(key, v) {
  const r = PARAM_RANGES[key];
  return Math.min(r.max, Math.max(r.min, v));
}

// ---- intent layer (v3.2) --------------------------------------------------
// Named intents replace the numeric gauge sliders on the plate. An axis is a
// small ordered list of options; each option is a concrete param set. Two
// invariants make this safe to bolt onto the existing param API:
//
//   1. Every axis' DEFAULT option is param-identical to defaultCtrl(), so a
//      fresh creature reads as a sentence of defaults ("calm / glowing /
//      normal / mid / drifting") and serializes to the empty string.
//   2. Intent state is never stored — getIntent derives it from the live
//      params (nearestOption). Presets, URL restores and raw setParam calls
//      therefore cannot desync the plate.
//
// Axis keys are disjoint (motion owns tempo+sway, light owns glow+twinkle,
// …) so no two axes can fight over a param.
//
// iridescence and dot-density are deliberately NOT on any axis: they are
// off the visible surface in v3.2 (obscure controls, user's verdict). The
// engine params and their hash codes stay intact so old URLs still restore.
export const INTENT_AXES = [
  {
    id: 'motion',
    label: 'motion',
    keys: ['tempo', 'sway'],
    options: [
      { id: 'still', params: { tempo: 0.25, sway: 0.1 } },
      { id: 'calm', params: { tempo: 1, sway: 1 } },
      { id: 'lively', params: { tempo: 1.6, sway: 1.55 } },
      { id: 'frantic', params: { tempo: 2.5, sway: 2.4 } },
    ],
  },
  {
    id: 'light',
    label: 'light',
    keys: ['glow', 'twinkle'],
    options: [
      { id: 'ghostly', params: { glow: 0.35, twinkle: 0.25 } },
      { id: 'dim', params: { glow: 0.65, twinkle: 0.6 } },
      { id: 'glowing', params: { glow: 1, twinkle: 1 } },
      { id: 'radiant', params: { glow: 1.8, twinkle: 1.7 } },
    ],
  },
  {
    id: 'size',
    label: 'size',
    keys: ['size'],
    options: [
      { id: 'tiny', params: { size: 0.45 } },
      { id: 'small', params: { size: 0.7 } },
      { id: 'normal', params: { size: 1 } },
      { id: 'large', params: { size: 1.7 } },
      { id: 'giant', params: { size: 2.8 } },
    ],
  },
  {
    id: 'depth',
    label: 'depth',
    keys: ['depth'],
    options: [
      { id: 'near', params: { depth: -0.7 } },
      { id: 'mid', params: { depth: 0 } },
      { id: 'far', params: { depth: 0.75 } },
    ],
  },
  {
    // the old behavior rotary, promoted out of the drawer — it was always the
    // most legible control in the set, and it was already a named intent.
    id: 'doing',
    label: 'doing',
    keys: ['behavior'],
    options: [
      { id: 'drifting', params: { behavior: 'drift' } },
      { id: 'patrolling', params: { behavior: 'patrol' } },
      { id: 'following you', params: { behavior: 'follow' } },
      { id: 'schooling', params: { behavior: 'school' } },
      { id: 'sleeping', params: { behavior: 'sleep' } },
    ],
  },
];

const AXIS_BY_ID = {};
for (const ax of INTENT_AXES) AXIS_BY_ID[ax.id] = ax;

function optionOf(ax, id) {
  for (let i = 0; i < ax.options.length; i++) if (ax.options[i].id === id) return ax.options[i];
  return null;
}

// Exact param match (used by the hash encoder): the ctrl sits precisely on
// one option, so the option word can stand in for its param codes.
function exactOption(ax, ctrl) {
  for (let i = 0; i < ax.options.length; i++) {
    const o = ax.options[i];
    let hit = true;
    for (let j = 0; j < ax.keys.length; j++) {
      const k = ax.keys[j];
      const t = o.params[k];
      if (typeof t === 'string') {
        if (ctrl[k] !== t) { hit = false; break; }
      } else if (!(Math.abs(ctrl[k] - t) <= 1e-3)) {
        hit = false;
        break;
      }
    }
    if (hit) return o.id;
  }
  return null;
}

// Nearest option in range-normalized param space — what the plate displays
// for an arbitrary param set (a legacy URL, a preset, a raw setParam).
// Allocation-free: the plate calls this every frame while a creature is
// selected. Ties resolve to the earlier option, so it is deterministic.
export function nearestOption(ax, ctrl) {
  let best = ax.options[0].id;
  let bestD = Infinity;
  for (let i = 0; i < ax.options.length; i++) {
    const o = ax.options[i];
    let d = 0;
    for (let j = 0; j < ax.keys.length; j++) {
      const k = ax.keys[j];
      const t = o.params[k];
      if (typeof t === 'string') {
        d += ctrl[k] === t ? 0 : 1;
      } else {
        const r = PARAM_RANGES[k];
        const e = (ctrl[k] - t) / (r.max - r.min);
        d += e * e;
      }
    }
    if (d < bestD) {
      bestD = d;
      best = o.id;
    }
  }
  return best;
}

const DEFAULTS = defaultCtrl();

// Each axis' default option — asserted param-identical to defaultCtrl() at
// module load, because the hash encoder depends on it (a default axis must
// serialize to nothing) and a mismatch would be a silent authoring bug.
const AXIS_DEFAULT = {};
for (const ax of INTENT_AXES) {
  const d = exactOption(ax, DEFAULTS);
  if (!d) throw new Error(`intent axis '${ax.id}' has no option matching defaultCtrl()`);
  AXIS_DEFAULT[ax.id] = d;
}

// Descriptor list for the UI: plain data, built once when the plate mounts.
export function intentAxisList() {
  return INTENT_AXES.map((ax) => ({
    id: ax.id,
    label: ax.label,
    keys: ax.keys.slice(),
    options: ax.options.map((o) => o.id),
    default: AXIS_DEFAULT[ax.id],
  }));
}

// ---- weather presets ------------------------------------------------------
// Each preset is a full scene-param set; 'moonlit' is byte-identical to the
// Phase C defaults so a plain load renders exactly the Phase C board.
// current: px/s lateral water drift; turbulence: global sway multiplier;
// gain: pre-accumulation exposure of the emitted light (uGain);
// fogTint: per-channel absorption multiplier on the exponential fog.
// trailsK follows the frame-graph spec: fadeK = pow(1-k, dt*60), so LOW k
// = long-lived trails and HIGH k = trail-less water (integrator fix — the
// original preset values had this inverted).
// Phase E fields — caustics/sediment/ao: 0..1 per-layer atmosphere intensity;
// bloom: UnrealBloom-style strength on the pipeline composite (frame-graph
// [4]). All four crossfade with the rest of the scene params in tick().
// moonlit's bloom must stay equal to the pipeline's default strength so a
// plain load renders byte-identical to a snapped moonlit preset.
export const PRESET_ORDER = ['moonlit', 'abyss', 'bioluminescent bay', 'ink', 'shallows'];

export const PRESETS = {
  // cool silver top-light — the Phase C default water; soft moon shafts,
  // a thin marine snow, grounded flora ("moonlit abyssal garden")
  moonlit: {
    lightDir: [-0.45, 0.75, 0.4], lightColor: [0.8, 0.94, 1.05], rim: 1.25,
    fogDensity: 0.0015, fogTint: [1, 1, 1], gain: 1.0, trailsK: 0.25,
    current: 0, turbulence: 1, planktonAlpha: 0.4,
    // caustics 0.85 -> 1.0 (Phase F default polish): the moon shafts were
    // reading as barely-there; full intensity keeps them soft but present, so
    // the default board says "moonlit" instead of "empty night water".
    caustics: 1.0, sediment: 0.55, ao: 0.7, bloom: 0.35,
  },
  // near-lightless, heavy red-absorbing fog, long trails; no shafts reach
  // this deep — dense silt instead, bloom held low
  abyss: {
    lightDir: [-0.2, 0.95, 0.22], lightColor: [0.3, 0.42, 0.62], rim: 0.65,
    fogDensity: 0.0036, fogTint: [1.7, 1.2, 0.85], gain: 0.7, trailsK: 0.06,
    current: 1.5, turbulence: 0.65, planktonAlpha: 0.12,
    caustics: 0, sediment: 1, ao: 0.85, bloom: 0.15,
  },
  // cyan-bright, lively turbulence, thick glowing plankton; the glow itself
  // carries the scene — bloom up, shafts nearly gone
  'bioluminescent bay': {
    lightDir: [-0.5, 0.6, 0.62], lightColor: [0.45, 1.0, 1.1], rim: 1.8,
    fogDensity: 0.001, fogTint: [1.45, 0.85, 0.75], gain: 1.35, trailsK: 0.14,
    current: 7, turbulence: 1.55, planktonAlpha: 0.9,
    caustics: 0.15, sediment: 0.5, ao: 0.5, bloom: 0.75,
  },
  // minimal glow, stark rims, no trails, still water — no atmosphere at all
  // (sediment fully off: stark empty water is ink's whole identity, and the
  // harness proves the layer absent at pixel level)
  ink: {
    lightDir: [-0.05, 0.99, 0.1], lightColor: [0.85, 0.85, 0.85], rim: 2.3,
    fogDensity: 0.0007, fogTint: [1, 1, 1], gain: 0.75, trailsK: 0.95,
    current: 0, turbulence: 0.8, planktonAlpha: 0.04,
    caustics: 0, sediment: 0, ao: 0.15, bloom: 0,
  },
  // warmer, brighter, light caustic-like flicker via turbulence — the shafts
  // at full strength, only a light dusting of silt
  shallows: {
    lightDir: [0.25, 0.85, 0.3], lightColor: [1.12, 1.02, 0.86], rim: 1.05,
    fogDensity: 0.0011, fogTint: [0.8, 0.95, 1.2], gain: 1.28, trailsK: 0.45,
    current: 4.5, turbulence: 1.4, planktonAlpha: 0.55,
    caustics: 1, sediment: 0.3, ao: 0.6, bloom: 0.3,
  },
};

const DEFAULT_PRESET = 'moonlit';
const FADE_S = 2.0; // 'weather changing, not a config load'

// Every preset shares moonlit's exact shape (full scene-param sets, above),
// so the key list is computed ONCE — lerpScene runs per frame during a
// crossfade and must not Object.keys() each call.
const SCENE_KEYS = Object.keys(PRESETS[DEFAULT_PRESET]);

function clonePreset(p) {
  return {
    ...p,
    lightDir: p.lightDir.slice(),
    lightColor: p.lightColor.slice(),
    fogTint: p.fogTint.slice(),
  };
}

function lerpScene(out, a, b, e) {
  for (let j = 0; j < SCENE_KEYS.length; j++) {
    const k = SCENE_KEYS[j];
    if (Array.isArray(a[k])) {
      for (let i = 0; i < a[k].length; i++) out[k][i] = a[k][i] + (b[k][i] - a[k][i]) * e;
    } else {
      out[k] = a[k] + (b[k] - a[k]) * e;
    }
  }
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2;
}

// ---- URL-hash ctrl encoding ----------------------------------------------
// Extended hash schema, backward compatible with plain name lists:
//   #<names csv>[;p=<preset>][;<ordinal>=<code>:<val>,<code>:<val>...]...
// Ordinals index the flattened spawn order of the names csv (per-batch
// instances in order), so restore is deterministic. Only non-default values
// are serialized. v3.2 adds intent codes to the <code>:<val> alphabet (see
// INTENT_CODES below) — 'm:frantic' where v3.1 wrote 't:2.5,w:2.4'. Both
// alphabets decode, so every v2/v3.1 link still restores exactly.
const CTRL_CODES = [
  ['color', 'c'], ['glow', 'g'], ['tempo', 't'], ['sway', 'w'], ['size', 's'],
  ['twinkle', 'k'], ['iridescence', 'i'], ['density', 'd'], ['depth', 'z'],
  ['behavior', 'b'],
];

const CODE_OF = {};
for (const [key, code] of CTRL_CODES) CODE_OF[key] = code;

// v3.2 intent codes: when a ctrl sits exactly on one intent option, the axis
// serializes as ONE readable word instead of its param codes — 'm:frantic'
// for 't:2.5,w:2.4'. Shared links read as sentences, and the encoding is
// idempotent (decode writes the option's exact params, so re-encode finds the
// same exact option again -> serialize round-trips byte-for-byte).
//
// The 'doing' axis is intentionally absent: behavior's own 'b:' code is
// already a word, so an intent code would only make the hash longer.
//
// Backward compatibility is total in BOTH directions: decodeCtrl still reads
// every legacy raw code, and any ctrl that is NOT exactly on an option still
// serializes with the legacy raw codes.
const INTENT_CODES = [
  ['motion', 'm'], ['light', 'l'], ['size', 'x'], ['depth', 'e'],
];
const AXIS_OF_CODE = {};
for (const [axisId, code] of INTENT_CODES) AXIS_OF_CODE[code] = axisId;

function rawPart(key, ctrl) {
  const v = ctrl[key];
  const code = CODE_OF[key];
  if (key === 'behavior') return v !== DEFAULTS.behavior ? code + ':' + v : null;
  if (key === 'color') return v != null ? code + ':' + Math.round(v) : null;
  return Math.abs(v - DEFAULTS[key]) > 1e-3 ? code + ':' + +v.toFixed(2) : null;
}

export function encodeCtrl(ctrl) {
  const out = [];
  const push = (p) => {
    if (p) out.push(p);
  };
  push(rawPart('color', ctrl));
  for (const [axisId, code] of INTENT_CODES) {
    const ax = AXIS_BY_ID[axisId];
    const exact = exactOption(ax, ctrl);
    if (exact) {
      // default axis -> nothing to say (only non-defaults are serialized)
      if (exact !== AXIS_DEFAULT[axisId]) out.push(code + ':' + exact);
    } else {
      for (const k of ax.keys) push(rawPart(k, ctrl)); // off-intent: raw codes
    }
  }
  push(rawPart('iridescence', ctrl)); // off-surface in v3.2, still persisted
  push(rawPart('density', ctrl));
  push(rawPart('behavior', ctrl)); // the 'doing' axis, already a word
  return out.join(',');
}

export function decodeCtrl(str) {
  const ctrl = defaultCtrl();
  for (const pair of String(str).split(',')) {
    const i = pair.indexOf(':');
    if (i < 0) continue;
    const code = pair.slice(0, i);
    const raw = pair.slice(i + 1);
    const axisId = AXIS_OF_CODE[code];
    if (axisId) {
      const ax = AXIS_BY_ID[axisId];
      const o = optionOf(ax, raw);
      if (o) for (const k of ax.keys) ctrl[k] = clampParam(k, o.params[k]);
      continue;
    }
    const entry = CTRL_CODES.find((e) => e[1] === code);
    if (!entry) continue;
    const key = entry[0];
    if (key === 'behavior') {
      if (BEHAVIORS.includes(raw)) ctrl.behavior = raw;
    } else {
      const f = parseFloat(raw);
      if (Number.isFinite(f)) ctrl[key] = clampParam(key, f);
    }
  }
  return ctrl;
}

// ---- the controls object --------------------------------------------------
export function createControls(engine) {
  const { state, camera, canvas } = engine;

  let selectedId = null;
  const selCbs = [];
  const summonCbs = [];

  let targetPreset = DEFAULT_PRESET;
  let live = clonePreset(PRESETS[DEFAULT_PRESET]);
  let fade = null; // { t, from, to }

  const alive = () =>
    state.creatures.filter((c) => c.state === 'alive' && c.klass !== 'legacy');
  // plain loop, not .find(arrow): byId sits on per-frame paths (screenAnchor
  // for the plate + labels, getParam/getIntent for the plate rows) and a
  // predicate closure per call is an allocation the frame budget forbids.
  function byId(id) {
    if (id == null) return null;
    const list = state.creatures;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.id === id && c.state === 'alive') return c;
    }
    return null;
  }

  // ---- projection: creature center -> CSS px anchor -----------------------
  // anchorInto is the no-alloc path: callers that run per frame (hitTest,
  // labels via screenAnchor's out param) pass a reused target object.
  const _v = new THREE.Vector3();
  const _a = { x: 0, y: 0, radiusPx: 0 }; // hitTest's private scratch
  function anchorInto(c, out) {
    camera.updateMatrixWorld();
    _v.copy(c.points.position).project(camera);
    out.x = (_v.x * 0.5 + 0.5) * state.W;
    out.y = (-_v.y * 0.5 + 0.5) * state.H;
    const viewDist = Math.max(camera.position.distanceTo(c.points.position), 1);
    // camDist = (cssH/2)/tan(fov/2), so worldR * camDist / viewDist = px
    out.radiusPx = (c.rad * engine.getCamDist()) / viewDist;
    return out;
  }
  function anchor(c) {
    return anchorInto(c, { x: 0, y: 0, radiusPx: 0 });
  }

  // nearer/larger wins: normalized click distance, tie-broken toward the camera
  function hitTest(px, py) {
    let best = null;
    let bestScore = Infinity;
    for (const c of alive()) {
      if (c.material.uniforms.uFormation.value < 0.35) continue; // still forming
      const a = anchorInto(c, _a);
      const r = Math.max(a.radiusPx, 18);
      const d = Math.hypot(px - a.x, py - a.y);
      if (d > r * 1.1 + 10) continue;
      const viewDist = camera.position.distanceTo(c.points.position);
      const score = d / r + viewDist * 0.0004;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  // ---- selection ----------------------------------------------------------
  function indexTagOf(c) {
    const name = c.spec.name || c.spec.kind || '?';
    const same = alive().filter((o) => (o.spec.name || o.spec.kind) === name);
    const i = Math.max(same.indexOf(c), 0);
    return name[0] + '·' + String(i + 1).padStart(2, '0');
  }

  function getSelected() {
    const c = byId(selectedId);
    if (!c) return null;
    // intents: the derived named view of params, so the plate can populate in
    // one read. Not per-frame (selection change only), so the objects are fine.
    const intents = {};
    for (const ax of INTENT_AXES) intents[ax.id] = nearestOption(ax, c.ctrl);
    return {
      id: c.id,
      name: c.spec.name || c.spec.kind,
      indexTag: indexTagOf(c),
      params: { ...c.ctrl },
      intents,
    };
  }

  /**
   * @param {string|null} id
   * @param {{quiet?: boolean}} [opts]  quiet: this selection was not a click.
   *   Listeners get it as a second argument so a UI can tell "the user picked
   *   this" from "the app picked this for them" — the inspector uses it to
   *   avoid throwing a modal up over the ocean every time a name is typed.
   */
  function select(id, opts = {}) {
    const next = id == null ? null : byId(id) ? id : null;
    if (next === selectedId) return;
    selectedId = next;
    state.focus = next ? byId(next) : null;
    const snap = getSelected();
    const meta = { quiet: !!opts.quiet };
    for (const cb of selCbs) {
      try { cb(snap, meta); } catch { /* UI's problem, not the engine's */ }
    }
  }

  canvas.addEventListener('click', (e) => {
    // v3.7: a horizontal PAN over the porthole ends in a click event. The
    // column keeps `dragging()` true through that click, so navigation never
    // silently deselects the creature you were looking at.
    if (engine.canSelect && !engine.canSelect()) return;
    const hit = hitTest(e.clientX, e.clientY);
    select(hit ? hit.id : null); // empty-water click deselects
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') select(null);
  });

  // ---- per-creature params ------------------------------------------------
  function setParam(id, key, value) {
    const c = byId(id);
    if (!c || !(key in c.ctrl)) return false;
    if (key === 'behavior') {
      if (!BEHAVIORS.includes(value)) return false;
      c.ctrl.behavior = value;
      c.patC = null; // patrol recaptures its center on next use
      c.patAng = undefined;
    } else if (key === 'color') {
      c.ctrl.color = value == null ? null : clampParam('color', +value);
      c.applyCtrlVisual();
    } else {
      const f = +value;
      if (!Number.isFinite(f)) return false;
      c.ctrl[key] = clampParam(key, f);
      if (key === 'twinkle' || key === 'iridescence' || key === 'density') c.applyCtrlVisual();
    }
    engine.requestSave();
    return true;
  }

  function getParam(id, key) {
    const c = byId(id);
    return c ? c.ctrl[key] : undefined;
  }

  // ---- intents (v3.2) -----------------------------------------------------
  // setIntent is pure sugar over setParam: one named choice, N params, one
  // save. Nothing stores the choice — getIntent re-derives it, so the plate
  // stays truthful no matter who moved the params.
  function setIntent(id, axisId, value) {
    const ax = AXIS_BY_ID[axisId];
    if (!ax) return false;
    const o = optionOf(ax, value);
    if (!o) return false;
    let ok = false;
    for (const k of ax.keys) if (setParam(id, k, o.params[k])) ok = true;
    return ok;
  }

  function getIntent(id, axisId) {
    const c = byId(id);
    const ax = AXIS_BY_ID[axisId];
    if (!c || !ax) return null;
    return nearestOption(ax, c.ctrl);
  }

  // ---- weather presets ----------------------------------------------------
  function applyScene(v) {
    const g = engine.globalUniforms;
    g.uLightDir.value.set(v.lightDir[0], v.lightDir[1], v.lightDir[2]).normalize();
    g.uLightColor.value.setRGB(v.lightColor[0], v.lightColor[1], v.lightColor[2]);
    g.uRim.value = v.rim;
    g.uFogDensity.value = v.fogDensity;
    g.uFogTint.value.set(v.fogTint[0], v.fogTint[1], v.fogTint[2]);
    g.uGain.value = v.gain;
    engine.pipeline.setTrails(v.trailsK);
    if (engine.plankton) {
      engine.plankton.points.material.uniforms.uAlpha.value = v.planktonAlpha;
    }
    // Phase E: atmosphere layer intensities + bloom strength ride the same
    // crossfade (atmosphere is null in the spike scenes, which never preset)
    if (engine.atmosphere) {
      const a = engine.atmosphere;
      if (a.caustics) a.caustics.setIntensity(v.caustics);
      if (a.sediment) a.sediment.setIntensity(v.sediment);
      if (a.ao) a.ao.setIntensity(v.ao);
    }
    engine.pipeline.setBloom({ strength: v.bloom });
  }

  function setPreset(name, opts = {}) {
    if (!PRESETS[name]) return false;
    targetPreset = name;
    if (opts.snap) {
      live = clonePreset(PRESETS[name]);
      applyScene(live);
      fade = null;
    } else {
      fade = { t: 0, from: clonePreset(live), to: PRESETS[name] };
    }
    engine.requestSave();
    return true;
  }

  // ---- summon / reform / release ------------------------------------------
  function summon(text) {
    const before = state.pending.length;
    const res = engine.spawnName(text);
    if (!res) return { ok: false, id: null };
    const first = state.pending[before];
    const id = first ? first.spec.id : null;
    let sizePx = 60;
    if (first) {
      const s = first.spec;
      const viewDist = Math.max(engine.getCamDist() - s.base[2], 1);
      sizePx = (s.boundR * s.scale * engine.getCamDist()) / viewDist;
    }
    for (const cb of summonCbs) {
      try { cb({ id, sizePx }); } catch { /* sonar ring is decorative */ }
    }
    return { ok: true, id };
  }

  function reform(id) {
    const c = byId(id);
    if (c) c.reform();
  }

  function release(id) {
    const c = byId(id);
    if (!c) return;
    if (c.id === selectedId) select(null);
    c.disperse();
    engine.saveHash();
  }

  // ---- URL-hash extension -------------------------------------------------
  // Registered into main.js's saveHash: given the canonical name batches,
  // return extra hash segments (preset + per-ordinal ctrl diffs).
  function encodeExtras(batches) {
    const parts = [];
    if (targetPreset !== DEFAULT_PRESET) parts.push('p=' + targetPreset);
    const findCtrl = (name, i) => {
      const c = state.creatures.find(
        (cc) => cc.state === 'alive' && cc.spec.name === name && cc.spec.instance === i,
      );
      if (c) return c.ctrl;
      // still pending (e.g. mid-restore): the ctrl rides on the spec
      const p = state.pending.find((pp) => pp.spec.name === name && pp.spec.instance === i);
      return p && p.spec.ctrl ? { ...defaultCtrl(), ...p.spec.ctrl } : null;
    };
    let ord = 0;
    for (const b of batches) {
      const n = Math.min(b.count, 6);
      for (let i = 0; i < n; i++, ord++) {
        const ctrl = findCtrl(b.name, i);
        if (!ctrl) continue;
        const enc = encodeCtrl(ctrl);
        if (enc) parts.push(ord + '=' + enc);
      }
    }
    return parts;
  }
  engine.setHashExtras(encodeExtras);

  function serialize() {
    return engine.hashBody();
  }

  function restore(str) {
    select(null);
    const segs = String(str ?? '').split(';');
    let names = '';
    let presetName = null;
    const ctrls = new Map();
    for (const seg of segs) {
      const s = seg.trim();
      if (!s) continue;
      if (s.startsWith('p=')) {
        presetName = s.slice(2);
      } else if (s.startsWith('d=') || s.startsWith('s=')) {
        // v3.4 — the vessel's depth ('d='), v3.7 — its position along the
        // transect ('s=', metres offshore). main.js owns both (it owns the
        // column and reads these segments before the engine even exists);
        // skipped here so neither is ever mistaken for a creature name. Leaving
        // 's=' out of this list summoned a creature called "s=9000".
        continue;
      } else {
        const m = /^(\d+)=(.*)$/.exec(s);
        if (m) ctrls.set(+m[1], decodeCtrl(m[2]));
        else names = names ? names + ',' + s : s; // plain name list (legacy hash)
      }
    }
    engine.loadBoard(names);
    state.pending.forEach((p, i) => {
      const c = ctrls.get(i);
      if (c) p.spec.ctrl = c;
    });
    if (presetName && PRESETS[presetName]) setPreset(presetName, { snap: true });
    engine.saveHash();
  }

  // ---- per-frame hook (driven by main.js) ---------------------------------
  function tick(dt) {
    // selection liveness: released/dispersed creatures deselect themselves
    if (selectedId && !byId(selectedId)) select(null);

    // preset crossfade
    if (fade) {
      fade.t += dt / FADE_S;
      const e = easeInOut(Math.min(fade.t, 1));
      lerpScene(live, fade.from, fade.to, e);
      applyScene(live);
      if (fade.t >= 1) fade = null;
    }

    // continuous scene params read by the integrator every frame
    state.turbulence = live.turbulence;
    state.planktonRate = 1 + live.current * 0.12;
    state.current = live.current; // atmosphere (shaft sway, mote drift)

    // lateral current: swimmers lean downstream (their steering compensates),
    // drifters wrap around the volume; sleepers and the rooted stay put.
    const cur = live.current;
    if (cur) {
      const wrapX = state.W / 2 + 80;
      for (const c of state.creatures) {
        if (c.state !== 'alive' || c.klass === 'legacy' || c.klass === 'rooted') continue;
        if (c.ctrl.behavior === 'sleep') continue;
        c.px += cur * dt;
        if (c.klass === 'drifter' && c.px > wrapX) c.px = -wrapX;
      }
    }
  }

  return {
    // selection
    select,
    getSelected,
    onSelectionChange: (cb) => {
      selCbs.push(cb);
      return () => {
        const i = selCbs.indexOf(cb);
        if (i >= 0) selCbs.splice(i, 1);
      };
    },
    // out (optional): reused {x, y, radiusPx} target — the no-alloc path for
    // per-frame callers (labels). Omit it and a fresh object is returned.
    screenAnchor: (id, out) => {
      const c = byId(id);
      return c ? (out ? anchorInto(c, out) : anchor(c)) : null;
    },
    // params (unchanged surface — harness / presets / hash all ride this)
    setParam,
    getParam,
    paramRange: (key) => PARAM_RANGES[key] || null,
    // intents (v3.2) — the named layer the gauge plate speaks in
    setIntent,
    getIntent,
    intentAxes: intentAxisList,
    // presets
    setPreset,
    getPreset: () => targetPreset,
    presetNames: () => PRESET_ORDER.slice(),
    sceneValues: () => clonePreset(live), // live scene params (UI/tests may read)
    // v3.4 per-frame path: the SAME live object, not a clone. main.js reads
    // lightColor/fogTint/gain off it every frame to compose depth on top of the
    // crossfaded weather, and a clone per frame is an allocation the frame
    // budget forbids. Read it, never retain or mutate it — use sceneValues()
    // if you need a snapshot you can keep.
    liveScene: () => live,
    // lifecycle
    summon,
    reform,
    release,
    onSummon: (cb) => {
      summonCbs.push(cb);
      return () => {
        const i = summonCbs.indexOf(cb);
        if (i >= 0) summonCbs.splice(i, 1);
      };
    },
    // persistence
    serialize,
    restore,
    // engine hooks
    tick,
    hitTest: (x, y) => {
      const c = hitTest(x, y);
      return c ? c.id : null;
    },
  };
}

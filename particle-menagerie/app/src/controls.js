// Bathyscaphe control plumbing — Phase D engine-side API. The UI chrome
// (gauge plate, weather rotary, summon line) codes against exactly this
// surface; nothing here draws DOM. createControls(engine) receives the
// integrator's engine object (see main.js) and returns the contract:
//
//   select / getSelected / onSelectionChange / screenAnchor
//   setParam / getParam / paramRange
//   setPreset / getPreset / presetNames
//   summon / reform / release / onSummon
//   serialize / restore
//
// plus tick(dt), the per-frame hook main.js drives (preset crossfade,
// current drift, selection liveness).

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
    caustics: 0.85, sediment: 0.55, ao: 0.7, bloom: 0.35,
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

function clonePreset(p) {
  return {
    ...p,
    lightDir: p.lightDir.slice(),
    lightColor: p.lightColor.slice(),
    fogTint: p.fogTint.slice(),
  };
}

function lerpScene(out, a, b, e) {
  for (const k of Object.keys(a)) {
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
// are serialized.
const CTRL_CODES = [
  ['color', 'c'], ['glow', 'g'], ['tempo', 't'], ['sway', 'w'], ['size', 's'],
  ['twinkle', 'k'], ['iridescence', 'i'], ['density', 'd'], ['depth', 'z'],
  ['behavior', 'b'],
];

export function encodeCtrl(ctrl) {
  const d = defaultCtrl();
  const out = [];
  for (const [key, code] of CTRL_CODES) {
    const v = ctrl[key];
    if (key === 'behavior') {
      if (v !== d.behavior) out.push(code + ':' + v);
    } else if (key === 'color') {
      if (v != null) out.push(code + ':' + Math.round(v));
    } else if (Math.abs(v - d[key]) > 1e-3) {
      out.push(code + ':' + +v.toFixed(2));
    }
  }
  return out.join(',');
}

export function decodeCtrl(str) {
  const ctrl = defaultCtrl();
  for (const pair of String(str).split(',')) {
    const i = pair.indexOf(':');
    if (i < 0) continue;
    const code = pair.slice(0, i);
    const raw = pair.slice(i + 1);
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
  const byId = (id) =>
    state.creatures.find((c) => c.id === id && c.state === 'alive') || null;

  // ---- projection: creature center -> CSS px anchor -----------------------
  const _v = new THREE.Vector3();
  function anchor(c) {
    camera.updateMatrixWorld();
    _v.copy(c.points.position).project(camera);
    const x = (_v.x * 0.5 + 0.5) * state.W;
    const y = (-_v.y * 0.5 + 0.5) * state.H;
    const viewDist = Math.max(camera.position.distanceTo(c.points.position), 1);
    // camDist = (cssH/2)/tan(fov/2), so worldR * camDist / viewDist = px
    const radiusPx = (c.rad * engine.getCamDist()) / viewDist;
    return { x, y, radiusPx };
  }

  // nearer/larger wins: normalized click distance, tie-broken toward the camera
  function hitTest(px, py) {
    let best = null;
    let bestScore = Infinity;
    for (const c of alive()) {
      if (c.material.uniforms.uFormation.value < 0.35) continue; // still forming
      const a = anchor(c);
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
    return {
      id: c.id,
      name: c.spec.name || c.spec.kind,
      indexTag: indexTagOf(c),
      params: { ...c.ctrl },
    };
  }

  function select(id) {
    const next = id == null ? null : byId(id) ? id : null;
    if (next === selectedId) return;
    selectedId = next;
    state.focus = next ? byId(next) : null;
    const snap = getSelected();
    for (const cb of selCbs) {
      try { cb(snap); } catch { /* UI's problem, not the engine's */ }
    }
  }

  canvas.addEventListener('click', (e) => {
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
    screenAnchor: (id) => {
      const c = byId(id);
      return c ? anchor(c) : null;
    },
    // params
    setParam,
    getParam,
    paramRange: (key) => PARAM_RANGES[key] || null,
    // presets
    setPreset,
    getPreset: () => targetPreset,
    presetNames: () => PRESET_ORDER.slice(),
    sceneValues: () => clonePreset(live), // live scene params (UI/tests may read)
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

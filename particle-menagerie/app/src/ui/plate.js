// Bathyscaphe State B chrome — the gauge plate (v3.2: named intents).
// Fidelity contract: design/bathyscaphe/README.md (State B + Interactions),
// with ONE directed change to the control FORM: the numeric needle sliders
// are gone. The visual LANGUAGE is untouched — amber phosphor, Spectral
// small-caps labels, IBM Plex Mono readouts, glass plate, brass hairlines,
// the 400ms rise-through-water entry, 40%->85% hover.
//
// Why: numbers like "glow 62 / sway 25" name nothing. Every row now reads as
// a description of what the creature IS DOING, and the gauge needle survives
// as the thing that points at the chosen word on a brass detent strip:
//
//   motion   · · | ·          lively      (tempo + sway — one idea, one row)
//   light    · | · ·             dim      (glow + twinkle)
//   size     · · | · ·        normal
//   depth    · | ·               mid      (the parallax band)
//   doing    | · · · ·      drifting      (promoted out of the drawer)
//   color    ● ● ● ● ● ● ● ● ●
//   ─────────────────────────────
//   re-form   release
//
// iridescence and dot-density are CUT from the surface entirely (obscure) —
// their engine params and URL-hash codes live on, so old links still restore.
// Nothing worthwhile was left behind 'more ›', so the drawer is gone and
// re-form / release sit inline. Restraint rule still holds: three things
// visible at rest (summon input, weather rotary, plate).
//
// Styles live in ./chrome.css ("State B — gauge plate" section), loaded once
// via <link> in index.html — do NOT re-import it. Markup is built here.
//
// Consumes ONLY the controls API (src/controls.js):
//   controls.onSelectionChange(cb)  — cb(snapshot|null): surface / sink
//   controls.getSelected()          — { id, name, indexTag, params, intents }
//   controls.screenAnchor(id, out)  — { x, y, radiusPx } per frame (no-alloc
//                                     out param); the plate follows it
//   controls.intentAxes()           — axis descriptors (the rows below)
//   controls.setIntent / getIntent  — the named layer
//   controls.setParam / getParam    — only for color (a hue, not an intent)
//   controls.reform / release
//
// Interactions:
//   entry  = blur 8px -> 0 + 6px upward drift, 400ms ease-out ("rising
//            through water"); exit reverses, slightly faster
//   pick   = click a notch (or the row's label/word to cycle in place); the
//            needle springs to it underdamped, overshooting a fraction of a
//            notch and settling — the felt detent, now literal
//   keys   = ← → step, home/end ends, enter/space cycles
//   the word is derived, never stored: a raw setParam from anywhere (URL
//   restore, another agent's UI) leaves the row reading its NEAREST intent.

// v2 palette (particle-menagerie.html SWATCH): null = monochrome default
const V2_PALETTE = [null, 45, 15, 185, 165, 215, 275, 310, 130];

const SURFACE_MS = 400; // rise: blur 8px->0 + 6px upward drift, ease-out
const SINK_MS = 300; // exit reverses, slightly faster
const EDGE_PX = 14; // canvas-edge margin the plate never crosses
const GAP_PX = 18; // gap between the creature's radius and the plate
const FOLLOW_RATE = 10; // 1-exp(-rate*dt) anchor smoothing
const OMEGA = 16; // needle spring, rad/s
const ZETA = 0.62; // underdamped -> ~a tenth of a notch of overshoot
const OVER = 0.4; // how far past the end notches the needle may swing

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Wire the State B gauge plate. Builds #plate (appended to <body>), replaces
 * any stale instance, and drives itself from a private rAF loop (anchor
 * follow + needle springs) — main.js only has to create it.
 *
 * @param {object} controls - the createControls(engine) instance
 * @returns {{ el: HTMLElement, dispose(): void }}
 */
export function initPlate(controls) {
  const stale = document.getElementById('plate');
  if (stale) stale.remove();

  const el = document.createElement('div');
  el.id = 'plate';

  // ---- markup -------------------------------------------------------------
  const head = document.createElement('div');
  head.className = 'plate-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'plate-name';
  const tagEl = document.createElement('span');
  tagEl.className = 'plate-tag';
  head.append(nameEl, tagEl);

  const rowsEl = document.createElement('div');
  rowsEl.className = 'plate-intents';

  const divider = document.createElement('div');
  divider.className = 'plate-divider';

  const actions = document.createElement('div');
  actions.className = 'plate-actions';
  const mkAction = (label, act) => {
    const s = document.createElement('span');
    s.className = 'chrome-action';
    s.dataset.act = act;
    s.textContent = label;
    s.setAttribute('role', 'button');
    s.tabIndex = 0;
    actions.appendChild(s);
    return s;
  };
  mkAction('re-form', 'reform');
  mkAction('release', 'release');

  el.append(head, rowsEl, divider, actions);
  document.body.appendChild(el);

  // ---- intent rows --------------------------------------------------------
  let selId = null;
  let visible = false;
  const rows = []; // one entry per axis, in axis order

  function buildRow(axis) {
    const n = axis.options.length;

    const row = document.createElement('div');
    row.className = 'plate-row plate-intent';
    row.dataset.axis = axis.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'listbox');
    row.setAttribute('aria-label', axis.label);

    const label = document.createElement('span');
    label.className = 'plate-label';
    label.textContent = axis.label;

    const strip = document.createElement('div');
    strip.className = 'plate-notches';
    const notchEls = [];
    for (let i = 0; i < n; i++) {
      const notch = document.createElement('div');
      notch.className = 'plate-notch';
      notch.dataset.i = String(i);
      notch.dataset.value = axis.options[i];
      notch.setAttribute('role', 'option');
      notch.setAttribute('aria-label', axis.options[i]);
      notch.setAttribute('aria-selected', 'false');
      strip.appendChild(notch);
      notchEls.push(notch);
    }
    const needle = document.createElement('div');
    needle.className = 'plate-needle';
    strip.appendChild(needle);

    const word = document.createElement('span');
    word.className = 'plate-value';
    row.append(label, strip, word);
    rowsEl.appendChild(row);

    const r = {
      axis: axis.id,
      options: axis.options,
      n,
      i: 0, // selected notch index
      v: 0, // spring position, notch units
      vel: 0,
      target: 0,
      active: false,
      row,
      needle,
      word,
      notchEls,
      lastPct: -1,
      lastWord: '',
    };
    rows.push(r);

    // click a notch = pick it; click the label or the word = cycle in place.
    // preventDefault kills the text-selection drag, so focus is moved by hand
    // (the row is the keyboard target afterwards; esc still bubbles out).
    strip.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const t = ev.target.closest('.plate-notch');
      if (!t) return;
      ev.preventDefault();
      row.focus({ preventScroll: true });
      pick(r, +t.dataset.i);
    });
    const cycle = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      row.focus({ preventScroll: true });
      pick(r, r.i + 1); // wraps
    };
    label.addEventListener('pointerdown', cycle);
    word.addEventListener('pointerdown', cycle);

    row.addEventListener('keydown', (ev) => {
      let next = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = Math.min(r.i + 1, r.n - 1);
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = Math.max(r.i - 1, 0);
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = r.n - 1;
      else if (ev.key === 'Enter' || ev.key === ' ') next = (r.i + 1) % r.n;
      else return; // Escape and friends keep bubbling (esc deselects)
      ev.preventDefault();
      ev.stopPropagation(); // keep the summon field from stealing focus keys
      pick(r, next);
    });
    return r;
  }

  for (const axis of controls.intentAxes()) buildRow(axis);

  // Pick an option: commit it to the engine, spring the needle to it. Always
  // commits, even when the index is unchanged — that is how an off-intent
  // param set (a hand-tuned legacy URL) snaps onto the word it was reading.
  function pick(r, i) {
    if (!selId) return;
    const idx = ((i % r.n) + r.n) % r.n;
    r.i = idx;
    r.target = idx;
    r.active = true;
    setWord(r, r.options[idx]);
    controls.setIntent(selId, r.axis, r.options[idx]);
  }

  function setWord(r, w) {
    if (w === r.lastWord) return;
    r.lastWord = w;
    r.word.textContent = w;
    for (let k = 0; k < r.n; k++) {
      r.notchEls[k].setAttribute('aria-selected', k === r.i ? 'true' : 'false');
    }
  }

  function renderRow(r) {
    // notches tile the strip in equal cells; cell i is centered at (i+.5)/n
    const pct = ((r.v + 0.5) / r.n) * 100;
    if (Math.abs(pct - r.lastPct) < 0.02) return;
    r.lastPct = pct;
    r.needle.style.left = pct.toFixed(2) + '%';
  }

  // snap a row to an option with no spring travel (populate / external change)
  function snapRow(r, value) {
    const i = Math.max(r.options.indexOf(value), 0);
    r.i = i;
    r.v = r.target = i;
    r.vel = 0;
    r.active = false;
    r.lastWord = '';
    r.lastPct = -1;
    setWord(r, r.options[i]);
    renderRow(r);
  }

  // ---- color: compact swatch row (a hue is visual, not an intent) ---------
  const colRow = document.createElement('div');
  colRow.className = 'plate-row plate-colors';
  const colLabel = document.createElement('span');
  colLabel.className = 'plate-label';
  colLabel.textContent = 'color';
  const swatches = document.createElement('div');
  swatches.className = 'plate-swatches';
  const swatchEls = V2_PALETTE.map((h) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'plate-swatch';
    b.style.background = h == null ? '#fff' : 'hsl(' + h + ' 78% 62%)';
    b.setAttribute('aria-label', h == null ? 'monochrome' : 'hue ' + h);
    b.addEventListener('click', () => {
      if (!selId) return;
      controls.setParam(selId, 'color', h);
      markSwatch(h);
    });
    swatches.appendChild(b);
    return b;
  });
  colRow.append(colLabel, swatches);
  rowsEl.appendChild(colRow);

  let curHue = null;
  function markSwatch(h) {
    curHue = h;
    swatchEls.forEach((b, i) => {
      const v = V2_PALETTE[i];
      b.classList.toggle('current', v == null ? h == null : v === h);
    });
  }

  // ---- actions ------------------------------------------------------------
  const runAction = (act) => {
    if (!selId) return;
    if (act === 'reform') controls.reform(selId);
    else if (act === 'release') controls.release(selId); // engine deselects -> sink
  };
  actions.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (t) runAction(t.dataset.act);
  });
  actions.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-act]');
    if (t) {
      e.preventDefault();
      runAction(t.dataset.act);
    }
  });

  // ---- surface / sink (rising through water) ------------------------------
  let anim = null;
  let snap = true;
  let px = 0;
  let py = 0;

  function populate(sel) {
    selId = sel.id;
    nameEl.textContent = sel.name;
    tagEl.textContent = sel.indexTag;
    for (const r of rows) {
      snapRow(r, (sel.intents && sel.intents[r.axis]) || controls.getIntent(sel.id, r.axis));
    }
    markSwatch(sel.params.color ?? null);
  }

  function surface(sel) {
    const wasVisible = visible;
    if (anim) {
      anim.cancel();
      anim = null;
    }
    el.classList.remove('sinking');
    populate(sel);
    if (wasVisible) return; // switching creatures: stay up, glide over
    visible = true;
    snap = true;
    el.classList.add('surfaced');
    place(0); // position before the rise so it doesn't fly across the screen
    anim = el.animate(
      [
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
      ],
      { duration: SURFACE_MS, easing: 'ease-out' },
    );
    anim.onfinish = () => {
      anim = null;
    };
  }

  function sink() {
    selId = null;
    if (!visible) return;
    visible = false;
    if (anim) anim.cancel();
    el.classList.add('sinking');
    anim = el.animate(
      [
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
      ],
      { duration: SINK_MS, easing: 'ease-in', fill: 'forwards' },
    );
    const done = () => {
      el.classList.remove('surfaced', 'sinking');
      if (anim) {
        anim.cancel();
        anim = null;
      }
    };
    anim.onfinish = done;
  }

  // ---- anchor follow ------------------------------------------------------
  const anchorScratch = { x: 0, y: 0, radiusPx: 0 }; // no-alloc per-frame path
  function place(dt) {
    const a = controls.screenAnchor(selId, anchorScratch);
    if (!a) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let tx = a.x + a.radiusPx + GAP_PX; // prefer beside, to the right
    if (tx + w + EDGE_PX > W) tx = a.x - a.radiusPx - GAP_PX - w; // flip left
    tx = clamp(tx, EDGE_PX, Math.max(W - w - EDGE_PX, EDGE_PX));
    let ty = clamp(a.y - h / 2, EDGE_PX, Math.max(H - h - EDGE_PX, EDGE_PX));
    // The summon row (bottom-center, ~360px wide band above the bottom edge)
    // outranks the plate: lift the plate clear when they would overlap.
    const SUMMON_H = 104;
    const summonHalf = 190;
    if (tx + w > W / 2 - summonHalf && tx < W / 2 + summonHalf && ty + h > H - SUMMON_H) {
      ty = Math.max(H - h - SUMMON_H, EDGE_PX);
    }
    if (snap) {
      snap = false;
      px = tx;
      py = ty;
    } else {
      const k = 1 - Math.exp(-FOLLOW_RATE * dt);
      px += (tx - px) * k;
      py += (ty - py) * k;
    }
    el.style.left = px.toFixed(1) + 'px';
    el.style.top = py.toFixed(1) + 'px';
  }

  // ---- needle springs -----------------------------------------------------
  // Params are committed on pick, not per frame — the spring is purely the
  // felt-detent settle. Underdamped, so it swings a fraction of a notch past
  // the chosen word and comes back.
  function stepSprings(dt) {
    const k = OMEGA * OMEGA;
    const c = 2 * ZETA * OMEGA;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.active) continue;
      r.vel += (k * (r.target - r.v) - c * r.vel) * dt;
      r.v += r.vel * dt;
      r.v = clamp(r.v, -OVER, r.n - 1 + OVER);
      if (Math.abs(r.v - r.target) < 0.008 && Math.abs(r.vel) < 0.05) {
        r.v = r.target;
        r.vel = 0;
        r.active = false;
      }
      renderRow(r);
    }
  }

  // external changes (restore, presets, a raw setParam from anywhere) show up
  // as the NEAREST intent — the row is a view of the params, never a store
  function refreshFromEngine() {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.active) continue;
      const cur = controls.getIntent(selId, r.axis);
      if (cur && cur !== r.lastWord) {
        const idx = Math.max(r.options.indexOf(cur), 0);
        r.i = idx;
        r.target = idx;
        r.active = true; // glide, don't jump
        setWord(r, cur);
      }
    }
    const hue = controls.getParam(selId, 'color') ?? null;
    if (hue !== curHue) markSwatch(hue);
  }

  // ---- private frame loop -------------------------------------------------
  let raf = 0;
  let lastT = performance.now();
  let syncTick = 0;
  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = clamp((t - lastT) / 1000, 0.001, 0.05);
    lastT = t;
    if (!visible || !selId) return;
    place(dt);
    stepSprings(dt);
    // external param sync is a poll, not a hot path: ~10Hz is invisible to
    // the eye and keeps the plate's per-frame work to the anchor + springs
    if (++syncTick >= 6) {
      syncTick = 0;
      refreshFromEngine();
    }
  }
  raf = requestAnimationFrame(loop);

  // ---- wiring -------------------------------------------------------------
  const off = controls.onSelectionChange((sel) => (sel ? surface(sel) : sink()));
  const already = controls.getSelected();
  if (already) surface(already);

  return {
    el,
    dispose() {
      cancelAnimationFrame(raf);
      if (typeof off === 'function') off();
      if (anim) anim.cancel();
      el.remove();
    },
  };
}

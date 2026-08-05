// Bathyscaphe chrome — the SHORE GAUGE (v3.7).
//
// The depth gauge's horizontal twin. v3.4 gave the vessel an instrument for the
// vertical axis; v3.7 gave the world a second axis — a cross-shelf transect
// from the shoreline out to the abyssal plain — so it gets the same instrument,
// laid on its side along the BOTTOM edge:
//
//     ····──────╮                                   ← the seabed, in section
//               ╰──╮
//                  ╰────────────────────  1200 m
//     ──┼──┼──┼──┼──▮──┼──┼──┼──┼──┼──┼──  the rule, the ticks, the needle
//       0     6    12    18    24    36    km offshore
//                12.4 km  ᴄᴏɴᴛɪɴᴇɴᴛᴀʟ sʟᴏᴘᴇ
//
// Everything about it is the depth gauge's idiom rotated 90°: a brass hairline
// scale, 1px graduations, 8px numerals at 30% warm white, ONE amber needle, a
// mono distance readout and the zone name in Spectral small-caps — because the
// zone name is what makes the axis a PLACE rather than a slider. No plate, no
// glass, no backdrop-filter, no fill, no border. Legibility over both the
// bright surface glitter and the black abyss comes from a dark CASING on every
// mark (--sg-casing / --sg-halo), exactly as it does on the depth gauge, so the
// instrument stays a drawing ON the water instead of a slab over it.
//
// Styles live in ./chrome.css — the "v3.7 — SHORE GAUGE" section (loaded once
// via <link> in index.html; do NOT re-import it). Markup is built here.
//
// ---------------------------------------------------------------------------
// WHERE IT LIVES, AND WHY
// ---------------------------------------------------------------------------
// Four resting instruments now share the frame, and none of them may crowd
// another:
//
//   depth gauge   LEFT edge — but its INK, not its box: the 148px box ends at
//                 x = 170, while its readout stack starts at x = 88 and its
//                 note block is 172px wide, so the instrument reaches x = 260
//                 and, at abyssal depths, hangs down to y = 553.
//   summon row    BOTTOM-CENTRE, 300px wide, bottom: 56px     (owns the centre)
//   weather rotary BOTTOM-RIGHT, ink reaching 130px in when hovered
//   shore gauge   BOTTOM edge, left: 268px, right: 168px, bottom: 10px,
//                 44px tall — top edge at y = 54px, two pixels under the summon
//                 row's underline.
//
// That is the only rectangle in the frame that is both wide enough to carry a
// 36 km scale and empty. All three exclusions are measured numbers, not vibes,
// and the LEFT one is the one that costs something. The first draft started at
// x = 176 on the theory that the depth gauge's low-hanging readout could never
// coincide with this one, because THE VESSEL CAN ONLY BE DEEP WHERE THE WATER
// IS DEEP: past ~1000 m you are necessarily offshore of ~24 km, so the two
// needles are pushed to opposite ends of the frame by the same profile they
// both describe. That argument is true, and it is why the two READOUTS can
// never meet — but it says nothing about this instrument's STATIC ink. The
// numerals and the rule are drawn across the whole strip at all times, and at
// 1138 m the depth gauge prints "no sunlight below 1000 m" at x 88..260,
// y 495..507, with no hover gate: permanent, for as long as the vessel is deep.
// Measured in the running app, it landed straight across the "0 km" end of the
// rule. So the inshore end yields 92px and starts at 268 instead.
// (The readout additionally sits in the BOTTOM row of the strip, below the
// numerals, where nothing else in the app ever draws.)
//
// ---------------------------------------------------------------------------
// THE SECTION (the hairline profile)
// ---------------------------------------------------------------------------
// Above the rule sits an 18px cross-section of the seabed: the shelf, the
// break and the slope, drawn as a dotted contour — dots, because that is what
// the seabed in the world is made of, and because a percent-positioned dot
// needs no SVG, no canvas and no JS on resize. The band's top edge is the sea
// surface (0 m) and its bottom edge is 1200 m — which is also the rule's own
// hairline, so the profile LANDS on the baseline exactly where the slope
// bottoms out onto the plain. The needle's mark rides the contour with a
// hairline drop to the rule, and the length of that drop is the depth of water
// under the vessel. That single graphic is the whole feature: shallow here, a
// bench, a knee, a plunge, a plain.
//
// ON EXAGGERATION — an unlabelled exaggerated profile is the oldest lie in
// earth science, so this one is not exaggerated. 18px of band against a rule
// 524px wide works out at 1.03x, and wider viewports only flatten it further:
// the drawing is drawn at true proportion or under-states the seafloor, and it
// can never oversell a shelf break. Note this is NOT the world's own 10x
// vertical exaggeration (column.js VERTICAL_EXAGGERATION) — that would need a
// 175px band, and there is no 175px of frame to spend. The exact factor is
// measured on demand and reported by readout().
//
// What true scale costs, honestly: the shelf break is a 3px knee. A real one
// is a 0.1 degree kink, and no drawing that fits in a 44px strip can make it
// dramatic without lying about it. So the BREAK is named rather than
// caricatured — a brighter landmark graduation at 18 km, and the words "shelf
// break" in the readout when you are there — and the section is left to say the
// true thing it can say at this size: shallow inshore, a long bench, a steepening,
// a floor.
//
// ---------------------------------------------------------------------------
// Consumes ONLY the column API (src/column.js):
//   column.setShore(m, { source })  — commanded position, metres offshore. The
//                                     COLUMN owns the easing (critically damped
//                                     + flank cap), so every interaction here is
//                                     a set-point write, never a position write.
//   column.nudgeShore(dm, { source })— relative (wheel / arrow keys)
//   column.shore()                  — the eased, live position: what the NEEDLE
//                                     and the readout show
//   column.targetShore()            — the commanded position: the set-point bug
//   column.shoreRange()             — { min, max, shore, offshore, span, break,
//                                     plain }; SHARED object, read immediately
//   column.shoreZoneAt(m)           — a SHORE_ZONES entry ({ id, label, ... })
//   column.profileDepthAt(m)        — seabed depth in metres: THE PROFILE
// Every world constant is taken from the instance first and the module second,
// so this file cannot drift from column.js and cannot break the build if the
// module's export list changes underneath it.
//
// Contracts honoured:
//   * no per-frame allocation while the vessel is parked: the rAF mirror reads
//     numbers and touches the DOM only when a value actually moved (position
//     past a sub-pixel threshold, text only when the printed figure changes).
//     getBoundingClientRect is called on pointer events only, never in the loop.
//   * no engine coupling — this module never touches the scene, the clock or
//     the sim; its private rAF loop only mirrors column state into the DOM, and
//     it reads no wall clock at all (there is nothing here that is timed).
//   * determinism — the gauge holds no state the board depends on; the column
//     (and therefore the URL hash) is the sole owner of the transect position.
//   * offline — no fetch, no asset, no font beyond the two the chrome already
//     loads.

import * as world from '../column.js';

// ---- scale ---------------------------------------------------------------
const MAJOR_M = 6000; // major graduation (numeral) — 0, 6, 12 ... 36 km
const MINOR_M = 2000; // minor graduation between them
// Samples across the transect for the dotted section. 144 intervals puts a dot
// every 250 m of transect — 4px apart on a 960px viewport, 8px on a wide one —
// and lands one exactly on the shelf break (18 km is 50% of 36 km).
const PROFILE_STEPS = 144;

// ---- navigation gains ----------------------------------------------------
// Wheel over the gauge must feel EXACTLY like shift-wheel over the water, so
// the gain is column.js's own SHORE_WHEEL_GAIN (world px of transect per wheel
// px), imported rather than mirrored — a copied constant is the one place the
// instrument and the porthole can silently drift apart.
const KEY_STEP_M = 320; // arrow key: column.js's own SHORE_KEY_STEP_M
const PAGE_STEP_M = MAJOR_M; // PageUp/PageDown: exactly one graduation
const WHEEL_LINE_PX = 16; // deltaMode 1 (lines) -> px

// ---- repaint thresholds (the "don't touch the DOM" guards) ---------------
const POS_EPS = 0.02; // % of the transect — below this the needle hasn't moved
const TARGET_EPS_M = 90; // set-point bug appears once the vessel is this far off
// (0.25% of the transect — the same fraction of the axis as the depth gauge's
// 3 m of 1200 m, so both bugs appear after the same amount of screen travel)

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finite = (...vals) => {
  for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i])) return vals[i];
  return 0;
};

/** "640 m" inshore, "12.4 km" out — metres while metres still mean something
 *  (the shore stop is 400 m out and the surf zone is 500 m wide), kilometres
 *  once the numbers stop being walkable. */
export function formatShoreM(m) {
  const v = m < 0 ? 0 : m;
  if (v < 1000) return Math.round(v) + ' m';
  return (v / 1000).toFixed(1) + ' km';
}

/**
 * Mount the shore gauge.
 *
 * @param {object} column - the createColumn() instance (src/column.js)
 * @param {object} [opts]
 *   mount    parent element (default: document.body)
 * @returns {{ el: HTMLElement|null, shore(): number, readout(): object,
 *             dispose(): void }}
 */
export function initShoreGauge(column, opts = {}) {
  // Model-less boot (spike scenes never mount chrome, and a column built before
  // the transect landed has no setShore): stay inert rather than throwing into
  // the integrator's boot path.
  if (!column || typeof column.setShore !== 'function') {
    return { el: null, shore: () => 0, readout: () => ({}), dispose() {} };
  }

  const stale = document.getElementById('shoregauge');
  if (stale) stale.remove();

  const parent = opts.mount || document.body;

  // ---- the world's numbers ----------------------------------------------
  // Instance first (it is the live object), module second, literal last. The
  // literals are never expected to be used; they exist so that a column built
  // by an older or newer module can still raise a working instrument.
  const SPAN_M = finite(column.TRANSECT_M, world.TRANSECT_M, 36000) || 36000;
  const DEEPEST_M = finite(column.SEABED_DEPTH_M, world.SEABED_DEPTH_M, 1200) || 1200;
  const BREAK_AT_M = finite(column.BREAK_M, world.BREAK_M, 18000);
  const WHEEL_M_PER_PX =
    finite(world.SHORE_WHEEL_GAIN, 6) * finite(world.TRANSECT_METRES_PER_PX, 2);

  const profileAt =
    typeof column.profileDepthAt === 'function'
      ? column.profileDepthAt
      : typeof world.profileDepthAt === 'function'
        ? world.profileDepthAt
        : () => DEEPEST_M;
  const zoneAt =
    typeof column.shoreZoneAt === 'function'
      ? column.shoreZoneAt
      : typeof world.shoreZoneAt === 'function'
        ? world.shoreZoneAt
        : () => null;

  const pct = (m) => clamp01(m / SPAN_M) * 100;
  const depthPct = (d) => clamp01(d / DEEPEST_M) * 100;

  // ---- markup ------------------------------------------------------------
  const el = document.createElement('div');
  el.id = 'shoregauge';

  // 1. the section: a dotted seabed contour, 0 m at the top edge, 1200 m at the
  //    bottom. Every dot is placed in PERCENT on both axes, so a viewport
  //    resize re-lays the whole profile with no JS and no reflow storm.
  const section = document.createElement('div');
  section.className = 'sg-section';
  for (let i = 0; i <= PROFILE_STEPS; i++) {
    const m = (i / PROFILE_STEPS) * SPAN_M;
    const d = document.createElement('i');
    d.className = 'sg-bed';
    d.style.left = ((i / PROFILE_STEPS) * 100).toFixed(4) + '%';
    d.style.top = depthPct(profileAt(m)).toFixed(4) + '%';
    section.appendChild(d);
  }
  // the plumb from the vessel's mark down to the rule — what ties the section
  // to the scale, and incidentally a picture of how deep the water is here
  const drop = document.createElement('i');
  drop.className = 'sg-drop';
  section.appendChild(drop);
  // the vessel, riding the contour
  const mark = document.createElement('i');
  mark.className = 'sg-mark';
  section.appendChild(mark);

  // 2. the rule: the 22px hit strip, with a 1px brass hairline through it
  const rule = document.createElement('div');
  rule.className = 'sg-rule';
  rule.tabIndex = 0;
  rule.setAttribute('role', 'slider');
  rule.setAttribute('aria-label', 'distance from shore');
  rule.setAttribute('aria-orientation', 'horizontal');
  rule.setAttribute('aria-valuemin', '0');
  rule.setAttribute('aria-valuemax', String(Math.round(SPAN_M)));

  // the reachable segment (shoreRange().min .. .max) — the vessel is a
  // submersible, not a landing craft, and stops inshore in 4 m of water. The
  // travel stop explains itself with no copy.
  const reach = document.createElement('i');
  reach.className = 'sg-reach';
  rule.appendChild(reach);

  // graduations, in PERCENT — resize-proof for the same reason as the contour
  const scaleEl = document.createElement('div');
  scaleEl.className = 'sg-scale';
  for (let m = 0; m <= SPAN_M + 0.001; m += MINOR_M) {
    const major = Math.abs(m % MAJOR_M) < 0.001;
    const t = document.createElement('i');
    t.className = major ? 'sg-tick major' : 'sg-tick';
    t.style.left = pct(m).toFixed(4) + '%';
    rule.appendChild(t);
    if (!major) continue;
    const n = document.createElement('i');
    n.className = 'sg-num';
    n.textContent = String(Math.round(m / 1000));
    n.style.left = pct(m).toFixed(4) + '%';
    scaleEl.appendChild(n);
  }
  // the shelf break gets its own graduation: the profile's one landmark, and
  // the only place on this axis where the seabed does something sudden.
  if (BREAK_AT_M > 0 && BREAK_AT_M < SPAN_M) {
    const b = document.createElement('i');
    b.className = 'sg-tick landmark';
    b.style.left = pct(BREAK_AT_M).toFixed(4) + '%';
    rule.appendChild(b);
  }

  // the commanded-position bug (where the vessel is HEADED)
  const bug = document.createElement('i');
  bug.className = 'sg-bug';
  rule.appendChild(bug);

  // the needle: the plate's 2x10px amber gauge needle, stood upright — the
  // depth gauge lays the same needle on its side
  const needle = document.createElement('i');
  needle.className = 'sg-needle';
  rule.appendChild(needle);

  // 3. the readout: distance + zone, riding the needle, in the bottom row
  const read = document.createElement('div');
  read.className = 'sg-read';
  const value = document.createElement('span');
  value.className = 'sg-value';
  const zone = document.createElement('span');
  zone.className = 'sg-zone';
  read.append(value, zone);

  el.append(section, rule, scaleEl, read);
  parent.appendChild(el);

  // ---- interaction -------------------------------------------------------
  // Every gesture writes a SET-POINT. The column eases to it; the needle
  // follows the column. Nothing here ever positions the vessel directly.

  let dragging = false;

  function metresAt(clientX) {
    const r = rule.getBoundingClientRect(); // pointer events only, never rAF
    return clamp01((clientX - r.left) / Math.max(r.width, 1)) * SPAN_M;
  }

  function travel(clientX) {
    column.setShore(metresAt(clientX), { source: 'gauge' });
  }

  const onPointerDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation(); // never reads as an empty-water deselect click
    dragging = true;
    el.classList.add('awake');
    rule.classList.add('dragging');
    try {
      rule.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety; the move listener still works without it */
    }
    travel(ev.clientX); // click anywhere on the rule = travel there
  };
  const onPointerMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    travel(ev.clientX); // drag the needle
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    rule.classList.remove('dragging');
    if (!rule.matches(':hover') && document.activeElement !== rule) {
      el.classList.remove('awake');
    }
  };
  rule.addEventListener('pointerdown', onPointerDown);
  rule.addEventListener('pointermove', onPointerMove);
  rule.addEventListener('pointerup', endDrag);
  rule.addEventListener('pointercancel', endDrag);

  // Wheel over the gauge travels the transect — the whole instrument is the
  // horizontal axis, so a plain wheel means offshore/inshore here exactly as a
  // plain wheel means dive over the depth gauge. Shift-wheel and a trackpad's
  // native sideways swipe are the same gesture and take the same gain, which is
  // the column's own; positive (scroll down / scroll right) heads offshore.
  const onWheel = (ev) => {
    ev.preventDefault(); // a navigation control, not a scrollbar
    ev.stopPropagation();
    // deltaMode: 0 px, 1 lines, 2 pages
    const unit = ev.deltaMode === 1 ? WHEEL_LINE_PX : ev.deltaMode === 2 ? window.innerWidth || 960 : 1;
    const dx = ev.deltaX;
    const dy = ev.deltaY;
    const px = (Math.abs(dx) > Math.abs(dy) ? dx : dy) * unit;
    if (px === 0) return;
    column.nudgeShore(px * WHEEL_M_PER_PX, { source: 'gauge' });
  };
  rule.addEventListener('wheel', onWheel, { passive: false });

  // Arrow keys when focused. Offshore is +x, so the shore is to your left:
  // ArrowLeft heads for the beach, ArrowRight for the abyss — column.js's own
  // convention. Handled keys are stopped here so column.js's window-level
  // bindings don't apply the SAME step a second time; everything else (Escape,
  // typing) is left to bubble untouched.
  const onKey = (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const r = column.shoreRange();
    const lo = r.min;
    const hi = r.max;
    switch (ev.key) {
      case 'ArrowRight':
        column.nudgeShore(KEY_STEP_M, { source: 'gauge' });
        break;
      case 'ArrowLeft':
        column.nudgeShore(-KEY_STEP_M, { source: 'gauge' });
        break;
      case 'PageDown':
        column.nudgeShore(PAGE_STEP_M, { source: 'gauge' });
        break;
      case 'PageUp':
        column.nudgeShore(-PAGE_STEP_M, { source: 'gauge' });
        break;
      case 'Home':
        column.setShore(lo, { source: 'gauge' });
        break;
      case 'End':
        column.setShore(hi, { source: 'gauge' });
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  };
  rule.addEventListener('keydown', onKey);

  // hover / focus lifts the scale out of the water (150-200ms, per the design)
  const wake = () => el.classList.add('awake');
  const rest = () => {
    if (!dragging && document.activeElement !== rule) el.classList.remove('awake');
  };
  rule.addEventListener('pointerenter', wake);
  rule.addEventListener('pointerleave', rest);
  rule.addEventListener('focus', wake);
  rule.addEventListener('blur', rest);

  // ---- the live read (private rAF mirror; allocation-free at rest) --------
  let lastPos = -1e9; // % — needle + readout + mark position
  let lastBed = -1e9; // % — where the mark sits on the contour
  let lastBug = -1e9; // % — set-point bug
  let lastBugOn = null;
  let lastKey = -1e9; // the printed figure's quantum (see below)
  let lastZoneRec = null;
  let lastLo = -1e9;
  let lastHi = -1e9;

  function paint() {
    const m = column.shore();
    const p = pct(m);
    if (Math.abs(p - lastPos) > POS_EPS) {
      lastPos = p;
      const s = p.toFixed(3) + '%';
      needle.style.left = s;
      mark.style.left = s;
      drop.style.left = s;
      // the readout is clamped into the strip by CSS, so it can ride the needle
      // to either end without walking off the instrument
      read.style.setProperty('--sg-x', s);

      // the mark rides the contour, and the plumb reaches from it to the rule
      const bed = depthPct(profileAt(m));
      if (Math.abs(bed - lastBed) > POS_EPS) {
        lastBed = bed;
        const t = bed.toFixed(3) + '%';
        mark.style.top = t;
        drop.style.top = t;
        drop.style.height = (100 - bed).toFixed(3) + '%';
      }
    }

    // Text is rebuilt only when the PRINTED figure changes: whole metres while
    // the readout is in metres, 50 m steps once it is in kilometres (the
    // display carries one decimal, so nothing finer can show).
    const key = m < 1000 ? Math.round(m) : Math.round(m / 50);
    if (key !== lastKey) {
      lastKey = key;
      value.textContent = formatShoreM(m);
      rule.setAttribute('aria-valuenow', String(Math.round(m)));

      // the zone entry is a frozen table row, so this is an identity test and
      // builds no string while you travel inside one zone
      const z = zoneAt(m);
      if (z !== lastZoneRec) {
        lastZoneRec = z;
        zone.textContent = z ? z.label || z.id || '' : '';
      }
      // What the instrument says, spoken: the distance, the place, and the one
      // fact the section is drawing — how deep the water is under the vessel.
      rule.setAttribute(
        'aria-valuetext',
        formatShoreM(m) + ' offshore, ' + zone.textContent
          + ', seabed ' + Math.round(profileAt(m)) + ' m',
      );
    }

    // the set-point bug: only while the vessel is still travelling to it
    const tgt = column.targetShore ? column.targetShore() : m;
    const on = Math.abs(tgt - m) > TARGET_EPS_M;
    if (on) {
      const bp = pct(tgt);
      if (Math.abs(bp - lastBug) > POS_EPS) {
        lastBug = bp;
        bug.style.left = bp.toFixed(3) + '%';
      }
    }
    if (on !== lastBugOn) {
      lastBugOn = on;
      bug.style.opacity = on ? '1' : '0';
    }

    // the navigable segment — a stub at the inshore end, because the vessel
    // stops in 4 m of water rather than beaching itself
    const r = column.shoreRange(); // shared object — read now, never retained
    if (r.min !== lastLo || r.max !== lastHi) {
      lastLo = r.min;
      lastHi = r.max;
      const a = pct(r.min);
      reach.style.left = a.toFixed(3) + '%';
      reach.style.width = Math.max(0, pct(r.max) - a).toFixed(3) + '%';
    }
  }

  let raf = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    paint();
  }

  // ---- entry: rise through water -----------------------------------------
  // 400ms ease-out, blur 8px -> 0 with a 6px upward drift (README Motion).
  // Held until the engine's first frame (body.booted), so the instrument
  // surfaces INTO a rendered scene instead of animating behind the boot gate.
  let mo = null;
  function rise() {
    if (typeof el.animate !== 'function') return;
    el.animate(
      [
        { opacity: 0, filter: 'blur(8px)', transform: 'translateY(6px)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0)' },
      ],
      { duration: 400, easing: 'ease-out' },
    );
  }
  const booted = () => document.body.classList.contains('booted');
  if (booted()) {
    rise();
  } else if (typeof MutationObserver === 'function') {
    mo = new MutationObserver(() => {
      if (!booted()) return;
      mo.disconnect();
      mo = null;
      rise();
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  paint(); // first read before the first frame — never a blank instrument
  raf = requestAnimationFrame(loop);

  const api = {
    el,
    /** Where the instrument is reading right now (metres offshore). Test hook. */
    shore: () => column.shore(),
    /**
     * Every line the instrument is printing, plus the two numbers that are
     * drawn rather than written. `exaggeration` is measured, not assumed: it is
     * the section's true vertical exaggeration at the current viewport width,
     * and it must never exceed 1 (this drawing under-states the seafloor; it
     * never oversells a shelf break). Test hook — it reads layout, so never
     * call it from a frame path.
     */
    readout: () => {
      const w = rule.getBoundingClientRect().width || 1;
      const h = section.getBoundingClientRect().height || 1;
      return {
        distance: value.textContent,
        zone: zone.textContent,
        seabedM: Math.round(profileAt(column.shore())),
        exaggeration: h / DEEPEST_M / (w / SPAN_M),
      };
    },
    dispose() {
      cancelAnimationFrame(raf);
      if (mo) mo.disconnect();
      rule.removeEventListener('wheel', onWheel);
      el.remove();
    },
  };

  // Test hook, registered the way ui/ambient.js and ui/depthgauge.js register
  // theirs (twice, so it survives main.js assigning window.__menagerie after
  // the UI boots).
  const attach = () => {
    const m = (window.__menagerie = window.__menagerie || {});
    const ui = (m.ui = m.ui || {});
    ui.shoreGauge = api;
  };
  attach();
  setTimeout(attach, 0);

  return api;
}

export default initShoreGauge;

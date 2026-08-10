// Bathyscaphe chrome — the DEPTH GAUGE (v3.5).
//
// The vessel's own depth instrument: a slim vertical scale down the left edge
// that both READS the column ("where am I") and DRIVES it ("take me there").
// Fidelity contract: design/bathyscaphe/README.md — brass hairlines, amber
// phosphor needle, IBM Plex Mono readout, Spectral small-caps zone name,
// 150-200ms hovers, the 400ms rise-through-water entry, and the State C
// ambient rule (sinks with the rest of the chrome, returns on input).
//
// Styles live in ./chrome.css — the "v3.4 — DEPTH GAUGE" section (the scale,
// the needle, the ambient + boot gates) and the "v3.5 — DEPTH GAUGE: THE
// PHYSICS READOUT" section (everything below the metre value). Loaded once via
// <link> in index.html — do NOT re-import it. Markup is built here.
//
// Consumes ONLY the column API (src/column.js) and the zone/format helpers
// re-exported by src/depthprofile.js:
//   column.setDepth(m, { source })  — commanded depth; the COLUMN owns the
//                                     easing (critically damped + flank cap),
//                                     so every interaction here is a set-point
//                                     write and never a position write.
//   column.nudge(dm, { source })    — relative (wheel / arrow keys)
//   column.depth()                  — the eased, live depth: what the NEEDLE
//                                     and the readout show
//   column.targetDepth()            — the commanded depth: the set-point bug
//   column.range()                  — { min, max, surface, seabed, span };
//                                     SHARED object, read immediately
//   formatDepthM(m)                 — "643 m"
//
// v3.5 — THE PHYSICS READOUT. The gauge stopped being "a number and a mood
// word" and became the dive console's instrument stack: metres, zone (both
// names), pressure, temperature, light remaining, and one rotating fact about
// the zone you are in. Everything below the metre value is either exact
// physics or a SOURCED figure read through ../oceandata.js — nothing here is
// authored, estimated, or interpolated.
//
//   PRESSURE is computed, not looked up: 1 atm of atmosphere plus 1 atm per
//     10 m of seawater. It is the only figure on the instrument that is exact
//     at the current depth, and the only one that needs no citation.
//
//   TEMPERATURE and LIGHT come from oceandata's anchor tables, which are
//     deliberately full of nulls: no source gives a global mean temperature at
//     exactly 200 m, and none gives a light percentage below 100 m. The three
//     rules this module obeys, in order of how easy they are to break:
//
//     1. A NULL IS NEVER RENDERED. temperatureLabel()/lightLabel() return null
//        where the data is nulled and the line is then OMITTED — not zeroed,
//        not "unknown", not "n/a". This is visible in the running app: dive
//        past 200 m and the temperature READING DISAPPEARS, because no source
//        supports one between 200 and 1000 m. That gap is the feature.
//     2. A RANGE IS SHOWN AS A RANGE. Below 1000 m the sources disagree
//        (Britannica ~2 °C, the bathypelagic literature ~4 °C), so the data
//        carries rangeC [2,4] and the gauge prints "2–4 °C". It is never
//        collapsed to a midpoint.
//     3. AN ANCHOR IS NOT A LOCAL READING. These tables are step functions:
//        the 16%-of-surface-light figure is measured AT 10 m, and at 60 m the
//        true value is far lower. So every sourced figure is printed WITH THE
//        DEPTH IT BELONGS TO ("16% of surface light at 10 m", "17 °C" +
//        "surface mean", "2–4 °C" + "below 1000 m" — the caveat is a separate,
//        dimmer span so it can never read as part of the value). Nothing is
//        interpolated between anchors — the data does not support a curve, so
//        no curve is drawn, and no in-between value is ever invented.
//        Where the source is qualitative (NOAA: "rarely any significant light
//        beyond 200 m") the gauge prints the qualitative statement, which IS
//        true at the current depth, and no number.
//
//   ZONE NAMES now come from oceandata's sourced ZONES table — BOTH of them.
//     The friendly word is the sourced nickname ("Twilight zone" -> twilight)
//     and the proper name is the sourced name with its real extent
//     ("mesopelagic · 200–1000 m"). INTEGRATOR NOTE: this is a deliberate
//     departure from column.js's ZONES, whose boundaries are compressed to fit
//     the 1200 m column (its 'midnight' starts at 600 m; the real bathypelagic
//     starts at 1000 m). Mixing the two would print "midnight · mesopelagic",
//     which is self-contradictory — the mesopelagic IS the twilight zone. The
//     gauge therefore reads real metres against the real table and the scene's
//     atmosphere keeps keying off column.ZONES exactly as it did; only the
//     WORD on the instrument changed. Aligning column.ZONES with the sourced
//     boundaries is a separate, non-gauge change.
//
//   PROVENANCE. The readout looks authoritative, so it says what it is:
//     PROVENANCE_LINE ("curated from public sources") sits under the stack,
//     revealed on hover/focus rather than shouted at rest. The source URLs
//     live in src/data/ocean-data.json with every figure.
//
//   The stats are ambient context about the real ocean. They are not a claim
//   about the dots: nothing here says the procedural creature drifting past is
//   an accurate depiction of anything.
//
// The scale spans the WHOLE column (0 m .. seabed) so the numerals are true
// metres; the slightly inset navigable band (range().min .. .max — the vessel
// can never put the porthole above the waterline or below the floor) is drawn
// as a brighter segment of the same hairline, so the travel stops explain
// themselves without a word of copy.
//
// Contracts honoured:
//   * no per-frame allocation on the engine's path, and none of its own while
//     the vessel is parked: the rAF mirror reads numbers, and touches the DOM
//     only when a value actually moved (position past a sub-metre threshold,
//     text only when the ROUNDED metre changes). Nothing here allocates
//     objects or typed arrays; getBoundingClientRect is called on pointer
//     events only, never in the loop.
//     v3.5 keeps that: the whole readout is rebuilt only inside the same
//     "the rounded metre changed" branch, and inside it the zone / temperature
//     / light anchors are compared BY REFERENCE against the frozen table
//     entries oceandata returns, so a metre of drift inside one zone costs
//     three identity tests and zero strings. The fact timer accumulates the
//     rAF timestamp into a number and writes the DOM only on a text swap or an
//     opacity-class flip.
//   * no engine coupling — this module never touches the scene, the clock or
//     the sim; its private rAF loop only mirrors column state into the DOM.
//     The fact timer is driven by the rAF timestamp argument, never by
//     Date.now(), performance.now() or engine.clock.
//   * determinism — the gauge holds no state of its own that the board depends
//     on; the column (and therefore the URL hash) is the only owner of depth.
//     The one time-varying thing v3.5 adds (which fact is showing) is frozen
//     while body.ambient is set, i.e. in exactly the state the determinism
//     screenshots are taken in — and the chrome is invisible there anyway.
//   * offline — ocean data is imported, never fetched. vite inlines
//     src/data/ocean-data.json into the single-file build.

import { formatDepthM, SEABED_DEPTH_M, METRES_PER_PX, WHEEL_GAIN } from '../depthprofile.js';
import {
  zoneAt as oceanZoneAt,
  temperatureAt,
  temperatureLabel,
  lightAt as lightAnchorAt,
  lightLabel,
  PROVENANCE_LINE,
} from '../oceandata.js';

// ---- scale ---------------------------------------------------------------
const MAJOR_M = 200; // major graduation (numeral) — also the zone boundaries
const MINOR_M = 50; // minor graduation between them

// ---- the physics readout (v3.5) ------------------------------------------
// Pressure at depth: one atmosphere of air on the surface, plus one more for
// every ~10 m of seawater. This is the standard hydrostatic approximation —
// the same one the sourced bathypelagic fact uses when it says "pressure runs
// from roughly 100 to 400 atmospheres" — so the instrument and the fact line
// can never contradict each other. Exact, computed, uncited on purpose.
const ATM_PER_M = 1 / 10;

/** "1", "1.5", "44", "121" — one decimal only while the figure is small
 *  enough for it to mean something (below 10 atm, i.e. the top 90 m). */
function formatAtm(m) {
  const atm = 1 + Math.max(m, 0) * ATM_PER_M;
  if (atm >= 10) return String(Math.round(atm));
  const s = atm.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Where a light anchor's percentage is NULL, the source is qualitative rather
// than absent — and unlike a percentage, a qualitative statement is true at
// every depth below its anchor, so it can be printed as-is at the current
// depth. These are compressions of the sourced notes in ocean-data.json, not
// new claims:
//   200 m  note: "Under 1% remains; NOAA states there is rarely any
//                 significant light beyond 200 m."
//                 (oceanservice.noaa.gov/facts/light_travel.html)
//   1000 m note: "Effectively zero; 1000 m is the deepest sunlight reaches
//                 under the best conditions." + precision: "Below 1000 m is
//                 the aphotic zone, where no sunlight penetrates."
//                 (oceanexplorer.noaa.gov/ocean-fact/light-distributed/)
// A depth with no entry here and no percentage prints NOTHING.
const LIGHT_QUALITATIVE = Object.freeze({
  200: 'rarely any significant light beyond 200 m',
  1000: 'no sunlight below 1000 m',
});

// ---- the zone fact line --------------------------------------------------
// Brief, dim, and transient: it fades in when you arrive in a new zone, holds,
// then fades out; while the instrument is awake (hover/focus/drag) it stays up
// and rotates slowly through that zone's sourced facts. At rest in a zone you
// have been sitting in, the gauge is metres + zone + physics and nothing else.
const FACT_REVEAL_MS = 11000; // how long an arrival keeps the fact up
// Deliberately LONGER than the reveal window: an arrival shows exactly one
// fact and then goes quiet — the turnover is for someone who is holding the
// instrument open, not for someone who just swam past a boundary.
const FACT_ROTATE_MS = 12000;
const FACT_FADE_MS = 620; // must be >= the CSS opacity transition
const MAX_FRAME_MS = 100; // a backgrounded tab must not fast-forward the fact

// ---- navigation gains ----------------------------------------------------
// Wheel over the gauge must feel EXACTLY like the wheel over the water, or the
// instrument and the porthole disagree about what a scroll means. The gain is
// column.js's own WHEEL_GAIN (world px of dive per wheel px) — imported, not
// mirrored, so the two can never drift apart — converted to metres here.
const WHEEL_M_PER_PX = WHEEL_GAIN * METRES_PER_PX;
const KEY_STEP_M = 25; // arrow key: a fine trim
const PAGE_STEP_M = MAJOR_M; // PageUp/PageDown: exactly one graduation

// ---- repaint thresholds (the "don't touch the DOM" guards) ---------------
const POS_EPS = 0.02; // % of the column — below this the needle hasn't moved
const TARGET_EPS_M = 3; // set-point bug appears once the vessel is this far off

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Mount the depth gauge.
 *
 * @param {object} column - the createColumn() instance (src/column.js)
 * @param {object} [opts]
 *   mount    parent element (default: document.body)
 * @returns {{ el: HTMLElement|null, depth(): number, readout(): object,
 *             dispose(): void }}
 */
export function initDepthGauge(column, opts = {}) {
  // Model-less boot (spike scenes never mount chrome): stay inert rather than
  // throwing into the integrator's boot path.
  if (!column || typeof column.setDepth !== 'function') {
    return { el: null, depth: () => 0, dispose() {} };
  }

  const stale = document.getElementById('depthgauge');
  if (stale) stale.remove();

  const parent = opts.mount || document.body;
  const span = SEABED_DEPTH_M || 1;
  const pct = (m) => clamp01(m / span) * 100;

  // ---- markup ------------------------------------------------------------
  const el = document.createElement('div');
  el.id = 'depthgauge';

  // numerals live LEFT of the hairline; the readout rides RIGHT of it, so the
  // two never collide as the needle sweeps the scale
  const scale = document.createElement('div');
  scale.className = 'dg-scale';

  const colEl = document.createElement('div');
  colEl.className = 'dg-column';
  colEl.tabIndex = 0;
  colEl.setAttribute('role', 'slider');
  colEl.setAttribute('aria-label', 'depth');
  colEl.setAttribute('aria-orientation', 'vertical');
  colEl.setAttribute('aria-valuemin', '0');
  colEl.setAttribute('aria-valuemax', String(Math.round(span)));

  // the reachable segment of the hairline (range().min .. .max)
  const reach = document.createElement('div');
  reach.className = 'dg-reach';
  colEl.appendChild(reach);

  // graduations + numerals — positioned in PERCENT, so a viewport resize
  // re-lays the whole scale with no JS and no reflow storm
  for (let m = 0; m <= span + 0.001; m += MINOR_M) {
    const major = Math.abs(m % MAJOR_M) < 0.001;
    const t = document.createElement('i');
    t.className = major ? 'dg-tick major' : 'dg-tick';
    t.style.top = pct(m).toFixed(4) + '%';
    colEl.appendChild(t);
    if (!major) continue;
    const n = document.createElement('i');
    n.className = 'dg-num';
    n.textContent = String(Math.round(m));
    n.style.top = pct(m).toFixed(4) + '%';
    scale.appendChild(n);
  }

  // the commanded-depth bug (a set-point marker: where the vessel is HEADED)
  const bug = document.createElement('i');
  bug.className = 'dg-bug';
  colEl.appendChild(bug);

  // the needle: the plate's 2x10px amber gauge needle, laid on its side
  const needle = document.createElement('i');
  needle.className = 'dg-needle';
  colEl.appendChild(needle);

  // ---- the readout stack ------------------------------------------------
  // The METRE LINE rides the needle (the needle points at the number, not at
  // the middle of a block), and the rest of the instrument hangs beneath it.
  // The four lines here are NOWRAP and always present — a missing figure
  // shortens a line, it never removes one — and everything that can wrap or
  // vanish lives in .dg-note, which is absolutely positioned at top:100%. Net
  // effect: nothing that happens further down the stack can ever move the
  // depth reading.
  const read = document.createElement('div');
  read.className = 'dg-read';
  const value = document.createElement('span');
  value.className = 'dg-value';
  const zone = document.createElement('span'); // friendly name: "twilight"
  zone.className = 'dg-zone';
  const zoneSci = document.createElement('span'); // "mesopelagic · 200–1000 m"
  zoneSci.className = 'dg-zone-sci';
  // "44 atm · 2–4 °C" + the dimmer caveat that says which depth the sourced
  // figure belongs to. Two spans, because the caveat must never read as part
  // of the value.
  const phys = document.createElement('span');
  phys.className = 'dg-phys';
  const physVal = document.createElement('span');
  const physQual = document.createElement('span');
  physQual.className = 'dg-phys-qual';
  phys.append(physVal, physQual);

  const note = document.createElement('div');
  note.className = 'dg-note';
  const light = document.createElement('span'); // sourced, or absent entirely
  light.className = 'dg-light';
  const fact = document.createElement('span');
  fact.className = 'dg-fact';
  const prov = document.createElement('span');
  prov.className = 'dg-prov';
  prov.textContent = PROVENANCE_LINE; // "curated from public sources"
  note.append(light, fact, prov);
  read.append(value, zone, zoneSci, phys, note);

  el.append(scale, colEl, read);
  parent.appendChild(el);

  // ---- interaction -------------------------------------------------------
  // Every gesture writes a SET-POINT. The column eases to it; the needle
  // follows the column. Nothing here ever positions the vessel directly.

  let dragging = false;

  function metresAt(clientY) {
    const r = colEl.getBoundingClientRect(); // pointer events only, never rAF
    return clamp01((clientY - r.top) / Math.max(r.height, 1)) * span;
  }

  function travel(clientY) {
    column.setDepth(metresAt(clientY), { source: 'gauge' });
  }

  const onPointerDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation(); // never reads as an empty-water deselect click
    dragging = true;
    el.classList.add('awake');
    colEl.classList.add('dragging');
    try {
      colEl.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety; the move listener still works without it */
    }
    travel(ev.clientY); // click anywhere on the column = travel there
  };
  const onPointerMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    travel(ev.clientY); // drag the needle
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    colEl.classList.remove('dragging');
    if (!colEl.matches(':hover') && document.activeElement !== colEl) {
      el.classList.remove('awake');
    }
  };
  colEl.addEventListener('pointerdown', onPointerDown);
  colEl.addEventListener('pointermove', onPointerMove);
  colEl.addEventListener('pointerup', endDrag);
  colEl.addEventListener('pointercancel', endDrag);

  // wheel over the gauge — same gain as the wheel over the water
  const onWheel = (ev) => {
    ev.preventDefault(); // a dive control, not a scrollbar
    ev.stopPropagation();
    let px = ev.deltaY;
    if (ev.deltaMode === 1) px *= 16;
    else if (ev.deltaMode === 2) px *= window.innerHeight || 540;
    column.nudge(px * WHEEL_M_PER_PX, { source: 'gauge' });
  };
  colEl.addEventListener('wheel', onWheel, { passive: false });

  // arrow keys when focused. Handled keys are stopped here so column.js's own
  // window-level bindings don't apply the SAME step a second time; everything
  // else (Escape, typing) is left to bubble untouched.
  const onKey = (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const r = column.range();
    const lo = r.min;
    const hi = r.max;
    switch (ev.key) {
      case 'ArrowDown':
        column.nudge(KEY_STEP_M, { source: 'gauge' });
        break;
      case 'ArrowUp':
        column.nudge(-KEY_STEP_M, { source: 'gauge' });
        break;
      case 'PageDown':
        column.nudge(PAGE_STEP_M, { source: 'gauge' });
        break;
      case 'PageUp':
        column.nudge(-PAGE_STEP_M, { source: 'gauge' });
        break;
      case 'Home':
        column.setDepth(lo, { source: 'gauge' });
        break;
      case 'End':
        column.setDepth(hi, { source: 'gauge' });
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  };
  colEl.addEventListener('keydown', onKey);

  // hover / focus lifts the scale out of the water (150-200ms, per the design)
  const wake = () => el.classList.add('awake');
  const rest = () => {
    if (!dragging && document.activeElement !== colEl) el.classList.remove('awake');
  };
  colEl.addEventListener('pointerenter', wake);
  colEl.addEventListener('pointerleave', rest);
  colEl.addEventListener('focus', wake);
  colEl.addEventListener('blur', rest);

  // ---- the live read (private rAF mirror; allocation-free at rest) --------
  let lastPos = -1e9; // % — needle + readout position
  let lastBug = -1e9; // % — set-point bug
  let lastBugOn = null;
  let lastM = -1e9; // rounded metres (drives every string we build)
  let lastZone = '';
  let lastZoneProper = '';
  let lastLo = -1e9;
  let lastHi = -1e9;

  // v3.5 readout memo. Anchors are compared BY REFERENCE (oceandata returns
  // frozen table entries, never fresh objects), so crossing no boundary costs
  // one identity test and builds no string.
  let lastZoneRec = null;
  let lastTempRec = undefined;
  let lastLightRec = undefined;
  let lastAtmStr = '';
  let tempStr = ''; // "2–4 °C", or '' where the data is nulled
  let tempQual = ''; // "below 1000 m" / "surface mean" — never part of the value
  let lightStr = ''; // the sourced light line, or '' where nothing is sourced
  let lastTempShown = null; // the tempStr already composed into the line

  /** The sourced temperature figure, or '' when the data nulls both the point
   *  value and the range (200-1000 m). Never a midpoint, never an
   *  interpolation, never a placeholder. Sets `tempQual` alongside. */
  function buildTemp(t) {
    tempQual = '';
    if (!t) return '';
    const v = temperatureLabel(t); // "17 °C" / "2–4 °C" / null
    if (!v) return ''; // rule 1 — the row is omitted, not filled
    // rule 3 — an anchor is not a local reading, so say where it is from.
    // depth 0 is a global mean of the sea SURFACE, which is a different kind
    // of caveat from "the water below this line", so it gets its own words.
    tempQual = t.depthM === 0 ? 'surface mean' : 'below ' + t.depthM + ' m';
    return v;
  }

  /** The sourced light remaining, or '' where nothing is sourced (above 10 m
   *  the tables simply do not start yet — so the gauge says nothing). */
  function buildLight(l) {
    if (!l) return '';
    const pctLabel = lightLabel(l); // "16% of surface light" / null
    if (pctLabel) return pctLabel + ' at ' + l.depthM + ' m';
    return LIGHT_QUALITATIVE[l.depthM] || '';
  }

  /** "twilight" from the sourced nickname "Twilight zone". */
  function friendlyZone(z) {
    return String(z.nickname || z.name || '')
      .replace(/\s+zone$/i, '')
      .toLowerCase();
  }

  /** "mesopelagic" — the sourced proper name, minus the redundant "zone". */
  function properZoneName(z) {
    return String(z.name || '').replace(/\s+zone$/i, '').toLowerCase();
  }

  /** "mesopelagic · 200–1000 m" — the proper name AND the zone's real extent,
   *  which is also the quietest way to admit that this 1200 m column is a
   *  slice of a zone that keeps going for another 3 km. */
  function properZone(z) {
    const name = properZoneName(z);
    if (!Number.isFinite(z.depthMinM) || !Number.isFinite(z.depthMaxM)) return name;
    return name + ' · ' + z.depthMinM + '–' + z.depthMaxM + ' m';
  }

  // Every ocean-data read is wrapped: a data problem must degrade the readout,
  // never take the dive control down with it.
  function readOcean(m) {
    let z = null;
    let t = null;
    let l = null;
    try {
      z = oceanZoneAt(m) || null;
      t = temperatureAt(m) || null;
      l = lightAnchorAt(m) || null;
    } catch {
      /* leave whatever resolved; the lines below simply stay empty */
    }
    if (z !== lastZoneRec) {
      lastZoneRec = z;
      zone.textContent = z ? friendlyZone(z) : '';
      zoneSci.textContent = z ? properZone(z) : '';
      lastZone = zone.textContent;
      // the spoken form drops the "· 200–1000 m" tail — a screen reader should
      // hear a name, not a typographic separator
      lastZoneProper = z ? properZoneName(z) : '';
      setZoneFacts(z);
    }
    if (t !== lastTempRec) {
      lastTempRec = t;
      tempStr = buildTemp(t);
      // NOTE for whoever is tempted to add a `title` tooltip here: the whole
      // readout is pointer-events:none (the water has to stay clickable behind
      // it — see the v3.4 HIT AREA rule), so a native tooltip on these lines
      // can never fire. Everything the reader needs is either on the face or
      // in the aria-valuetext below; the full sourced sentences and the source
      // URLs live in src/data/ocean-data.json.
    }
    if (l !== lastLightRec) {
      lastLightRec = l;
      lightStr = buildLight(l);
      light.textContent = lightStr;
      light.classList.toggle('off', lightStr === ''); // display:none, not "0%"
    }
  }

  // ---- the fact line -----------------------------------------------------
  // A tiny state machine, driven off the rAF timestamp (no Date.now(), no
  // performance.now(), no engine clock — this is chrome, not sim, and it holds
  // no state the board depends on). It allocates nothing per frame: the fact
  // strings are the frozen ones from the data file, and the only DOM writes
  // happen on a text swap or an opacity-class flip.
  let zoneFacts = null; // the sourced facts array for the current zone
  let factIdx = 0;
  let factTurn = 0; // monotonic across zones, so re-entering one varies the fact
  let factShown = ''; // what is in the DOM right now
  let factWant = ''; // what should be
  let factLit = false;
  let factClock = 0; // ms the current fact has been up
  let swapWait = 0; // ms left of a fade-out before the text is exchanged
  let revealMs = 0; // ms left of the post-arrival reveal window
  let lastTs = 0;

  function setZoneFacts(z) {
    zoneFacts = z && Array.isArray(z.facts) && z.facts.length ? z.facts : null;
    if (zoneFacts) {
      factIdx = factTurn % zoneFacts.length;
      factTurn++;
    } else {
      factIdx = 0;
    }
    factWant = zoneFacts ? zoneFacts[factIdx] : '';
    // arriving in a zone is the one moment the fact earns its place on screen
    revealMs = factWant ? FACT_REVEAL_MS : 0;
  }

  function tickFact(ts) {
    // While the chrome is sunk (State C) the instrument is invisible: freeze
    // rather than rotate facts nobody can see — and, incidentally, keep the
    // ambient-forced determinism shots identical between two loads.
    if (document.body.classList.contains('ambient')) {
      lastTs = ts || 0;
      return;
    }
    let dt = 0;
    if (ts && lastTs) dt = Math.min(Math.max(ts - lastTs, 0), MAX_FRAME_MS);
    if (ts) lastTs = ts;

    if (revealMs > 0) revealMs -= dt;
    const show = revealMs > 0 || el.classList.contains('awake');

    if (swapWait > 0) {
      swapWait -= dt;
      if (swapWait <= 0) {
        swapWait = 0;
        factShown = factWant;
        fact.textContent = factShown;
        factClock = 0;
      }
    } else if (factWant !== factShown) {
      if (factLit) {
        swapWait = FACT_FADE_MS; // fade out, then exchange
      } else {
        factShown = factWant;
        fact.textContent = factShown;
        factClock = 0;
      }
    } else if (show && zoneFacts && zoneFacts.length > 1) {
      factClock += dt;
      if (factClock >= FACT_ROTATE_MS) {
        factIdx = (factIdx + 1) % zoneFacts.length;
        factWant = zoneFacts[factIdx];
      }
    }

    const lit = show && swapWait === 0 && factShown !== '';
    if (lit !== factLit) {
      factLit = lit;
      fact.classList.toggle('lit', lit);
    }
  }

  function paint(ts) {
    const m = column.depth();
    const p = pct(m);
    if (Math.abs(p - lastPos) > POS_EPS) {
      lastPos = p;
      const s = p.toFixed(3) + '%';
      needle.style.top = s;
      read.style.top = s;
    }

    const rounded = Math.round(m);
    if (rounded !== lastM) {
      lastM = rounded;
      value.textContent = formatDepthM(rounded);
      colEl.setAttribute('aria-valuenow', String(rounded));

      // the ROUNDED metre, so the printed depth and the printed zone can never
      // straddle a boundary ("200 m · sunlight" is not a thing this can say)
      readOcean(rounded);

      // pressure — recomputed every metre, restringed only when the printed
      // figure actually changes (once per 10 m below the surface layer)
      const atmStr = formatAtm(rounded);
      if (atmStr !== lastAtmStr || tempStr !== lastTempShown) {
        lastAtmStr = atmStr;
        lastTempShown = tempStr;
        physVal.textContent = tempStr ? atmStr + ' atm · ' + tempStr : atmStr + ' atm';
        physQual.textContent = tempQual;
      }

      // The whole instrument, spoken. A screen reader gets exactly what the
      // face shows and exactly as many figures — including the silences: no
      // temperature is announced between 200 and 1000 m, and no light above
      // 10 m, because none is sourced there.
      colEl.setAttribute(
        'aria-valuetext',
        rounded + ' metres, ' + lastZone + ' zone, ' + lastZoneProper + ', '
          + lastAtmStr + ' atmospheres'
          + (tempStr ? ', ' + tempStr + ' ' + tempQual : '')
          + (lightStr ? ', ' + lightStr : ''),
      );
    }

    tickFact(ts);

    // the set-point bug: only while the vessel is still travelling to it
    const tgt = column.targetDepth();
    const on = Math.abs(tgt - m) > TARGET_EPS_M;
    if (on) {
      const bp = pct(tgt);
      if (Math.abs(bp - lastBug) > POS_EPS) {
        lastBug = bp;
        bug.style.top = bp.toFixed(3) + '%';
      }
    }
    if (on !== lastBugOn) {
      lastBugOn = on;
      bug.style.opacity = on ? '1' : '0';
    }

    // the navigable segment moves when the viewport height changes
    const r = column.range(); // shared object — read now, never retained
    if (r.min !== lastLo || r.max !== lastHi) {
      lastLo = r.min;
      lastHi = r.max;
      const a = pct(r.min);
      reach.style.top = a.toFixed(3) + '%';
      reach.style.height = Math.max(0, pct(r.max) - a).toFixed(3) + '%';
    }
  }

  let raf = 0;
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    paint(ts);
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
    /** What the instrument is reading right now (metres). Test hook. */
    depth: () => column.depth(),
    /**
     * Every line the instrument is currently printing, as strings. Test hook
     * and the integrator's way to assert the honesty rules from outside:
     * `temp` and `light` are '' exactly where the data is nulled, and no
     * assertion should ever expect a number there.
     */
    readout: () => ({
      depth: value.textContent,
      zone: zone.textContent,
      zoneProper: zoneSci.textContent,
      pressure: lastAtmStr ? lastAtmStr + ' atm' : '',
      temp: tempStr,
      tempQualifier: tempQual,
      light: lightStr,
      fact: factLit ? factShown : '',
      provenance: PROVENANCE_LINE,
    }),
    dispose() {
      cancelAnimationFrame(raf);
      if (mo) mo.disconnect();
      colEl.removeEventListener('wheel', onWheel);
      el.remove();
    },
  };

  // Test hook, registered the way ui/ambient.js registers its own (twice, so
  // it survives main.js assigning window.__menagerie after the UI boots).
  const attach = () => {
    const m = (window.__menagerie = window.__menagerie || {});
    const ui = (m.ui = m.ui || {});
    ui.depthGauge = api;
  };
  attach();
  setTimeout(attach, 0);

  return api;
}

export default initDepthGauge;

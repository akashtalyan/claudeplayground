// Adaptive quality governor — Phase F, the F2 degradation ladder
// (technical-assessment.md §4 F2). Measures SMOOTHED REAL frame time (rAF
// wall-clock deltas — this is presentation pacing, not sim time; the
// injectable clock rule is untouched because the deltas are handed in by the
// caller, never read here) and walks the levers strictly IN ORDER, engaging
// each only when every earlier lever is already engaged:
//
//   1. renderScale 1.0 -> 0.65            (pipeline.setRenderScale)
//   2. DPR cap     1.5 -> 1.0             (backing-size path, high-DPR only)
//   3. sprite-size cap down 30%           (x0.7 on the effective app cap)
//   4. density fraction 1.0 -> 0.5        (drawRange over the build-time
//      cross-ring shuffle — RENDER-FRACTION ONLY; build-time dot counts
//      never change: geometry-spec §9 determinism)
//   5. creature cap 14 -> 10              (oldest alive disperse)
//
// Release walks the same ladder in reverse (last engaged, first released).
//
// Hysteresis: engage after ENGAGE_SUSTAIN_MS of rolling-p50 > ENGAGE_MS;
// release after RELEASE_SUSTAIN_MS of rolling-p50 < RELEASE_MS; never more
// than one step (either direction) per STEP_INTERVAL_MS, and the sustain
// timers reset on every step, so the ladder cannot oscillate.
//
// Hard-OFF contract: under ?governor=off or ?fixedstep=1 the governor never
// moves a lever (harness screenshots must never show a degraded scene, and
// under SwiftShader wall-clock frame time would instantly floor every lever).
// When off it still records frame-time telemetry, and telemetry.reason says
// why it is off. Telemetry shape (window.__menagerie.governor):
//   { level, framesMsP50, engaged: [...], off, reason }

export const ENGAGE_MS = 20; // sustained above this -> engage next lever
export const RELEASE_MS = 12; // sustained below this -> release last lever
export const ENGAGE_SUSTAIN_MS = 2000;
export const RELEASE_SUSTAIN_MS = 10000;
export const STEP_INTERVAL_MS = 3000; // one step per 3 s max, both directions

const WINDOW = 48; // rolling p50 window, frames (~0.8 s at 60 fps)
const MIN_SAMPLES = 30; // no decisions until the window is warm
const PAUSE_MS = 250; // a delta this long is a hidden/paused tab, not a slow frame

// Levers in F2 order. `engage`/`release` call the wiring hooks the host
// provides; the governor owns only the ordering and the hysteresis.
const LEVERS = [
  { name: 'renderScale', engage: (h) => h.renderScale(0.65), release: (h) => h.renderScale(1.0) },
  { name: 'dprCap', engage: (h) => h.dprCap(1.0), release: (h) => h.dprCap(1.5) },
  { name: 'spriteCap', engage: (h) => h.spriteCap(0.7), release: (h) => h.spriteCap(1.0) },
  { name: 'density', engage: (h) => h.density(0.5), release: (h) => h.density(1.0) },
  { name: 'creatureCap', engage: (h) => h.creatureCap(10), release: (h) => h.creatureCap(14) },
];

export const LEVER_COUNT = LEVERS.length;

export function createGovernor({ hooks, off = false, reason = null }) {
  const ring = new Float64Array(WINDOW);
  const scratch = new Float64Array(WINDOW);
  let head = 0;
  let count = 0;
  let level = 0;
  let overSince = null; // wall ms when p50 first exceeded ENGAGE_MS
  let underSince = null; // wall ms when p50 first dropped below RELEASE_MS
  let lastStep = null; // wall ms of the last lever move; first tick seeds it
  //                      so boot jank gets a full STEP_INTERVAL_MS of grace

  const telemetry = {
    level: 0,
    framesMsP50: 0,
    engaged: [],
    off: !!off,
    reason: off ? reason : null,
  };

  function p50() {
    const n = count;
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) scratch[i] = ring[i];
    const s = scratch.subarray(0, n).sort();
    return n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // Move to `target` engaged levers, engaging forward / releasing in reverse.
  function stepTo(target, now) {
    while (level < target) {
      LEVERS[level].engage(hooks);
      level++;
    }
    while (level > target) {
      level--;
      LEVERS[level].release(hooks);
    }
    lastStep = now;
    overSince = underSince = null; // fresh sustain after every move
    telemetry.level = level;
    telemetry.engaged = LEVERS.slice(0, level).map((l) => l.name);
  }

  // rawMs: this frame's REAL rAF delta (wall ms). now: current wall ms.
  // Both are handed in by the host's single wall-clock read site.
  function tick(rawMs, now) {
    if (lastStep === null) lastStep = now;
    if (!(rawMs > 0)) return;
    if (rawMs > PAUSE_MS) {
      // hidden tab / debugger pause — not evidence about render cost
      overSince = underSince = null;
      return;
    }
    ring[head] = rawMs;
    head = (head + 1) % WINDOW;
    if (count < WINDOW) count++;
    const med = p50();
    telemetry.framesMsP50 = med;
    if (off) return; // telemetry only — levers never move when off
    if (count < MIN_SAMPLES) return;

    if (med > ENGAGE_MS) {
      underSince = null;
      if (overSince === null) overSince = now;
    } else if (med < RELEASE_MS) {
      overSince = null;
      if (underSince === null) underSince = now;
    } else {
      overSince = underSince = null; // dead band: no pressure either way
    }

    if (now - lastStep < STEP_INTERVAL_MS) return; // one step per 3 s max
    if (overSince !== null && now - overSince >= ENGAGE_SUSTAIN_MS && level < LEVERS.length) {
      stepTo(level + 1, now);
    } else if (underSince !== null && now - underSince >= RELEASE_SUSTAIN_MS && level > 0) {
      stepTo(level - 1, now);
    }
  }

  return {
    telemetry,
    tick,
    // manual override for dev/harness lever verification (bypasses hysteresis
    // AND the off flag — it only ever runs when called explicitly)
    force: (n, now = 0) => stepTo(Math.min(Math.max(n | 0, 0), LEVERS.length), now),
  };
}

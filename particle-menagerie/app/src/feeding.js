// Feeding — SUPERSEDED by click-to-gather (src/gather.js), v3.2.
//
// The Phase E behaviour was: a click on empty water drops one sinking food
// mote and swimmers within 380 px break behaviour and race to it. v3.2 makes
// the click the centrepiece gesture instead — it plants an amber BEACON and
// EVERY swimmer and drifter converges on it from any distance while rooted
// plants lean toward it. That lives in gather.js; this file is now a thin
// back-compat shim so there is exactly ONE implementation, ONE canvas click
// listener and ONE per-creature steering hook in the app.
//
// New code should import initGather from './gather.js' directly. This shim
// exists so an un-rewired main.js keeps working and so the harness's
// __menagerie.feeding.drop() / .getMote() surface (test/run.mjs scenario 13)
// keeps meaning what it meant.
//
// ---------------------------------------------------------------------------
// INTEGRATION (main.js — one import swap and one moved call site):
//
//   import { initGather } from './gather.js';
//   gather = initGather({ scene, canvas, state, getCamDist: () => camDist,
//                         globalUniforms, hitTest: (x, y) => controls.hitTest(x, y),
//                         zRange: [Z_MIN, Z_MAX] });
//   ...
//   frame():   if (gather) gather.update(state.simT, dt);   // was feeding.tick
//
//   Creature.applyMotion(t, dt) {
//     const s = this.spec, o = this.points;
//     if (this.klass === 'legacy') { this.applyDrift(t); return; }
//     const b = this.ctrl.behavior;
//     if (gather && gather.steer(this, t, dt)) return;   // <-- THE ONE call site
//     if (this.klass === 'rooted') { ...unchanged... }   // rooted must stay BELOW it
//     if (b === 'sleep') return this.applySleep(t, dt);  // ...and sleep stays here
//     ...
//   }
//
// The hook must sit ABOVE the rooted branch (that is how plants get their
// lean) and the old `if (feeding && feeding.overrideMotion(...))` line must go
// — calling the hook twice per frame would double-integrate swimmer motion.
// Leaving the sleep check where it is costs nothing: steer() refuses any
// sleeping creature, rooted or not, so sleepers fall through to exactly
// today's path and still never wake.
// ---------------------------------------------------------------------------

import { initGather } from './gather.js';

/**
 * Back-compat wrapper. Same deps as before (`hitTest` included); returns the
 * old shape on top of the gather:
 *   tick(simT, dt)            -> gather.update
 *   overrideMotion(c, t, dt)  -> gather.steer   (now also drives rooted lean)
 *   drop(cssX, cssY)          -> plants the beacon at that screen point
 *   getMote()                 -> { x, y, z, phase } | null, where phase is
 *       'sink'  the beacon is lit and nobody has reached it yet
 *       'burst' at least one creature has reached it this epoch (latched —
 *               the beacon is a summons, so it is NOT consumed away; the
 *               arrival dot-burst still fires per creature)
 *       'fade'  the beacon is retiring and the crowd is easing back
 * Everything else (setPoint/clear/point/info/steer/active) is passed through.
 */
export function initFeeding(deps) {
  const g = initGather(deps);
  return {
    ...g,
    tick: g.update,
    overrideMotion: g.steer,
    drop: (cssX, cssY) => g.setPointFromScreen(cssX, cssY),
    getMote() {
      const p = g.point();
      if (!p) return null;
      const i = g.info();
      return {
        x: p.x,
        y: p.y,
        z: p.z,
        phase: i.phase === 'retire' ? 'fade' : i.fed ? 'burst' : 'sink',
      };
    },
  };
}

export { initGather };

// CPU frame-loop bench — pure node, no browser. Geometry modules are
// three-free by contract, so they import directly.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function runBench({ frames = 200, warmup = 20 } = {}) {
  const { makeEel } = await import('../src/geometry/eel.js');
  const { makeRay } = await import('../src/geometry/ray.js');

  const creatures = [makeEel(1337), makeRay(4242)];
  const bufs = creatures.map((g) => {
    g.init({
      aSize: new Float32Array(g.count),
      aTw: new Float32Array(g.count),
      aRing: new Float32Array(g.count),
    });
    return { g, pos: new Float32Array(g.count * 3), nor: new Float32Array(g.count * 3) };
  });

  const dt = 1 / 60;
  const times = new Float64Array(frames);
  for (let f = -warmup; f < frames; f++) {
    const t = (f + warmup) * dt;
    const t0 = performance.now();
    for (const b of bufs) b.g.updateTargets(t, 1.0, 1.0, b.pos, b.nor);
    const ms = performance.now() - t0;
    if (f >= 0) times[f] = ms;
  }

  const sorted = Array.from(times).sort((a, b) => a - b);
  return {
    frames,
    dots: creatures.reduce((s, g) => s + g.count, 0),
    eelDots: creatures[0].count,
    rayDots: creatures[1].count,
    medianMs: sorted[frames >> 1],
    p90Ms: sorted[Math.floor(frames * 0.9)],
    maxMs: sorted[frames - 1],
  };
}

// Standalone: node bench.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runBench(), null, 2));
}

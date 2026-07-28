// Spine machinery: arc-length reparameterization, rotation-minimizing frames
// (double-reflection), curvature, quantized ring tables.
// Pure math — no three.js; must run in plain node for CPU benchmarking.
// Contract: geometry-spec.md §§1-7. Zero allocation in the per-frame path:
// every array below is preallocated at build time and reused.

export const TAU = Math.PI * 2;
export const KAPPA_R_MAX = 0.7; // spec §5: max κ·ringRadius after sway scaling
export const RING_SHRINK = 0.9; // spec §5: local hard guard r ≤ 0.9/κ

// Quantized ring angles with slow per-ring twist baked in (spec §7), so the
// per-frame dot loop does zero trig (spec §3: ≈1 trig per dot amortized —
// here amortized to build time entirely).
export function makeRingTables(ringCount, dotsPerRing, twistPerRing) {
  const n = ringCount * dotsPerRing;
  const cosT = new Float32Array(n);
  const sinT = new Float32Array(n);
  for (let i = 0; i < ringCount; i++) {
    const tw = twistPerRing * i;
    for (let j = 0; j < dotsPerRing; j++) {
      const a = tw + (j * TAU) / dotsPerRing;
      cosT[i * dotsPerRing + j] = Math.cos(a);
      sinT[i * dotsPerRing + j] = Math.sin(a);
    }
  }
  return { cosT, sinT };
}

// Per-STATION spine state (spec §3): positions, unit tangents, RMF normals/
// binormals, curvature — all Float32Array(stationCount[*3]).
export function createSpine(stationCount, sampleCount = 200) {
  const positions = new Float32Array(stationCount * 3);
  const tangents = new Float32Array(stationCount * 3);
  const normals = new Float32Array(stationCount * 3);
  const binormals = new Float32Array(stationCount * 3);
  const kappa = new Float32Array(stationCount);
  const samp = new Float32Array(sampleCount * 3); // dense curve samples
  const cum = new Float32Array(sampleCount); // prefix-summed arc length

  // curveFn(u01, out, offset) writes one 3D point; seedAngle rotates the
  // deterministic RMF seed frame around the s=0 tangent (spec §2 — from the
  // creature's RNG, never world-up). The seed frame is BUILT ONCE (first
  // update); later updates propagate it temporally — previous frame's s=0
  // normal projected onto the new plane ⊥ T0 — so the frame chain never
  // snaps when a per-frame world-axis choice would flip branches.
  let seeded = false;
  // Stations sit at FIXED arc positions i·bodyLen/(N−1) measured from s=0
  // (spec §6: the body is inextensible — never fractions of the current
  // total curve length, which varies with wave phase).
  function update(curveFn, bodyLen, seedAngle) {
    const sc = stationCount;
    // --- sample ~200 points, prefix-sum lengths (spec §6)
    const invS = 1 / (sampleCount - 1);
    for (let k = 0; k < sampleCount; k++) curveFn(k * invS, samp, k * 3);
    cum[0] = 0;
    let total = 0;
    for (let k = 1; k < sampleCount; k++) {
      const o = k * 3;
      const dx = samp[o] - samp[o - 3];
      const dy = samp[o + 1] - samp[o - 2];
      const dz = samp[o + 2] - samp[o - 1];
      total += Math.sqrt(dx * dx + dy * dy + dz * dz);
      cum[k] = total;
    }
    // --- invert: equal-arc-length stations; tangents by finite difference
    const ds = bodyLen / (sc - 1);
    let k = 1;
    for (let i = 0; i < sc; i++) {
      let s = i * ds;
      if (s > total) s = total;
      while (k < sampleCount - 1 && cum[k] < s) k++;
      const s0 = cum[k - 1];
      const s1 = cum[k];
      const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      const oa = (k - 1) * 3;
      const ob = k * 3;
      const oi = i * 3;
      positions[oi] = samp[oa] + f * (samp[ob] - samp[oa]);
      positions[oi + 1] = samp[oa + 1] + f * (samp[ob + 1] - samp[oa + 1]);
      positions[oi + 2] = samp[oa + 2] + f * (samp[ob + 2] - samp[oa + 2]);
      const ka = k >= 2 ? (k - 2) * 3 : (k - 1) * 3;
      const kb = k < sampleCount - 1 ? (k + 1) * 3 : k * 3;
      let tx = samp[kb] - samp[ka];
      let ty = samp[kb + 1] - samp[ka + 1];
      let tz = samp[kb + 2] - samp[ka + 2];
      const tl = tx * tx + ty * ty + tz * tz;
      if (tl > 1e-20) {
        const il = 1 / Math.sqrt(tl);
        tx *= il;
        ty *= il;
        tz *= il;
      } else if (i > 0) {
        tx = tangents[oi - 3];
        ty = tangents[oi - 2];
        tz = tangents[oi - 1];
      } else {
        tx = 1;
        ty = 0;
        tz = 0;
      }
      tangents[oi] = tx;
      tangents[oi + 1] = ty;
      tangents[oi + 2] = tz;
    }
    // --- seed frame at s=0 (spec §2). First update: unit vector at
    // seedAngle in the plane ⊥ T0 (deterministic, RNG-seeded). Every later
    // update: temporal RMF — project the previous frame's s=0 normal onto
    // the new plane ⊥ T0. Never re-derived from world axes after t=0.
    {
      const tx = tangents[0];
      const ty = tangents[1];
      const tz = tangents[2];
      let ok = false;
      if (seeded) {
        const d = normals[0] * tx + normals[1] * ty + normals[2] * tz;
        const ex = normals[0] - d * tx;
        const ey = normals[1] - d * ty;
        const ez = normals[2] - d * tz;
        const l2 = ex * ex + ey * ey + ez * ez;
        if (l2 > 1e-12) {
          const il = 1 / Math.sqrt(l2);
          normals[0] = ex * il;
          normals[1] = ey * il;
          normals[2] = ez * il;
          ok = true;
        }
      }
      if (!ok) {
        // reference axis least aligned with T0 — used only to build the
        // initial frame (or if the propagated normal ever degenerates)
        let ax = 0;
        let ay = 0;
        let az = 0;
        const at = Math.abs(tx);
        if (at <= Math.abs(ty) && at <= Math.abs(tz)) ax = 1;
        else if (Math.abs(ty) <= Math.abs(tz)) ay = 1;
        else az = 1;
        // e1 = normalize(a − (a·T)T); e2 = T × e1
        const d = ax * tx + ay * ty + az * tz;
        let ex = ax - d * tx;
        let ey = ay - d * ty;
        let ez = az - d * tz;
        const il = 1 / Math.sqrt(ex * ex + ey * ey + ez * ez);
        ex *= il;
        ey *= il;
        ez *= il;
        const fx = ty * ez - tz * ey;
        const fy = tz * ex - tx * ez;
        const fz = tx * ey - ty * ex;
        const ca = Math.cos(seedAngle);
        const sa = Math.sin(seedAngle);
        normals[0] = ca * ex + sa * fx;
        normals[1] = ca * ey + sa * fy;
        normals[2] = ca * ez + sa * fz;
      }
      seeded = true;
      binormals[0] = ty * normals[2] - tz * normals[1];
      binormals[1] = tz * normals[0] - tx * normals[2];
      binormals[2] = tx * normals[1] - ty * normals[0];
    }
    // --- RMF propagation, double-reflection method (spec §2)
    for (let i = 1; i < sc; i++) {
      const o = i * 3;
      const p = o - 3;
      const v1x = positions[o] - positions[p];
      const v1y = positions[o + 1] - positions[p + 1];
      const v1z = positions[o + 2] - positions[p + 2];
      const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
      const tx = tangents[o];
      const ty = tangents[o + 1];
      const tz = tangents[o + 2];
      let rx;
      let ry;
      let rz;
      if (c1 < 1e-16) {
        rx = normals[p];
        ry = normals[p + 1];
        rz = normals[p + 2];
      } else {
        const k1 = 2 / c1;
        const dr = (v1x * normals[p] + v1y * normals[p + 1] + v1z * normals[p + 2]) * k1;
        rx = normals[p] - dr * v1x;
        ry = normals[p + 1] - dr * v1y;
        rz = normals[p + 2] - dr * v1z;
        const dt = (v1x * tangents[p] + v1y * tangents[p + 1] + v1z * tangents[p + 2]) * k1;
        const tLx = tangents[p] - dt * v1x;
        const tLy = tangents[p + 1] - dt * v1y;
        const tLz = tangents[p + 2] - dt * v1z;
        const v2x = tx - tLx;
        const v2y = ty - tLy;
        const v2z = tz - tLz;
        const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
        if (c2 > 1e-16) {
          const k2 = (v2x * rx + v2y * ry + v2z * rz) * (2 / c2);
          rx -= k2 * v2x;
          ry -= k2 * v2y;
          rz -= k2 * v2z;
        }
      }
      // re-orthogonalize against fp drift
      const dd = rx * tx + ry * ty + rz * tz;
      rx -= dd * tx;
      ry -= dd * ty;
      rz -= dd * tz;
      const il = 1 / Math.sqrt(rx * rx + ry * ry + rz * rz);
      normals[o] = rx * il;
      normals[o + 1] = ry * il;
      normals[o + 2] = rz * il;
      binormals[o] = ty * normals[o + 2] - tz * normals[o + 1];
      binormals[o + 1] = tz * normals[o] - tx * normals[o + 2];
      binormals[o + 2] = tx * normals[o + 1] - ty * normals[o];
    }
    // --- curvature κ = |ΔT|/Δs from the same finite differences (spec §5)
    for (let i = 0; i < sc; i++) {
      const ia = (i > 0 ? i - 1 : 0) * 3;
      const ib = (i < sc - 1 ? i + 1 : i) * 3;
      const span = (ib - ia) / 3;
      const dx = tangents[ib] - tangents[ia];
      const dy = tangents[ib + 1] - tangents[ia + 1];
      const dz = tangents[ib + 2] - tangents[ia + 2];
      kappa[i] = span > 0 ? Math.sqrt(dx * dx + dy * dy + dz * dz) / (span * ds) : 0;
    }
    return total;
  }

  // max(κ_i · r_i) over stations, for the global sway clamp (spec §5)
  function maxKappaR(radii) {
    let m = 0;
    for (let i = 0; i < stationCount; i++) {
      const v = kappa[i] * radii[i];
      if (v > m) m = v;
    }
    return m;
  }

  return { stationCount, positions, tangents, normals, binormals, kappa, update, maxKappaR };
}

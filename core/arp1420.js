// SAE ARP1420-style steady-state total-pressure distortion descriptors from a
// rings x rakes probe array. Ring profiles are linearly interpolated (periodic) onto a
// 1-degree grid before low-pressure regions are found, as the practice recommends.
import { RINGS, RAKES, rakeAngle } from './field.js';

// Stability-pressure-ratio loss sensitivities per ring (hub -> tip). These are ASSUMED,
// illustrative coefficients; a real program uses the engine manufacturer's values.
export const SENS = {
  KC: [0.30, 0.35, 0.40, 0.45, 0.50],
  KR: [0.10, 0.08, 0.06, 0.04, 0.02],
};

export function interpRing(values, nGrid = 360) {
  const n = values.length;
  const ang = values.map((_, k) => rakeAngle(k));
  const out = new Float64Array(nGrid);
  for (let g = 0; g < nGrid; g++) {
    const th = (g + 0.5) * 360 / nGrid;
    // find bracketing rakes (periodic)
    let k1 = -1;
    for (let k = 0; k < n; k++) if (ang[k] <= th) k1 = k;
    let a0, a1, v0, v1;
    if (k1 === -1) { a0 = ang[n - 1] - 360; v0 = values[n - 1]; a1 = ang[0]; v1 = values[0]; }
    else if (k1 === n - 1) { a0 = ang[n - 1]; v0 = values[n - 1]; a1 = ang[0] + 360; v1 = values[0]; }
    else { a0 = ang[k1]; v0 = values[k1]; a1 = ang[k1 + 1]; v1 = values[k1 + 1]; }
    const t = (th - a0) / (a1 - a0);
    out[g] = v0 + t * (v1 - v0);
  }
  return out;
}

// Circumferential descriptors for one ring.
export function ringDescriptors(values) {
  const grid = interpRing(values);
  const n = grid.length;
  let pav = 0;
  for (let g = 0; g < n; g++) pav += grid[g];
  pav /= n;
  const below = Array.from(grid, (v) => v < pav);
  const regions = [];
  if (below.every((b) => b)) return { pav, intensity: 0, extent: 0, mpr: 0, regions };
  // start scanning at a point above average so wrapped regions stay contiguous
  let start = below.findIndex((b) => !b);
  if (start < 0) start = 0;
  let cur = null;
  for (let j = 1; j <= n; j++) {
    const g = (start + j) % n;
    if (below[g]) {
      if (!cur) cur = { sum: 0, count: 0, startDeg: g * 360 / n };
      cur.sum += grid[g]; cur.count++;
    } else if (cur) { regions.push(cur); cur = null; }
  }
  if (cur) regions.push(cur);
  if (!regions.length) return { pav, intensity: 0, extent: 0, mpr: 0, regions };
  const regs = regions.map((r) => ({
    intensity: (pav - r.sum / r.count) / pav,
    extent: r.count * 360 / n,
    startDeg: r.startDeg,
  })).filter((r) => r.extent >= 1);
  let num = 0, den = 0, maxProd = 0;
  for (const r of regs) { num += r.intensity * r.extent; den += r.extent; maxProd = Math.max(maxProd, r.intensity * r.extent); }
  const intensity = den > 0 ? num / den : 0;
  const mpr = maxProd > 0 ? num / maxProd : 0;
  const extent = regs.reduce((m, r) => (r.intensity * r.extent > m.p ? { p: r.intensity * r.extent, e: r.extent } : m), { p: -1, e: 0 }).e;
  return { pav, intensity, extent, mpr, regions: regs };
}

// Full descriptor set for a [ring][rake] array of P/P0 means.
export function descriptors(mean) {
  const rings = [];
  for (let i = 0; i < RINGS; i++) rings.push(ringDescriptors(mean[i]));
  let pfav = 0;
  for (const r of rings) pfav += r.pav; // equal-area rings -> simple mean
  pfav /= RINGS;
  let dprs = 0;
  rings.forEach((r, i) => {
    r.radial = (pfav - r.pav) / pfav;
    dprs += SENS.KC[i] * r.intensity + SENS.KR[i] * Math.max(0, r.radial);
  });
  const maxRing = rings.reduce((m, r, i) => (r.intensity > rings[m].intensity ? i : m), 0);
  return { rings, pfav, dprs: 100 * dprs, maxRing };
}

export const PROBES = RINGS * RAKES;

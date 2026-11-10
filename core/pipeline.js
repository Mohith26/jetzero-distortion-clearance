// End-to-end: raw rake points -> probe screening -> descriptors with uncertainty ->
// calibrated GP clearance map -> next-sortie plan. Shared by the page, the data
// script and the backtest so every number comes from the same code.
import { mulberry32, gaussian, simulatePoint, probeField } from './field.js';
import { descriptors } from './arp1420.js';
import { screenProbes, descriptorUncertainty } from './health.js';
import { fitGP, predict, classify, makeGrid, planSortie, cellWeights } from './gp.js';

export const DEFAULT_GUARD = 0.10; // cleared cells keep a 10% margin below the limit
export const DEFAULT_LIMIT = 2.5; // % stability-pressure-ratio loss allocated to inlet distortion (assumed)

export function analyze(points, opts = {}) {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const useHealth = opts.health !== false;
  const screen = useHealth ? screenProbes(points) : { flags: [], recRmse: 0, baselineCount: 0 };
  const cache = opts.cache || new Map();
  const key = useHealth ? JSON.stringify(screen.flags.map((f) => [f.ring, f.rake, f.type, +(f.bias || 0).toFixed(5)])) : 'raw';
  const rows = points.map((p, idx) => {
    const ck = `${key}|${p.id ?? idx}`;
    if (!cache.has(ck)) cache.set(ck, descriptorUncertainty(p, useHealth ? screen.flags : null, screen.recRmse, { seed: 11 + idx, draws: opts.draws }));
    return cache.get(ck);
  });
  const X = points.map((p) => [p.cond.V, p.cond.psi, p.cond.N1]);
  const y = rows.map((r) => r.dprs);
  const noise = rows.map((r) => r.sd * r.sd);
  const groups = points.map((p) => p.day ?? 0);
  const model = fitGP(X, y, noise, opts.hyperGrid, limit, groups);
  const grid = opts.grid || makeGrid();
  const pred = predict(model, grid);
  const guard = opts.guard ?? DEFAULT_GUARD * limit;
  const classes = classify(pred.mu, pred.sp, model.calib.factor, limit, 1.96, guard, pred.sf);
  // Demonstration rule: a cell can only be cleared if a run was flown nearby
  // (wind vector within SUPPORT.kt and power within SUPPORT.n1). Extrapolation can
  // mark a cell as exceeding, never as cleared.
  const support = supportMask(grid, X);
  if (opts.supportRule) for (let i = 0; i < classes.length; i++) if (classes[i] === 0 && !support[i]) classes[i] = 1;
  return { limit, guard, screen, rows, model, grid, pred, classes, support };
}

// Area-weighted shares of the wind-rose envelope (all power settings).
export const SUPPORT = { kt: 6, n1: 10 };
export function supportMask(grid, X) {
  const D2R = Math.PI / 180;
  const xs = X.map(([V, psi, N1]) => [V * Math.cos(psi * D2R), V * Math.sin(psi * D2R), N1]);
  return grid.map(([V, psi, N1]) => {
    const u = V * Math.cos(psi * D2R), w = V * Math.sin(psi * D2R);
    return xs.some(([a, b, n]) => Math.abs(n - N1) <= SUPPORT.n1 && Math.hypot(a - u, b - w) <= SUPPORT.kt);
  });
}

export function summarize(classes, weights) {
  const out = [0, 0, 0];
  classes.forEach((c, i) => { out[c] += weights ? weights[i] : 1 / classes.length; });
  return { cleared: out[0], unresolved: out[1], exceeds: out[2] };
}

// Compare a map to the synthetic truth (only possible in simulation).
// vReach: only score cells at or below the strongest wind tested so far.
export function score(an, truth, weights, vReach = Infinity) {
  const f = an.model.calib.factor, z = 1.96;
  let wrongClear = 0, wrongExceed = 0, covered = 0, err = 0, tot = 0, wcMax = 0;
  const cls = [0, 0, 0];
  for (let i = 0; i < truth.length; i++) {
    if (an.grid[i][0] > vReach) continue;
    const w = weights[i], c = an.classes[i];
    tot += w; cls[c] += w;
    if (c === 0 && truth[i] > an.limit) { wrongClear += w; wcMax = Math.max(wcMax, truth[i] - an.limit); }
    if (c === 2 && truth[i] <= an.limit) wrongExceed += w;
    if (Math.abs(truth[i] - an.pred.mu[i]) <= z * f * an.pred.sp[i]) covered += w;
    err += w * Math.abs(truth[i] - an.pred.mu[i]);
  }
  return { cleared: cls[0] / tot, unresolved: cls[1] / tot, exceeds: cls[2] / tot, wrongClear: wrongClear / tot, wrongExceed: wrongExceed / tot, coverage: covered / tot, mae: err / tot, wcMaxExcess: wcMax };
}
export { cellWeights };

export function truthGrid(grid) {
  return grid.map(([V, psi, N1]) => descriptors(probeField({ V, psi, N1 }).field).dprs);
}

// Conventional matrix: evenly spaced headings (rotated by half a step on alternate
// days) with power settings cycled across runs and days.
export function standardPlan(day, windKt, runs = 8) {
  const out = [];
  const powers = [70, 80, 90, 100];
  const step = 360 / runs, off = (day % 2) * step / 2;
  for (let j = 0; j < runs; j++) out.push({ V: windKt, psi: (j * step + off) % 360, N1: powers[(j + day) % powers.length] });
  return out;
}

// Crosswind test days are scheduled on windy forecasts: 10 kt plus a Weibull (k=2,
// scale 12 kt) excess, capped at the 35 kt test limit. Wind speed is not controllable.
export function windForDay(rng) {
  const u = Math.max(1e-9, rng());
  return Math.min(35, 10 + 12 * Math.sqrt(-Math.log(u)));
}

export function baselineRuns() {
  return [60, 65, 70, 75, 85, 95, 100].map((N1, j) => ({ V: 1.5, psi: (j * 90) % 360, N1 }));
}

export function simulateRuns(runs, rng, day, startId) {
  return runs.map((r, j) => {
    const p = simulatePoint(r, rng);
    p.day = day; p.id = startId + j;
    return p;
  });
}

export { planSortie, gaussian, mulberry32 };

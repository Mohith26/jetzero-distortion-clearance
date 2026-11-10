// Backtest: standard 8-heading sweep vs boundary-targeted planning, on the same
// synthetic world and the same sequence of (uncontrollable) test-day winds.
// Usage: node scripts/backtest.js [seeds=12] [days=8]
import fs from 'node:fs';
import * as P from '../core/pipeline.js';

const SEEDS = +(process.argv[2] || 12), DAYS = +(process.argv[3] || 8), RUNS = +(process.argv[4] || 8);
const grid = (await import('../core/gp.js')).makeGrid();
const W = P.cellWeights(grid);
const truth = P.truthGrid(grid);

function campaign(seed, policy) {
  const health = policy !== 'standard-raw';
  const windRng = P.mulberry32(1000 + seed);      // same winds for both policies
  const measRng = P.mulberry32(5000 + seed);      // same measurement-noise stream
  let pts = P.simulateRuns(P.baselineRuns(), measRng, 0, 0);
  const cache = new Map();
  const daily = [];
  let vMax = 0;
  let an = P.analyze(pts, { grid, cache, health });
  for (let d = 1; d <= DAYS; d++) {
    const wind = P.windForDay(windRng);
    vMax = Math.max(vMax, wind);
    const runs = policy !== 'adaptive'
      ? P.standardPlan(d, wind, RUNS)
      : P.planSortie(an.model, grid, { windKt: wind, runs: RUNS, limit: an.limit, weights: W }).runs.map((r) => ({ V: r.V, psi: r.psi, N1: r.N1 }));
    pts = pts.concat(P.simulateRuns(runs, measRng, d, pts.length));
    an = P.analyze(pts, { grid, cache, health });
    const s = P.score(an, truth, W, Math.floor(vMax / 2.5) * 2.5);
    const sAll = P.score(an, truth, W);
    daily.push({ day: d, wind: +wind.toFixed(1), points: pts.length, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(4)])), calib: +an.model.calib.factor.toFixed(3), unresolvedAll: +sAll.unresolved.toFixed(4), wrongClearAll: +sAll.wrongClear.toFixed(4) });
  }
  return daily;
}

const out = { seeds: SEEDS, days: DAYS, runsPerDay: RUNS, limit: P.DEFAULT_LIMIT, policies: {} };
const t0 = Date.now();
for (const policy of ['standard', 'standard-raw', 'adaptive']) {
  out.policies[policy] = [];
  for (let s = 1; s <= SEEDS; s++) {
    out.policies[policy].push(campaign(s, policy));
    process.stdout.write(`${policy} seed ${s} done (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
}
// mean curves
out.mean = {};
for (const [pol, runs] of Object.entries(out.policies)) {
  out.mean[pol] = [];
  for (let d = 0; d < DAYS; d++) {
    const keys = ['cleared', 'unresolved', 'exceeds', 'wrongClear', 'wrongExceed', 'coverage', 'mae', 'unresolvedAll', 'wrongClearAll', 'wcMaxExcess'];
    const row = { day: d + 1 };
    for (const k of keys) row[k] = +(runs.reduce((a, r) => a + r[d][k], 0) / runs.length).toFixed(4);
    out.mean[pol].push(row);
  }
}
fs.writeFileSync(new URL(`../data/backtest_r${RUNS}.json`, import.meta.url), JSON.stringify(out));
for (const [pol, rows] of Object.entries(out.mean)) console.log(pol, rows.map((r) => `d${r.day} U=${(100 * r.unresolved).toFixed(1)} WC=${(100 * r.wrongClear).toFixed(2)} cov=${(100 * r.coverage).toFixed(0)} mae=${r.mae.toFixed(2)} wcx=${r.wcMaxExcess.toFixed(2)}`).join(' | '));

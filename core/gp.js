// Gaussian-process clearance map over (wind speed, wind azimuth, %N1) with
// leave-one-out conformal calibration and a greedy test-point planner that targets
// the clearance boundary.

const D2R = Math.PI / 180;
export const SPACE = { vMax: 35, n1Min: 60, n1Max: 100 };

// Power-law input warping of %N1 (chosen by marginal likelihood, like Snoek et al.'s
// input warping): g > 1 stretches the high-power end where body boundary-layer
// ingestion switches on quickly.
export function warpN1(n1, g = 1) {
  const t = Math.min(1, Math.max(0, (n1 - SPACE.n1Min) / (SPACE.n1Max - SPACE.n1Min)));
  return g === 1 ? t : Math.pow(t, g);
}

// Inputs are [V kt, psi deg, N1 %]. The kernel works on the wind vector (headwind and
// crosswind components) so that every azimuth coincides at calm, as it does physically.
export function kernel(a, b, h) {
  const ua = a[0] * Math.cos(a[1] * D2R), wa = a[0] * Math.sin(a[1] * D2R);
  const ub = b[0] * Math.cos(b[1] * D2R), wb = b[0] * Math.sin(b[1] * D2R);
  const du = (ua - ub) / SPACE.vMax / h.lu;
  const dw = (wa - wb) / SPACE.vMax / h.lw;
  const dn = (warpN1(a[2], h.g) - warpN1(b[2], h.g)) / h.ln;
  return h.s2 * Math.exp(-0.5 * (du * du + dw * dw + dn * dn));
}

function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 1e-12) return null; L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  return L;
}
function solveL(L, n, b) { const x = Float64Array.from(b); for (let i = 0; i < n; i++) { let s = x[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k]; x[i] = s / L[i * n + i]; } return x; }
function solveLT(L, n, b) { const x = Float64Array.from(b); for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; } return x; }

export const HYPER_GRID = (() => {
  const g_ = [];
  for (const lu of [0.3, 0.55]) for (const lw of [0.08, 0.14, 0.22, 0.35]) for (const ln of [0.1, 0.18, 0.3, 0.5])
    for (const s2 of [1, 2.5, 6]) for (const nug of [0.03, 0.08]) for (const rel of [0, 0.06, 0.12]) for (const g of [1, 3]) g_.push({ lu, lw, ln, s2, nug, rel, g });
  return g_;
})();

// Build a GP model. X: [[V, psi, N1]], y: values, noise: per-point measurement variance.
// priorMean: the value the map reverts to away from data. Using the limit itself means
// an untested condition can never be cleared by extrapolation.
export function buildModel(X, y, noise, h, priorMean = null) {
  const n = X.length;
  const mean = priorMean ?? y.reduce((a, b) => a + b, 0) / n;
  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    const k = kernel(X[i], X[j], h);
    K[i * n + j] = k; K[j * n + i] = k;
  }
  // run-to-run scatter: absolute floor plus a part proportional to the distortion level
  const extra = y.map((v) => h.nug * h.nug + (h.rel * Math.max(0, v)) ** 2);
  for (let i = 0; i < n; i++) K[i * n + i] += noise[i] + extra[i];
  const L = cholesky(K, n);
  if (!L) return null;
  const r = y.map((v) => v - mean);
  const alpha = solveLT(L, n, solveL(L, n, r));
  let logdet = 0; for (let i = 0; i < n; i++) logdet += 2 * Math.log(L[i * n + i]);
  let quad = 0; for (let i = 0; i < n; i++) quad += r[i] * alpha[i];
  const lml = -0.5 * quad - 0.5 * logdet - 0.5 * n * Math.log(2 * Math.PI);
  const medNoise = [...noise].sort((a, b) => a - b)[noise.length >> 1] || 0;
  return { X, y, noise, extra, medNoise, h, n, mean, L, alpha, lml };
}

export function fitGP(X, y, noise, grid = HYPER_GRID, priorMean = null, groups = null) {
  let best = null;
  for (const h of grid) {
    const m = buildModel(X, y, noise, h, priorMean);
    if (m && (!best || m.lml > best.lml)) best = m;
  }
  best.priorMean = priorMean;
  best.calib = groups ? groupCalibration(best, groups) : looCalibration(best);
  return best;
}

// Split-by-day conformal calibration: hold out a whole test day (one wind speed) at a
// time, refit with the same hyperparameters, and score the held-out runs. Grid cells
// sit at untested wind speeds, so this matches how the map is actually used better
// than single-point leave-one-out (which is reported alongside for reference).
export function groupCalibration(model, groups, level = 0.9) {
  const { X, y, noise, h } = model;
  const ids = [...new Set(groups)];
  const scores = [];
  for (const g of ids) {
    const tr = [], te = [];
    groups.forEach((gg, i) => (gg === g ? te : tr).push(i));
    if (te.length === 0 || tr.length < 5) continue;
    const m = buildModel(tr.map((i) => X[i]), tr.map((i) => y[i]), tr.map((i) => noise[i]), h, model.priorMean);
    if (!m) continue;
    const p = predict(m, te.map((i) => X[i]));
    te.forEach((i, t) => {
      const sd = Math.sqrt(p.sf[t] ** 2 + noise[i] + model.extra[i]);
      scores.push(Math.abs(y[i] - p.mu[t]) / sd);
    });
  }
  const loo = looCalibration(model, level);
  if (scores.length < 8) return { ...loo, method: 'leave-one-out (too few days)', looFactor: loo.factor };
  scores.sort((a, b) => a - b);
  const n = scores.length;
  const rank = Math.min(n - 1, Math.ceil((n + 1) * level) - 1);
  const q = scores[rank];
  return { q, factor: Math.max(loo.factor, q / 1.645), scores, method: 'leave-one-day-out', looFactor: loo.factor };
}

// Closed-form leave-one-out residuals; conformal scale so that 90% two-sided intervals
// mu +/- 1.645 * c * sigma hold on held-out points.
export function looCalibration(model, level = 0.9) {
  const { n, L, alpha } = model;
  // diag of K^-1 via column solves
  const diag = new Float64Array(n);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    e.fill(0); e[i] = 1;
    const z = solveL(L, n, e);
    let s = 0; for (let k = 0; k < n; k++) s += z[k] * z[k];
    diag[i] = s;
  }
  const scores = [];
  for (let i = 0; i < n; i++) {
    const resid = alpha[i] / diag[i];       // y_i - mu_{-i}
    const sd = Math.sqrt(1 / diag[i]);      // predictive sd including noise
    scores.push(Math.abs(resid) / sd);
  }
  scores.sort((a, b) => a - b);
  const rank = Math.min(n - 1, Math.ceil((n + 1) * level) - 1);
  const q = scores[rank];
  return { q, factor: Math.max(0.5, q / 1.645), scores };
}

export function runVar(model, mu) {
  const h = model.h, med = model.medNoise || 0;
  return med + h.nug * h.nug + ((h.rel || 0) * Math.max(0, mu)) ** 2;
}

export function predict(model, Xs) {
  const { X, n, h, L, alpha, mean } = model;
  const mu = new Float64Array(Xs.length), sf = new Float64Array(Xs.length);
  const kx = new Float64Array(n);
  for (let s = 0; s < Xs.length; s++) {
    for (let i = 0; i < n; i++) kx[i] = kernel(Xs[s], X[i], h);
    let m = mean; for (let i = 0; i < n; i++) m += kx[i] * alpha[i];
    const v = solveL(L, n, kx);
    let q = 0; for (let i = 0; i < n; i++) q += v[i] * v[i];
    mu[s] = m; sf[s] = Math.sqrt(Math.max(1e-9, h.s2 - q));
  }
  // run-level predictive sd: latent uncertainty plus the fitted run-to-run scatter
  const sp = new Float64Array(Xs.length);
  for (let s = 0; s < Xs.length; s++) sp[s] = Math.sqrt(sf[s] * sf[s] + runVar(model, mu[s]));
  return { mu, sf, sp };
}

export function makeGrid() {
  const g = [];
  for (let V = 0; V <= 35; V += 2.5) for (let psi = 0; psi < 360; psi += 15) for (let N1 = 60; N1 <= 100; N1 += 5) g.push([V, psi, N1]);
  return g;
}
// Area of each cell in the wind-vector plane (annulus sector), normalised to sum to 1
// per power setting. The 24 azimuth copies of the calm cell share one small disc.
export function cellWeights(grid) {
  const w = grid.map(([V]) => (V === 0 ? 0.3125 / 24 : V));
  const per = {};
  grid.forEach(([, , N1], i) => { per[N1] = (per[N1] || 0) + w[i]; });
  const nP = Object.keys(per).length;
  return w.map((x, i) => x / per[grid[i][2]] / nP);
}

// 0 = cleared, 1 = unresolved, 2 = exceeds
// Cleared: 95% of runs at the condition stay below (limit - guard), using the run-level
// predictive sd. Exceeds: the expected distortion is above the limit with 95%
// confidence, using the latent sd. Everything else is unresolved.
export function classify(mu, sp, factor, limit, z = 1.96, guard = 0, sf = sp) {
  const c = new Uint8Array(mu.length);
  for (let i = 0; i < mu.length; i++) {
    c[i] = mu[i] + z * factor * sp[i] < limit - guard ? 0 : mu[i] - z * factor * sf[i] > limit ? 2 : 1;
  }
  return c;
}

function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
export { normCdf };

// Greedy batch planner. Today's wind speed is given (it cannot be chosen); the test
// conductor chooses heading (-> azimuth) and power. Minimises the expected number of
// grid cells whose side of the limit is still in doubt, using exact rank-1 updates of
// the GP posterior covariance (variance updates do not depend on the unseen outcomes).
export function planSortie(model, grid, opts) {
  const { windKt, runs = 8, limit } = opts;
  const wts = opts.weights || cellWeights(grid);
  const factor = model.calib ? model.calib.factor : 1;
  const cands = [];
  for (let psi = 0; psi < 360; psi += 15) for (let N1 = 60; N1 <= 100; N1 += 5) cands.push([windKt, psi, N1]);
  const { X, n, h, L } = model;
  const pg = predict(model, grid);
  // A = L^-1 k(X, grid) and B = L^-1 k(X, cands)
  const Ag = grid.map((g) => solveL(L, n, X.map((x) => kernel(g, x, h))));
  const Ac = cands.map((c) => solveL(L, n, X.map((x) => kernel(c, x, h))));
  // cov(c, g) = k(c,g) - Ac . Ag
  const G = grid.length, C = cands.length;
  const cov = new Float64Array(C * G);
  for (let c = 0; c < C; c++) for (let g = 0; g < G; g++) {
    const kcg = kernel(cands[c], grid[g], h);
    if (kcg < 1e-6 * h.s2) { cov[c * G + g] = 0; continue; }
    let s = 0; const a = Ac[c], b = Ag[g];
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    cov[c * G + g] = kcg - s;
  }
  const ccov = new Float64Array(C * C);
  for (let c = 0; c < C; c++) for (let d = 0; d <= c; d++) {
    let s = 0; const a = Ac[c], b = Ac[d];
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    const v = kernel(cands[c], cands[d], h) - s;
    ccov[c * C + d] = v; ccov[d * C + c] = v;
  }
  const varG = Float64Array.from(pg.sf, (s) => s * s);
  const mu = pg.mu;
  const pc = predict(model, cands);
  const noiseC = Array.from(pc.mu, (m) => runVar(model, m));
  const rv = Array.from(mu, (m) => runVar(model, m));
  const doubt = (g, v) => { const s = factor * Math.sqrt(Math.max(v, 1e-12) + rv[g]); return normCdf(-Math.abs(mu[g] - limit) / s); };
  let current = 0; for (let g = 0; g < G; g++) current += wts[g] * doubt(g, varG[g]);
  const start = current;
  const chosen = [];
  for (let r = 0; r < runs; r++) {
    let best = -1, bestVal = Infinity;
    const explore = opts.explore !== false && r === runs - 1 && runs >= 3;
    if (explore) {
      // one space-filling run per sortie: the candidate with the largest remaining
      // latent variance, so ridges between tested power settings get looked at
      let bv = -1;
      for (let c = 0; c < C; c++) if (ccov[c * C + c] > bv) { bv = ccov[c * C + c]; best = c; }
      const denomE = ccov[best * C + best] + noiseC[best];
      let total = current;
      for (let g = 0; g < G; g++) { const cg = cov[best * G + g]; if (cg !== 0) total += wts[g] * (doubt(g, varG[g] - cg * cg / denomE) - doubt(g, varG[g])); }
      bestVal = total;
    }
    for (let c = 0; c < C && !explore; c++) {
      const denom = ccov[c * C + c] + noiseC[c];
      let total = current;
      for (let g = 0; g < G; g++) {
        const cg = cov[c * G + g];
        if (cg === 0) continue;
        total += wts[g] * (doubt(g, varG[g] - cg * cg / denom) - doubt(g, varG[g]));
      }
      if (total < bestVal) { bestVal = total; best = c; }
    }
    const denom = ccov[best * C + best] + noiseC[best];
    // rank-1 update of everything
    const cb = cov.slice(best * G, best * G + G);
    const cc = ccov.slice(best * C, best * C + C);
    for (let g = 0; g < G; g++) varG[g] -= cb[g] * cb[g] / denom;
    for (let c = 0; c < C; c++) {
      for (let g = 0; g < G; g++) cov[c * G + g] -= cc[c] * cb[g] / denom;
      for (let d = 0; d < C; d++) ccov[c * C + d] -= cc[c] * cc[d] / denom;
    }
    chosen.push({ V: windKt, psi: cands[best][1], N1: cands[best][2], doubtAfter: bestVal, gain: current - bestVal, kind: explore ? 'explore' : 'boundary' });
    current = bestVal;
  }
  return { runs: chosen, doubtBefore: start, doubtAfter: current, cells: G };
}

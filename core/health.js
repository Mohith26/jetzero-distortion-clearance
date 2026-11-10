// Probe health screening for a fan-face rake campaign, plus descriptor uncertainty.
import { RINGS, RAKES, mulberry32, gaussian } from './field.js';
import { descriptors } from './arp1420.js';

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); };
const mad = (a) => { const m = median(a); return median(a.map((x) => Math.abs(x - m))) * 1.4826; };

export function isBaseline(pt) { return pt.cond.V < 3 && pt.cond.N1 <= 75; }

// Reconstruct probe (i,k) by radial transfer: across the healthy rakes, regress ring i
// on its radial neighbour ring j (P_i[k] = a + b * P_j[k]), then predict rake k from
// P_j[k]. This carries the shape of a distortion lobe across rings, which plain
// neighbour averaging flattens.
export function reconstruct(mean, i, k, exclude = new Set()) {
  const j = i === RINGS - 1 ? i - 1 : i + 1;
  const xs = [], ys = [];
  for (let kk = 0; kk < RAKES; kk++) {
    if (kk === k || exclude.has(`${i},${kk}`) || exclude.has(`${j},${kk}`)) continue;
    xs.push(mean[j][kk]); ys.push(mean[i][kk]);
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let t = 0; t < n; t++) { sxx += (xs[t] - mx) ** 2; sxy += (xs[t] - mx) * (ys[t] - my); }
  // ridge toward slope 1 (pure offset) when ring j is nearly uniform
  const lam = 4e-6;
  const b = (sxy + lam * 1) / (sxx + lam);
  return my + b * (mean[j][k] - mx);
}

// Screen the whole campaign. Returns flags and corrections.
export function screenProbes(points) {
  const flags = [];
  // 1) Frozen / stuck: temporal SD collapses versus every other probe.
  const sdMed = [];
  for (let i = 0; i < RINGS; i++) for (let k = 0; k < RAKES; k++) sdMed.push({ i, k, v: median(points.map((p) => p.sd[i][k])) });
  const logs = sdMed.map((s) => Math.log(Math.max(s.v, 1e-7)));
  const m0 = median(logs), s0 = mad(logs) || 0.1;
  for (const s of sdMed) {
    const z = (Math.log(Math.max(s.v, 1e-7)) - m0) / s0;
    if (z < -6) flags.push({ ring: s.i, rake: s.k, type: 'stuck', z, medianSd: s.v, action: 'replaced by neighbour reconstruction' });
  }
  const stuck = new Set(flags.map((f) => `${f.ring},${f.rake}`));
  // 2) Calibration offset: on calm baseline runs each ring is uniform, so a healthy
  //    probe reads its ring median.
  const base = points.filter(isBaseline);
  const biases = [];
  for (let i = 0; i < RINGS; i++) for (let k = 0; k < RAKES; k++) {
    if (stuck.has(`${i},${k}`) || base.length < 2) continue;
    const res = base.map((p) => p.mean[i][k] - median(p.mean[i].filter((_, kk) => !stuck.has(`${i},${kk}`))));
    const b = res.reduce((a, c) => a + c, 0) / res.length;
    const sd = Math.sqrt(res.reduce((a, c) => a + (c - b) ** 2, 0) / Math.max(1, res.length - 1));
    biases.push({ i, k, b, se: sd / Math.sqrt(res.length) });
  }
  const spread = mad(biases.map((x) => x.b)) || 1e-4;
  for (const x of biases) {
    const z = x.b / Math.max(spread, x.se);
    if (Math.abs(z) > 6 && Math.abs(x.b) > 0.0015) flags.push({ ring: x.i, rake: x.k, type: 'bias', z, bias: x.b, se: x.se, action: 'offset removed' });
  }
  // 3) Reconstruction accuracy, measured leave-one-out on healthy probes of the same rings.
  const errs = [];
  const flagRings = new Set(flags.filter((f) => f.type === 'stuck').map((f) => f.ring));
  for (const p of points) for (const i of flagRings) for (let k = 0; k < RAKES; k++) {
    if (stuck.has(`${i},${k}`)) continue;
    const corr = applyCorrections(p, flags, false);
    errs.push(reconstruct(corr, i, k, stuck) - corr[i][k]);
  }
  const recRmse = errs.length ? Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length) : 0;
  return { flags, recRmse, baselineCount: base.length };
}

export function applyCorrections(pt, flags, doReconstruct = true) {
  const mean = pt.mean.map((r) => r.slice());
  const stuck = new Set();
  for (const f of flags) {
    if (f.type === 'bias') mean[f.ring][f.rake] -= f.bias;
    if (f.type === 'stuck') stuck.add(`${f.ring},${f.rake}`);
  }
  if (doReconstruct) for (const key of stuck) {
    const [i, k] = key.split(',').map(Number);
    mean[i][k] = reconstruct(mean, i, k, stuck);
  }
  return mean;
}

// Monte Carlo uncertainty of the stability-loss descriptor for one point.
// sources: averaging noise of each probe, per-probe calibration uncertainty, and
// reconstruction error for replaced probes.
export function descriptorUncertainty(pt, flags, recRmse, opts = {}) {
  const draws = opts.draws || 120, calSd = opts.calSd ?? 0.0005, nEff = 30;
  const rng = mulberry32(opts.seed ?? 7);
  const corrected = flags ? applyCorrections(pt, flags) : pt.mean;
  const replaced = new Set((flags || []).filter((f) => f.type === 'stuck').map((f) => `${f.ring},${f.rake}`));
  const base = descriptors(corrected);
  const samples = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    const m = corrected.map((row, i) => row.map((v, k) => {
      const s = replaced.has(`${i},${k}`) ? recRmse : Math.hypot(pt.sd[i][k] / Math.sqrt(nEff), calSd);
      return v + s * gaussian(rng);
    }));
    samples[d] = descriptors(m).dprs;
  }
  let mu = 0; for (const s of samples) mu += s; mu /= draws;
  let v = 0; for (const s of samples) v += (s - mu) ** 2; v /= draws - 1;
  return { dprs: base.dprs, sd: Math.sqrt(v), desc: base, corrected };
}

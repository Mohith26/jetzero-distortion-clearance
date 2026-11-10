import test from 'node:test';
import assert from 'node:assert/strict';
import { RINGS, RAKES, mulberry32, simulatePoint, probeField, FAULTS } from '../core/field.js';
import { ringDescriptors, descriptors } from '../core/arp1420.js';
import { screenProbes, reconstruct } from '../core/health.js';
import { buildModel, fitGP, looCalibration, predict, classify, planSortie, makeGrid } from '../core/gp.js';
import { baselineRuns, standardPlan, simulateRuns, analyze } from '../core/pipeline.js';

test('ARP1420: uniform ring has zero circumferential distortion', () => {
  const d = ringDescriptors(Array(8).fill(0.99));
  assert.equal(d.intensity, 0);
});

test('ARP1420: one low probe gives one region, MPR 1; two opposite lows give MPR ~2', () => {
  const one = ringDescriptors([1, 1, 1, 0.9, 1, 1, 1, 1]);
  assert.equal(one.regions.length, 1);
  assert.ok(Math.abs(one.mpr - 1) < 1e-9);
  assert.ok(one.intensity > 0.02 && one.intensity < 0.1);
  assert.ok(one.extent > 60 && one.extent < 100, `extent ${one.extent}`);
  const two = ringDescriptors([1, 0.9, 1, 1, 1, 0.9, 1, 1]);
  assert.equal(two.regions.length, 2);
  assert.ok(Math.abs(two.mpr - 2) < 0.05);
});

test('ARP1420: deeper deficit raises stability loss', () => {
  const a = descriptors(probeField({ V: 25, psi: 270, N1: 80 }).field).dprs;
  const b = descriptors(probeField({ V: 10, psi: 270, N1: 80 }).field).dprs;
  assert.ok(a > b + 1, `${a} vs ${b}`);
});

function campaign(faults, seed = 3) {
  const rng = mulberry32(seed);
  let pts = baselineRuns().map((r, j) => ({ ...simulatePoint(r, rng, { faults }), day: 0, id: j }));
  for (let d = 1; d <= 3; d++) pts = pts.concat(standardPlan(d, 22, 8).map((r, j) => ({ ...simulatePoint(r, rng, { faults }), day: d, id: pts.length + j })));
  return pts;
}

test('probe screen finds the injected frozen probe and calibration offset', () => {
  const s = screenProbes(campaign(FAULTS));
  const stuck = s.flags.find((f) => f.type === 'stuck');
  const bias = s.flags.find((f) => f.type === 'bias');
  assert.deepEqual([stuck.ring, stuck.rake], [FAULTS[0].ring, FAULTS[0].rake]);
  assert.deepEqual([bias.ring, bias.rake], [FAULTS[1].ring, FAULTS[1].rake]);
  assert.ok(Math.abs(bias.bias - FAULTS[1].value) < 0.0008, `bias ${bias.bias}`);
  assert.equal(s.flags.length, 2);
});

test('probe screen raises no flags on a healthy rake', () => {
  const s = screenProbes(campaign([]));
  assert.equal(s.flags.length, 0, JSON.stringify(s.flags));
});

test('radial-transfer reconstruction recovers a probe inside a distortion lobe', () => {
  for (const c of [{ V: 0, psi: 0, N1: 100 }, { V: 25, psi: 270, N1: 85 }, { V: 20, psi: 150, N1: 95 }]) {
    const f = probeField(c).field;
    const est = reconstruct(f, 4, 3, new Set(['4,3']));
    assert.ok(Math.abs(est - f[4][3]) < 0.004, `${JSON.stringify(c)} ${est} vs ${f[4][3]}`);
  }
});

test('GP closed-form leave-one-out matches brute-force refits', () => {
  const rng = mulberry32(9);
  const X = Array.from({ length: 14 }, () => [rng() * 30, Math.floor(rng() * 24) * 15, 60 + Math.floor(rng() * 9) * 5]);
  const y = X.map(([V, psi, N1]) => 0.05 * V + Math.sin(psi * Math.PI / 180) + (N1 - 80) / 40);
  const noise = X.map(() => 0.01);
  const h = { lu: 0.4, lw: 0.3, ln: 0.4, s2: 1.5, nug: 0.05, rel: 0, g: 1 };
  const m = buildModel(X, y, noise, h, 0.5);
  const loo = looCalibration(m);
  const brute = [];
  for (let i = 0; i < X.length; i++) {
    const keep = X.map((_, j) => j).filter((j) => j !== i);
    const mi = buildModel(keep.map((j) => X[j]), keep.map((j) => y[j]), keep.map((j) => noise[j]), h, 0.5);
    const p = predict(mi, [X[i]]);
    brute.push(Math.abs(y[i] - p.mu[0]) / Math.sqrt(p.sf[0] ** 2 + noise[i] + h.nug ** 2));
  }
  brute.sort((a, b) => a - b);
  brute.forEach((b, i) => assert.ok(Math.abs(b - loo.scores[i]) < 1e-6, `${b} vs ${loo.scores[i]}`));
});

test('prior mean at the limit: far from data is never cleared', () => {
  const X = [[1, 0, 60], [1, 90, 65]], y = [0.1, 0.1];
  const m = fitGP(X, y, [0.001, 0.001], undefined, 2.5);
  const p = predict(m, [[30, 270, 100]]);
  const c = classify(p.mu, p.sp, 1, 2.5, 1.96, 0.25, p.sf);
  assert.equal(c[0], 1);
  assert.ok(Math.abs(p.mu[0] - 2.5) < 0.05);
});

test('planner: chosen run lowers expected doubt, and refitting with it never raises latent variance', () => {
  const pts = campaign(FAULTS, 5);
  const an = analyze(pts);
  const grid = makeGrid().filter((_, i) => i % 7 === 0);
  const plan = planSortie(an.model, grid, { windKt: 20, runs: 1, limit: an.limit, explore: false });
  assert.equal(plan.runs.length, 1);
  assert.ok(plan.doubtAfter <= plan.doubtBefore);
  // latent variance after adding the run does not depend on the outcome; check against a refit
  const r = plan.runs[0];
  const m = an.model;
  const X2 = [...m.X, [r.V, r.psi, r.N1]];
  const muC = predict(m, [[r.V, r.psi, r.N1]]).mu[0];
  const y2 = [...m.y, muC];
  const n2 = [...m.noise, 0];
  // match the planner's noise model for the new run
  const extraNew = m.medNoise;
  n2[n2.length - 1] = extraNew;
  const m2 = buildModel(X2, y2, n2, m.h, m.mean);
  const before = predict(m, grid), after = predict(m2, grid);
  let reduced = 0;
  for (let i = 0; i < grid.length; i++) { assert.ok(after.sf[i] <= before.sf[i] + 1e-9); if (after.sf[i] < before.sf[i] - 1e-6) reduced++; }
  assert.ok(reduced > 0);
});

test('pipeline is deterministic for a seed', () => {
  const a = analyze(campaign(FAULTS, 11)), b = analyze(campaign(FAULTS, 11));
  assert.deepEqual(Array.from(a.classes), Array.from(b.classes));
  assert.equal(a.rows[5].dprs, b.rows[5].dprs);
});

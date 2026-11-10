// Generates the synthetic Jet1 crosswind campaign shown in the demo (seeded).
// Day 0: calm-day static engine runs. Days 1-5: conventional 8-heading matrix on
// windy days. Output: raw per-probe 30 s means and SDs, like a data system export.
import fs from 'node:fs';
import * as P from '../core/pipeline.js';

const SEED = 20261028;
const windRng = P.mulberry32(SEED);
const measRng = P.mulberry32(SEED + 1);
const r5 = (v) => Math.round(v * 1e5) / 1e5;

let pts = P.simulateRuns(P.baselineRuns(), measRng, 0, 0);
const days = [{ day: 0, wind: 1.5, note: 'calm static runs' }];
for (let d = 1; d <= 5; d++) {
  const w = P.windForDay(windRng);
  days.push({ day: d, wind: +w.toFixed(1) });
  pts = pts.concat(P.simulateRuns(P.standardPlan(d, w, 8), measRng, d, pts.length));
}
const forecast = { day: 6, windKt: +P.windForDay(windRng).toFixed(1), fromDeg: 250, runs: 4 };
const start = new Date('2027-03-02T15:00:00Z');
const out = {
  meta: {
    generator: 'scripts/gen_data.js', seed: SEED, synthetic: true,
    probes: '8 rakes x 5 equal-area rings at the fan face (ARP1420 layout)',
    note: 'Synthetic data from core/field.js. Not JetZero or Pratt & Whitney data.',
  },
  days,
  forecast,
  points: pts.map((p, i) => ({
    id: p.id, day: p.day,
    run: `CW-${String(p.day).padStart(2, '0')}-${String(i + 1).padStart(3, '0')}`,
    time: new Date(start.getTime() + p.day * 86400000 + (i % 8) * 1500000).toISOString(),
    cond: { V: +p.cond.V.toFixed(1), psi: p.cond.psi, N1: p.cond.N1 },
    mean: p.mean.map((r) => r.map(r5)),
    sd: p.sd.map((r) => r.map(r5)),
  })),
};
fs.writeFileSync(new URL('../data/campaign.json', import.meta.url), JSON.stringify(out));
console.log('points', out.points.length, 'days', JSON.stringify(days), 'forecast', JSON.stringify(forecast));

// Synthetic fan-face flow model for a top-mounted, semi-buried nacelle in ground crosswind.
// This is the "world" the demo is tested against. It is NOT JetZero data: it is a
// parametric stand-in with the qualitative physics reported for crosswind inlet testing
// (windward-lip separation above a mass-flow-dependent critical crosswind, shielding by
// the neighbouring nacelle, tailwind distortion, and body boundary-layer ingestion at
// high thrust and low airspeed).

export const RINGS = 5;
export const RAKES = 8;
export const HUB = 0.32; // hub-to-tip radius ratio

// Equal-area ring centroids (ARP1420-style 8 rakes x 5 rings = 40 probes).
export function ringRadius(i) {
  return Math.sqrt(HUB * HUB + (1 - HUB * HUB) * (i + 0.5) / RINGS);
}
// Rake angle, degrees clockwise from top dead centre, forward looking aft.
export function rakeAngle(k) {
  return 22.5 + 45 * k;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const D2R = Math.PI / 180;
const softplus = (x) => (x > 30 ? x : Math.log1p(Math.exp(x)));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
function angDiff(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  return Math.abs(d);
}
function lobe(theta, centre, halfWidth) {
  const d = angDiff(theta, centre);
  if (d >= halfWidth) return 0;
  const c = Math.cos((Math.PI / 2) * (d / halfWidth));
  return c * c;
}

// Default model parameters (the "true" installation in the synthetic world).
export const TRUTH = {
  vcrit0: 15.0,      // kt, minimum critical crosswind for windward-lip separation
  vcritCurv: 0.010,  // kt per (%N1)^2 around the worst mass flow
  n1Worst: 80,       // %N1 with the lowest critical crosswind
  inboardShield: 0.6,// crosswind from the inboard side is partly shielded by the other nacelle
  headRelief: 0.15,  // headwind component that offsets effective crosswind
  lipDepth: 0.20,    // max fractional total-pressure loss in the separated sector
  tailOnset: 8,      // kt tailwind before aft-quadrant distortion starts
  tailDepth: 0.05,
  blDepth: 0.065,    // body boundary-layer ingestion depth at high thrust
  blN1: 86,          // %N1 where diverter starts to run out of capacity
};

// Deterministic deficit components at a condition. psi: wind azimuth relative to the
// nose, degrees clockwise (0 = headwind, 90 = from the right/inboard, 270 = from the left/outboard).
export function components(cond, p = TRUTH) {
  const { V, psi, N1 } = cond;
  const c = V * Math.sin(psi * D2R);           // + from right (inboard), - from left (outboard)
  const head = V * Math.cos(psi * D2R);          // + headwind, - tailwind
  const shield = c > 0 ? p.inboardShield : 1.0;
  const vEff = Math.abs(c) * shield - p.headRelief * head;
  const vCrit = p.vcrit0 + p.vcritCurv * (N1 - p.n1Worst) ** 2;
  const s = softplus((vEff - vCrit) / 2.5) * 2.5;
  const flow = 0.6 + 0.4 * (N1 - 60) / 40;
  const lip = p.lipDepth * (1 - Math.exp(-s / 7)) * flow;
  const tail = p.tailDepth * (1 - Math.exp(-Math.max(0, -head - p.tailOnset) / 10)) * flow;
  const bl = p.blDepth * sigmoid((N1 - p.blN1) / 3.5) * Math.exp(-Math.max(0, head) / 25);
  return { lip, lipCentre: c >= 0 ? 90 : 270, tail, bl, vEff, vCrit };
}

// Noise-free fractional total pressure P/P0 at (r, theta) for a condition.
export function pressureAt(r, theta, comp) {
  const span = (r - HUB) / (1 - HUB);
  let p = 1 - 0.003 - 0.004 * (1 - span);
  p -= comp.lip * lobe(theta, comp.lipCentre, 65) * span * span;
  p -= comp.tail * lobe(theta, 0, 80) * (0.5 + 0.5 * span);
  p -= comp.bl * lobe(theta, 180, 70) * Math.pow(span, 1.5);
  return p;
}

// 40-probe noise-free rake values [ring][rake].
export function probeField(cond, p = TRUTH, scale = null) {
  const comp = components(cond, p);
  if (scale) { comp.lip *= scale.lip; comp.tail *= scale.tail; comp.bl *= scale.bl; }
  const out = [];
  for (let i = 0; i < RINGS; i++) {
    const row = [];
    for (let k = 0; k < RAKES; k++) row.push(pressureAt(ringRadius(i), rakeAngle(k), comp));
    out.push(row);
  }
  return { field: out, comp };
}

// Instrument faults present in the synthetic campaign.
export const FAULTS = [
  { ring: 4, rake: 3, type: 'stuck', value: 0.9968, note: 'frozen transducer (reads a constant)' },
  { ring: 3, rake: 6, type: 'bias', value: +0.0045, note: 'calibration offset' },
];

// Simulate one steady-state test point (30 s window). Returns per-probe mean and
// temporal standard deviation, as a data system would report them.
export function simulatePoint(cond, rng, opts = {}) {
  const p = opts.params || TRUTH;
  const faults = opts.faults === undefined ? FAULTS : opts.faults;
  // Run-to-run variability of the separated flow (unsteady onset, gusts).
  const scale = {
    lip: Math.exp(0.10 * gaussian(rng)),
    tail: Math.exp(0.10 * gaussian(rng)),
    bl: Math.exp(0.08 * gaussian(rng)),
  };
  const Vact = Math.max(0, cond.V * (1 + 0.06 * gaussian(rng)));
  const actual = { V: Vact, psi: cond.psi, N1: cond.N1 };
  const { field } = probeField(actual, p, scale);
  const nEff = 30;
  const mean = [], sd = [];
  for (let i = 0; i < RINGS; i++) {
    const mr = [], sr = [];
    for (let k = 0; k < RAKES; k++) {
      const clean = 0.997 - 0.004 * (1 - (ringRadius(i) - HUB) / (1 - HUB));
      const deficit = Math.max(0, clean - field[i][k]);
      const sdt = 0.0018 + 0.30 * deficit;              // separated flow is unsteady
      let m = field[i][k] + (sdt / Math.sqrt(nEff)) * gaussian(rng);
      let s = sdt * (1 + 0.15 * gaussian(rng));
      mr.push(m); sr.push(Math.abs(s));
    }
    mean.push(mr); sd.push(sr);
  }
  for (const f of faults) {
    if (f.type === 'stuck') { mean[f.ring][f.rake] = f.value; sd[f.ring][f.rake] = 0; }
    if (f.type === 'bias') mean[f.ring][f.rake] += f.value;
  }
  return { cond: actual, planned: cond, mean, sd };
}

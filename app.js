import { RINGS, RAKES, HUB, ringRadius, rakeAngle } from './core/field.js';
import { descriptors } from './core/arp1420.js';
import { analyze, summarize, cellWeights, planSortie, DEFAULT_LIMIT } from './core/pipeline.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const pct = (v, d = 1) => `${(100 * v).toFixed(d)}`;
const probeName = (i, k) => `R${i + 1}-K${k + 1}`;

const [campaign, bt4, bt8] = await Promise.all(['data/campaign.json', 'data/backtest_r4.json', 'data/backtest_r8.json'].map((u) => fetch(u).then((r) => r.json())));
const points = campaign.points;
const state = { n1: 90, screen: true, sel: null, plan: null, bt: 8 };

const A = analyze(points, { health: true });   // screened
const B = analyze(points, { health: false });  // raw, as recorded
const W = cellWeights(A.grid);
const cur = () => (state.screen ? A : B);

// default selection: the run whose distortion changes most when probes are screened
let maxD = -1;
points.forEach((p, i) => { const d = Math.abs(A.rows[i].dprs - B.rows[i].dprs); if (d > maxD) { maxD = d; state.sel = i; } });

// ---------- KPIs ----------
function renderKpis() {
  const an = cur();
  const s = summarize(an.classes, W);
  const over = an.rows.filter((r) => r.dprs > an.limit).length;
  const cards = [
    ['Envelope cleared', pct(s.cleared), '%', `95% of runs under ${(an.limit - an.guard).toFixed(2)}%`],
    ['Unresolved', pct(s.unresolved), '%', 'needs more runs'],
    ['Exceeds limit', pct(s.exceeds), '%', `expected loss over ${an.limit}%`],
    ['Runs over limit', `${over}`, `/ ${points.length}`, 'measured ΔPRS'],
    ['Probes flagged', `${A.screen.flags.length}`, '/ 40', state.screen ? 'screening on' : 'screening off: raw values', A.screen.flags.length && !state.screen],
  ];
  $('kpis').innerHTML = cards.map(([l, v, u, sub, alert]) => `<div class="kpi${alert ? ' alert' : ''}"><div class="lab">${l}</div><div class="val">${v}<small>${u}</small></div><div class="sub">${sub}</div></div>`).join('');
  const lastDay = campaign.days[campaign.days.length - 1];
  $('railMeta').innerHTML = `<b>${points.length}</b> steady-state points<br><b>${campaign.days.length}</b> test days (to day ${lastDay.day})<br>Max wind tested <b>${Math.max(...points.map((p) => p.cond.V)).toFixed(1)} kt</b><br>Map calibration ×<b>${an.model.calib.factor.toFixed(2)}</b><br><span style="font-size:12.5px">${an.model.calib.method}</span>`;
}

// ---------- Rose ----------
const RC = { cx: 230, cy: 218, R: 186, vmax: 35 };
const rpos = (V, psi) => { const r = RC.R * V / RC.vmax, a = psi * Math.PI / 180; return [RC.cx + r * Math.sin(a), RC.cy - r * Math.cos(a)]; };
function sector(v0, v1, a0, a1) {
  const [x0, y0] = rpos(v1, a0), [x1, y1] = rpos(v1, a1), [x2, y2] = rpos(v0, a1), [x3, y3] = rpos(v0, a0);
  const r1 = RC.R * v1 / RC.vmax, r0 = RC.R * v0 / RC.vmax;
  if (v0 <= 0) return `M${RC.cx},${RC.cy} L${x0},${y0} A${r1},${r1} 0 0 1 ${x1},${y1} Z`;
  return `M${x0},${y0} A${r1},${r1} 0 0 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 0 ${x3},${y3} Z`;
}
function renderRose() {
  const svg = $('rose'); svg.innerHTML = '';
  const an = cur();
  const fill = ['#6fc8c6', '#e1e1e1', '#ff4400'];
  const g = el('g', {}, svg);
  an.grid.forEach(([V, psi, N1], i) => {
    if (N1 !== state.n1) return;
    const v0 = Math.max(0, V - 1.25), v1 = V + 1.25;
    const p = el('path', { d: sector(v0, v1, psi - 7.5, psi + 7.5), fill: fill[an.classes[i]], stroke: '#fff', 'stroke-width': 0.6 }, g);
    const t = el('title', {}, p); t.textContent = `${V} kt from ${psi}° rel · N1 ${N1}%\nPredicted ΔPRS ${an.pred.mu[i].toFixed(2)} ± ${(1.96 * an.model.calib.factor * an.pred.sp[i]).toFixed(2)} %`;
  });
  // grid rings and spokes
  for (const v of [10, 20, 30]) {
    el('circle', { cx: RC.cx, cy: RC.cy, r: RC.R * v / RC.vmax, fill: 'none', stroke: '#01011f', 'stroke-opacity': 0.18, 'stroke-dasharray': '2 3' }, svg);
    const [x, y] = rpos(v, 0); el('text', { x: x + 4, y: y + 12, 'font-size': 11, fill: '#636464' }, svg).textContent = `${v} kt`;
  }
  for (let a = 0; a < 360; a += 45) { const [x, y] = rpos(36, a); el('line', { x1: RC.cx, y1: RC.cy, x2: x, y2: y, stroke: '#01011f', 'stroke-opacity': 0.1 }, svg); }
  const lab = (t, a, dy = 0, anchor = 'middle') => { const [x, y] = rpos(38.5, a); el('text', { x, y: y + 4 + dy, 'font-size': 11.5, 'font-weight': 600, fill: '#636464', 'text-anchor': anchor, 'letter-spacing': '.06em' }, svg).textContent = t; };
  lab('HEADWIND', 0, 4); lab('TAILWIND', 180, 4);
  lab('FROM RIGHT', 90, -6, 'end'); lab('(INBOARD)', 90, 8, 'end');
  lab('FROM LEFT', 270, -6, 'start'); lab('(OUTBOARD)', 270, 8, 'start');
  // runs at this power
  points.forEach((p, i) => {
    if (Math.abs(p.cond.N1 - state.n1) > 2.5) return;
    const [x, y] = rpos(Math.min(p.cond.V, 35), p.cond.psi);
    const over = an.rows[i].dprs > an.limit;
    const c = el('circle', { cx: x, cy: y, r: i === state.sel ? 6 : 4, fill: over ? '#7a2100' : '#01011f', stroke: '#fff', 'stroke-width': 1.5, style: 'cursor:pointer' }, svg);
    el('title', {}, c).textContent = `${p.run}: ${p.cond.V} kt @ ${p.cond.psi}° · ΔPRS ${an.rows[i].dprs.toFixed(2)}%`;
    c.addEventListener('click', () => select(i));
  });
  if (state.plan) for (const r of state.plan.runs) {
    if (Math.abs(r.N1 - state.n1) > 2.5) continue;
    const [x, y] = rpos(r.V, r.psi); el('circle', { cx: x, cy: y, r: 7, fill: 'none', stroke: '#ff4400', 'stroke-width': 2.2 }, svg);
  }
  // nose glyph
  el('path', { d: `M${RC.cx},${RC.cy - 9} L${RC.cx + 6},${RC.cy + 6} L${RC.cx},${RC.cy + 3} L${RC.cx - 6},${RC.cy + 6} Z`, fill: '#01011f' }, svg);
}

// ---------- Fan face ----------
const STOPS = [[1.0, [248, 249, 251]], [0.975, [255, 218, 204]], [0.95, [255, 105, 51]], [0.925, [205, 55, 0]], [0.90, [122, 33, 0]]];
function color(p) {
  if (p >= STOPS[0][0]) return STOPS[0][1];
  for (let s = 1; s < STOPS.length; s++) if (p >= STOPS[s][0]) { const [p0, c0] = STOPS[s - 1], [p1, c1] = STOPS[s]; const t = (p0 - p) / (p0 - p1); return c0.map((v, j) => v + t * (c1[j] - v)); }
  return STOPS[STOPS.length - 1][1];
}
function sampleFace(mean, r, th) {
  const rr = Array.from({ length: RINGS }, (_, i) => ringRadius(i));
  const ring = (i) => { const vals = mean[i]; let k1 = -1; for (let k = 0; k < RAKES; k++) if (rakeAngle(k) <= th) k1 = k; let a0, a1, v0, v1; if (k1 < 0) { a0 = rakeAngle(RAKES - 1) - 360; v0 = vals[RAKES - 1]; a1 = rakeAngle(0); v1 = vals[0]; } else if (k1 === RAKES - 1) { a0 = rakeAngle(k1); v0 = vals[k1]; a1 = rakeAngle(0) + 360; v1 = vals[0]; } else { a0 = rakeAngle(k1); v0 = vals[k1]; a1 = rakeAngle(k1 + 1); v1 = vals[k1 + 1]; } return v0 + (th - a0) / (a1 - a0) * (v1 - v0); };
  if (r <= rr[0]) return ring(0);
  if (r >= rr[RINGS - 1]) return ring(RINGS - 1);
  let i = 0; while (rr[i + 1] < r) i++;
  const t = (r - rr[i]) / (rr[i + 1] - rr[i]);
  return ring(i) * (1 - t) + ring(i + 1) * t;
}
function renderFace() {
  const an = cur(), i = state.sel, p = points[i];
  const mean = an.rows[i].corrected;
  const cv = $('face'), ctx = cv.getContext('2d'), N = cv.width, c = N / 2, R = N / 2 - 30;
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - c, dy = c - y, r = Math.hypot(dx, dy) / R;
    const o = (y * N + x) * 4;
    if (r > 1 || r < HUB) { img.data[o + 3] = 0; continue; }
    let th = Math.atan2(dx, dy) * 180 / Math.PI; if (th < 0) th += 360;
    const col = color(sampleFace(mean, r, th));
    img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
  }
  ctx.clearRect(0, 0, N, N); ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = '#01011f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.stroke();
  ctx.fillStyle = '#353535'; ctx.beginPath(); ctx.arc(c, c, R * HUB, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '600 20px Titillium Web'; ctx.textAlign = 'center'; ctx.fillText('HUB', c, c + 7);
  const flagged = new Map(A.screen.flags.map((f) => [`${f.ring},${f.rake}`, f]));
  for (let k = 0; k < RAKES; k++) {
    const a = rakeAngle(k) * Math.PI / 180;
    ctx.strokeStyle = 'rgba(1,1,31,.25)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(c + R * HUB * Math.sin(a), c - R * HUB * Math.cos(a)); ctx.lineTo(c + R * Math.sin(a), c - R * Math.cos(a)); ctx.stroke();
    for (let ri = 0; ri < RINGS; ri++) {
      const rr = R * ringRadius(ri), x = c + rr * Math.sin(a), y = c - rr * Math.cos(a);
      const f = flagged.get(`${ri},${k}`);
      ctx.beginPath(); ctx.arc(x, y, f ? 9 : 5, 0, 2 * Math.PI);
      ctx.fillStyle = f ? '#fff' : '#01011f'; ctx.fill();
      if (f) { ctx.lineWidth = 3.5; ctx.strokeStyle = '#ff4400'; ctx.stroke(); }
    }
  }
  ctx.fillStyle = '#636464'; ctx.font = '600 19px Titillium Web';
  ctx.fillText('TOP', c, 22); ctx.fillText('BODY', c, N - 6);
  ctx.textAlign = 'left'; ctx.fillText('IN', N - 26, c + 6); ctx.textAlign = 'right'; ctx.fillText('OUT', 38, c + 6);
  $('faceTitle').textContent = `Fan face · ${p.run}`;
  $('scaleTicks').innerHTML = '';
  // ring table
  const d = an.rows[i].desc;
  const raw = descriptors(p.mean);
  let h = `<tr><th>Ring</th><th>ΔPC/P</th><th>Extent</th><th>MPR</th><th>ΔPR/P</th></tr>`;
  d.rings.forEach((r, ri) => { h += `<tr><td>${ri + 1}${ri === 0 ? ' (hub)' : ri === RINGS - 1 ? ' (tip)' : ''}</td><td>${fmt(r.intensity, 4)}</td><td>${r.extent.toFixed(0)}°</td><td>${fmt(r.mpr, 2)}</td><td>${fmt(r.radial, 4)}</td></tr>`; });
  const over = an.rows[i].dprs > an.limit;
  const diff = state.screen && Math.abs(an.rows[i].dprs - raw.dprs) >= 0.05 ? ` <span class="delta">raw ${raw.dprs.toFixed(2)}</span>` : '';
  h += `<tr class="total"><td colspan="3">${p.cond.V} kt @ ${p.cond.psi}° · N1 ${p.cond.N1}% · ΔPRS</td><td colspan="2">${an.rows[i].dprs.toFixed(2)} ± ${(1.96 * an.rows[i].sd).toFixed(2)} %${diff} <span class="tag ${over ? 'over' : 'ok'}">${over ? 'over' : 'under'}</span></td></tr>`;
  $('ringTable').innerHTML = h;
}

// ---------- Run log ----------
function renderRuns() {
  const an = cur();
  let h = `<tr><th>Run</th><th>Day</th><th class="num">Wind kt</th><th class="num">Azimuth</th><th class="num">%N1</th><th class="num">ΔPRS raw</th><th class="num">ΔPRS screened</th><th class="num">95% ±</th><th>Status</th></tr>`;
  points.forEach((p, i) => {
    const s = A.rows[i].dprs, r = B.rows[i].dprs, v = an.rows[i].dprs;
    const changed = Math.abs(s - r) >= 0.2;
    h += `<tr data-i="${i}" class="${i === state.sel ? 'sel' : ''}"><td>${p.run}</td><td>${p.day}</td><td class="num">${p.cond.V.toFixed(1)}</td><td class="num">${p.cond.psi}°</td><td class="num">${p.cond.N1}</td><td class="num">${r.toFixed(2)}</td><td class="num">${s.toFixed(2)}</td><td class="num">${(1.96 * A.rows[i].sd).toFixed(2)}</td><td>${v > an.limit ? '<span class="tag over">over limit</span>' : '<span class="tag ok">under</span>'}${changed ? ' <span class="tag fix">probe fix</span>' : ''}</td></tr>`;
  });
  $('runTable').innerHTML = h;
  $('runTable').querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => select(+tr.dataset.i)));
}

// ---------- Probe health ----------
function renderHealth() {
  const svg = $('probeGrid'); svg.innerHTML = '';
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const flags = new Map(A.screen.flags.map((f) => [`${f.ring},${f.rake}`, f]));
  const cw = 44, ch = 38, x0 = 56, y0 = 32;
  for (let k = 0; k < RAKES; k++) { el('text', { x: x0 + k * cw + cw / 2, y: 11, 'font-size': 11.5, 'text-anchor': 'middle', fill: '#01011f', 'font-weight': 600 }, svg).textContent = `K${k + 1}`; el('text', { x: x0 + k * cw + cw / 2, y: 24, 'font-size': 10.5, 'text-anchor': 'middle', fill: '#898989' }, svg).textContent = `${rakeAngle(k)}°`; }
  for (let i = 0; i < RINGS; i++) {
    el('text', { x: 0, y: y0 + (RINGS - 1 - i) * ch + ch / 2 + 4, 'font-size': 11.5, fill: '#636464', 'font-weight': 600 }, svg).textContent = `R${i + 1}${i === RINGS - 1 ? ' tip' : i === 0 ? ' hub' : ''}`;
    for (let k = 0; k < RAKES; k++) {
      const sd = med(points.map((p) => p.sd[i][k]));
      const f = flags.get(`${i},${k}`);
      const t = Math.min(1, sd / 0.006);
      const fill = f ? '#ff4400' : `rgb(${Math.round(248 - t * 137)},${Math.round(249 - t * 49)},${Math.round(251 - t * 53)})`;
      const r = el('rect', { x: x0 + k * cw + 1, y: y0 + (RINGS - 1 - i) * ch + 1, width: cw - 2, height: ch - 2, fill }, svg);
      el('title', {}, r).textContent = `${probeName(i, k)} median 30 s SD ${(sd * 100).toFixed(3)}% P0${f ? ` · ${f.type}` : ''}`;
      el('text', { x: x0 + k * cw + cw / 2, y: y0 + (RINGS - 1 - i) * ch + ch / 2 + 4, 'font-size': 11, 'text-anchor': 'middle', fill: f ? '#fff' : '#01011f' }, svg).textContent = (sd * 100).toFixed(2);
    }
  }
  el('text', { x: x0, y: y0 + RINGS * ch + 18, 'font-size': 12, fill: '#636464' }, svg).textContent = 'Median 30 s total-pressure SD per probe, % of P0 (unsteadiness)';
  const allSd = med(points.flatMap((p) => p.sd.flat()));
  const affected = (f) => points.map((p, i) => ({ i, d: A.rows[i].dprs - B.rows[i].dprs })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  const big = affected();
  const items = A.screen.flags.map((f) => {
    const name = `${probeName(f.ring, f.rake)} (${rakeAngle(f.rake)}°, ring ${f.ring + 1})`;
    if (f.type === 'stuck') return `<div class="flag"><b>${name}: frozen transducer</b><div>Median 30 s SD ${(f.medianSd * 100).toFixed(4)}% vs ${(allSd * 100).toFixed(3)}% across the rake (robust z = ${f.z.toFixed(0)}). Replaced by radial-transfer reconstruction from ring ${f.ring} on the same rake; leave-one-out error on healthy ring-${f.ring + 1} probes ${(A.screen.recRmse * 100).toFixed(2)}% P0, carried into every error bar.</div></div>`;
    return `<div class="flag"><b>${name}: calibration offset ${(f.bias * 100 >= 0 ? '+' : '')}${(f.bias * 100).toFixed(2)}% P0</b><div>Measured against its ring on ${A.screen.baselineCount} calm static runs (±${(f.se * 100).toFixed(3)}%, z = ${f.z.toFixed(0)}). Offset removed before descriptors.</div></div>`;
  });
  items.push(`<div class="flag" style="border-left-color:#6fc8c6"><b>Effect on the data</b><div class="eff">Largest change is ${points[big.i].run} (${points[big.i].cond.V} kt @ ${points[big.i].cond.psi}°, N1 ${points[big.i].cond.N1}%): ΔPRS ${B.rows[big.i].dprs.toFixed(2)}% raw vs ${A.rows[big.i].dprs.toFixed(2)}% screened. ${points.filter((p, i) => Math.abs(A.rows[i].dprs - B.rows[i].dprs) >= 0.2).length} of ${points.length} runs move by 0.2 points or more.</div></div>`);
  $('flagList').innerHTML = items.join('');
}

// ---------- Planner ----------
function renderPlan() {
  const an = A;
  const V = +$('fcWind').value, from = +$('fcFrom').value, n = +$('fcRuns').value;
  const plan = planSortie(an.model, an.grid, { windKt: V, runs: n, limit: an.limit, weights: W });
  state.plan = plan;
  const maxGain = Math.max(...plan.runs.map((r) => r.gain));
  const side = (psi) => (psi === 0 ? 'headwind' : psi === 180 ? 'tailwind' : psi < 180 ? `${psi}° from the right` : `${360 - psi}° from the left`);
  $('planOut').innerHTML = plan.runs.map((r, j) => {
    const hdg = ((from - r.psi) % 360 + 360) % 360;
    return `<div class="plan-run"><span class="n">${j + 1}</span><span class="hdg">HDG ${String(Math.round(hdg)).padStart(3, '0')}°</span><span class="why">N1 ${r.N1}% · wind ${side(r.psi)}${r.kind === 'explore' ? ' · coverage run' : ''}</span><div class="gain" style="width:${Math.max(8, 150 * r.gain / maxGain)}px"></div></div>`;
  }).join('') + `<div class="plan-sum">Expected doubtful envelope area: <b>${(100 * plan.doubtBefore).toFixed(2)}%</b> → <b>${(100 * plan.doubtAfter).toFixed(2)}%</b> of the map after these ${n} runs (bar = share of the reduction).</div>`;
  renderRose();
}

// ---------- Backtest ----------
function renderBacktest() {
  const bt = state.bt === 4 ? bt4 : bt8;
  const S = bt.mean.standard, Ad = bt.mean.adaptive, Rw = bt.mean['standard-raw'];
  const last = bt.days - 1;
  $('btLede').innerHTML = `${bt.seeds} simulated campaigns, ${bt.days} windy test days each, ${bt.runsPerDay} runs a day, same winds for every plan. Scored against the synthetic truth inside the wind speeds actually reached. By day ${bt.days} the planner leaves ${pct(Ad[last].unresolved)}% unresolved vs ${pct(S[last].unresolved)}% for a rotating heading matrix, so it is not a big win on its own. Skipping the probe screen is the real risk: raw probes wrongly cleared ${(Rw[last].wrongClear / Math.max(1e-9, S[last].wrongClear)).toFixed(1)}× as much envelope.`;
  const svg = $('btChart'); svg.innerHTML = '';
  const X = (d) => 50 + (d - 1) * (480 / (bt.days - 1)), Y = (v) => 200 - v * 260;
  for (const v of [0, 0.2, 0.4, 0.6]) { el('line', { x1: 50, x2: 530, y1: Y(v), y2: Y(v), stroke: '#555' }, svg); el('text', { x: 40, y: Y(v) + 4, 'font-size': 12, fill: '#898989', 'text-anchor': 'end' }, svg).textContent = `${v * 100}%`; }
  for (let d = 1; d <= bt.days; d++) el('text', { x: X(d), y: 222, 'font-size': 12, fill: '#898989', 'text-anchor': 'middle' }, svg).textContent = `Day ${d}`;
  const line = (rows, color, dash) => { el('polyline', { points: rows.map((r) => `${X(r.day)},${Y(r.unresolved)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-dasharray': dash || '' }, svg); rows.forEach((r) => el('circle', { cx: X(r.day), cy: Y(r.unresolved), r: 3.5, fill: color }, svg)); };
  line(Rw, '#898989', '5 4'); line(S, '#ffffff'); line(Ad, '#6fc8c6');
  const leg = [['Rotating heading matrix', '#fff'], ['Boundary planner', '#6fc8c6'], ['Matrix, raw probes', '#898989']];
  leg.forEach(([t, c], j) => { el('rect', { x: 50 + j * 170, y: 6, width: 14, height: 4, fill: c }, svg); el('text', { x: 70 + j * 170, y: 12, 'font-size': 12.5, fill: '#d7d8d8' }, svg).textContent = t; });
  el('text', { x: 530, y: 30, 'font-size': 12, fill: '#898989', 'text-anchor': 'end' }, svg).textContent = 'Unresolved share of reachable envelope';
  const row = (name, r) => `<tr><td>${name}</td><td>${pct(r.unresolved)}%</td><td>${pct(r.wrongClear, 2)}%</td><td>${pct(r.coverage, 0)}%</td><td>${r.mae.toFixed(2)}</td></tr>`;
  $('btTable').innerHTML = `<table><tr><th>Day ${bt.days} (mean)</th><th>Unresolved</th><th>Wrongly cleared</th><th>95% band coverage</th><th>MAE pts</th></tr>${row('Rotating heading matrix', S[last])}${row('Boundary planner', Ad[last])}${row('Matrix, raw probes', Rw[last])}</table>`;
}

function select(i) { state.sel = i; renderFace(); renderRuns(); renderRose(); }
function renderAll() { renderKpis(); renderRose(); renderFace(); renderRuns(); }

$('n1').addEventListener('input', (e) => { state.n1 = +e.target.value; $('n1Out').textContent = state.n1; renderRose(); });
$('screenToggle').addEventListener('change', (e) => { state.screen = e.target.checked; renderAll(); });
$('planBtn').addEventListener('click', renderPlan);
$('btSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.bt = +b.dataset.r; $('btSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderBacktest(); }));
document.querySelectorAll('.rail a').forEach((a) => a.addEventListener('click', () => { document.querySelectorAll('.rail a').forEach((x) => x.classList.toggle('on', x === a)); }));

$('fcWind').value = campaign.forecast.windKt; $('fcFrom').value = campaign.forecast.fromDeg; $('fcRuns').value = campaign.forecast.runs;
$('heroSub').textContent = `Jet1 Demonstrator · No. 1 engine fan face, 40-probe rake · Crosswind ground runs, days 0–${campaign.days[campaign.days.length - 1].day} · limit ${DEFAULT_LIMIT}% ΔPRS (assumed)`;
state.n1 = points[state.sel].cond.N1; $('n1').value = state.n1; $('n1Out').textContent = state.n1;
renderHealth(); renderAll(); renderPlan(); renderBacktest();
document.fonts.ready.then(() => renderFace());
window.__ready = true;

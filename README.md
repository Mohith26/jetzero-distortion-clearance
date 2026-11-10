# Inlet Distortion Clearance (concept for JetZero's Jet1 crosswind runs)

**Live demo:** https://mohith26.github.io/jetzero-distortion-clearance/

An unofficial concept page for the kind of data reduction JetZero's FAA CLEEN IV work will need: fan-face total-pressure rakes on a top-mounted, semi-buried nacelle, measured during crosswind ground runs. It takes raw 40-probe rake data and:

1. **Screens the rake for bad probes** using only the campaign's own data. Frozen transducers show up as a collapse in 30 s unsteadiness against every other probe. Calibration offsets show up on calm static runs, where each ring should be uniform. A frozen probe is rebuilt by *radial transfer*: across the healthy rakes it regresses its ring on the neighbouring ring, then predicts the missing probe from the neighbour on its own rake. That carries the shape of a distortion lobe, which simple neighbour averaging flattens.
2. **Computes SAE ARP1420-style descriptors** per ring (circumferential intensity, extent, multiple-per-rev, radial intensity) and a stability-pressure-ratio loss (ΔPRS). Error bars come from Monte Carlo over averaging noise, per-probe calibration uncertainty and the measured reconstruction error.
3. **Maps clearance over wind speed, wind azimuth and %N1** with a Gaussian process on the wind vector (so all azimuths coincide at calm). The %N1 input is power-warped, with the warp picked by marginal likelihood. Run-to-run scatter has an absolute part and a part proportional to distortion level. The prior mean sits at the limit, so an untested condition can never be cleared by extrapolation. Intervals are calibrated by split conformal **leaving one whole test day out at a time**, because map cells sit at wind speeds that weren't flown. A cell is *cleared* only if 95% of runs there would stay under the limit minus a 10% margin. It *exceeds* if the expected loss is over the limit with 95% confidence. Anything else is *unresolved*.
4. **Plans the next sortie**: you give it the forecast wind, which can't be scheduled, and it picks headings and power settings. It minimises the expected envelope area whose side of the limit is still in doubt, using exact rank-1 updates of the GP posterior covariance, and it holds back one coverage run per sortie for the point of largest remaining variance.

## Results on the synthetic campaign (all computed by the code in `core/`)

- The screen flags exactly the two planted faults: a frozen probe at ring 5, rake 4 (157.5°) and a +0.45% P0 offset at ring 4, rake 7. It raises no flags on a healthy rake (unit test).
- The frozen probe sits in the body-side boundary-layer lobe. On run CW-02-021 (16 kt from 225°, 100% N1), it made ΔPRS read **1.59%** raw. Screened, the same run reads **2.38% ± 0.27%**, against a noise-free model value of 2.30%. 7 of 47 runs move by 0.2 points or more.
- Backtest (`scripts/backtest.js`): 12 seeded campaigns, 6 windy test days, the same winds for every plan, scored against the synthetic truth inside the wind speeds reached.

| Day 6 mean | Unresolved | Wrongly cleared | 95% band coverage |
|---|---|---|---|
| 8 runs/day, rotating heading matrix | 34.6% | 0.06% | 92% |
| 8 runs/day, boundary planner | 30.5% | 0.09% | 93% |
| 8 runs/day, matrix on raw probes | 32.4% | 0.14% | 92% |
| 4 runs/day, rotating heading matrix | 36.8% | 0.04% | 92% |
| 4 runs/day, boundary planner | 37.3% | 0.06% | 93% |
| 4 runs/day, matrix on raw probes | 33.1% | 0.17% | 89% |

**Honest reading:** the planner is not a big win over a well-designed rotating matrix: it's slightly better at 8 runs/day and even at 4. (An earlier, non-rotating baseline made the planner look much better; I kept the fairer baseline.) The clearer result is about the probe screen. Raw probes make the map look *more* resolved while wrongly clearing about 2-4× as much envelope.

## Run it

```
node --test test/*.test.js     # 10 tests: ARP1420, probe screen, reconstruction, GP LOO vs brute force, planner, determinism
node scripts/gen_data.js        # regenerates data/campaign.json (seed 20261028)
node scripts/backtest.js 12 6 8 # writes data/backtest_r8.json (about 10 s)
node scripts/backtest.js 12 6 4
```

The page is static (HTML/CSS/ES modules, no build step) and computes everything in the browser from `data/campaign.json`.

## Limitations

- **Synthetic world.** `core/field.js` is a parametric stand-in with the qualitative physics: windward-lip separation above a mass-flow-dependent critical crosswind, shielding by the other nacelle, tailwind distortion, and body boundary-layer ingestion at high power and low airspeed. It is not JetZero, Pratt & Whitney or CFD data, and the numbers mean nothing about Jet1.
- **Assumed engine sensitivities.** ΔPRS uses illustrative ring coefficients (KC 0.30-0.50, KR 0.02-0.10) and an assumed 2.5% limit. A real program uses the engine maker's distortion methodology and limits.
- Steady-state only. No time-variant (high-response) distortion, no total-temperature distortion, no fan-exit data.
- The map has a small wrongly-cleared area (0.04-0.09% of the reachable envelope in the backtest), concentrated near the limit. That is why there is a 10% margin, and why real clearance should still be confirmed by flown points.
- Reconstruction assumes the neighbouring ring has the same lobe shape. It is weakest when two lobes with different radial profiles overlap.

## Novelty note

I looked through JetZero's newsroom, press releases (including the Oct 28, 2026 CLEEN IV award), the nTop/NVIDIA NemoClaw workflow write-up, the Applied Dynamics digital-test webinar and careers pages, and found no public distortion-analysis tooling. ARP1420 descriptors themselves are standard practice, and data systems such as NASA's RADD compute them. GP-based adaptive test design has been published for wind tunnels (ICAS 2016) and flight test (Stanford/USAF TPS, 2025). The combination here is the new part: automated rake QA with lobe-preserving reconstruction, propagated into descriptor uncertainty, plus a day-held-out conformal clearance map for crosswind ground runs with an uncontrollable wind.

Unofficial concept demo by Mohith Gajjela. Not affiliated with JetZero. Synthetic data.

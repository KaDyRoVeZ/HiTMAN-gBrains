# Hub dampening: held-out verdict (FAIL)

`search.hub_dampening` failed its sealed held-out evaluation, so the search-side mechanism is not part of this release.
The `hubWeight` helper in `src/core/search/hub-dampening.ts` stays, because the multi-hop chain executor
(`relational-chain.ts`) weights intermediate nodes with it.

The candidate was the frozen build af1225d7b with H = 32, the half degree picked on development seed 1
(`../p2-hub-dampening-dev/`). It ran on sealed hub-world seeds 2 and 3 against two rivals:
- remove: the backlink boost set to 0 (31a792c94);
- cap: backlink and graph-signal factors capped at 1.02 (4e2bd760e).

The bar, all four required:
1. concept nDCG@5 at least +1.0 point, with the 95% CI above 0;
2. better than both rivals on concept;
3. hub-as-answer nDCG@5 no lower than −0.5 point;
4. one-hop recall@5 no lower than −0.5 point.

CIs are paired bootstraps over probes (10,000 draws, seed 42), in points.

| Workload | Concept Δ (H = 32) | H = 32 vs remove | H = 32 vs cap | Hub-as-answer Δ | One-hop R@5 Δ | Failed conditions |
|---|---|---|---|---|---|---|
| seed 2, keyword | +3.3 (+2.5, +4.2) | −3.1 (−4.0, −2.3) | −2.6 (−3.3, −1.9) | −30.6 (−45.0, −16.8) | −5.4 (−9.1, −2.0) | 2, 3, 4 |
| seed 3, keyword | +3.6 (+2.8, +4.5) | −2.8 (−3.6, −2.1) | −2.3 (−2.9, −1.7) | −36.2 (−53.0, −19.9) | −1.0 (−3.8, +1.4) | 2, 3, 4 |
| seed 2, hybrid (valid rows only) | +1.0 (+0.3, +1.9) | +0.4 (−1.2, +2.6) | −0.9 (−1.6, −0.3) | −24.5 (−42.6, −8.2) | +0.3 (−4.6, +5.2) | 1, 2, 3 |
| seed 2, hybrid (no-op rows counted as off) | +0.3 (+0.1, +0.6) | +0.6 (−0.3, +1.6) | −0.5 (−1.2, +0.2) | −24.5 (−42.6, −8.2) | +0.2 (−3.0, +3.5) | 1, 2, 3 |
| seed 3, hybrid (valid rows only) | +1.2 (+0.4, +2.1) | +0.7 (−0.4, +2.4) | −0.3 (−0.5, −0.04) | −10.0 (−20.2, −1.2) | +0.8 (−3.6, +5.1) | 2, 3 |
| seed 3, hybrid (no-op rows counted as off) | +0.35 (+0.1, +0.6) | +0.5 (−0.4, +1.5) | −0.1 (−0.8, +0.5) | −10.0 (−20.2, −1.2) | +0.5 (−2.4, +3.5) | 1, 2, 3 |

On the keyword workloads, dampening lifts concept retrieval, but both rivals lift it more. It also costs between a quarter
and a third of hub-as-answer nDCG@5, against a −0.5 guard.

**All 12 cells ran.** All 12 preregistered cells ran. The seed-3 hybrid candidate and cap cells confirm FAIL:
hub-as-answer −10.0 (−20.2, −1.2), and the capped rival still wins on concept. The full table is in gbrain-evals
[`p2.md`](https://github.com/garrytan/gbrain-evals/blob/48dd47bd8/docs/benchmarks/2026-10-05-heldout-program/p2.md)
(merged in gbrain-evals#81, `48dd47bd8`).

**Hybrid telemetry.** In seed-2 hybrid, 346 of 625 H = 32 probe rows (299 concept, 47 one-hop) carried no hub-dampening
stamp. On those queries the lexical metadata-boost gate skipped the backlink and graph-signal stages, so dampening had
nothing to act on and the ranking equals dampening off. The table reports both treatments: those rows dropped, and those
rows counted as off. Neither changes the verdict.

## Consequence

The ranking stage, the `search.hub_dampening` key, its per-call override, the knobs-hash part, the `hub_degree_shape`
doctor check and the per-row hub weights in explain output are removed. Search ranking is unchanged from master.

`verdict.json` is the custodian's aggregate. The sealed seeds stay in owner custody.

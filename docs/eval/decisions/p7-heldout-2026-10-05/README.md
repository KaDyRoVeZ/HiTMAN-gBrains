# P7 multi-relation query planner: held-out verdict

The custodian (P0) ran the sealed multi-hop set (`multi-hop-paraphrase`, N9 v1)
once on the frozen planner build, under the preregistration in gbrain-evals
(`docs/benchmarks/2026-10-04-p7-multi-hop-planner-preregistration.md`, scored by
`docs/benchmarks/2026-10-04-p7-multi-hop-planner/heldout-verdict.ts`). The
sealed receipts stay with the custodian. Verdict: **pass**, so
`search.relational_planner` defaults on in `balanced` and `tokenmax`.

## Benefit gates

| Gate | Result |
|---|---|
| 1. Sign test, paid paraphrase, cell (a) | 24 questions better, 0 worse, p = 1.2 × 10⁻⁷ |
| 2. Strict all-hit@10 on the five typed families | cell (a) 0 → 27.0%, cell (b, reranker on) 1.1 → 28.1%: +27 points in both |
| 3. Safety | chain answer precision 0.83 (≥ 0.7); edge-evidence correctness 0.85 (≥ 0.8); non-gold pages above the first gold page 3.31 → 0.09; no typed family dropped |
| 4. No hurt | no cell hurts, including the keyless cell |
| 5. One-hop regression (relational-ab) | 0 questions worse |
| 6. False fire | 0 of 500 LongMemEval-S, 0 of 77 BrainBench non-relational, 0 of 50 cat-13 queries |

Custodian notes: N9 v1 has no unanswerable questions, so the abstention part of
gate 3 could not be evaluated; v1 was opened twice, within its three-opening
limit.

## Defaults

- `search.relational_planner`: on in `balanced` and `tokenmax`, off in
  `conservative` (that tier has relational retrieval off).
- `search.relational_orient_onehop`: off in every bundle and available opt-in.
  The orientation ablation was 1 question better and 0 worse on relational-ab
  (p = 1.0), short of the improvement its default rule requires.

## Known gap

The planner planned 70% of the plainly worded (template) questions and 21% of
the reworded (paraphrase) ones. The surface-form vocabulary is the limit, the
same brittleness the one-hop relational parser showed in its own held-out run.
Widening coverage of reworded questions without giving up precision is the
follow-up.

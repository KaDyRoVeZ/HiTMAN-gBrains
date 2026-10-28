# P7 multi-relation query planner: development verdict and held-out preregistration

This folder holds the development comparison for the multi-relation query
planner (`search.relational_planner`) and points at the plan for the held-out
run. `decision.json` is the decision-kit spec and `verdict.json` is the kit's
dev verdict. Dev verdicts never set a default; the held-out verdict from the
custodian does.

## Builds

- Baseline: `273d2b7e8` (P1 temporal edges head, master `6622a119e` merged in; this branch is stacked on it).
- Candidate: `94bd52e01`, with `search.relational_planner=true`. Later branch
  commits change only documentation.

## Development results (kit verdict `pass`)

- LongMemEval-S, all 500 questions, hash embeddings (keyless; the planner needs
  no key): recall_all@5 0.5553 → 0.5553 (non-inferiority, pass), nDCG@10
  0.6616 → 0.6616, latency Δ −0.15 ms (95% CI −0.66 to +0.35). The planner
  plans none of these questions, so the two arms return the same results.
- The composed multi-hop set (`multi-hop-paraphrase`, N9) is this plan's sealed
  held-out set, so it is not a dev source here; the custodian runs it.

Further development evidence (oracle reachability, the implementer's world-v1
probe, paraphrase coverage against an LLM planner, false-fire parse checks,
relational-ab one-hop regression, latency on world-v1 and a 100k-link graph) is
recorded in the preregistration.

## Held-out run

Preregistration: gbrain-evals branch `capy/p7-preregistration`,
`docs/benchmarks/2026-10-04-p7-multi-hop-planner-preregistration.md`. It fixes
the arms (feature arm set with `GBRAIN_EVAL_SEARCH_PINS="search.relational_planner=true"`),
cells, metrics, release gates, benefit gates 1-7 and the default rule before
any held-out cell runs.

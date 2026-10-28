# P1 temporal typed edges, E2: per-model certification of `apply` mode

**Held-out verdict: pass for all five models.** Each is in `CERTIFIED_APPLY_MODELS`
(`src/core/cycle/edge-contradictions.ts`), so with no explicit
`dream.edge_contradictions.mode` the nightly relationship check applies its closures
with any of them. Every other chat model proposes.

## Run

Custodian (P0), phrasing set C, 3 runs per model, frozen build `feb077ef9`. The ledger
holds only dated "joined" lines (as an employment history usually reads), so every
closure comes from the contradiction phase; undated and out-of-order sub-ledgers check
that undated pairs are never closed and that late-recorded evidence is born closed.

Preregistered bar ([round 1](../p1-dev-2026-10-04/README.md)): wrong closures ≤ 1% in
every run, and as-of exact at least 10 points above the deterministic E1 arm.

Models: claude-haiku-4-5 (the utility default), claude-sonnet-5-5, gpt-6.1-sol,
claude-opus-5-5 and claude-fable-5-1.

| Check (all five models, every run) | Result |
|---|---|
| Wrong closures | 0 |
| As-of exact vs the E1 arm | +0.111 to +0.115 (bar +0.10) |
| Undated pairs closed | 0 |

Each run applied 65–66 closures. Judge output errors: claude-sonnet-5-5 returned 3 and 6
malformed outputs in two runs and claude-fable-5-1 6 in one; those pairs were not
proposed, which is the designed behavior for a malformed answer.

## What the result does not show

1. **No model is better than another here.** The model only flags that two current
   relationships cannot both hold; date arithmetic picks which one ended and when. All
   five sit at the same ceiling, so the pass certifies that `apply` is safe with each of
   them, not a ranking.
2. **Closures are often late.** 41 of the 66 closures are dated after the real end: with only "joined" lines, a gap between jobs closes the earlier job on the next
   start date. That is late, not wrong, and it is why as-of clears the bar by about 1.5
   points. Follow-up: close at the gap when an explicit end date exists, and otherwise
   record the end date as an upper bound.
3. **Proposals go stale within a cycle.** 51 proposals per model went stale in the same
   cycle and are judged again the next night.

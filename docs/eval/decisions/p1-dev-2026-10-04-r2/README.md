# P1 temporal typed edges, round 2: development verdict and held-out preregistration

**Held-out E1 (set C, seeds 11/13/17, custodian): pass.** `graph.edge_validity` stays on.
Results are below, under "Held-out verdicts".

Round 2 replaces [round 1](../p1-dev-2026-10-04/README.md), whose held-out run on
phrasing set B failed. `decision.json` is the decision-kit spec and `verdict.json` the
dev verdict. Dev verdicts never set a default; the custodian's held-out verdict does.

## Builds

- Baseline: `6622a119e` (master merge base).
- Candidate: `feb077ef9`, frozen. It also carries pack-declared relation semantics
  (`link_types[].temporal`).

## What failed on set B, and the fix

The set B run (custodian, seeds 11/13/17) failed the traps gate: 101 of 115 trap items
were correct (87.8% against a 99% bar). Advisor traps were 35/35, investment-after-exit
37/43, alumni meetings 29/37. Current-employer recall fell 0.049 and live-edge recall
0.062 below the baseline. Set A, the only phrasing the build had been tuned on, showed
traps at 1.0 and no recall change, so the build had overfit set A.

Three development phrasing sets written after the verdict without sight of set B (A2,
A3) reproduced both failure kinds on the round-1 build: recall 0.44–0.47 against a
baseline of 0.67–0.87, traps 0.69–0.85. The causes were general rules, not wording:

1. **Cues outside the relationship.** A start or end cue anywhere before a reference
   moved employment even when the line was about investing, a meeting or an event
   ("Joined [X]'s Series B", "Joined the [X] alumni dinner"). Natural cues now never
   move a state relationship on investing, meeting or event lines, or when the
   reference is qualified by what follows ("[X]'s …", "[X] alumni"); "[X]'s advisory
   board" is the one qualified form that dates `advises`. Event relations never close.
2. **Past prose closing a dated start.** A dated start with past-tense prose and no
   dated end was closed at an unknown date, and present perfect and promotions ("has
   worked at", "was promoted to CTO at") read as past. A dated start now stays open
   until a dated end, and those forms read as present.
3. **Missed transitions.** "Started at [X]" was taken for the explicit grammar with a
   relation named `at`, so the line was ignored; the grammar now needs a relation
   token. "Moved from [A] to [B]" and "Left [A] for [B]" did not start B; they do,
   for the relation that ended. Frontmatter `since`/`until` stored as UTC-midnight
   timestamps were not read; they are. Common leave and join verbs were added
   ("moved on from", "stepped away from", "was hired by", "accepted an offer from").

Unit tests for each rule are in `test/link-temporal-evidence.test.ts` and
`test/link-validity.test.ts`.

## Development results (all temporal-edges gates pass on A, A2 and A3)

Source: gbrain-evals branch `p1-temporal-edges-dev-a2` (`a257cab`, on P0's
`p0-heldout-harness`), `eval/runner/temporal-edges.ts --phrasing A|A2|A3`, seeds 3 and 5.

| Metric | A base → cand | A2 base → cand | A3 base → cand |
|---|---|---|---|
| Current-employer precision | 0.343 → 1.000 | 0.356 → 1.000 | 0.327 → 0.889 |
| As-of exact | 0.212 → 0.900 | 0.217 → 0.913 | 0.194 → 0.694 |
| During-year F1 | 0.594 → 0.896 | 0.601 → 0.909 | 0.472 → 0.690 |
| Stale summary flagged | 0.000 → 0.867 | 0.000 → 0.700 | 0.000 → 0.533 |
| Current-employer recall | 0.842 → 0.842 | 0.870 → 0.870 | 0.670 → 0.670 |
| Live-edge recall | 0.842 → 0.842 | 0.871 → 0.871 | 0.662 → 0.662 |
| Traps | 0.446 → 1.000 | 0.446 → 1.000 | 0.541 → 1.000 |
| Write-order invariance | 1 → 1 | 1 → 1 | 1 → 1 |

Recall equals the baseline on every set, so the remaining recall gap is link typing,
which both builds share: a timeline-only "Joined [X]" or "is an advisor to [X]" can
type the edge as something other than `works_at`. That also caps A3's precision and
as-of numbers.

Guardrails: LoCoMo dev recall-all@5 0.7543 → 0.7543 (pass); N3 513/513 in both builds
(pass, no regression); N4 0.6176 → 0.6176 with no new wrong merge (pass); N1 contracts
pass in both; BEAM-100k 0.4537 → 0.4537, inconclusive (6 clusters, below the kit's
minimum of 10), which makes the overall kit verdict `inconclusive`.

## Held-out preregistration (custodian only)

1. **E1 on a fresh phrasing set C** (set B is spent), seeds 11, 13 and 17. Gates as in
   round 1: now-precision +0.10, as-of +0.15, during-F1 +0.15, stale-summary correction
   +0.20 (superiority, cluster-bootstrap interval above zero); current-employer and
   live-edge recall non-inferior within 0.02; traps ≥ 0.99; order invariance 1 on every
   item; no guardrail failing. `graph.edge_validity` stays on only if E1 passes.
2. **E2 and E3** as preregistered in round 1, run on this frozen build after E1. E2
   passed for all five models: [p1-e2-2026-10-05](../p1-e2-2026-10-05/README.md).

## Held-out verdicts

**E1, set C (custodian; baseline `6622a119e`, candidate `feb077ef9`): pass.**

| Gate | Baseline → candidate | Result |
|---|---|---|
| Current-employer precision | 0.376 → 0.943 | pass |
| As-of exact | 0.208 → 0.678 | pass |
| During-year F1 | 0.455 → 0.653 | pass |
| Stale-summary correction | 0.000 → 0.364 | pass |
| Current-employer recall | 0.616 → 0.612 | non-inferior, pass |
| Live-edge recall | 0.608 → 0.603 | non-inferior, pass |
| Traps | 115 / 115 | pass |
| Write-order invariance | 240 / 240 | pass |

**E3, ingestion to answer (report only).** After a correction is written, `entity`,
`context_pack` and compiled context show it for 0.277 of people and ambient turn context
for 0.239; the baseline shows it for none. The ceiling is link typing shared by both
builds: a line such as "Signed on with [X] as CTO" is not typed `works_at`, so there is
no relationship for the correction to date.

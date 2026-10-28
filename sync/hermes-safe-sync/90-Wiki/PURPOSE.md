---
type: system-policy
status: active
updated_at: 2026-10-23T13:36:00+07:00
---
# PURPOSE — HiTMAN Knowledge OS

## Purpose
Компилировать проверяемое долговременное знание из разрешённых источников, сохранять provenance, выявлять противоречия и давать всем Hermes-профилям единый безопасный read layer.

## Boundaries
- Operating truth остаётся в Projects, Areas, task ledger и профильных системах.
- `90-Wiki/20-Knowledge/` хранит проверенное и повторно применимое знание.
- Live memory и runtime skills остаются внутри каждого Hermes profile.
- Wiki хранит безопасные каталоги профилей/skills, ссылки, manifests и approved snapshots — не credentials и не полные session transcripts.

## Authority
- BOSS утверждает side effects, canonical policy, массовые изменения, sensitive-domain conclusions, external sends, installs, deletes, commit и push.
- Профиль `default` — единственный canonical Wiki writer.
- Остальные профили читают Wiki и подают предложения через собственные handoff directories.

## Query and ingest
- Query read-only по умолчанию.
- Ingest: Capture → Manifest → Analyze → Triage → Review → Compile → Index → Lint.
- Outcomes: New, Update, Disputed, No material, Review required.

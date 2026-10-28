# SCHEMA

## Managed zone
`90-Wiki/` — единственная canonical LLM Wiki zone. Legacy material индексируется in place и мигрируется при использовании.

## Page types
`raw-source`, `concept`, `entity`, `procedure`, `decision`, `comparison`, `query`, `review-item`, `security-finding`, `system-policy`.

## Required fields
`schema_version`, `id`, `type`, `title`, `status`, `created_at`, `updated_at`, `privacy`, `source_refs`.

## Privacy
`public | personal | sensitive | restricted | secret-ref | prohibited`.

## Source modes
`safe-copy | reference-only`. Email, School, Finance, Health, Work, Telegram, Hermes and System default to `reference-only`.

## Lifecycle
- Raw: captured → processed → archived.
- Knowledge: proposed → active → disputed | outdated | superseded | retired.
- Project: proposed → active → on-hold | completed → archived.
- Security: candidate → confirmed | needs-validation | rejected → resolved.

## Writers
- `default`: canonical Wiki and shared indexes.
- Role profiles: own `40-Agents/20-Handoffs/<profile>/` only.
- Scheduled sync: generated indexes/manifests/log receipt only.

## Invariants
Query read-only; Raw immutable; exact provenance; no silent conflict overwrite; one writer per generated target; tasks only via `ledger_ref`.

import type { Migration } from './types.ts';
import { FACT_INSERT_GUARD_SQL } from '../facts/insert-guard-schema.ts';
import { STAMP_ROW_FUNCTION } from '../persistence/attribution-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7105: the facts purge refusal and withdrawal stamp run once per INSERT
// statement (one AFTER INSERT ... REFERENCING NEW TABLE trigger,
// facts/insert-guard-schema.ts) instead of once per inserted row. The per-row
// facts_refuse_purged and facts_preserve_withdrawal triggers keep their
// functions and now fire on UPDATE only. The write-attribution function is
// re-created so the guard's withdrawal stamp (an UPDATE under
// gbrain.fact_withdrawal_stamp) keeps the row's last_write_* values.
// Function and trigger DDL only: no row changes.
export const v264: Migration = {
  version: 264,
  name: 'set_based_fact_insert_guards',
  idempotent: true,
  sql: `${STAMP_ROW_FUNCTION};\n${FACT_INSERT_GUARD_SQL}`,
};

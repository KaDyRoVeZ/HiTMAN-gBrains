import type { BrainEngine } from '../../src/core/engine.ts';

/** gbrain_require_managed_writer() source lookup as shipped through 0.60.37.0 (schema v196): source_id read whenever the key exists. */
const PRE_5983_SOURCE_LOOKUP = `IF row_data ? 'source_id' THEN target_source := row_data->>'source_id';
  ELSE SELECT source_id INTO target_source FROM pages WHERE id=(row_data->>'page_id')::integer; END IF;
  IF TG_OP='UPDATE' THEN
    IF old_data ? 'source_id' THEN old_source := old_data->>'source_id';
    ELSE SELECT source_id INTO old_source FROM pages WHERE id=(old_data->>'page_id')::integer; END IF;
  END IF;`;

/** Re-installs the pre-#5983 guard function in place of the current one. */
export async function installPre5983Guard(engine: BrainEngine): Promise<void> {
  const [{ src }] = await engine.executeRaw<{ src: string }>(`SELECT pg_get_functiondef('gbrain_require_managed_writer'::regproc) AS src`);
  const current = src.slice(src.indexOf("IF TG_TABLE_NAME NOT IN ('tags','timeline_entries','takes')"), src.indexOf('-- Cascaded projection removal'));
  if (!current) throw new Error('installPre5983Guard: the current guard function has an unexpected shape');
  await engine.executeRaw(src.replace(current, `${PRE_5983_SOURCE_LOOKUP}\n  `));
}

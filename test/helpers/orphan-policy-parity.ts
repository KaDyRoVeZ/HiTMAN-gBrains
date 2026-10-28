/**
 * Generated slug/type corpus for the orphan-policy TS/SQL parity check
 * (`orphanExclusionSql` vs `shouldExcludeFromOrphanReporting`). Shared by the
 * PGLite unit test and its Postgres twin so both engines judge the same rows.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { orphanExclusionSql, shouldExcludeFromOrphanReporting, type OrphanPolicyOverrides } from '../../src/core/orphan-policy.ts';
import { renderFragment, sqlFragment } from '../../src/core/engine-sql/fragment.ts';

const STEMS = [
  '', 'a', 'notes/x', 'people/alice-example', 'readme', 'README', 'index', 'schema', 'log', '_atlas', '_stats', 'claude',
  'x/_index', 'x/log', 'x/readme', 'x/logs', 'x/_indexes', 'x/Readme', '/log', '_index',
  'w/raw/y', 'raw', 'raw/y', 'w/raw', 'w/daily/y', 'daily', 'daily/x', 'w/daily', 'dailyx/y',
  'output/x', 'outputs/x', 'output', 'dashboards/x', 'scripts/x', 'templates/x', '_templates/x', 'openclaw/config/x', 'openclaw/x',
  'extracts/x', 'life/events/2026-01-01-ab', 'life/diary/x', 'life/eventsx/y',
  'scratch', 'scratch/x', 'thoughts/x', 'catalog/x', 'entities/x', 'atoms/x', 'skills/x', 'dreaming/x', 'inbox/x', 'inboxes/x',
  '2026-01-02', '2026-01-02-standup', '2026-01-02-', '2026-01-02-\n', '2026-01-02-a\nb', '2026-01-02\n', '2026-1-02', '12026-01-02',
  '٢٠٢٦-٠١-٠٢', '٢٠٢٦-01-02', '2026-٠١-02', '2026-01-٠٢', 'x/aindex', 'x/%index', '２０２６-01-02', '2026-01-02-\u2028', '2026-01-02-x\u2029', '2026-01-02-\r', '2026-01-02-\t', '2026-01-02/x',
  '_brain-x', '_brain', '_brainx', 'agents/a/soul', 'agents/a/souls', 'agents/a/b/soul', 'agents//soul', 'agents/a\n/soul',
  'agents/a/identity', 'agents/a/tools', 'agents/a/user', 'agents/a/heartbeat', 'agents/a/dreams', 'agents/a/dormant', 'agents/a/agents',
  'agents/a/memory/dreaming/x', 'agents/memory/dreaming/', 'x/agents/a/soul', 'agentsx/a/soul',
  'private/x', 'private', 'Ünï/x', 'one-off', 'one-off/x', 'x', '%/_index', 'a_b/log', 'a%b', "o'brien", 'emoji/🧠/log',
];

const SUFFIXES = ['', '/', '/x', '\n', ' ', '/readme', '/log'];
const TYPES: Array<string | null> = [null, '', 'note', 'person', 'atom', 'conversation', 'source', 'Atom', 'atoms', 'media'];

export const PARITY_OVERRIDES: Array<OrphanPolicyOverrides | undefined> = [
  undefined,
  { excludePrefixes: [], excludeSlugs: [] },
  { excludePrefixes: ['private/', 'Ünï/', 'a%', 'x'], excludeSlugs: ['one-off', 'x', "o'brien", '2026-1-02'] },
];

export function parityCorpus(seed = 3): Array<{ slug: string; type: string | null }> {
  let a = seed >>> 0;
  const rand = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  const rows: Array<{ slug: string; type: string | null }> = [];
  for (const stem of STEMS) {
    for (const suffix of SUFFIXES) rows.push({ slug: stem + suffix, type: TYPES[Math.floor(rand() * TYPES.length)] });
  }
  for (const type of TYPES) rows.push({ slug: 'notes/plain', type });
  for (let i = 0; i < 400; i++) {
    const a1 = STEMS[Math.floor(rand() * STEMS.length)];
    const a2 = STEMS[Math.floor(rand() * STEMS.length)];
    rows.push({ slug: `${a1}/${a2}`.replace(/^\//, ''), type: TYPES[Math.floor(rand() * TYPES.length)] });
  }
  return rows;
}

/** Evaluate `orphanExclusionSql` on the engine and compare with the TS renderer row by row. */
export async function expectOrphanPolicyParity(engine: BrainEngine): Promise<number> {
  const rows = parityCorpus();
  let checked = 0;
  for (const overrides of PARITY_OVERRIDES) {
    const { text, params } = renderFragment(sqlFragment`
      SELECT p.ord::int AS ord, ${orphanExclusionSql('p', overrides)} AS excluded
        FROM unnest(${rows.map(r => r.slug)}::text[], ${rows.map(r => r.type)}::text[]) WITH ORDINALITY AS p(slug, type, ord)
       ORDER BY p.ord`);
    const result = await engine.executeRaw<{ ord: number; excluded: boolean }>(text, params);
    expect(result.length).toBe(rows.length);
    const mismatches = result
      .map(r => ({ ...rows[r.ord - 1], sql: r.excluded, ts: shouldExcludeFromOrphanReporting(rows[r.ord - 1].slug, overrides, { type: rows[r.ord - 1].type }) }))
      .filter(r => r.sql !== r.ts);
    expect({ overrides, mismatches }).toEqual({ overrides, mismatches: [] });
    checked += rows.length;
  }
  return checked;
}

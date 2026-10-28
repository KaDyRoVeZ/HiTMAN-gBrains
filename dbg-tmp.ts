import { PGLiteEngine } from './src/core/pglite-engine.ts';
import { operations } from './src/core/operations.ts';
import { generateTemporalEdgesWorld, currentEmployers } from '/home/user/.capy/work/src/gbrain-evals-p0/eval/generators/temporal-edges-gen.ts';
const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
const ctx: any = { engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' };
const op = (n: string) => operations.find(o => o.name === n)!;
const w = generateTemporalEdgesWorld({ seed: 3, phrasing: process.argv[2] });
for (const p of w.pages) { const s = await engine.readPageSnapshot(p.slug, { sourceId: 'default' }); await op('put_page').handler(ctx, { slug: p.slug, content: p.content, ...(s ? { expected_revision: s.revision } : {}) }); }
let shown = 0; const styles: Record<string, number> = {};
for (const p of w.people) {
  const cur = currentEmployers(p);
  const live = (await op('get_links').handler(ctx, { slug: p.slug, link_type: 'works_at' }) as any[]).map(r => r.to_slug);
  const wrong = live.filter(s => !cur.includes(s)); if (!wrong.length) continue;
  styles[p.style] = (styles[p.style] ?? 0) + 1;
  if (shown++ < 2) { console.log('WRONG', p.style, wrong, JSON.stringify(p.stints.map(s => [s.company.slice(10), s.from, s.until]))); console.log(w.pages.find(x => x.slug === p.slug)!.content);
    for (const r of await op('get_links').handler(ctx, { slug: p.slug, status: 'all', link_type: 'works_at' }) as any[]) console.log('  ', r.to_slug, r.status, JSON.stringify(r.stints)); }
}
console.log(styles);

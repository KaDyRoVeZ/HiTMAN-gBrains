/**
 * run-case.ts — one takes-bootstrap eval case through the production path.
 *
 * Seeds the case page into the brain AND its markdown file under the brain
 * repo (`sync.repo_path` must already point at `brainDir`), runs
 * `extractTakesFromPages` (consent gate → eligibility selector → classifier →
 * md-first fence write → DB mirror), and reads the case's predictions back
 * from the page's takes fence, the canonical store. The caller deletes the
 * page before the next case so each run selects only its own page.
 *
 * A classifier call that failed (`llm_error:*` skip) yields `claims: null`,
 * which the scorer counts as malformed. Any other outcome that means the
 * production path never classified this page (consent gate, unavailable
 * gateway, not selected, skipped for another reason) throws: that is a
 * harness or corpus defect, never a classifier verdict.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractTakesFromPages } from '../../src/core/extract-takes-from-pages.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import type { PageType } from '../../src/core/types.ts';
import type { CasePrediction, CorpusCase } from './scorer.ts';

export const EVAL_HOLDER = 'eval';

export interface CaseRun extends CasePrediction {
  /** The skip reason when the classifier call failed (claims is then null). */
  error?: string;
}

export async function runCase(engine: BrainEngine, brainDir: string, c: CorpusCase, model: string): Promise<CaseRun> {
  const { slug, type, title, body } = c.page;
  await engine.putPage(slug, { type: type as PageType, title, compiled_truth: body, frontmatter: {} });
  const page = await engine.getPage(slug);
  if (!page) throw new Error(`case ${c.id}: page ${slug} was not stored`);
  const mdPath = join(brainDir, `${slug}.md`);
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, serializePageToMarkdown(page, []));

  const res = await extractTakesFromPages(engine, {
    bootstrapEnabled: true, maxPages: 1, includeCovered: false, holder: EVAL_HOLDER, model,
  });
  if (res.llm_unavailable) throw new Error(`case ${c.id}: the chat gateway is unavailable`);
  if (res.budget_exhausted) throw new Error(`case ${c.id}: the extractor's takes budget stopped the run`);
  if (res.pages_scanned !== 1) {
    throw new Error(`case ${c.id}: the extractor selected ${res.pages_scanned} pages; the case page must be the only eligible one (type in ALLOWED_PAGE_TYPES, body over 200 chars)`);
  }
  const skip = res.skipped[0];
  if (skip?.reason.startsWith('llm_error')) return { id: c.id, claims: null, error: skip.reason };
  if (skip) throw new Error(`case ${c.id}: the extractor skipped the page (${skip.reason})`);

  const takes = parseTakesFence(readFileSync(mdPath, 'utf8')).takes
    .filter(t => t.active && t.holder === EVAL_HOLDER);
  return { id: c.id, claims: takes.map(t => ({ claim: t.claim, kind: t.kind, weight: t.weight })) };
}

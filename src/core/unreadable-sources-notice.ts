/**
 * GBRA-156: `sources_not_readable`, the notice on an unscoped remote read
 * that reached no source holding a page while other sources hold pages.
 *
 * A connection with no source grant (a token minted without --sources, or
 * an unbound agent stdio connection) reads the default source plus the
 * federated ones. A new source is not federated by default, so such a
 * connection can answer every search with an empty result that reads like a
 * clean miss. This notice says the pages are elsewhere and names the host
 * command that makes them readable, without naming any source the connection
 * cannot read. A connection whose operator granted it sources (every OAuth
 * client carries at least its bound source), or a read that names a source,
 * never gets it: that scope is deliberate.
 */
import type { Notice } from './agent-output.ts';
import { emptyRead } from './interop-notices.ts';
import type { OperationContext } from './ops/contract.ts';
import { federatedSearchScope } from './ops/context.ts';
import { hostFix } from './ops/op-fix.ts';

const UNSCOPED_READ_OPS: ReadonlySet<string> = new Set(['search', 'query', 'recall', 'list_pages']);

function namesSources(params: Record<string, unknown>): boolean {
  const ids = params.source_ids;
  return params.source_id !== undefined || (Array.isArray(ids) ? ids.length > 0 : typeof ids === 'string' && ids.trim() !== '');
}

/** The notice for one successful call, or null. Never throws. */
export async function unreadableSourcesNotice(
  op: string, params: Record<string, unknown>, result: unknown, ctx: OperationContext,
): Promise<Notice | null> {
  if (ctx.remote === false || !UNSCOPED_READ_OPS.has(op) || !emptyRead(op, result) || namesSources(params)) return null;
  if (ctx.explicitReadBinding || ctx.auth?.allowedSources !== undefined || ctx.auth?.hasSourceGrant === true) return null;
  try {
    const scope = federatedSearchScope(ctx);
    const readable = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : null);
    if (!readable) return null;
    const [row] = await ctx.engine.executeRaw<{ in_scope: boolean; elsewhere: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pages WHERE source_id = ANY($1::text[]) AND deleted_at IS NULL) AS in_scope,
              EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
                       WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND NOT (p.source_id = ANY($1::text[]))) AS elsewhere`,
      [readable],
    );
    if (!row || row.in_scope || !row.elsewhere) return null;
    return {
      code: 'sources_not_readable',
      kind: 'degraded',
      why: `This unscoped ${op} read every source this connection can read (the default source and any federated source), and none of them holds a page. `
        + 'Other sources on this brain hold pages, but they are not federated and this connection has no source grant, so it cannot read them. '
        + 'The empty result is not proof the brain has nothing on this. The brain host\'s operator can federate a source so every connection without a grant reads it (command in fix), '
        + 'or grant this connection the sources it should read (`gbrain auth rescope --token <name> --sources <ids>`).',
      fix: {
        ...hostFix(ctx, ['gbrain', 'sources', 'federate', '<source>'],
          'Makes the source readable by every connection without a source grant; only the trusted CLI on the brain host changes federation.'),
        inputs: [{ name: 'source', how: 'Ask the user which source these connections should read (`gbrain sources list` on the brain host shows them).' }],
      },
    };
  } catch {
    return null;
  }
}

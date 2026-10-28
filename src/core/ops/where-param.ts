/**
 * The `where` param shared by search, query and list_pages (#7159):
 * frontmatter equality, validated once at the op boundary
 * (search/frontmatter-where.ts holds the semantics and the SQL).
 */
import type { OperationContext, ParamDef } from './contract.ts';
import { invalidParam } from './op-fix.ts';
import { FrontmatterWhereError, WHERE_EXAMPLE, parseFrontmatterWhere, type FrontmatterWhere } from '../search/frontmatter-where.ts';

export const WHERE_PARAM: ParamDef = { type: 'object', cliKeyValue: true, fullSurfaceOnly: true, description: 'Frontmatter equality, e.g. {status: "active"}; a list matches any.' };

/** The validated filter, or undefined when absent; a bad key or value is invalid_params. */
export function whereOpParam(ctx: Pick<OperationContext, 'remote' | 'transport'>, tool: string, raw: unknown): FrontmatterWhere | undefined {
  try {
    return parseFrontmatterWhere(raw);
  } catch (e) {
    if (!(e instanceof FrontmatterWhereError)) throw e;
    throw invalidParam(ctx, tool, 'where', e.message, { example: ctx.remote === false ? 'status=active' : WHERE_EXAMPLE });
  }
}

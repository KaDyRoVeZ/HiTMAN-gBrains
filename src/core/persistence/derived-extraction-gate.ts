import type { WriteAuthority } from './model.ts';

/**
 * The writer confinement rule for paid derived extraction (facts backstop and
 * Life Chronicle events), shared so the two can never drift: a confined writer
 * (slug-bound, delegated or restricted namespace) never triggers it, and an
 * operation-bound grant needs `extract_facts`, the existing derived-extraction
 * permission. null = the writer may trigger extraction.
 */
export function derivedExtractionSkip(authority: Pick<WriteAuthority, 'restrictedNamespace' | 'delegated' | 'slugPrefixes' | 'operations'>):
  'slug_bound_client' | 'operation_bound_client' | null {
  if (authority.restrictedNamespace || authority.delegated || authority.slugPrefixes != null) return 'slug_bound_client';
  if (authority.operations != null && !authority.operations.includes('extract_facts')) return 'operation_bound_client';
  return null;
}

/** #4732 scenario shared by the PGLite unit arm and the Postgres E2E arm. */
import { expect } from 'bun:test';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

export async function assertHealthNamesActiveColumn(engine: BrainEngine): Promise<void> {
  const health = async () => {
    const res = await dispatchToolCall(engine, 'get_health', {}, { remote: true, transport: 'stdio' as const, sourceId: 'default' });
    expect(res.isError ?? false).toBe(false);
    return JSON.parse(res.content[0].text) as { embedding_column?: string };
  };
  await engine.unsetConfig('search_embedding_column');
  await engine.unsetConfig('embedding_columns');
  expect((await health()).embedding_column).toBe('embedding');
  await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_reg8 vector(8)');
  await engine.setConfig('embedding_columns', JSON.stringify({
    embedding_reg8: { provider: 'openai:text-embedding-3-small', dimensions: 8, type: 'vector' },
  }));
  await engine.setConfig('search_embedding_column', 'embedding_reg8');
  try {
    expect((await health()).embedding_column).toBe('embedding_reg8');
  } finally {
    await engine.unsetConfig('search_embedding_column');
    await engine.unsetConfig('embedding_columns');
  }
}

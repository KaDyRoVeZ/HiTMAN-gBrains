export async function countPages(engine: { executeRaw(sql: string, p?: unknown[]): Promise<unknown> }, sourceId: string) {
  return engine.executeRaw(
    `SELECT count(*) FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
}

export async function countPages(engine: { executeRaw(sql: string, p?: unknown[]): Promise<unknown> }) {
  return engine.executeRaw(
    `SELECT count(*) FROM pages WHERE deleted_at IS NULL`,
  );
}

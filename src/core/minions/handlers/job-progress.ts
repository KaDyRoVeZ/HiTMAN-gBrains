/**
 * #7241: best-effort `job.updateProgress` for handlers that report their phase. Progress is advisory, so a
 * failed write (a lost lock token, a dropped connection) never fails the job it describes.
 */
import type { MinionJobContext } from '../types.ts';

export async function reportJobProgress(job: Pick<MinionJobContext, 'updateProgress'>, progress: unknown): Promise<void> {
  try { await job.updateProgress(progress); } catch { /* advisory: the job's own result is the record */ }
}

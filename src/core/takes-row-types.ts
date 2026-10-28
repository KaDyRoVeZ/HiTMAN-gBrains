/**
 * Shared row-shape types for the takes pipeline (stale rows + embedding
 * writes), peeled out of engine.ts so the engine classes and their takes
 * delegates stay within the module-size ratchet.
 */

/** v0.28 stale-takes row (mirrors StaleChunkRow shape). Embedding column intentionally omitted. */
export interface StaleTakeRow {
  take_id: number;
  page_slug: string;
  row_num: number;
  claim: string;
}

/**
 * Stale-take inventory scope. `model` / `dims` widen "stale" from a missing
 * vector to one from another model or width; `sourceId` scopes to one source.
 */
export interface StaleTakeOpts {
  model?: string;
  dims?: number;
  sourceId?: string;
}

/**
 * Vector write for an existing take row, bound to the claim text the vector
 * was computed from and the model that computed it (#5885): the write is
 * discarded when the row's claim changed in the meantime.
 */
export interface TakeEmbeddingInput {
  take_id: number;
  embedding: Float32Array;
  claim: string;
  model: string;
}

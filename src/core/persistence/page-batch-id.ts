/** #6007: deterministic request ids of `put_pages` children (page-batch.ts). */
import { createHash } from 'node:crypto';

/** RFC 4122 namespace for put_pages child request ids (fixed forever: changing it re-admits replays). */
const CHILD_NAMESPACE = Buffer.from('a7f4c2d0600742b8b1e95d3c8f0a6007', 'hex');

/** UUIDv5(namespace, "put_pages:v1:<batch>:<index>"). */
export function pageBatchChildRequestId(batchId: string, index: number): string {
  const hash = createHash('sha1').update(CHILD_NAMESPACE).update(`put_pages:v1:${batchId.toLowerCase()}:${index}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every request id a batch can hold, in index order. */
export function pageBatchChildRequestIds(batchId: string, size: number): string[] {
  return Array.from({ length: size }, (_, index) => pageBatchChildRequestId(batchId, index));
}

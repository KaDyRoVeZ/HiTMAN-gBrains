/**
 * Hub dampening: a node linked to many others carries less signal per link.
 *
 * `hubWeight(n, H) = 1 / (1 + ((max(n, 1) - 1) / H)^2)`, where H is the degree
 * at which a boost is halved. Feed it the caller-visible degree (what the
 * caller may read), never a global count. `'off'` or an unset H means no
 * dampening (weight 1).
 */
export type HubDampening = 'off' | number;

export function hubWeight(degree: number, h: HubDampening | undefined): number {
  if (h === undefined || h === 'off' || !(h > 0) || !Number.isFinite(degree)) return 1;
  const x = (Math.max(degree, 1) - 1) / h;
  return 1 / (1 + x * x);
}

/** Shrink a multiplicative boost toward 1 by the hub weight of its node. */
export function dampenBoost(factor: number, degree: number, h: HubDampening | undefined): number {
  return 1 + (factor - 1) * hubWeight(degree, h);
}

/** `'off'`/false/null → 'off'; a positive number (or numeric string) → H; anything else → undefined (fall through). */
export function normalizeHubDampening(v: unknown): HubDampening | undefined {
  if (v === 'off' || v === false || v === null) return 'off';
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

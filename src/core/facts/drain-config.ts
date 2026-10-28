/** Config keys of the automatic facts drain (drain.ts) and their `config set` validation. */
interface NumericKeySpec { fallback: number; min: number; max: number; integer: boolean; meaning: string }
export const FACTS_DRAIN_KEYS = {
  'facts.drain_budget_usd': { fallback: 1, min: 0.01, max: 100, integer: false, meaning: 'USD cap for one automatic drain run' },
  'facts.drain_daily_budget_usd': { fallback: 5, min: 0.01, max: 1000, integer: false, meaning: 'USD cap for automatic drain runs per rolling 24 hours' },
  'facts.drain_max_jobs': { fallback: 50, min: 1, max: 1000, integer: true, meaning: 'jobs one automatic drain run takes at most' },
} as const satisfies Record<string, NumericKeySpec>;
export type FactsDrainKey = keyof typeof FACTS_DRAIN_KEYS;

export function parseFactsDrainKey(key: FactsDrainKey, raw: string): number | null {
  const spec: NumericKeySpec = FACTS_DRAIN_KEYS[key];
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (spec.integer && !Number.isInteger(n)) return null;
  return n >= spec.min && n <= spec.max ? n : null;
}

/** `config set` validation for facts.drain_*; the refusal text, or null when valid. */
export function validateFactsDrainConfigValue(key: string, value: string): string | null {
  if (!(key in FACTS_DRAIN_KEYS)) return null;
  const k = key as FactsDrainKey;
  const spec: NumericKeySpec = FACTS_DRAIN_KEYS[k];
  return parseFactsDrainKey(k, value) !== null ? null
    : `${key} must be ${spec.integer ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max} (${spec.meaning}; default ${spec.fallback}) (got '${value}'). Nothing was written.`;
}


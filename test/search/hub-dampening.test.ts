/**
 * hubWeight / dampenBoost: the degree-aware weight relational-chain.ts uses
 * for intermediate nodes.
 *
 * Pinned contracts:
 *   - hubWeight(1, H) = 1; hubWeight(H + 1, H) = 0.5; `off` / undefined = 1
 *   - dampenBoost scales a boost's excess over 1.0 by that weight
 */
import { describe, test, expect } from 'bun:test';
import { dampenBoost, hubWeight } from '../../src/core/search/hub-dampening.ts';

describe('hubWeight', () => {
  test('degree <= 1 keeps the full lift; H + 1 halves it; 3H + 1 keeps 10%', () => {
    expect(hubWeight(0, 100)).toBe(1);
    expect(hubWeight(1, 100)).toBe(1);
    expect(hubWeight(101, 100)).toBeCloseTo(0.5, 12);
    expect(hubWeight(301, 100)).toBeCloseTo(0.1, 12);
  });

  test('off, undefined and invalid half degrees mean no dampening', () => {
    expect(hubWeight(10_000, 'off')).toBe(1);
    expect(hubWeight(10_000, undefined)).toBe(1);
    expect(hubWeight(10_000, Number.NaN)).toBe(1);
    expect(hubWeight(10_000, -5)).toBe(1);
  });

  test('non-finite degrees are treated as no links', () => {
    expect(hubWeight(Number.NaN, 10)).toBe(1);
    expect(hubWeight(Number.POSITIVE_INFINITY, 10)).toBe(1);
  });

  test('the c = 0.001 setting corresponds to H ≈ 31.6', () => {
    const H = 1 / Math.sqrt(0.001);
    for (const n of [1, 11, 33, 101, 1001]) {
      expect(hubWeight(n, H)).toBeCloseTo(1 / (1 + 0.001 * (n - 1) ** 2), 12);
    }
  });
});

describe('dampenBoost', () => {
  test('scales the excess over 1.0', () => {
    expect(dampenBoost(1.1, 101, 100)).toBeCloseTo(1.05, 12);
    expect(dampenBoost(1.1, 1, 100)).toBe(1.1);
  });
});

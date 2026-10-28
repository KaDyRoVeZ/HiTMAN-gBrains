/**
 * Delta-debugging shrinker for crash-robot failures. It removes ops from the
 * failing schedule (dependencies are kept by `restrict`: an op whose producer
 * was removed is removed with it) while the run still shows a violation of
 * the same class. A candidate whose run errors out is an invalid sequence,
 * counted apart from a non-reproducing one. The result is accepted only when
 * it reproduces in 3 of 3 fresh reruns.
 */
import type { RobotRun } from './robot-driver.ts';
import { runDigest } from './robot-driver.ts';

type Execute = (run: RobotRun, keep?: Map<string, Set<string>>) => Promise<{ violations: { class: string }[] }>;
export interface ShrinkResult {
  original: { ops: number; classes: string[] }; shrunk: RobotRun; reruns: number; reproduced: number;
  candidates: number; invalid: number; accepted: boolean; digest: string;
}

export async function shrinkRun(failing: RobotRun, execute: Execute): Promise<ShrinkResult> {
  const classes = new Set<string>(failing.violations.map(v => v.class));
  const { scheduleFor } = await import('./robot-driver.ts');
  const all = failing.ops ?? scheduleFor(failing.schedule, failing.seed, failing.length).ops.map(d => d.id);
  let candidates = 0, invalid = 0;
  const reproduces = async (ops: string[]): Promise<boolean> => {
    candidates++;
    try {
      const result = await execute({ ...failing, ops, violations: [] });
      return result.violations.some(v => classes.has(v.class));
    } catch { invalid++; return false; }
  };
  let current = all;
  let chunks = 2;
  while (current.length > 1) {
    const size = Math.ceil(current.length / chunks);
    let reduced = false;
    for (let start = 0; start < current.length; start += size) {
      const complement = [...current.slice(0, start), ...current.slice(start + size)];
      if (complement.length && await reproduces(complement)) {
        current = complement; chunks = Math.max(2, chunks - 1); reduced = true; break;
      }
    }
    if (!reduced) {
      if (size === 1) break;
      chunks = Math.min(current.length, chunks * 2);
    }
  }
  const shrunk: RobotRun = { ...failing, ops: current, violations: [] };
  let reproduced = 0;
  for (let i = 0; i < 3; i++) if (await reproduces(current)) reproduced++;
  return { original: { ops: all.length, classes: [...classes] }, shrunk, reruns: 3, reproduced, candidates, invalid,
    accepted: reproduced === 3, digest: runDigest(shrunk) };
}

/**
 * Deterministic stand-ins for the clock and the ID source, for tests and reproducible runs: the
 * same seed and start time always give the same IDs, times and therefore the same audit hashes.
 */
import type { Clock, IdSource, IsoUtc } from '@tw/model';

/** A clock that starts at `startIso` and moves on by `stepMs` (default 1000) at every reading. */
export function fixedClock(startIso: IsoUtc, stepMs = 1000): Clock {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) throw new Error(`fixedClock needs an ISO time; got ${startIso}.`);
  let ticks = 0;
  return { now: () => new Date(start + stepMs * ticks++) };
}

/** Mulberry32: a small, well-mixed 32-bit generator, plenty for distinct test IDs. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function hex(next: () => number, chars: number): string {
  let out = '';
  while (out.length < chars) out += next().toString(16).padStart(8, '0');
  return out.slice(0, chars);
}

/** IDs from a seeded generator: 'p_' + 16 hex characters and 'e_' + 8 hex characters. */
export function seededIds(seed: number): IdSource {
  const next = generator(seed);
  return {
    newProjectId: () => `p_${hex(next, 16)}`,
    newExportId: () => `e_${hex(next, 8)}`,
  };
}

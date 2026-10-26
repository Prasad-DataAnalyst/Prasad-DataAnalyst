/** Walks an audit chain from genesis and reports the first entry that does not link up. */
import type { AuditEntry, AuditSeq, ChainReport, Sha256Hex } from '@tw/model';
import { hashEntry } from './hash';

/**
 * Checks, in order, that entry i has seq i + 1, that its `prev` is the previous entry's `hash`
 * (the genesis hash for the first) and that its `hash` matches its content. `brokenAt` is the
 * position (as a seq) where the chain first fails, so a deleted or reordered line is reported where
 * the gap appears. Removing trailing entries cannot be detected from the chain alone; callers that
 * know the expected head (the .twp manifest) compare it separately.
 */
export function verifyChain(entries: readonly AuditEntry[], genesis: Sha256Hex): ChainReport {
  let prev = genesis;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as AuditEntry;
    const problem = linkProblem(entry, i + 1, prev);
    if (problem !== null) return broken(entries.length, i + 1, problem);
    prev = entry.hash;
  }
  return { ok: true, entries: entries.length };
}

function linkProblem(entry: AuditEntry, expectedSeq: AuditSeq, expectedPrev: Sha256Hex): string | null {
  if (entry.seq !== expectedSeq) {
    return `Entry ${expectedSeq} has sequence number ${entry.seq}; an entry is missing, duplicated or out of order.`;
  }
  if (entry.prev !== expectedPrev) {
    return `Entry ${expectedSeq} does not link to the entry before it (its prev hash differs).`;
  }
  if (entry.hash !== hashEntry(entry)) {
    return `Entry ${expectedSeq} was changed after it was written (its content does not match its hash).`;
  }
  return null;
}

export function broken(entries: number, brokenAt: AuditSeq, reason: string): ChainReport {
  return { ok: false, entries, brokenAt, reason };
}

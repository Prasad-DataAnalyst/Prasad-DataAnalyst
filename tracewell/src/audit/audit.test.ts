import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@tw/io';
import { AUDIT_GENESIS_PREFIX, type Actor, type AuditDraft, type AuditEntry } from '@tw/model';
import { AuditLog, genesisHash, hashEntry } from './index';

const USER: Actor = { kind: 'user', profileId: 'u_prasad', name: 'Prasad', role: 'Analyst' };
const ENGINE: Actor = { kind: 'system', component: 'engine' };

function at(i: number): string {
  return `2026-10-19T09:${String(i).padStart(2, '0')}:00.000Z`;
}

function draftFor(i: number): AuditDraft {
  if (i % 3 === 0) {
    return { action: 'check.run', target: { datasetId: 'd1' }, payload: { issues: i } };
  }
  if (i % 3 === 1) {
    return {
      action: 'cell.edit',
      target: { datasetId: 'd1', rowId: i, columnId: 'c2' },
      old: i,
      new: i + 0.5,
      reason: `Corrected value ${i} after checking the field sheet`,
    };
  }
  return { action: 'issue.accept', target: { datasetId: 'd2', rowId: i }, reason: 'Known shutdown period' };
}

function logOf(n: number, projectId = 'p_test'): AuditLog {
  const log = new AuditLog(projectId);
  for (let i = 1; i <= n; i++) log.append(draftFor(i), at(i), i % 3 === 0 ? ENGINE : USER);
  return log;
}

function lines(log: AuditLog): string[] {
  return log.toJsonl().split('\n').slice(0, -1);
}

function joinLines(ls: string[]): string {
  return ls.map((l) => `${l}\n`).join('');
}

/** Rewrites one field of line k (1-based) without resealing its hash, as a tamperer would. */
function tamperReason(ls: string[], k: number): string[] {
  const copy = [...ls];
  const entry = JSON.parse(copy[k - 1] as string) as AuditEntry;
  copy[k - 1] = JSON.stringify({ ...entry, reason: `${entry.reason ?? ''} (edited)` });
  return copy;
}

describe('AuditLog.append', () => {
  it('assigns seq 1..n, links prev to the previous hash and seals each entry with hashEntry', () => {
    const log = logOf(7);
    const entries = log.entries();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entries[0]?.prev).toBe(genesisHash('p_test'));
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.prev).toBe(entries[i - 1]?.hash);
    }
    for (const e of entries) expect(e.hash).toBe(hashEntry(e));
    expect(log.head).toEqual({ seq: 7, hash: entries[6]?.hash });
    expect(log.length).toBe(7);
  });

  it('starts empty at seq 0 with the genesis hash as head', () => {
    const log = new AuditLog('p_empty');
    expect(log.head).toEqual({ seq: 0, hash: genesisHash('p_empty') });
    expect(log.verify()).toEqual({ ok: true, entries: 0 });
    expect(log.toJsonl()).toBe('');
  });

  it('keeps the time and actor the caller supplies', () => {
    const log = new AuditLog('p_test');
    const entry = log.append(draftFor(1), '2026-01-02T03:04:05.006Z', USER);
    expect(entry.at).toBe('2026-01-02T03:04:05.006Z');
    expect(entry.actor).toEqual(USER);
  });

  it('refuses a malformed draft instead of writing an entry that would not round-trip', () => {
    const log = new AuditLog('p_test');
    const bad = { action: 'not.an.action', target: {} } as unknown as AuditDraft;
    expect(() => log.append(bad, at(1), USER)).toThrow(/audit entry/);
    expect(log.length).toBe(0);
  });

  it('detaches stored entries from the caller and freezes them deeply', () => {
    const log = new AuditLog('p_test');
    const payload = { nested: { count: 1 } };
    const entry = log.append({ action: 'check.run', target: {}, payload }, at(1), ENGINE);
    payload.nested.count = 99;
    expect(log.get(1)?.payload).toEqual({ nested: { count: 1 } });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.payload)).toBe(true);
    expect(() => {
      (entry as { reason?: string }).reason = 'changed';
    }).toThrow(TypeError);
  });
});

describe('genesis hash', () => {
  it('is SHA-256 of the prefix and the project id, so it differs per project', () => {
    expect(genesisHash('p_a')).toBe(sha256Hex(`${AUDIT_GENESIS_PREFIX}p_a`));
    expect(genesisHash('p_a')).not.toBe(genesisHash('p_b'));
  });

  it('makes an otherwise identical chain fail verification under another project id', () => {
    const text = logOf(3, 'p_a').toJsonl();
    expect(AuditLog.fromJsonl('p_a', text).report.ok).toBe(true);
    const other = AuditLog.fromJsonl('p_b', text).report;
    expect(other.ok).toBe(false);
    expect(other.brokenAt).toBe(1);
  });
});

describe('JSON Lines round trip', () => {
  it('toJsonl writes one canonical entry per line, each terminated by a newline', () => {
    const text = logOf(4).toJsonl();
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(5);
  });

  it('fromJsonl restores an identical, verified log', () => {
    const original = logOf(9);
    const { log, report } = AuditLog.fromJsonl('p_test', original.toJsonl());
    expect(report).toEqual({ ok: true, entries: 9 });
    expect(log.entries()).toEqual(original.entries());
    expect(log.toJsonl()).toBe(original.toJsonl());
    expect(log.head).toEqual(original.head);
  });

  it('accepts CRLF line endings written by a Windows editor', () => {
    const text = logOf(3).toJsonl().replace(/\n/g, '\r\n');
    expect(AuditLog.fromJsonl('p_test', text).report.ok).toBe(true);
  });

  it('continues the chain after loading', () => {
    const { log } = AuditLog.fromJsonl('p_test', logOf(3).toJsonl());
    const next = log.append(draftFor(4), at(4), USER);
    expect(next.seq).toBe(4);
    expect(log.verify().ok).toBe(true);
  });
});

describe('tamper evidence', () => {
  const N = 9;
  const base = lines(logOf(N));

  it.each([1, 5, N])('a changed reason in line %i is reported at that seq', (k) => {
    // Lines 3, 6 and 9 are check.run entries without a reason; tampering adds one, which also breaks the hash.
    const { log, report } = AuditLog.fromJsonl('p_test', joinLines(tamperReason(base, k)));
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(k);
    expect(report.reason).toMatch(/changed after it was written/);
    expect(log.length).toBe(N);
  });

  it('a deleted line is reported where the gap appears', () => {
    const ls = [...base];
    ls.splice(3, 1);
    const { report } = AuditLog.fromJsonl('p_test', joinLines(ls));
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(4);
  });

  it('two swapped lines are reported at the first of them', () => {
    const ls = [...base];
    [ls[4], ls[5]] = [ls[5] as string, ls[4] as string];
    const { report } = AuditLog.fromJsonl('p_test', joinLines(ls));
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(5);
  });

  it('an appended forged line with a wrong prev is reported at its seq', () => {
    const forgedBody = {
      ...draftFor(1),
      seq: N + 1,
      at: at(N + 1),
      actor: USER,
      prev: '0'.repeat(64),
    };
    const forged = { ...forgedBody, hash: hashEntry(forgedBody) };
    const { report } = AuditLog.fromJsonl('p_test', joinLines([...base, JSON.stringify(forged)]));
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(N + 1);
    expect(report.reason).toMatch(/does not link/);
  });

  it('an unreadable line is reported at its position while the readable entries are kept', () => {
    const ls = [...base];
    ls[2] = '{not json';
    const { log, report } = AuditLog.fromJsonl('p_test', joinLines(ls));
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(3);
    expect(log.length).toBe(N - 1);
  });

  it('a well-formed JSON line that is not an audit entry is reported', () => {
    const ls = [...base];
    ls[6] = '{"hello":"world"}';
    const { report } = AuditLog.fromJsonl('p_test', joinLines(ls));
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(7);
  });

  it('a blank line in the middle counts as a missing entry', () => {
    const ls = [...base];
    ls.splice(2, 0, '');
    const { report } = AuditLog.fromJsonl('p_test', joinLines(ls));
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toBe(3);
  });
});

describe('query', () => {
  const log = logOf(12);

  it('filters by action', () => {
    const page = log.query({ action: ['cell.edit'] });
    expect(page.items.every((e) => e.action === 'cell.edit')).toBe(true);
    expect(page.total).toBe(4);
  });

  it('treats an empty action list as any action', () => {
    expect(log.query({ action: [] }).total).toBe(12);
  });

  it('filters by dataset and row', () => {
    expect(log.query({ datasetId: 'd2' }).items.map((e) => e.seq)).toEqual([2, 5, 8, 11]);
    expect(log.query({ datasetId: 'd1', rowId: 7 }).items.map((e) => e.seq)).toEqual([7]);
  });

  it('pages in ascending order by default and descending on request', () => {
    const first = log.query({ limit: 5 });
    expect(first.items.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(first.total).toBe(12);
    const second = log.query({ limit: 5, offset: 5 });
    expect(second.items.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
    expect(second.offset).toBe(5);
    const desc = log.query({ order: 'desc', limit: 3 });
    expect(desc.items.map((e) => e.seq)).toEqual([12, 11, 10]);
  });

  it('starts from a given seq', () => {
    expect(log.query({ fromSeq: 10 }).items.map((e) => e.seq)).toEqual([10, 11, 12]);
  });

  it('rejects negative, fractional or oversized paging values with a fix', () => {
    expect(() => log.query({ offset: -1 })).toThrow(/offset/);
    expect(() => log.query({ limit: 2.5 })).toThrow(/limit/);
    expect(() => log.query({ limit: 100_000 })).toThrow(/limit/);
  });

  it('does not let the caller reorder the log through a desc query', () => {
    log.query({ order: 'desc' });
    expect(log.entries().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('append-only guarantees (FR-AUD-02)', () => {
  it('offers no method to update, delete, remove, clear or truncate entries', () => {
    const methods = Object.getOwnPropertyNames(AuditLog.prototype);
    const mutating = methods.filter((m) => /update|delete|remove|clear|truncate|splice|set|pop|shift/i.test(m));
    expect(mutating).toEqual([]);
  });

  it('entries() returns a frozen copy, so mutating it throws in strict mode', () => {
    const log = logOf(3);
    const entries = log.entries();
    expect(Object.isFrozen(entries)).toBe(true);
    expect(() => (entries as AuditEntry[]).pop()).toThrow(TypeError);
    expect(log.length).toBe(3);
  });

  it('get returns entries by seq and undefined for an unknown seq', () => {
    const log = logOf(3);
    expect(log.get(2)?.seq).toBe(2);
    expect(log.get(4)).toBeUndefined();
    expect(log.get(0)).toBeUndefined();
  });
});

describe('conformance vector chain-10', () => {
  const text = readFileSync(new URL('./__fixtures__/chain-10.jsonl', import.meta.url), 'utf8');
  const expected = JSON.parse(
    readFileSync(new URL('./__fixtures__/chain-10.expected.json', import.meta.url), 'utf8'),
  ) as { projectId: string; head: { seq: number; hash: string } };

  it('verifies and has the expected head hash', () => {
    const { log, report } = AuditLog.fromJsonl(expected.projectId, text);
    expect(report).toEqual({ ok: true, entries: 10 });
    expect(log.head).toEqual(expected.head);
  });

  it('re-encodes byte for byte', () => {
    const { log } = AuditLog.fromJsonl(expected.projectId, text);
    expect(log.toJsonl()).toBe(text);
  });
});

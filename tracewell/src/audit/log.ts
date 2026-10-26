/**
 * The project's audit log (SAD section 9): append-only and SHA-256 hash-chained. The class offers
 * no way to change or remove an entry (FR-AUD-02); undo is a compensating `entry.revert` entry
 * appended by the engine. Entries are deep-frozen, so callers cannot edit them in place either.
 */
import {
  EngineError,
  canonicalJson,
  schemas,
  type Actor,
  type AuditDraft,
  type AuditEntry,
  type AuditQuery,
  type AuditSeq,
  type ChainReport,
  type IsoUtc,
  type JsonValue,
  type Page,
  type ProjectId,
  type Sha256Hex,
} from '@tw/model';
import { broken, verifyChain } from './chain';
import { genesisHash, hashEntry } from './hash';
import { decodeJsonl, encodeJsonl } from './jsonl';
import { queryEntries } from './query';

export class AuditLog {
  readonly projectId: ProjectId;
  readonly #genesis: Sha256Hex;
  readonly #entries: AuditEntry[] = [];

  constructor(projectId: ProjectId) {
    this.projectId = projectId;
    this.#genesis = genesisHash(projectId);
  }

  /**
   * Reads a log written by toJsonl. Every well-formed entry is kept even when the chain is broken,
   * so a tampered project can still be opened read-only and inspected; the report says where the
   * chain first fails, whether at an unreadable line or at a link that does not verify.
   */
  static fromJsonl(projectId: ProjectId, text: string): { log: AuditLog; report: ChainReport } {
    const decoded = decodeJsonl(text);
    const log = new AuditLog(projectId);
    for (const entry of decoded.entries) log.#entries.push(deepFreeze(entry));
    const chain = log.verify();
    const bad = decoded.firstBadLine;
    const report =
      bad !== undefined && (chain.ok || (chain.brokenAt ?? Infinity) >= bad.at)
        ? broken(log.length, bad.at, bad.reason)
        : chain;
    return { log, report };
  }

  /**
   * Adds an entry after the current head. The time and actor come from the caller because the
   * engine owns the injected clock and the session profile; content rules such as the minimum
   * reason length are also the engine's, while this method refuses anything that would not
   * survive a JSON Lines round trip unchanged.
   */
  append(draft: AuditDraft, at: IsoUtc, actor: Actor): AuditEntry {
    const head = this.head;
    const unsealed = { ...draft, seq: head.seq + 1, at, actor, prev: head.hash };
    const entry = normalise({ ...unsealed, hash: hashEntry(unsealed) });
    this.#entries.push(entry);
    return entry;
  }

  /** The last entry's seq and hash; seq 0 and the genesis hash while the log is empty. */
  get head(): { seq: AuditSeq; hash: Sha256Hex } {
    const last = this.#entries[this.#entries.length - 1];
    return last === undefined ? { seq: 0, hash: this.#genesis } : { seq: last.seq, hash: last.hash };
  }

  get length(): number {
    return this.#entries.length;
  }

  entries(): readonly AuditEntry[] {
    return Object.freeze([...this.#entries]);
  }

  get(seq: AuditSeq): AuditEntry | undefined {
    // On an intact chain entry n sits at index n - 1; a broken one loaded read-only needs a scan.
    const direct = this.#entries[seq - 1];
    if (direct?.seq === seq) return direct;
    return this.#entries.find((e) => e.seq === seq);
  }

  query(q: AuditQuery): Page<AuditEntry> {
    return queryEntries(this.#entries, q);
  }

  verify(): ChainReport {
    return verifyChain(this.#entries, this.#genesis);
  }

  toJsonl(): string {
    return encodeJsonl(this.#entries);
  }
}

/**
 * Detaches the entry from the caller's objects and puts it in the exact form a JSON round trip
 * produces (for example -0 becomes 0), so the stored entry, its hash and its JSONL line agree.
 */
function normalise(candidate: AuditEntry): AuditEntry {
  const roundTripped: unknown = JSON.parse(canonicalJson(candidate as unknown as JsonValue));
  const checked = schemas.auditEntry.safeParse(roundTripped);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? 'entry' : issue.path.join('.');
    throw new EngineError(
      'INVALID_INPUT',
      `The audit entry is not well formed at ${where}: ${issue?.message ?? 'invalid value'}.`,
      'Correct the entry so it matches the audit entry schema before appending it.',
      { path: where },
    );
  }
  return deepFreeze(checked.data);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The two digests that define the audit chain (SAD sections 9.1 and 9.4). Every engine and the
 * Python oracles compute them the same way, so they are kept apart from the log's bookkeeping.
 */
import { sha256Hex } from '@tw/io';
import {
  AUDIT_GENESIS_PREFIX,
  canonicalJson,
  type AuditEntry,
  type JsonValue,
  type ProjectId,
  type Sha256Hex,
} from '@tw/model';

/** The `prev` of a project's first entry: SHA-256(AUDIT_GENESIS_PREFIX + projectId). */
export function genesisHash(projectId: ProjectId): Sha256Hex {
  return sha256Hex(AUDIT_GENESIS_PREFIX + projectId);
}

/**
 * SHA-256(utf8(canonicalJson(entry without hash))). A stray `hash` key is ignored rather than
 * hashed, so passing a whole entry gives the same digest as passing its draft form.
 */
export function hashEntry(e: Omit<AuditEntry, 'hash'>): Sha256Hex {
  const { hash: _ignored, ...rest } = e as Omit<AuditEntry, 'hash'> & { hash?: unknown };
  return sha256Hex(canonicalJson(rest as unknown as JsonValue));
}

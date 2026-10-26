// Public entry point of the audit module, imported elsewhere as '@tw/audit': the append-only,
// SHA-256 hash-chained audit log and the two digests that define its chain.

export { genesisHash, hashEntry } from './hash';
export { AuditLog } from './log';

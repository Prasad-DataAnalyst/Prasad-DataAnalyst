/**
 * Test-only helpers for the ZIP tests: an independent walk over the archives writeZip produces
 * (which have no extra fields, comments or data descriptors), byte patching to craft damaged and
 * malicious archives, a ZIP64 rewriter, and access to the Python oracle.
 */
import { spawnSync } from 'node:child_process';

export interface CentralRecord {
  /** Offset of the central directory header. */
  at: number;
  /** Offset of the matching local header. */
  localAt: number;
  name: string;
  method: number;
  compressedSize: number;
  size: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The central directory records of an archive written by writeZip (no archive comment). */
export function centralRecords(zip: Uint8Array): CentralRecord[] {
  const v = view(zip);
  const end = zip.length - 22;
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const records: CentralRecord[] = [];
  for (let i = 0; i < count; i++) {
    const nameLength = v.getUint16(at + 28, true);
    records.push({
      at,
      localAt: v.getUint32(at + 42, true),
      name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)),
      method: v.getUint16(at + 10, true),
      compressedSize: v.getUint32(at + 20, true),
      size: v.getUint32(at + 24, true),
    });
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return records;
}

/** The raw (possibly compressed) data of an entry, located through its local header. */
export function rawData(zip: Uint8Array, record: CentralRecord): Uint8Array {
  const v = view(zip);
  const start = record.localAt + 30 + v.getUint16(record.localAt + 26, true) + v.getUint16(record.localAt + 28, true);
  return zip.subarray(start, start + record.compressedSize);
}

/**
 * Inserts `extra` bytes after the data of the only entry of a one-entry archive and grows its
 * compressed size to cover them, as a producer that miscounts (or an attacker) would.
 */
export function padCompressedData(zip: Uint8Array, extra: number): Uint8Array {
  const records = centralRecords(zip);
  const [record] = records;
  if (record === undefined || records.length !== 1) throw new Error('padCompressedData expects a one-entry archive');
  const dataEnd = rawData(zip, record).byteOffset - zip.byteOffset + record.compressedSize;
  const out = new Uint8Array(zip.length + extra).fill(0xa5, dataEnd, dataEnd + extra);
  out.set(zip.subarray(0, dataEnd));
  out.set(zip.subarray(dataEnd), dataEnd + extra);
  const v = view(out);
  const compressedSize = record.compressedSize + extra;
  v.setUint32(record.localAt + 18, compressedSize, true);
  v.setUint32(record.at + extra + 20, compressedSize, true);
  v.setUint32(out.length - 22 + 16, record.at + extra, true);
  return out;
}

export function withU16(zip: Uint8Array, at: number, value: number): Uint8Array {
  const copy = zip.slice();
  view(copy).setUint16(at, value, true);
  return copy;
}

export function withU32(zip: Uint8Array, at: number, value: number): Uint8Array {
  const copy = zip.slice();
  view(copy).setUint32(at, value, true);
  return copy;
}

/** Sets a field in both the central header and the local header of an entry. */
export function patchBoth(
  zip: Uint8Array,
  record: CentralRecord,
  field: 'flags' | 'method' | 'size',
  value: number,
): Uint8Array {
  if (field === 'size') return withU32(withU32(zip, record.at + 24, value), record.localAt + 22, value);
  const offset = field === 'flags' ? 8 : 10;
  return withU16(withU16(zip, record.at + offset, value), record.localAt + offset - 2, value);
}

/** Replaces an entry's name bytes (same length) in both headers. */
export function renameBoth(zip: Uint8Array, record: CentralRecord, name: Uint8Array): Uint8Array {
  const copy = zip.slice();
  copy.set(name, record.at + 46);
  copy.set(name, record.localAt + 30);
  return copy;
}

function u64(v: DataView, at: number, value: number): void {
  v.setUint32(at, value % 0x1_0000_0000, true);
  v.setUint32(at + 4, Math.floor(value / 0x1_0000_0000), true);
}

/**
 * Rewrites an archive from writeZip into ZIP64 form: every central header moves its sizes and
 * local offset into a ZIP64 extra field, and a ZIP64 end record and locator precede an end record
 * whose fields are all at their maximum.
 */
export function toZip64(zip: Uint8Array): Uint8Array {
  const records = centralRecords(zip);
  const v = view(zip);
  const directoryStart = v.getUint32(zip.length - 22 + 16, true);
  const headers = records.map((r) => {
    const nameLength = v.getUint16(r.at + 28, true);
    const header = new Uint8Array(46 + nameLength + 28);
    header.set(zip.subarray(r.at, r.at + 46 + nameLength));
    const h = view(header);
    h.setUint32(20, 0xffffffff, true);
    h.setUint32(24, 0xffffffff, true);
    h.setUint32(42, 0xffffffff, true);
    h.setUint16(30, 28, true);
    const extra = 46 + nameLength;
    h.setUint16(extra, 0x0001, true);
    h.setUint16(extra + 2, 24, true);
    u64(h, extra + 4, r.size);
    u64(h, extra + 12, r.compressedSize);
    u64(h, extra + 20, r.localAt);
    return header;
  });
  const directorySize = headers.reduce((n, h) => n + h.length, 0);
  const out = new Uint8Array(directoryStart + directorySize + 56 + 20 + 22);
  out.set(zip.subarray(0, directoryStart));
  let at = directoryStart;
  for (const header of headers) {
    out.set(header, at);
    at += header.length;
  }
  const o = view(out);
  const record64 = at;
  o.setUint32(at, 0x06064b50, true);
  u64(o, at + 4, 56 - 12);
  o.setUint16(at + 12, 45, true);
  o.setUint16(at + 14, 45, true);
  u64(o, at + 24, records.length);
  u64(o, at + 32, records.length);
  u64(o, at + 40, directorySize);
  u64(o, at + 48, directoryStart);
  at += 56;
  o.setUint32(at, 0x07064b50, true);
  u64(o, at + 8, record64);
  o.setUint32(at + 16, 1, true);
  at += 20;
  o.setUint32(at, 0x06054b50, true);
  o.setUint16(at + 8, 0xffff, true);
  o.setUint16(at + 10, 0xffff, true);
  o.setUint32(at + 12, 0xffffffff, true);
  o.setUint32(at + 16, 0xffffffff, true);
  return out;
}

export const PYTHON_AVAILABLE = spawnSync('python3', ['--version']).status === 0;

/** Runs a Python script in isolated mode; stdout is returned as bytes, failures throw with stderr. */
export function runPython(lines: readonly string[], args: readonly string[] = []): Uint8Array {
  const result = spawnSync('python3', ['-I', '-c', lines.join('\n'), ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`python3 failed: ${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}

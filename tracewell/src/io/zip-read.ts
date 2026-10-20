/**
 * Guarded ZIP reading for XLSX workbooks, `.twp` projects and export packages (SAD section 12).
 *
 * The central directory is parsed and checked when the archive is opened: entry count, total
 * declared size, encryption, compression methods, local headers and duplicate names. Entries are
 * inflated only when read, never beyond their declared size, and checked against their CRC-32, so
 * a zip bomb fails with a clear error instead of exhausting memory.
 */
import { EngineError, type JsonValue } from '@tw/model';
import { crc32 } from './crc32';
import { formatCount, invalidArgument } from './errors';
import { inflateExact } from './inflate';
import { decodeCp437 } from './cp437';
import {
  CENTRAL_HEADER_BYTES,
  END_OF_CENTRAL_DIR_BYTES,
  EXTRA_ZIP64,
  FLAG_ENCRYPTED,
  FLAG_STRONG_ENCRYPTION,
  FLAG_UTF8_NAME,
  LOCAL_HEADER_BYTES,
  MAX_COMMENT_BYTES,
  MAX_U16,
  MAX_U32,
  METHOD_DEFLATE,
  METHOD_STORED,
  SIG_CENTRAL_HEADER,
  SIG_END_OF_CENTRAL_DIR,
  SIG_LOCAL_HEADER,
  SIG_ZIP64_END_OF_CENTRAL_DIR,
  SIG_ZIP64_LOCATOR,
  ZIP64_END_OF_CENTRAL_DIR_BYTES,
  ZIP64_LOCATOR_BYTES,
} from './zip-format';

export interface ZipReader {
  /** Paths of the file entries in archive order; directory entries are left out. */
  paths(): string[];
  has(path: string): boolean;
  /** Declared uncompressed size; read() fails if the data does not match it. */
  size(path: string): number;
  /** The entry's bytes, inflated and checked against its CRC-32. Each call returns a new array. */
  read(path: string): Uint8Array;
  /** The entry decoded as UTF-8, without a leading byte-order mark. */
  readText(path: string): string;
}

export interface ZipReadOptions {
  /** Cap on the total declared uncompressed size of all entries; default 2 GiB. */
  maxInflatedBytes?: number;
  /** Cap on the number of entries in the central directory; default 10,000. */
  maxEntries?: number;
}

const DEFAULT_MAX_INFLATED_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_ENTRIES = 10_000;

interface Entry {
  path: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's compressed data, just after its local header. */
  dataStart: number;
}

interface Directory {
  count: number;
  offset: number;
  size: number;
  /** Where the central directory must end: the ZIP64 end record or the end record. */
  limit: number;
}

// ---------------------------------------------------------------------------------------------
// Errors

const DAMAGED_FIX =
  'The file was damaged or changed after it was written, or it was not written by a ZIP tool. ' +
  'Use an intact copy of the file, for example the original from its source.';
const UNSUPPORTED_FIX =
  'Save the file again with a standard ZIP tool or with the program that created it, without encryption ' +
  'or a password, then open the new copy.';
const LIMIT_FIX =
  'This limit protects against malicious archives (zip bombs). If the file is genuine, split its contents ' +
  'into smaller files and open those.';

const MULTI_DISK = 'The archive is split across several files (a multi-disk ZIP), which cannot be read.';

function damaged(message: string, detail?: JsonValue): EngineError {
  return new EngineError('PROJECT_INVALID', `The archive is damaged: ${message}`, DAMAGED_FIX, detail);
}

function unsupported(message: string, detail?: JsonValue): EngineError {
  return new EngineError('FORMAT_UNSUPPORTED', message, UNSUPPORTED_FIX, detail);
}

function overLimit(message: string, detail: JsonValue): EngineError {
  return new EngineError('PROJECT_INVALID', message, LIMIT_FIX, detail);
}

// ---------------------------------------------------------------------------------------------
// Opening

/**
 * Opens a ZIP archive held in memory.
 * Throws EngineError('FORMAT_UNSUPPORTED') when the bytes are not a ZIP archive or use encryption,
 * multiple disks or a compression method other than STORED and DEFLATE; and
 * EngineError('PROJECT_INVALID') when the structure is damaged, a name is duplicated, or the
 * entry count or total declared size exceeds its cap.
 */
export function readZip(data: Uint8Array, o: ZipReadOptions = {}): ZipReader {
  const maxInflatedBytes = limit(o.maxInflatedBytes, DEFAULT_MAX_INFLATED_BYTES, 'maxInflatedBytes');
  const maxEntries = limit(o.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const directory = locateDirectory(data, view);
  if (directory.count > maxEntries) {
    throw overLimit(
      `The archive has ${formatCount(directory.count)} entries, more than the limit of ${formatCount(maxEntries)}.`,
      { reason: 'entry-count', entries: directory.count, limit: maxEntries },
    );
  }
  const entries = parseCentralDirectory(data, view, directory);
  checkInflatedTotal(entries, maxInflatedBytes);
  return reader(data, entries);
}

function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidArgument(`The ZIP option ${name} must be a whole number of zero or more.`, { [name]: String(value) });
  }
  return value;
}

function checkInflatedTotal(entries: readonly Entry[], maxInflatedBytes: number): void {
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= maxInflatedBytes) return;
  throw overLimit(
    `The archive would expand to ${formatCount(total)} bytes, more than the limit of ` +
      `${formatCount(maxInflatedBytes)} bytes.`,
    { reason: 'inflated-size', declaredBytes: total, limit: maxInflatedBytes },
  );
}

// ---------------------------------------------------------------------------------------------
// End of central directory

function locateDirectory(data: Uint8Array, view: DataView): Directory {
  const end = findEndRecord(data, view);
  if (end < 0) throw unsupported('The file is not a ZIP archive: it has no ZIP end-of-central-directory record.');
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const countOnDisk = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  if (disk !== 0 || directoryDisk !== 0 || countOnDisk !== count) {
    throw unsupported(MULTI_DISK);
  }
  const directory = hasZip64Locator(view, end)
    ? zip64Directory(view, end)
    : { count, offset: view.getUint32(end + 16, true), size: view.getUint32(end + 12, true), limit: end };
  if (directory.offset + directory.size > directory.limit) {
    throw damaged('the central directory lies outside the file.', { offset: directory.offset, size: directory.size });
  }
  return directory;
}

/** Searches backwards, because the end record is followed only by the archive comment. */
function findEndRecord(data: Uint8Array, view: DataView): number {
  const last = data.length - END_OF_CENTRAL_DIR_BYTES;
  const first = Math.max(0, last - MAX_COMMENT_BYTES);
  for (let at = last; at >= first; at--) {
    if (view.getUint32(at, true) !== SIG_END_OF_CENTRAL_DIR) continue;
    // A signature inside the comment would claim a comment running past the end of the file.
    if (at + END_OF_CENTRAL_DIR_BYTES + view.getUint16(at + 20, true) <= data.length) return at;
  }
  return -1;
}

function hasZip64Locator(view: DataView, end: number): boolean {
  const at = end - ZIP64_LOCATOR_BYTES;
  return at >= 0 && view.getUint32(at, true) === SIG_ZIP64_LOCATOR;
}

function zip64Directory(view: DataView, end: number): Directory {
  const locator = end - ZIP64_LOCATOR_BYTES;
  if (view.getUint32(locator + 4, true) !== 0 || view.getUint32(locator + 16, true) > 1) {
    throw unsupported(MULTI_DISK);
  }
  const record = readU64(view, locator + 8);
  if (
    record + ZIP64_END_OF_CENTRAL_DIR_BYTES > locator ||
    view.getUint32(record, true) !== SIG_ZIP64_END_OF_CENTRAL_DIR
  ) {
    throw damaged('the ZIP64 end-of-central-directory record is missing or misplaced.', { offset: record });
  }
  const countOnDisk = readU64(view, record + 24);
  const count = readU64(view, record + 32);
  if (view.getUint32(record + 16, true) !== 0 || view.getUint32(record + 20, true) !== 0 || countOnDisk !== count) {
    throw unsupported(MULTI_DISK);
  }
  return { count, size: readU64(view, record + 40), offset: readU64(view, record + 48), limit: record };
}

/** Little-endian unsigned 64-bit value; anything beyond 2^53 cannot be a real offset in memory. */
function readU64(view: DataView, at: number): number {
  const low = view.getUint32(at, true);
  const high = view.getUint32(at + 4, true);
  if (high > 0x1fffff) throw damaged('a 64-bit size or offset is impossibly large.', { offset: at });
  return high * 0x1_0000_0000 + low;
}

// ---------------------------------------------------------------------------------------------
// Central directory

function parseCentralDirectory(data: Uint8Array, view: DataView, directory: Directory): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const end = directory.offset + directory.size;
  let pos = directory.offset;
  for (let i = 0; i < directory.count; i++) {
    if (pos + CENTRAL_HEADER_BYTES > end || view.getUint32(pos, true) !== SIG_CENTRAL_HEADER) {
      throw damaged(`central directory entry ${i + 1} of ${directory.count} is missing or malformed.`, { offset: pos });
    }
    const header = readCentralHeader(data, view, pos, end);
    pos = header.next;
    if (seen.has(header.entry.path)) {
      throw damaged(`the entry "${header.entry.path}" appears more than once.`, { path: header.entry.path });
    }
    seen.add(header.entry.path);
    if (!header.isDirectory) entries.push(header.entry);
  }
  return entries;
}

interface CentralHeader {
  entry: Entry;
  isDirectory: boolean;
  next: number;
}

function readCentralHeader(data: Uint8Array, view: DataView, pos: number, end: number): CentralHeader {
  const flags = view.getUint16(pos + 8, true);
  const method = view.getUint16(pos + 10, true);
  const nameStart = pos + CENTRAL_HEADER_BYTES;
  const nameEnd = nameStart + view.getUint16(pos + 28, true);
  const extraEnd = nameEnd + view.getUint16(pos + 30, true);
  const next = extraEnd + view.getUint16(pos + 32, true);
  if (next > end) throw damaged('a central directory entry runs past the end of the directory.', { offset: pos });

  const nameBytes = data.subarray(nameStart, nameEnd);
  const path = decodeName(nameBytes, flags);
  checkSupported(path, flags, method);
  const sizes = entrySizes(view, pos, path, method, data.subarray(nameEnd, extraEnd));
  const dataStart = locateData(data, view, sizes.localOffset, nameBytes, method, path);
  if (dataStart + sizes.compressedSize > data.length) {
    throw damaged(`the data of entry "${path}" runs past the end of the file.`, { path });
  }
  const entry: Entry = {
    path,
    method,
    crc: view.getUint32(pos + 16, true),
    compressedSize: sizes.compressedSize,
    size: sizes.size,
    dataStart,
  };
  return { entry, isDirectory: path.endsWith('/') && sizes.size === 0, next };
}

/** Sizes and local header offset of the central header at `pos`, taking a ZIP64 extra field into account. */
function entrySizes(view: DataView, pos: number, path: string, method: number, extra: Uint8Array): Sizes {
  const sizes = withZip64Extra(path, extra, {
    compressedSize: view.getUint32(pos + 20, true),
    size: view.getUint32(pos + 24, true),
    localOffset: view.getUint32(pos + 42, true),
    diskStart: view.getUint16(pos + 34, true),
  });
  if (sizes.diskStart !== 0) throw unsupported(MULTI_DISK);
  if (method === METHOD_STORED && sizes.compressedSize !== sizes.size) {
    throw damaged(`the stored entry "${path}" has different compressed and uncompressed sizes.`, { path });
  }
  return sizes;
}

function checkSupported(path: string, flags: number, method: number): void {
  if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
    throw unsupported(`The archive entry "${path}" is encrypted, which is not supported.`, { path });
  }
  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    throw unsupported(
      `The archive entry "${path}" uses compression method ${method}; only STORED (0) and DEFLATE (8) are supported.`,
      { path, method },
    );
  }
}

/**
 * Bit 11 marks a UTF-8 name. Without it the APPNOTE says CP437, but many tools write UTF-8 without
 * setting the bit, so a name that is valid UTF-8 is read as UTF-8 and anything else as CP437.
 */
function decodeName(bytes: Uint8Array, flags: number): string {
  const utf8 = decodeUtf8Strict(bytes);
  if (utf8 !== null) return utf8;
  if ((flags & FLAG_UTF8_NAME) !== 0) throw damaged('an entry name marked as UTF-8 is not valid UTF-8.');
  return decodeCp437(bytes);
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

interface Sizes {
  compressedSize: number;
  size: number;
  localOffset: number;
  diskStart: number;
}

/**
 * Fields set to their maximum (0xFFFFFFFF, or 0xFFFF for the disk) are stored in the ZIP64 extra
 * field instead, as 64-bit values in a fixed order, each present only when its field is maxed.
 */
function withZip64Extra(path: string, extra: Uint8Array, sizes: Sizes): Sizes {
  const needs = [sizes.size === MAX_U32, sizes.compressedSize === MAX_U32, sizes.localOffset === MAX_U32];
  if (!needs.includes(true) && sizes.diskStart !== MAX_U16) return sizes;
  const field = findExtraField(extra, EXTRA_ZIP64);
  if (field === null) throw damaged(`the entry "${path}" needs a ZIP64 extra field but has none.`, { path });
  const view = new DataView(field.buffer, field.byteOffset, field.byteLength);
  const values: number[] = [];
  let at = 0;
  for (const needed of needs) {
    if (!needed) {
      values.push(-1);
      continue;
    }
    if (at + 8 > field.length) throw damaged(`the ZIP64 extra field of entry "${path}" is too short.`, { path });
    values.push(readU64(view, at));
    at += 8;
  }
  const [size = -1, compressedSize = -1, localOffset = -1] = values;
  return {
    size: size >= 0 ? size : sizes.size,
    compressedSize: compressedSize >= 0 ? compressedSize : sizes.compressedSize,
    localOffset: localOffset >= 0 ? localOffset : sizes.localOffset,
    diskStart: sizes.diskStart === MAX_U16 && at + 4 <= field.length ? view.getUint32(at, true) : sizes.diskStart,
  };
}

/** The data of the extra field with header ID `id`, or null. Extra fields are (id, length, data) records. */
function findExtraField(extra: Uint8Array, id: number): Uint8Array | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let at = 0; at + 4 <= extra.length;) {
    const length = view.getUint16(at + 2, true);
    if (view.getUint16(at, true) === id) return extra.subarray(at + 4, Math.min(at + 4 + length, extra.length));
    at += 4 + length;
  }
  return null;
}

/**
 * Checks the local header that precedes an entry's data and returns where the data starts. The
 * local name must equal the central one, so every ZIP reader sees the same entry under one name.
 */
function locateData(
  data: Uint8Array,
  view: DataView,
  offset: number,
  name: Uint8Array,
  method: number,
  path: string,
): number {
  if (offset + LOCAL_HEADER_BYTES > data.length || view.getUint32(offset, true) !== SIG_LOCAL_HEADER) {
    throw damaged(`the local header of entry "${path}" is missing.`, { path, offset });
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const localName = data.subarray(offset + LOCAL_HEADER_BYTES, offset + LOCAL_HEADER_BYTES + nameLength);
  if (view.getUint16(offset + 8, true) !== method || !sameBytes(localName, name)) {
    throw damaged(`the local header of entry "${path}" does not match the central directory.`, { path });
  }
  return offset + LOCAL_HEADER_BYTES + nameLength + extraLength;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

// ---------------------------------------------------------------------------------------------
// Reading entries

const textDecoder = new TextDecoder('utf-8', { fatal: true });

function reader(data: Uint8Array, entries: readonly Entry[]): ZipReader {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const entry = (path: string): Entry => {
    const found = byPath.get(path);
    if (found === undefined) {
      throw new EngineError(
        'NOT_FOUND',
        `The archive has no entry named "${path}".`,
        'Check that the file is of the expected kind and was saved completely.',
        { path },
      );
    }
    return found;
  };
  const read = (path: string): Uint8Array => inflateEntry(data, entry(path));
  return {
    paths: () => entries.map((e) => e.path),
    has: (path) => byPath.has(path),
    size: (path) => entry(path).size,
    read,
    readText(path: string): string {
      try {
        return textDecoder.decode(read(path));
      } catch (e) {
        if (e instanceof EngineError) throw e;
        throw damaged(`the entry "${path}" is not valid UTF-8 text.`, { path });
      }
    },
  };
}

function inflateEntry(data: Uint8Array, entry: Entry): Uint8Array {
  const compressed = data.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  const bytes = entry.method === METHOD_STORED ? compressed.slice() : inflated(compressed, entry);
  if (crc32(bytes) !== entry.crc) {
    throw damaged(`the entry "${entry.path}" fails its CRC-32 check.`, { path: entry.path });
  }
  return bytes;
}

function inflated(compressed: Uint8Array, entry: Entry): Uint8Array {
  const outcome = inflateExact(compressed, entry.size);
  const detail = { path: entry.path, declaredBytes: entry.size };
  switch (outcome.kind) {
    case 'ok':
      return outcome.data;
    case 'oversize':
      throw overLimit(
        `The archive entry "${entry.path}" expands to more than its declared ${formatCount(entry.size)} bytes.`,
        { ...detail, reason: 'entry-oversize' },
      );
    case 'undersize':
      throw damaged(
        `the entry "${entry.path}" expands to ${formatCount(outcome.actual)} bytes, not the declared ` +
          `${formatCount(entry.size)}.`,
        { ...detail, actualBytes: outcome.actual },
      );
    case 'corrupt':
      throw damaged(`the compressed data of entry "${entry.path}" cannot be decoded (${outcome.reason}).`, detail);
  }
}

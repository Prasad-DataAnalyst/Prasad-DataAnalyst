/**
 * Deterministic ZIP writing for XLSX workbooks, `.twp` projects and export packages (SAD sections
 * 10.4 and 11). The same entries always give the same bytes, in Node and in the browser: a fixed
 * 1980-01-01 timestamp, no extra fields, no host-specific attributes, and DEFLATE level 6 from
 * fflate, which is pure JavaScript.
 *
 * The container is written here rather than by fflate's zipSync because zipSync converts entry
 * times with local-time getters, which would make the bytes depend on the machine's time zone.
 */
import { deflateSync } from 'fflate';
import { utf8 } from '@tw/model';
import { crc32 } from './crc32';
import { formatCount, invalidArgument } from './errors';
import { comparePaths, hasLoneSurrogate } from './paths';
import {
  CENTRAL_HEADER_BYTES,
  DOS_DATE_1980_01_01,
  DOS_TIME_MIDNIGHT,
  END_OF_CENTRAL_DIR_BYTES,
  FLAG_UTF8_NAME,
  LOCAL_HEADER_BYTES,
  MAX_U16,
  MAX_U32,
  METHOD_DEFLATE,
  METHOD_STORED,
  SIG_CENTRAL_HEADER,
  SIG_END_OF_CENTRAL_DIR,
  SIG_LOCAL_HEADER,
  VERSION_DEFLATE,
  VERSION_MADE_BY,
  VERSION_STORED,
} from './zip-format';

export interface ZipEntryInput {
  /** Forward-slash path inside the archive, such as 'xl/workbook.xml'. */
  path: string;
  data: Uint8Array;
  /** Store without compression: originals in a `.twp`, and the `mimetype` entry that must come first. */
  store?: boolean;
}

interface PreparedEntry {
  name: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  size: number;
  payload: Uint8Array;
}

/**
 * Builds a ZIP archive. Entries are written in the caller's order unless `sort` is set, in which
 * case they are ordered by path (Unicode code point order).
 * Throws EngineError('INVALID_INPUT') for an empty, absolute, backslashed, dot-segment, duplicate
 * or not well-formed (lone surrogate) path, and for archives that would need ZIP64 (4 GiB or
 * 65,535 entries).
 */
export function writeZip(entries: ZipEntryInput[], o: { sort?: boolean } = {}): Uint8Array {
  const ordered = o.sort === true ? [...entries].sort((a, b) => comparePaths(a.path, b.path)) : entries;
  if (ordered.length >= MAX_U16) {
    throw invalidArgument(`A ZIP archive without ZIP64 holds fewer than 65,535 entries; ${ordered.length} were given.`);
  }
  const seen = new Set<string>();
  return assemble(ordered.map((entry) => prepare(entry, seen)));
}

function prepare(entry: ZipEntryInput, seen: Set<string>): PreparedEntry {
  checkEntryPath(entry.path, seen);
  const name = utf8(entry.path);
  if (name.length > MAX_U16) throw invalidArgument(`The ZIP entry path is longer than 65,535 bytes.`);
  if (entry.data.byteLength >= MAX_U32) {
    throw invalidArgument(`The ZIP entry "${entry.path}" is 4 GiB or larger, which needs ZIP64.`, { path: entry.path });
  }
  const store = entry.store === true;
  return {
    name,
    // Only non-ASCII names need the UTF-8 flag; leaving it off otherwise matches common tools.
    flags: name.length === entry.path.length ? 0 : FLAG_UTF8_NAME,
    method: store ? METHOD_STORED : METHOD_DEFLATE,
    crc: crc32(entry.data),
    size: entry.data.byteLength,
    payload: store ? entry.data : deflateSync(entry.data, { level: 6 }),
  };
}

/** Paths are written as given and later looked up exactly, so only unambiguous relative paths are allowed. */
function checkEntryPath(path: string, seen: Set<string>): void {
  const reject = (why: string): never => {
    throw invalidArgument(`The ZIP entry path "${path}" ${why}.`, { path });
  };
  if (path === '') reject('is empty');
  if (path.includes('\u0000')) reject('contains a NUL character');
  // Two paths differing only in lone surrogates would both be written as U+FFFD: a duplicate name.
  if (hasLoneSurrogate(path)) reject('contains a lone surrogate, which has no UTF-8 form');
  if (path.includes('\\')) reject('contains a backslash; ZIP paths use forward slashes');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) reject('is absolute');
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    reject('has an empty, "." or ".." segment');
  }
  if (seen.has(path)) reject('appears more than once');
  seen.add(path);
}

function assemble(entries: readonly PreparedEntry[]): Uint8Array {
  const localBytes = sum(entries, (e) => LOCAL_HEADER_BYTES + e.name.length + e.payload.length);
  const centralBytes = sum(entries, (e) => CENTRAL_HEADER_BYTES + e.name.length);
  if (localBytes + centralBytes > MAX_U32) {
    throw invalidArgument(
      `The ZIP archive would be ${formatCount(localBytes + centralBytes)} bytes; without ZIP64 it must stay below 4 GiB.`,
    );
  }
  const out = new Uint8Array(localBytes + centralBytes + END_OF_CENTRAL_DIR_BYTES);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let pos = 0;
  for (const entry of entries) {
    offsets.push(pos);
    pos = writeLocalHeader(view, out, pos, entry);
    out.set(entry.payload, pos);
    pos += entry.payload.length;
  }
  const centralStart = pos;
  entries.forEach((entry, i) => {
    pos = writeCentralHeader(view, out, pos, entry, offsets[i] ?? 0);
  });
  writeEndOfCentralDir(view, pos, entries.length, pos - centralStart, centralStart);
  return out;
}

function sum(entries: readonly PreparedEntry[], size: (e: PreparedEntry) => number): number {
  return entries.reduce((total, e) => total + size(e), 0);
}

function versionNeeded(entry: PreparedEntry): number {
  return entry.method === METHOD_STORED ? VERSION_STORED : VERSION_DEFLATE;
}

/** Fields shared by the local and central headers, from "version needed" to "extra field length". */
function writeCommonFields(view: DataView, at: number, entry: PreparedEntry): void {
  view.setUint16(at, versionNeeded(entry), true);
  view.setUint16(at + 2, entry.flags, true);
  view.setUint16(at + 4, entry.method, true);
  view.setUint16(at + 6, DOS_TIME_MIDNIGHT, true);
  view.setUint16(at + 8, DOS_DATE_1980_01_01, true);
  view.setUint32(at + 10, entry.crc, true);
  view.setUint32(at + 14, entry.payload.length, true);
  view.setUint32(at + 18, entry.size, true);
  view.setUint16(at + 22, entry.name.length, true);
  view.setUint16(at + 24, 0, true);
}

function writeLocalHeader(view: DataView, out: Uint8Array, pos: number, entry: PreparedEntry): number {
  view.setUint32(pos, SIG_LOCAL_HEADER, true);
  writeCommonFields(view, pos + 4, entry);
  out.set(entry.name, pos + LOCAL_HEADER_BYTES);
  return pos + LOCAL_HEADER_BYTES + entry.name.length;
}

function writeCentralHeader(
  view: DataView,
  out: Uint8Array,
  pos: number,
  entry: PreparedEntry,
  offset: number,
): number {
  view.setUint32(pos, SIG_CENTRAL_HEADER, true);
  view.setUint16(pos + 4, VERSION_MADE_BY, true);
  writeCommonFields(view, pos + 6, entry);
  // Comment length, disk number, internal and external attributes stay zero.
  view.setUint32(pos + 42, offset, true);
  out.set(entry.name, pos + CENTRAL_HEADER_BYTES);
  return pos + CENTRAL_HEADER_BYTES + entry.name.length;
}

function writeEndOfCentralDir(view: DataView, pos: number, count: number, size: number, offset: number): void {
  view.setUint32(pos, SIG_END_OF_CENTRAL_DIR, true);
  // Disk numbers stay zero: the archive is a single file.
  view.setUint16(pos + 8, count, true);
  view.setUint16(pos + 10, count, true);
  view.setUint32(pos + 12, size, true);
  view.setUint32(pos + 16, offset, true);
  // Archive comment length stays zero.
}

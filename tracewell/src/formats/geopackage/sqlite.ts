/**
 * The SQLite database file format (https://www.sqlite.org/fileformat.html), written and read by
 * code of our own (SAD decision D-16), so a GeoPackage needs no SQLite library in the browser and
 * both engines write the same bytes. sqlite.rs in the native engine follows every rule here.
 *
 * The writer lays a database out once, as a bulk load: pages of 4096 bytes, each table's rows in
 * rowid order packed into leaf pages as they come, interior pages built level by level above them,
 * long records spilled to overflow pages, and the schema table on page 1, built last. Pages are
 * numbered in the order they are made, which is also the order they are written: page 1 first as
 * a placeholder, then every other page as it is finished, then page 1 again.
 *
 * The reader opens any database of the format, written by SQLite or by this writer: any page size,
 * reserved bytes, UTF-8 or UTF-16 text, interior pages and overflow chains. It checks every page
 * number and offset it follows, so a damaged or hostile file is refused, not looped over.
 */

/** A value of a record: INTEGER as bigint, REAL as number, TEXT as string, BLOB as bytes. */
export type SqlValue = null | bigint | number | string | Uint8Array;

export class SqliteFormatError extends Error {
  override name = 'SqliteFormatError';
}

function fail(message: string): never {
  throw new SqliteFormatError(message);
}

export const SQLITE_PAGE_SIZE = 4096;
/** The library version the header names: 3.7.0, the first to read the in-header page count. */
const SQLITE_VERSION_NUMBER = 3_007_000;

const LEAF_TABLE = 0x0d;
const INTERIOR_TABLE = 0x05;
const LEAF_INDEX = 0x0a;
const LEAF_HEADER = 8;
const INTERIOR_HEADER = 12;
/** Page 1 starts with the 100-byte database header. */
const FILE_HEADER = 100;

/** The most and least of a record a b-tree cell holds on its page, by the file format's rules. */
function limits(usable: number): { maxTable: number; maxIndex: number; min: number } {
  return {
    maxTable: usable - 35,
    maxIndex: Math.floor(((usable - 12) * 64) / 255) - 23,
    min: Math.floor(((usable - 12) * 32) / 255) - 23,
  };
}

const WRITE = limits(SQLITE_PAGE_SIZE);

/** How many bytes of a record of `size` bytes stay on the page; the rest go to overflow pages. */
function localSize(size: number, max: number, min: number, usable: number): number {
  if (size <= max) return size;
  const surplus = min + ((size - min) % (usable - 4));
  return surplus <= max ? surplus : min;
}

// ---------------------------------------------------------------------------------------------
// Bytes

const TWO_64 = 1n << 64n;

/** The bytes of a varint: big-endian groups of seven bits, the ninth byte holding eight. */
export function varintBytes(value: bigint | number): number[] {
  if (typeof value === 'number' && value >= 0 && value < 2 ** 49) {
    const groups: number[] = [];
    let v = value;
    do {
      groups.push(v % 128);
      v = Math.floor(v / 128);
    } while (v > 0);
    groups.reverse();
    for (let i = 0; i < groups.length - 1; i++) groups[i] = (groups[i] as number) | 0x80;
    return groups;
  }
  let v = BigInt(value);
  if (v < 0n) v += TWO_64;
  if (v >> 56n !== 0n) {
    const out = new Array<number>(9);
    out[8] = Number(v & 0xffn);
    v >>= 8n;
    for (let i = 7; i >= 0; i--) {
      out[i] = Number(v & 0x7fn) | 0x80;
      v >>= 7n;
    }
    return out;
  }
  const groups: number[] = [];
  do {
    groups.push(Number(v & 0x7fn));
    v >>= 7n;
  } while (v !== 0n);
  groups.reverse();
  for (let i = 0; i < groups.length - 1; i++) groups[i] = (groups[i] as number) | 0x80;
  return groups;
}

function varintLength(value: bigint | number): number {
  return varintBytes(value).length;
}

function putU16(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 8) & 0xff;
  b[at + 1] = v & 0xff;
}

function putU32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

function u16(b: Uint8Array, at: number): number {
  return ((b[at] as number) << 8) | (b[at + 1] as number);
}

function u32(b: Uint8Array, at: number): number {
  return (
    (((b[at] as number) << 24) |
      ((b[at + 1] as number) << 16) |
      ((b[at + 2] as number) << 8) |
      (b[at + 3] as number)) >>>
    0
  );
}

const utf8 = new TextEncoder();

/** The serial type of an integer and the bytes it takes, as SQLite chooses them. */
function integerType(v: bigint): [number, number] {
  const u = v < 0n ? -1n - v : v;
  if (u <= 127n) return v === 0n ? [8, 0] : v === 1n ? [9, 0] : [1, 1];
  if (u <= 32_767n) return [2, 2];
  if (u <= 8_388_607n) return [3, 3];
  if (u <= 2_147_483_647n) return [4, 4];
  if (u <= 0x7fff_ffff_ffffn) return [5, 6];
  return [6, 8];
}

/** A record: a header of serial types, then each value in the fewest bytes its type allows. */
export function encodeRecord(values: readonly SqlValue[]): Uint8Array {
  const types: number[] = [];
  const sizes: number[] = [];
  const texts: (Uint8Array | null)[] = [];
  for (const v of values) {
    let type: number;
    let size: number;
    let bytes: Uint8Array | null = null;
    if (v === null) [type, size] = [0, 0];
    else if (typeof v === 'bigint') [type, size] = integerType(v);
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail(`a record cannot hold the number ${v}`);
      [type, size] = [7, 8];
    } else if (typeof v === 'string') {
      bytes = utf8.encode(v);
      [type, size] = [13 + 2 * bytes.length, bytes.length];
    } else {
      bytes = v;
      [type, size] = [12 + 2 * v.length, v.length];
    }
    types.push(type);
    sizes.push(size);
    texts.push(bytes);
  }
  const typeBytes = types.reduce((n, t) => n + varintLength(t), 0);
  let header = typeBytes + 1;
  while (typeBytes + varintLength(header) !== header) header = typeBytes + varintLength(header);
  const out = new Uint8Array(header + sizes.reduce((n, s) => n + s, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const b of varintBytes(header)) out[at++] = b;
  for (const t of types) for (const b of varintBytes(t)) out[at++] = b;
  values.forEach((v, i) => {
    const size = sizes[i] as number;
    if (typeof v === 'bigint') {
      for (let k = 0; k < size; k++) out[at + k] = Number((v >> BigInt(8 * (size - 1 - k))) & 0xffn);
    } else if (typeof v === 'number') {
      view.setFloat64(at, v, false);
    } else if (v !== null) {
      out.set(texts[i] as Uint8Array, at);
    }
    at += size;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The writer

/** The pages made so far; page n is pages[n - 1], and page 1 is filled last. */
class Pager {
  readonly pages: (Uint8Array | null)[] = [null];

  allocate(): number {
    this.pages.push(null);
    return this.pages.length;
  }

  put(n: number, page: Uint8Array): void {
    this.pages[n - 1] = page;
  }
}

/** Puts the part of a record past its local bytes on a chain of new overflow pages; the first page. */
function spill(pager: Pager, payload: Uint8Array, local: number): number {
  const chunk = SQLITE_PAGE_SIZE - 4;
  const count = Math.ceil((payload.length - local) / chunk);
  const first = pager.pages.length + 1;
  for (let i = 0; i < count; i++) {
    const n = pager.allocate();
    const page = new Uint8Array(SQLITE_PAGE_SIZE);
    putU32(page, 0, i < count - 1 ? n + 1 : 0);
    page.set(payload.subarray(local + i * chunk, Math.min(payload.length, local + (i + 1) * chunk)), 4);
    pager.put(n, page);
  }
  return first;
}

function cellSize(prefix: number, payload: number, max: number): number {
  const local = localSize(payload, max, WRITE.min, SQLITE_PAGE_SIZE);
  return prefix + local + (local < payload ? 4 : 0);
}

/** A cell holding a record: its prefix, the local part, and the first overflow page if it spills. */
function payloadCell(pager: Pager, prefix: number[], payload: Uint8Array, max: number): Uint8Array {
  const local = localSize(payload.length, max, WRITE.min, SQLITE_PAGE_SIZE);
  const spills = local < payload.length;
  const cell = new Uint8Array(prefix.length + local + (spills ? 4 : 0));
  cell.set(prefix);
  cell.set(payload.subarray(0, local), prefix.length);
  if (spills) putU32(cell, prefix.length + local, spill(pager, payload, local));
  return cell;
}

/** A b-tree page: its header, the cell pointers in key order, and the cells packed from the end. */
function btreePage(type: number, cells: readonly Uint8Array[], right: number | null, offset: number): Uint8Array {
  const page = new Uint8Array(SQLITE_PAGE_SIZE);
  page[offset] = type;
  putU16(page, offset + 3, cells.length);
  const pointers = offset + (right === null ? LEAF_HEADER : INTERIOR_HEADER);
  let end = SQLITE_PAGE_SIZE;
  cells.forEach((cell, i) => {
    end -= cell.length;
    page.set(cell, end);
    putU16(page, pointers + 2 * i, end);
  });
  if (pointers + 2 * cells.length > end) fail('the cells do not fit on their page');
  putU16(page, offset + 5, end);
  if (right !== null) putU32(page, offset + 8, right);
  return page;
}

/** A child of an interior page: its page and the largest rowid below it. */
interface Child {
  page: number;
  key: bigint;
}

function interiorCell(c: Child): Uint8Array {
  const key = varintBytes(c.key);
  const cell = new Uint8Array(4 + key.length);
  putU32(cell, 0, c.page);
  cell.set(key, 4);
  return cell;
}

function interiorPage(children: readonly Child[], offset: number): Uint8Array {
  return btreePage(
    INTERIOR_TABLE,
    children.slice(0, -1).map(interiorCell),
    (children[children.length - 1] as Child).page,
    offset,
  );
}

/** Whether children fit on one interior page of this many bytes: each but the last takes a cell. */
function fitsOne(children: readonly Child[], capacity: number): boolean {
  let used = INTERIOR_HEADER;
  for (let i = 0; i < children.length - 1; i++) used += 2 + 4 + varintLength((children[i] as Child).key);
  return used <= capacity;
}

/** Children packed onto interior pages in order, each page as full as it goes. */
function packChildren(children: readonly Child[]): Child[][] {
  const groups: Child[][] = [];
  let group: Child[] = [];
  let used = INTERIOR_HEADER;
  for (const c of children) {
    if (group.length > 0) {
      const cost = 2 + 4 + varintLength((group[group.length - 1] as Child).key);
      if (used + cost > SQLITE_PAGE_SIZE) {
        groups.push(group);
        group = [c];
        used = INTERIOR_HEADER;
        continue;
      }
      used += cost;
    }
    group.push(c);
  }
  groups.push(group);
  // An interior page below the root holds two children at least.
  const last = groups[groups.length - 1] as Child[];
  if (groups.length > 1 && last.length === 1) last.unshift((groups[groups.length - 2] as Child[]).pop() as Child);
  return groups;
}

/**
 * The interior levels above a table's leaves, built until one page holds them all; the root page.
 * The schema's root must be page 1, which has 100 bytes less room; when one child is all it holds,
 * it holds no cells, only the pointer to that child, as SQLite leaves page 1 when it deepens it.
 */
function interiorLevels(pager: Pager, leaves: readonly Child[], rootIsPage1: boolean): number {
  let level = leaves;
  for (;;) {
    if (!rootIsPage1 && level.length === 1) return (level[0] as Child).page;
    if (rootIsPage1 && fitsOne(level, SQLITE_PAGE_SIZE - FILE_HEADER)) {
      pager.put(1, interiorPage(level, FILE_HEADER));
      return 1;
    }
    level = packChildren(level).map((g) => {
      const page = pager.allocate();
      pager.put(page, interiorPage(g, 0));
      return { page, key: (g[g.length - 1] as Child).key };
    });
  }
}

/** A table's b-tree, built as its rows come: a leaf page is written when the next row does not fit. */
class TableTree {
  private readonly leaves: Child[] = [];
  private cells: Uint8Array[] = [];
  private used = 0;
  private lastKey = 0n;

  constructor(private readonly pager: Pager) {}

  add(rowid: bigint, payload: Uint8Array): void {
    const prefix = [...varintBytes(payload.length), ...varintBytes(rowid)];
    const size = cellSize(prefix.length, payload.length, WRITE.maxTable);
    if (this.cells.length > 0 && LEAF_HEADER + this.used + size + 2 > SQLITE_PAGE_SIZE) this.flush();
    this.cells.push(payloadCell(this.pager, prefix, payload, WRITE.maxTable));
    this.used += size + 2;
    this.lastKey = rowid;
  }

  private flush(): void {
    const page = this.pager.allocate();
    this.pager.put(page, btreePage(LEAF_TABLE, this.cells, null, 0));
    this.leaves.push({ page, key: this.lastKey });
    this.cells = [];
    this.used = 0;
  }

  /** The root page; a table without rows is one empty leaf. */
  finish(): number {
    if (this.cells.length > 0 || this.leaves.length === 0) this.flush();
    return interiorLevels(this.pager, this.leaves, false);
  }
}

/** The leaf of an index small enough for one page; entries are its keys and rowid, in key order. */
function indexLeaf(pager: Pager, entries: readonly (readonly SqlValue[])[]): number {
  const cells = entries.map((e) => {
    const payload = encodeRecord(e);
    return payloadCell(pager, varintBytes(payload.length), payload, WRITE.maxIndex);
  });
  const page = pager.allocate();
  pager.put(page, btreePage(LEAF_INDEX, cells, null, 0));
  return page;
}

/** The schema table on page 1, or on leaves below an interior page 1 when it does not fit there. */
function schemaTree(pager: Pager, rows: readonly (readonly SqlValue[])[]): void {
  const cells = rows.map((values, i) => {
    const payload = encodeRecord(values);
    return payloadCell(pager, [...varintBytes(payload.length), ...varintBytes(i + 1)], payload, WRITE.maxTable);
  });
  const bytes = cells.reduce((n, c) => n + c.length + 2, 0);
  if (FILE_HEADER + LEAF_HEADER + bytes <= SQLITE_PAGE_SIZE) {
    pager.put(1, btreePage(LEAF_TABLE, cells, null, FILE_HEADER));
    return;
  }
  const groups: number[][] = [];
  let group: number[] = [];
  let used = 0;
  cells.forEach((c, i) => {
    if (group.length > 0 && LEAF_HEADER + used + c.length + 2 > SQLITE_PAGE_SIZE) {
      groups.push(group);
      group = [];
      used = 0;
    }
    group.push(i);
    used += c.length + 2;
  });
  groups.push(group);
  const leaves = groups.map((g) => {
    const page = pager.allocate();
    pager.put(
      page,
      btreePage(
        LEAF_TABLE,
        g.map((i) => cells[i] as Uint8Array),
        null,
        0,
      ),
    );
    return { page, key: BigInt((g[g.length - 1] as number) + 1) };
  });
  interiorLevels(pager, leaves, true);
}

export interface SqliteIndexDef {
  name: string;
  /** Each entry: the indexed values, then the rowid, in key order. */
  entries: readonly (readonly SqlValue[])[];
}

export interface SqliteTableDef {
  name: string;
  /** The CREATE TABLE statement, as the schema table holds it. */
  sql: string;
  /** The rows in rowid order; a rowid alias column holds null in its record. */
  rows: Iterable<readonly [bigint, readonly SqlValue[]]>;
  /** The automatic indexes of the table's UNIQUE and PRIMARY KEY constraints, in the order SQLite numbers them. */
  indexes?: readonly SqliteIndexDef[];
}

export interface SqliteHeader {
  applicationId: number;
  userVersion: number;
}

/** A whole database: the tables in order, each followed by its indexes, the schema on page 1. */
export function writeSqlite(header: SqliteHeader, tables: readonly SqliteTableDef[]): Uint8Array {
  const pager = new Pager();
  const schema: SqlValue[][] = [];
  for (const t of tables) {
    const tree = new TableTree(pager);
    for (const [rowid, values] of t.rows) tree.add(rowid, encodeRecord(values));
    schema.push(['table', t.name, t.name, BigInt(tree.finish()), t.sql]);
    for (const index of t.indexes ?? []) {
      schema.push(['index', index.name, t.name, BigInt(indexLeaf(pager, index.entries)), null]);
    }
  }
  schemaTree(pager, schema);
  const page1 = pager.pages[0] as Uint8Array;
  page1.set(utf8.encode('SQLite format 3\0'), 0);
  putU16(page1, 16, SQLITE_PAGE_SIZE);
  page1[18] = 1;
  page1[19] = 1;
  page1[21] = 64;
  page1[22] = 32;
  page1[23] = 32;
  putU32(page1, 24, 1);
  putU32(page1, 28, pager.pages.length);
  putU32(page1, 40, 1);
  putU32(page1, 44, 4);
  putU32(page1, 56, 1);
  putU32(page1, 60, header.userVersion);
  putU32(page1, 68, header.applicationId);
  putU32(page1, 92, 1);
  putU32(page1, 96, SQLITE_VERSION_NUMBER);
  const out = new Uint8Array(pager.pages.length * SQLITE_PAGE_SIZE);
  pager.pages.forEach((p, i) => out.set(p as Uint8Array, i * SQLITE_PAGE_SIZE));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The reader

/** A varint that fits a safe integer, and where the next value starts. */
function readVarint(b: Uint8Array, at: number, end: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    if (at + i >= end) fail('a varint runs past its cell');
    const byte = b[at + i] as number;
    v = v * 128 + (byte & 0x7f);
    if (byte < 0x80) {
      if (v > Number.MAX_SAFE_INTEGER) fail('a size is too large');
      return [v, at + i + 1];
    }
  }
  fail('a size is too large');
}

/** A varint as the 64-bit signed integer a rowid is. */
function readVarint64(b: Uint8Array, at: number, end: number): [bigint, number] {
  let v = 0n;
  for (let i = 0; i < 9; i++) {
    if (at + i >= end) fail('a varint runs past its cell');
    const byte = b[at + i] as number;
    if (i === 8) {
      v = (v << 8n) | BigInt(byte);
      return [BigInt.asIntN(64, v), at + 9];
    }
    v = (v << 7n) | BigInt(byte & 0x7f);
    if (byte < 0x80) return [BigInt.asIntN(64, v), at + i + 1];
  }
  fail('a varint runs past its cell');
}

export type SqliteTextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** Decodes a record, its text in the database's encoding. */
export function decodeRecord(p: Uint8Array, encoding: SqliteTextEncoding = 'utf-8'): SqlValue[] {
  const [header, first] = readVarint(p, 0, p.length);
  if (header > p.length || header < first) fail('a record header runs past its record');
  const types: number[] = [];
  let at = first;
  while (at < header) {
    const [t, next] = readVarint(p, at, header);
    types.push(t);
    at = next;
  }
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const decoder = new TextDecoder(encoding);
  const values: SqlValue[] = [];
  let body = header;
  const need = (n: number): void => {
    if (body + n > p.length) fail('a record value runs past its record');
  };
  for (const t of types) {
    if (t === 0) values.push(null);
    else if (t >= 1 && t <= 6) {
      const size = [0, 1, 2, 3, 4, 6, 8][t] as number;
      need(size);
      let v = 0n;
      for (let k = 0; k < size; k++) v = (v << 8n) | BigInt(p[body + k] as number);
      values.push(BigInt.asIntN(size * 8, v));
      body += size;
    } else if (t === 7) {
      need(8);
      values.push(view.getFloat64(body, false));
      body += 8;
    } else if (t === 8 || t === 9) values.push(BigInt(t - 8));
    else if (t >= 12) {
      const size = Math.floor((t - 12) / 2);
      need(size);
      const bytes = p.subarray(body, body + size);
      values.push(t % 2 === 0 ? bytes.slice() : decoder.decode(bytes));
      body += size;
    } else fail(`a record uses the reserved serial type ${t}`);
  }
  return values;
}

export interface SqliteSchemaRow {
  type: string;
  name: string;
  table: string;
  root: number;
  sql: string | null;
}

/** A database file held in memory, read page by page. */
export class SqliteDatabase {
  readonly pageSize: number;
  readonly usable: number;
  readonly pageCount: number;
  readonly encoding: SqliteTextEncoding;
  readonly applicationId: number;
  readonly userVersion: number;
  private readonly limits: { maxTable: number; maxIndex: number; min: number };

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length < FILE_HEADER || new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') {
      fail('it does not start with the SQLite header');
    }
    const size = u16(bytes, 16);
    this.pageSize = size === 1 ? 65_536 : size;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) fail(`its page size ${size} is not valid`);
    this.usable = this.pageSize - (bytes[20] as number);
    if (this.usable < 480) fail('its pages keep too many reserved bytes');
    if (bytes[21] !== 64 || bytes[22] !== 32 || bytes[23] !== 32) fail('its payload fractions are not 64, 32 and 32');
    const pages = Math.floor(bytes.length / this.pageSize);
    const counted = u32(bytes, 28);
    this.pageCount = counted > 0 && u32(bytes, 24) === u32(bytes, 92) && counted <= pages ? counted : pages;
    if (this.pageCount < 1) fail('it is cut short');
    const encoding = u32(bytes, 56);
    if (encoding > 3) fail(`its text encoding ${encoding} is not valid`);
    this.encoding = encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8';
    this.userVersion = u32(bytes, 60);
    this.applicationId = u32(bytes, 68);
    this.limits = limits(this.usable);
  }

  private page(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 1 || n > this.pageCount) fail(`it points to page ${n}, outside the file`);
    return this.bytes.subarray((n - 1) * this.pageSize, n * this.pageSize);
  }

  /** The record a cell holds from `at`, joined from its overflow pages when it spills. */
  private payload(data: Uint8Array, at: number, size: number, max: number): Uint8Array {
    const local = localSize(size, max, this.limits.min, this.usable);
    if (at + local > this.usable) fail('a cell runs past its page');
    if (local === size) return data.subarray(at, at + size);
    if (at + local + 4 > this.usable) fail('a cell runs past its page');
    const out = new Uint8Array(size);
    out.set(data.subarray(at, at + local));
    let next = u32(data, at + local);
    let filled = local;
    while (filled < size) {
      if (next === 0) fail('an overflow chain ends before its record does');
      const page = this.page(next);
      const take = Math.min(this.usable - 4, size - filled);
      out.set(page.subarray(4, 4 + take), filled);
      filled += take;
      next = u32(page, 0);
    }
    return out;
  }

  /** The rows of a table b-tree in rowid order. */
  *rows(root: number): Generator<{ rowid: bigint; values: SqlValue[] }> {
    yield* this.walk(root, 0, new Set());
  }

  private *walk(n: number, depth: number, seen: Set<number>): Generator<{ rowid: bigint; values: SqlValue[] }> {
    if (depth > 40) fail('its b-tree is deeper than any valid one');
    if (seen.has(n)) fail(`its b-tree visits page ${n} twice`);
    seen.add(n);
    const data = this.page(n);
    const hdr = n === 1 ? FILE_HEADER : 0;
    const type = data[hdr] as number;
    if (type !== LEAF_TABLE && type !== INTERIOR_TABLE) fail(`page ${n} is not a page of a table`);
    const cells = u16(data, hdr + 3);
    const pointers = hdr + (type === LEAF_TABLE ? LEAF_HEADER : INTERIOR_HEADER);
    if (pointers + 2 * cells > this.usable) fail(`page ${n} lists more cells than it holds`);
    for (let i = 0; i < cells; i++) {
      const at = u16(data, pointers + 2 * i);
      if (at < pointers + 2 * cells || at >= this.usable) fail(`a cell of page ${n} lies outside its page`);
      if (type === INTERIOR_TABLE) {
        if (at + 4 > this.usable) fail(`a cell of page ${n} lies outside its page`);
        yield* this.walk(u32(data, at), depth + 1, seen);
      } else {
        const [size, a1] = readVarint(data, at, this.usable);
        const [rowid, a2] = readVarint64(data, a1, this.usable);
        yield { rowid, values: decodeRecord(this.payload(data, a2, size, this.limits.maxTable), this.encoding) };
      }
    }
    if (type === INTERIOR_TABLE) yield* this.walk(u32(data, hdr + 8), depth + 1, seen);
  }

  /** The schema table: every table, index, view and trigger. */
  schema(): SqliteSchemaRow[] {
    const rows: SqliteSchemaRow[] = [];
    for (const { values } of this.rows(1)) {
      const [type, name, table, root, sql] = values;
      if (typeof type !== 'string' || typeof name !== 'string' || typeof table !== 'string') {
        fail('a row of its schema is not a schema row');
      }
      rows.push({
        type,
        name,
        table,
        root: typeof root === 'bigint' ? Number(root) : 0,
        sql: typeof sql === 'string' ? sql : null,
      });
    }
    return rows;
  }
}

// ---------------------------------------------------------------------------------------------
// CREATE TABLE

interface Token {
  text: string;
  /** An identifier, quoted or bare, or a string literal, which SQLite also takes as a name. */
  name: boolean;
  quoted: boolean;
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const quotedRun = (close: string, doubled: boolean): string => {
    let text = '';
    i++;
    for (;;) {
      if (i >= sql.length) fail('a quoted name in a CREATE TABLE statement is not closed');
      const c = sql[i] as string;
      if (c === close) {
        if (doubled && sql[i + 1] === close) {
          text += close;
          i += 2;
          continue;
        }
        i++;
        return text;
      }
      text += c;
      i++;
    }
  };
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) i++;
    else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === '"' || c === '`') tokens.push({ text: quotedRun(c, true), name: true, quoted: true });
    else if (c === '[') tokens.push({ text: quotedRun(']', false), name: true, quoted: true });
    else if (c === "'") tokens.push({ text: quotedRun("'", true), name: true, quoted: true });
    else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i] as string)) i++;
      tokens.push({ text: sql.slice(start, i), name: true, quoted: false });
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < sql.length && /[0-9A-Za-z.+-]/.test(sql[i] as string)) {
        if ((sql[i] === '+' || sql[i] === '-') && !/[eE]/.test(sql[i - 1] as string)) break;
        i++;
      }
      tokens.push({ text: sql.slice(start, i), name: false, quoted: false });
    } else {
      tokens.push({ text: c, name: false, quoted: false });
      i++;
    }
  }
  return tokens;
}

/** Upper case as SQLite folds names: ASCII letters only. */
export function sqlUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

const keyword = (t: Token | undefined, word: string): boolean =>
  t !== undefined && !t.quoted && sqlUpper(t.text) === word;

const COLUMN_CONSTRAINTS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'NULL',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS',
]);
const TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

export interface SqliteColumn {
  name: string;
  /** The declared type, its words joined by single spaces, as written; '' when none. */
  type: string;
  /** The column is the rowid under another name (INTEGER PRIMARY KEY), so its record holds null. */
  rowid: boolean;
}

/**
 * A stored value as SQLite reads it from its column: a column whose declared type gives it REAL
 * affinity (REAL, FLOAT, DOUBLE) holds whole numbers as integers on disk, and reads them as reals.
 */
export function columnValue(c: SqliteColumn, v: SqlValue): SqlValue {
  if (typeof v !== 'bigint') return v;
  const t = sqlUpper(c.type);
  const real = !t.includes('INT') && !/CHAR|CLOB|TEXT|BLOB/.test(t) && /REAL|FLOA|DOUB/.test(t);
  return real ? Number(v) : v;
}

/** The name and columns a CREATE TABLE statement declares. */
export function parseCreateTable(sql: string): { name: string; columns: SqliteColumn[]; withoutRowid: boolean } {
  const t = tokenize(sql);
  let i = 0;
  if (!keyword(t[i++], 'CREATE')) fail('a table is not created by a CREATE TABLE statement');
  if (keyword(t[i], 'TEMP') || keyword(t[i], 'TEMPORARY')) i++;
  if (!keyword(t[i++], 'TABLE')) fail('a table is not created by a CREATE TABLE statement');
  if (keyword(t[i], 'IF') && keyword(t[i + 1], 'NOT') && keyword(t[i + 2], 'EXISTS')) i += 3;
  let nameToken = t[i++];
  if (t[i]?.text === '.' && !t[i]?.quoted) {
    nameToken = t[i + 1];
    i += 2;
  }
  if (nameToken === undefined || !nameToken.name) fail('a CREATE TABLE statement names no table');
  if (t[i]?.text !== '(' || t[i]?.quoted) fail(`the table ${nameToken.text} is not created with a list of columns`);
  i++;
  const items: Token[][] = [];
  let item: Token[] = [];
  let depth = 0;
  for (; ; i++) {
    const tok = t[i];
    if (tok === undefined) fail(`the column list of the table ${nameToken.text} is not closed`);
    if (!tok.quoted && tok.text === '(') depth++;
    if (!tok.quoted && tok.text === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (!tok.quoted && tok.text === ',' && depth === 0) {
      items.push(item);
      item = [];
    } else item.push(tok);
  }
  items.push(item);
  const rest = t.slice(i + 1);
  const withoutRowid = rest.some((tok, k) => keyword(tok, 'WITHOUT') && keyword(rest[k + 1], 'ROWID'));
  const columns: (SqliteColumn & { pk: boolean; desc: boolean })[] = [];
  let tablePk: string[] = [];
  for (const it of items) {
    const head = it[0];
    if (head === undefined) fail(`the table ${nameToken.text} declares an empty column`);
    if (!head.quoted && TABLE_CONSTRAINTS.has(sqlUpper(head.text))) {
      const p = it.findIndex((tok, k) => keyword(tok, 'PRIMARY') && keyword(it[k + 1], 'KEY'));
      if (p >= 0) {
        const open = it.findIndex((tok, k) => k > p && !tok.quoted && tok.text === '(');
        const names: string[] = [];
        let d = 0;
        for (let k = open + 1; k < it.length; k++) {
          const tok = it[k] as Token;
          if (!tok.quoted && tok.text === '(') d++;
          if (!tok.quoted && tok.text === ')') {
            if (d === 0) break;
            d--;
          }
          if (d === 0 && tok.name && (k === open + 1 || it[k - 1]?.text === ',')) names.push(tok.text);
        }
        tablePk = names;
      }
      continue;
    }
    if (!head.name) fail(`the table ${nameToken.text} declares a column without a name`);
    const words: string[] = [];
    let k = 1;
    for (; k < it.length; k++) {
      const tok = it[k] as Token;
      if (!tok.quoted && COLUMN_CONSTRAINTS.has(sqlUpper(tok.text))) break;
      if (!tok.quoted && tok.text === '(') {
        const close = it.findIndex((x, m) => m > k && !x.quoted && x.text === ')');
        const inner = it
          .slice(k + 1, close < 0 ? it.length : close)
          .map((x) => x.text)
          .join('');
        words.push(`${words.pop() ?? ''}(${inner})`);
        k = close < 0 ? it.length : close;
        continue;
      }
      words.push(tok.text);
    }
    const p = it.findIndex((tok, m) => m >= k && keyword(tok, 'PRIMARY') && keyword(it[m + 1], 'KEY'));
    columns.push({
      name: head.text,
      type: words.join(' '),
      rowid: false,
      pk: p >= 0,
      desc: p >= 0 && keyword(it[p + 2], 'DESC'),
    });
  }
  if (!withoutRowid) {
    for (const c of columns) {
      const single = tablePk.length === 1 && sqlUpper(tablePk[0] as string) === sqlUpper(c.name);
      c.rowid = sqlUpper(c.type) === 'INTEGER' && ((c.pk && !c.desc) || single);
    }
  }
  return {
    name: nameToken.text,
    columns: columns.map(({ name, type, rowid }) => ({ name, type, rowid })),
    withoutRowid,
  };
}

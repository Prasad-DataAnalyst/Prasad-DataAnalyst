/**
 * Typed column storage (SAD section 7.2). Numbers, integers, dates and datetimes live in Float64Array
 * chunks with a validity byte per row; booleans in Uint8Array chunks; strings and geometries in
 * plain arrays. Values that failed to parse, and values matched as null markers, are null in the
 * typed vector and keep their source text in sparse maps, so nothing is lost silently.
 *
 * Chunks are fixed-size so that a growing column never copies what it already holds: a 1 GB import
 * would otherwise need twice its size at every reallocation.
 */
import {
  isDateCell,
  isDateTimeCell,
  isGeometryCell,
  type CellValue,
  type ColumnId,
  type Geometry,
  type LogicalType,
  type RowId,
} from '@tw/model';
import { invalidArgument, notFound } from './errors';
import { geometryBytes, RAW_ENTRY_BYTES, STRING_BYTES } from './memory';

/** A typed column as the rest of the engine reads it. */
export interface ColumnData {
  readonly id: ColumnId;
  readonly type: LogicalType;
  readonly length: number;
  get(r: RowId): CellValue;
  /** The source text of a value that failed to parse or matched a null marker. */
  raw(r: RowId): string | undefined;
  nullMarker(r: RowId): string | undefined;
  parseOk(r: RowId): boolean;
}

/** One parsed cell: a typed value (null, possibly from a null marker) or source text that did not parse. */
export type CellParse = { ok: true; value: CellValue; nullMarker?: string } | { ok: false; raw: string };

const CHUNK_SHIFT = 16;
const CHUNK_SIZE = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_SIZE - 1;
const MS_PER_DAY = 86_400_000;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------------------------
// Value codecs between CellValue and the stored representation
// ---------------------------------------------------------------------------------------------

/** Days since 1970-01-01 for canonical date text, or NaN for text that names no real day. */
function dateToDays(text: string): number {
  if (!DATE_TEXT.test(text)) return NaN;
  const ms = Date.parse(`${text}T00:00:00.000Z`);
  // The round trip rejects days such as 30 February, which Date.parse would roll over.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== text) return NaN;
  return ms / MS_PER_DAY;
}

function daysToDate(days: number): string {
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Milliseconds since the epoch for canonical UTC datetime text, or NaN. */
function datetimeToMs(text: string): number {
  if (!DATETIME_TEXT.test(text)) return NaN;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString() === text ? ms : NaN;
}

type NumericType = 'number' | 'integer' | 'date' | 'datetime';

/** The Float64 code of a non-null value for a numeric-backed type, or NaN when the value does not fit. */
function encodeNumeric(type: NumericType, v: CellValue): number {
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v) ? v : NaN;
    case 'date':
      return isDateCell(v) ? dateToDays(v.date) : NaN;
    case 'datetime':
      return isDateTimeCell(v) ? datetimeToMs(v.datetime) : NaN;
  }
}

function decodeNumeric(type: NumericType, code: number): CellValue {
  switch (type) {
    case 'number':
    case 'integer':
      return code;
    case 'date':
      return { date: daysToDate(code) };
    case 'datetime':
      return { datetime: new Date(code).toISOString() };
  }
}

function preview(v: CellValue): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  return JSON.stringify(v).slice(0, 80);
}

// ---------------------------------------------------------------------------------------------
// Column implementations
// ---------------------------------------------------------------------------------------------

/** Shared parts of every column: identity, length and the sparse source-text maps. */
abstract class BaseColumn implements ColumnData {
  constructor(
    readonly id: ColumnId,
    readonly type: LogicalType,
    readonly length: number,
    private readonly failed: ReadonlyMap<RowId, string>,
    private readonly markers: ReadonlyMap<RowId, string>,
  ) {}

  abstract get(r: RowId): CellValue;
  protected abstract valueBytes(): number;

  raw(r: RowId): string | undefined {
    return this.failed.get(r) ?? this.markers.get(r);
  }

  nullMarker(r: RowId): string | undefined {
    return this.markers.get(r);
  }

  parseOk(r: RowId): boolean {
    return !this.failed.has(r);
  }

  estimatedBytes(): number {
    return this.valueBytes() + sparseBytes(this.failed) + sparseBytes(this.markers);
  }

  protected check(r: RowId): void {
    if (!Number.isInteger(r) || r < 0 || r >= this.length) {
      throw notFound(`Row ${String(r)} does not exist in column ${this.id}, which has ${this.length} rows.`, {
        column: this.id,
        row: Number.isFinite(r) ? r : String(r),
      });
    }
  }
}

function sparseBytes(map: ReadonlyMap<RowId, string>): number {
  let n = 0;
  for (const text of map.values()) n += RAW_ENTRY_BYTES + 2 * text.length;
  return n;
}

class NumericColumn extends BaseColumn {
  constructor(
    id: ColumnId,
    readonly numericType: NumericType,
    length: number,
    private readonly values: readonly Float64Array[],
    private readonly valid: readonly Uint8Array[],
    failed: ReadonlyMap<RowId, string>,
    markers: ReadonlyMap<RowId, string>,
  ) {
    super(id, numericType, length, failed, markers);
  }

  get(r: RowId): CellValue {
    this.check(r);
    const chunk = r >>> CHUNK_SHIFT;
    const i = r & CHUNK_MASK;
    if (this.valid[chunk]?.[i] !== 1) return null;
    return decodeNumeric(this.numericType, this.values[chunk]?.[i] ?? NaN);
  }

  protected valueBytes(): number {
    return this.values.length * CHUNK_SIZE * 9;
  }
}

/** Booleans as one byte per row: 0 false, 1 true, NULL_BYTE null (the validity is folded in). */
const NULL_BYTE = 255;

class BooleanColumn extends BaseColumn {
  constructor(
    id: ColumnId,
    length: number,
    private readonly bytes: readonly Uint8Array[],
    failed: ReadonlyMap<RowId, string>,
    markers: ReadonlyMap<RowId, string>,
  ) {
    super(id, 'boolean', length, failed, markers);
  }

  get(r: RowId): CellValue {
    this.check(r);
    const b = this.bytes[r >>> CHUNK_SHIFT]?.[r & CHUNK_MASK];
    return b === 0 ? false : b === 1 ? true : null;
  }

  protected valueBytes(): number {
    return this.bytes.length * CHUNK_SIZE;
  }
}

class StringColumn extends BaseColumn {
  constructor(
    id: ColumnId,
    length: number,
    private readonly values: readonly (string | null)[],
    private readonly bytes: number,
    failed: ReadonlyMap<RowId, string>,
    markers: ReadonlyMap<RowId, string>,
  ) {
    super(id, 'string', length, failed, markers);
  }

  get(r: RowId): CellValue {
    this.check(r);
    return this.values[r] ?? null;
  }

  protected valueBytes(): number {
    return this.bytes;
  }
}

class GeometryColumn extends BaseColumn {
  constructor(
    id: ColumnId,
    length: number,
    private readonly values: readonly (Geometry | null)[],
    private readonly bytes: number,
    failed: ReadonlyMap<RowId, string>,
    markers: ReadonlyMap<RowId, string>,
  ) {
    super(id, 'geometry', length, failed, markers);
  }

  get(r: RowId): CellValue {
    this.check(r);
    const g = this.values[r] ?? null;
    return g === null ? null : { geometry: g };
  }

  protected valueBytes(): number {
    return this.bytes;
  }
}

/** Memory held by a column; columns built elsewhere are estimated at 16 bytes a row. */
export function columnBytes(col: ColumnData): number {
  return col instanceof BaseColumn ? col.estimatedBytes() : col.length * 16;
}

// ---------------------------------------------------------------------------------------------
// Writers: append cells one at a time, then seal into a column
// ---------------------------------------------------------------------------------------------

/** Appends parsed cells to one column. */
export abstract class ColumnWriter {
  protected length = 0;
  protected readonly failed = new Map<RowId, string>();
  protected readonly markers = new Map<RowId, string>();
  private sparse = 0;

  constructor(
    readonly id: ColumnId,
    readonly type: LogicalType,
  ) {}

  /** Throws INVALID_INPUT, before anything is stored, when the cell cannot go in this column. */
  check(cell: CellParse): void {
    const r = this.length;
    if (!cell.ok) {
      if (typeof cell.raw !== 'string') throw invalidArgument(`A failed cell in column ${this.id} has no raw text.`);
      return;
    }
    const { value, nullMarker } = cell;
    if (nullMarker !== undefined && (value !== null || typeof nullMarker !== 'string')) {
      throw invalidArgument(`Row ${r} of column ${this.id} names a null marker but carries a value.`, {
        column: this.id,
        row: r,
      });
    }
    if (value !== null && !this.fits(value)) {
      throw invalidArgument(
        `Row ${r} of column ${this.id} holds ${preview(value)}, which is not a valid ${this.type} value.`,
        { column: this.id, row: r, type: this.type },
      );
    }
  }

  push(cell: CellParse): void {
    this.check(cell);
    this.store(cell);
  }

  /** Stores a cell that check() accepted. */
  store(cell: CellParse): void {
    const r = this.length;
    if (cell.ok) {
      if (cell.nullMarker !== undefined) this.remember(this.markers, r, cell.nullMarker);
      this.append(cell.value);
    } else {
      this.remember(this.failed, r, cell.raw);
      this.append(null);
    }
    this.length = r + 1;
  }

  /** Bytes held so far, kept current on every push so budget checks cost nothing. */
  estimatedBytes(): number {
    return this.valueBytes() + this.sparse;
  }

  abstract finish(): ColumnData;
  protected abstract append(v: CellValue): void;
  protected abstract valueBytes(): number;
  protected abstract fits(v: CellValue): boolean;

  private remember(map: Map<RowId, string>, r: RowId, text: string): void {
    map.set(r, text);
    this.sparse += RAW_ENTRY_BYTES + 2 * text.length;
  }
}

/** Grows a list of fixed-size typed chunks. */
class Chunks<T extends Float64Array | Uint8Array> {
  readonly list: T[] = [];
  constructor(private readonly make: (n: number) => T) {}

  set(r: number, v: number): void {
    const chunk = r >>> CHUNK_SHIFT;
    while (this.list.length <= chunk) this.list.push(this.make(CHUNK_SIZE));
    (this.list[chunk] as T)[r & CHUNK_MASK] = v;
  }
}

class NumericWriter extends ColumnWriter {
  private readonly values = new Chunks((n) => new Float64Array(n));
  private readonly valid = new Chunks((n) => new Uint8Array(n));

  constructor(
    id: ColumnId,
    private readonly numericType: NumericType,
  ) {
    super(id, numericType);
  }

  protected fits(v: CellValue): boolean {
    return !Number.isNaN(encodeNumeric(this.numericType, v));
  }

  protected append(v: CellValue): void {
    const r = this.length;
    // Writing both chunk lists for every row keeps them the same length, even for trailing nulls.
    this.valid.set(r, v === null ? 0 : 1);
    this.values.set(r, v === null ? 0 : encodeNumeric(this.numericType, v));
  }

  protected valueBytes(): number {
    return this.values.list.length * CHUNK_SIZE * 9;
  }

  finish(): ColumnData {
    const { length, failed, markers } = this;
    return new NumericColumn(this.id, this.numericType, length, this.values.list, this.valid.list, failed, markers);
  }
}

class BooleanWriter extends ColumnWriter {
  private readonly bytes = new Chunks((n) => new Uint8Array(n));

  constructor(id: ColumnId) {
    super(id, 'boolean');
  }

  protected fits(v: CellValue): boolean {
    return typeof v === 'boolean';
  }

  protected append(v: CellValue): void {
    this.bytes.set(this.length, v === null ? NULL_BYTE : v === true ? 1 : 0);
  }

  protected valueBytes(): number {
    return this.bytes.list.length * CHUNK_SIZE;
  }

  finish(): ColumnData {
    return new BooleanColumn(this.id, this.length, this.bytes.list, this.failed, this.markers);
  }
}

class StringWriter extends ColumnWriter {
  private readonly values: (string | null)[] = [];
  private bytes = 0;

  constructor(id: ColumnId) {
    super(id, 'string');
  }

  protected fits(v: CellValue): boolean {
    return typeof v === 'string';
  }

  protected append(v: CellValue): void {
    const s = v as string | null;
    this.values.push(s);
    this.bytes += 8 + (s === null ? 0 : STRING_BYTES + 2 * s.length);
  }

  protected valueBytes(): number {
    return this.bytes;
  }

  finish(): ColumnData {
    return new StringColumn(this.id, this.length, this.values, this.bytes, this.failed, this.markers);
  }
}

class GeometryWriter extends ColumnWriter {
  private readonly values: (Geometry | null)[] = [];
  private bytes = 0;

  constructor(id: ColumnId) {
    super(id, 'geometry');
  }

  protected fits(v: CellValue): boolean {
    return isGeometryCell(v);
  }

  protected append(v: CellValue): void {
    const g = v === null ? null : (v as { geometry: Geometry }).geometry;
    this.values.push(g);
    this.bytes += 8 + (g === null ? 0 : geometryBytes(g));
  }

  protected valueBytes(): number {
    return this.bytes;
  }

  finish(): ColumnData {
    return new GeometryColumn(this.id, this.length, this.values, this.bytes, this.failed, this.markers);
  }
}

export function columnWriter(id: ColumnId, type: LogicalType): ColumnWriter {
  switch (type) {
    case 'number':
    case 'integer':
    case 'date':
    case 'datetime':
      return new NumericWriter(id, type);
    case 'boolean':
      return new BooleanWriter(id);
    case 'string':
      return new StringWriter(id);
    case 'geometry':
      return new GeometryWriter(id);
    default:
      throw invalidArgument(`Column ${id} has the unknown type ${JSON.stringify(type)}.`);
  }
}

/** Builds one whole column, as used for an in-place re-parse after a detection override. */
export function buildColumn(id: ColumnId, type: LogicalType, cells: CellParse[]): ColumnData {
  const writer = columnWriter(id, type);
  for (const cell of cells) writer.push(cell);
  return writer.finish();
}

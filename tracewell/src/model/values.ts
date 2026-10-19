/**
 * Cell values as they cross the engine API (SAD section 7.2), and the raw fields that format
 * readers emit before detection gives them a type.
 */
import type { IsoUtc } from './ids';

export type LogicalType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'geometry';

/** RFC 7946 position: longitude, latitude and optional further ordinates. */
export type Position = number[];

export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint' | 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };

/** A calendar date without a time zone: 'YYYY-MM-DD'. */
export interface DateCell {
  date: string;
}

/** An instant, always UTC with millisecond precision. */
export interface DateTimeCell {
  datetime: IsoUtc;
}

export interface GeometryCell {
  geometry: Geometry;
}

/** A typed value. Numbers are always finite: a value that is not becomes null with its raw text kept. */
export type CellValue = null | string | number | boolean | DateCell | DateTimeCell | GeometryCell;

/** What readers emit: text, native numbers, booleans and dates where the format has them, or a format error cell. */
export type RawField = string | number | boolean | null | DateCell | DateTimeCell | { error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isDateCell(v: unknown): v is DateCell {
  return isRecord(v) && typeof v['date'] === 'string';
}

export function isDateTimeCell(v: unknown): v is DateTimeCell {
  return isRecord(v) && typeof v['datetime'] === 'string';
}

export function isGeometryCell(v: unknown): v is GeometryCell {
  if (!isRecord(v)) return false;
  const geometry = v['geometry'];
  return isRecord(geometry) && typeof geometry['type'] === 'string';
}

function isErrorField(v: unknown): v is { error: string } {
  return isRecord(v) && typeof v['error'] === 'string';
}

/**
 * The text a reader field stands for, as shown in lineage and kept in a column's raw map.
 * Numbers use the canonical number form, booleans the JSON words, error cells their error code
 * (for example '#DIV/0!'), and an empty field is ''.
 */
export function rawToText(v: RawField): string {
  if (v === null) return '';
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
      // String() is the canonical number form for finite numbers and already writes -0 as '0'.
      return String(v);
    case 'boolean':
      return v ? 'true' : 'false';
  }
  if (isDateCell(v)) return v.date;
  if (isDateTimeCell(v)) return v.datetime;
  if (isErrorField(v)) return v.error;
  return '';
}

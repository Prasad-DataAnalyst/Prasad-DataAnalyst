/**
 * RFC 7946 FeatureCollection writer for exports. Numbers are written in their canonical form
 * (SAD section 9.4), which is the shortest text that reads back as the same double, so coordinates
 * keep full precision. There is never a `crs` member: RFC 7946 output is always OGC:CRS84, and the
 * export module refuses non-WGS84 data before it gets here (TW-EXP-003).
 *
 * Members keep their insertion order (type, then coordinates; properties in column order) rather
 * than the sorted order of canonicalJson, so the file reads naturally in a text editor.
 */
import { canonicalNumber, utf8, type Geometry } from '@tw/model';
import { invalidArgument } from './errors';

export interface GeoJsonFeatureOut {
  geometry: Geometry | null;
  properties: Record<string, string | number | boolean | null>;
}

/** Deeper nesting than any real geometry; it stops runaway recursion on a cyclic or hostile value. */
const MAX_DEPTH = 256;

function jsonText(v: unknown, depth: number): string {
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return canonicalNumber(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'object':
      if (v === null) return 'null';
      if (depth >= MAX_DEPTH) throw invalidArgument(`A geometry is nested more than ${MAX_DEPTH} levels deep.`);
      return Array.isArray(v) ? arrayText(v, depth + 1) : objectText(v as Record<string, unknown>, depth + 1);
    default:
      throw invalidArgument(`A value of type ${typeof v} cannot be written to GeoJSON.`);
  }
}

function arrayText(items: readonly unknown[], depth: number): string {
  return `[${items.map((item) => jsonText(item, depth)).join(',')}]`;
}

function objectText(o: Record<string, unknown>, depth: number): string {
  const members: string[] = [];
  for (const [key, value] of Object.entries(o)) {
    // Undefined members are left out, as JSON.stringify does.
    if (value !== undefined) members.push(`${JSON.stringify(key)}:${jsonText(value, depth)}`);
  }
  return `{${members.join(',')}}`;
}

function featureText(f: GeoJsonFeatureOut): string {
  return `{"type":"Feature","geometry":${jsonText(f.geometry, 0)},"properties":${jsonText(f.properties, 0)}}`;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * The features as a UTF-8 FeatureCollection with one feature per line. `name` is written as the
 * common `name` foreign member that GIS tools show as the layer name. Throws INVALID_INPUT for a
 * number that is not finite.
 */
export function writeGeoJson(features: Iterable<GeoJsonFeatureOut>, o?: { name?: string }): Uint8Array {
  const name = o?.name === undefined ? '' : `"name":${JSON.stringify(o.name)},`;
  // Encoded feature by feature, so a large export never builds one string of the whole file.
  const chunks: Uint8Array[] = [utf8(`{"type":"FeatureCollection",${name}"features":[\n`)];
  let first = true;
  for (const f of features) {
    chunks.push(utf8(`${first ? '' : ',\n'}${featureText(f)}`));
    first = false;
  }
  chunks.push(utf8(first ? ']}\n' : '\n]}\n'));
  return concat(chunks);
}

/**
 * Non-streaming GeoJSON reader for export read-back of small files. It applies the same document
 * rules as the streaming reader (FeatureCollection, single Feature or bare Geometry) but keeps
 * property values exactly as parsed, so read-back can compare them with what was written.
 */
import { decodeAll, sniffEncoding } from '@tw/io';
import { brokenJson, notGeoJson } from './errors';
import { GEOMETRY_TYPES, isRecord } from './json';

export interface GeoJsonDocument {
  features: { geometry: unknown; properties: Record<string, unknown> }[];
  /** The top-level `crs` member as written, or null when there is none. */
  crs: unknown | null;
}

function parse(bytes: Uint8Array): unknown {
  const { value, bomLength } = sniffEncoding(bytes);
  try {
    return JSON.parse(decodeAll(bytes, value, bomLength)) as unknown;
  } catch (e) {
    throw brokenJson(e instanceof Error ? e.message : String(e));
  }
}

function featureOf(value: unknown): GeoJsonDocument['features'][number] {
  const f = isRecord(value) ? value : {};
  const properties = isRecord(f['properties']) ? f['properties'] : {};
  return { geometry: f['geometry'] ?? null, properties };
}

function featuresOf(root: Record<string, unknown>): GeoJsonDocument['features'] {
  const type = root['type'];
  if (type === 'FeatureCollection') {
    const features = root['features'] ?? [];
    if (!Array.isArray(features)) throw notGeoJson('The "features" member is not an array.');
    return features.map(featureOf);
  }
  if (type === 'Feature') return [featureOf(root)];
  if (typeof type === 'string' && GEOMETRY_TYPES.has(type)) return [{ geometry: root, properties: {} }];
  throw notGeoJson('The top-level object is not a GeoJSON FeatureCollection, Feature or Geometry.');
}

export function readGeoJsonAll(bytes: Uint8Array): GeoJsonDocument {
  const root = parse(bytes);
  if (!isRecord(root)) throw notGeoJson('The file is JSON but not a GeoJSON object: its top level is not an object.');
  return { features: featuresOf(root), crs: root['crs'] ?? null };
}

/**
 * Coordinate reference systems and the transformation between any two of them (FR-PRC-02), from a
 * curated part of the EPSG Dataset (registry.json): a projected source is first unprojected, a
 * change of datum goes through WGS 84 with the EPSG transformation recorded for each datum, and a
 * projected target is projected last. Coordinates are (x, y): longitude and latitude in degrees
 * for a geographic system, easting and northing in metres for a projected one.
 *
 * Every operation is one of methods.ts, so the native engine (geodesy.rs, which reads the same
 * registry) gives the same bits for the same input.
 */
import { EngineError } from '@tw/model';
import { PI } from './exact';
import {
  ellipsoid,
  fromGeocentric,
  helmert,
  lambertConic2,
  lccForward,
  lccReverse,
  tmForward,
  tmReverse,
  toGeocentric,
  transverseMercator,
  type Ellipsoid,
  type Helmert,
  type LambertConic,
  type TransverseMercator,
} from './methods';
import REGISTRY from './registry.json';

const D2R = PI / 180;
const R2D = 180 / PI;
const TWO_PI = 2 * PI;

/** [west, south, east, north] in degrees. */
export type Area = [number, number, number, number];

interface DatumTransformation {
  code: string;
  name: string;
  method: '9603' | '9606' | '9607';
  helmert: Helmert;
  /** Metres, as the EPSG Dataset states it. */
  accuracy: number;
  area: Area;
}

interface Datum {
  code: string;
  name: string;
  ellipsoid: Ellipsoid;
  ellipsoidName: string;
  toWgs84: DatumTransformation | null;
}

type Projection = { method: '9807'; tm: TransverseMercator } | { method: '9802'; lcc: LambertConic };

export interface CrsDefinition {
  code: string;
  name: string;
  kind: 'geographic' | 'projected';
  datum: Datum;
  projection: Projection | null;
}

export const CRS_REGISTRY_VERSION: string = REGISTRY.version;
export const CRS_REGISTRY_SOURCE: string = REGISTRY.source;

const METHOD_NAMES: Record<string, string> = {
  '9603': 'Geocentric translations (geog2D domain)',
  '9606': 'Position Vector transformation (geog2D domain)',
  '9607': 'Coordinate Frame rotation (geog2D domain)',
  '9807': 'Transverse Mercator',
  '9802': 'Lambert Conic Conformal (2SP)',
};

interface RawTransformation {
  code: string;
  name: string;
  method: string;
  tx: number;
  ty: number;
  tz: number;
  rx?: number;
  ry?: number;
  rz?: number;
  ds?: number;
  accuracy: number;
  area: number[];
}

function datumOf(code: string): Datum {
  const raw = (
    REGISTRY.datums as Record<string, { name: string; ellipsoid: string; toWgs84: RawTransformation | null }>
  )[code];
  if (raw === undefined) throw new Error(`The registry has no datum ${code}.`);
  const el = (REGISTRY.ellipsoids as Record<string, { name: string; a: number; invF?: number; b?: number }>)[
    raw.ellipsoid
  ];
  if (el === undefined) throw new Error(`The registry has no ellipsoid ${raw.ellipsoid}.`);
  const f = el.invF !== undefined ? 1 / el.invF : (el.a - (el.b as number)) / el.a;
  const t = raw.toWgs84;
  return {
    code,
    name: raw.name,
    ellipsoid: ellipsoid(el.a, f),
    ellipsoidName: el.name,
    toWgs84:
      t === null
        ? null
        : {
            code: t.code,
            name: t.name,
            method: t.method as DatumTransformation['method'],
            helmert: {
              tx: t.tx,
              ty: t.ty,
              tz: t.tz,
              rx: t.rx ?? 0,
              ry: t.ry ?? 0,
              rz: t.rz ?? 0,
              ds: t.ds ?? 0,
              positionVector: t.method !== '9607',
            },
            accuracy: t.accuracy,
            area: t.area as Area,
          },
  };
}

function geographic(code: string): CrsDefinition | null {
  const raw = (REGISTRY.geographic as Record<string, { name: string; datum: string }>)[code];
  if (raw === undefined) return null;
  return { code: `EPSG:${code}`, name: raw.name, kind: 'geographic', datum: datumOf(raw.datum), projection: null };
}

interface RawProjected {
  name: string;
  base: string;
  method: string;
  lat0?: number;
  lon0?: number;
  k0?: number;
  latF?: number;
  lonF?: number;
  lat1?: number;
  lat2?: number;
  fe: number;
  fn: number;
}

function projected(code: string, raw: RawProjected): CrsDefinition {
  const base = geographic(raw.base);
  if (base === null) throw new Error(`The registry has no geographic CRS ${raw.base}.`);
  const el = base.datum.ellipsoid;
  const projection: Projection =
    raw.method === '9807'
      ? {
          method: '9807',
          tm: transverseMercator(
            el,
            (raw.lat0 as number) * D2R,
            (raw.lon0 as number) * D2R,
            raw.k0 as number,
            raw.fe,
            raw.fn,
          ),
        }
      : {
          method: '9802',
          lcc: lambertConic2(
            el,
            (raw.latF as number) * D2R,
            (raw.lonF as number) * D2R,
            (raw.lat1 as number) * D2R,
            (raw.lat2 as number) * D2R,
            raw.fe,
            raw.fn,
          ),
        };
  return { code: `EPSG:${code}`, name: raw.name, kind: 'projected', datum: base.datum, projection };
}

function utm(code: number): CrsDefinition | null {
  for (const u of REGISTRY.utm) {
    const zone = code - u.first + u.firstZone;
    if (zone < u.firstZone || zone > u.lastZone) continue;
    return projected(String(code), {
      name: u.name.replace('{zone}', String(zone)),
      base: u.base,
      method: '9807',
      lat0: 0,
      lon0: zone * 6 - 183,
      k0: 0.9996,
      fe: 500000,
      fn: u.south ? 10000000 : 0,
    });
  }
  return null;
}

/** The definition of a supported CRS, or null. OGC:CRS84 is WGS 84 with longitude first. */
export function crsDefinition(code: string): CrsDefinition | null {
  if (code === 'OGC:CRS84') {
    const wgs84 = geographic('4326') as CrsDefinition;
    return { ...wgs84, code, name: 'WGS 84 (CRS84)' };
  }
  const m = /^EPSG:(\d{4,5})$/.exec(code);
  if (m === null) return null;
  const n = m[1] as string;
  const raw = (REGISTRY.projected as Record<string, RawProjected>)[n];
  if (raw !== undefined) return projected(n, raw);
  return geographic(n) ?? utm(Number(n));
}

/** Every supported CRS by code and name, geographic ones first, in code order. */
export function supportedCrs(): { code: string; name: string; kind: 'geographic' | 'projected' }[] {
  const codes = [
    ...Object.keys(REGISTRY.geographic),
    ...Object.keys(REGISTRY.projected),
    ...REGISTRY.utm.flatMap((u) => Array.from({ length: u.lastZone - u.firstZone + 1 }, (_, i) => String(u.first + i))),
  ];
  return codes
    .map((c) => crsDefinition(`EPSG:${c}`) as CrsDefinition)
    .sort((a, b) =>
      a.kind === b.kind ? Number(a.code.slice(5)) - Number(b.code.slice(5)) : a.kind === 'geographic' ? -1 : 1,
    )
    .map((c) => ({ code: c.code, name: c.name, kind: c.kind }));
}

/** One operation of a transformation, as the audit log records it. */
export interface CrsOperation {
  /** The EPSG code of the transformation, or of the projected CRS whose projection is applied. */
  code: string;
  name: string;
  method: string;
  /** Metres; null for a conversion, which is exact. */
  accuracy: number | null;
}

export interface CrsTransformer {
  from: CrsDefinition;
  to: CrsDefinition;
  operations: CrsOperation[];
  /** The sum of the operations' stated accuracies, in metres; 0 when every one is exact. */
  accuracy: number;
  /** The transformed point, or null for a point outside what the CRS can hold. */
  forward(x: number, y: number): [number, number] | null;
}

function unknownCrs(code: string): EngineError {
  return new EngineError(
    'INVALID_INPUT',
    `${code} is not a coordinate reference system this edition can transform.`,
    'Choose a listed coordinate reference system.',
    { crs: code },
  );
}

function wrap(lambda: number): number {
  if (lambda > PI) return lambda - TWO_PI;
  if (lambda < -PI) return lambda + TWO_PI;
  return lambda;
}

function unproject(c: CrsDefinition, x: number, y: number): [number, number] | null {
  const p = c.projection;
  if (p === null) {
    if (!(Math.abs(y) <= 90 && Math.abs(x) <= 180)) return null;
    return [y * D2R, x * D2R];
  }
  const [phi, lambda] = p.method === '9807' ? tmReverse(p.tm, x, y) : lccReverse(p.lcc, x, y);
  return [phi, wrap(lambda)];
}

function project(c: CrsDefinition, phi: number, lambda: number): [number, number] {
  const p = c.projection;
  if (p === null) return [lambda * R2D, phi * R2D];
  return p.method === '9807' ? tmForward(p.tm, phi, lambda) : lccForward(p.lcc, phi, lambda);
}

function shiftDatum(from: Datum, to: Datum, phi: number, lambda: number): [number, number] {
  let [x, y, z] = toGeocentric(from.ellipsoid, phi, lambda);
  if (from.toWgs84 !== null) [x, y, z] = helmert(from.toWgs84.helmert, false, x, y, z);
  if (to.toWgs84 !== null) [x, y, z] = helmert(to.toWgs84.helmert, true, x, y, z);
  const [p, l] = fromGeocentric(to.ellipsoid, x, y, z);
  return [p, wrap(l)];
}

function datumOperations(d: Datum, reverse: boolean): CrsOperation[] {
  const t = d.toWgs84;
  if (t === null) return [];
  return [
    {
      code: t.code,
      name: reverse ? `${t.name}, reversed` : t.name,
      method: `${METHOD_NAMES[t.method] as string} (EPSG method ${t.method})`,
      accuracy: t.accuracy,
    },
  ];
}

function projectionOperation(c: CrsDefinition, reverse: boolean): CrsOperation[] {
  const p = c.projection;
  if (p === null) return [];
  return [
    {
      code: c.code,
      name: reverse ? `${c.name}, to latitude and longitude` : c.name,
      method: `${METHOD_NAMES[p.method] as string} (EPSG method ${p.method})`,
      accuracy: null,
    },
  ];
}

/** The transformation from one CRS to another, or INVALID_INPUT naming a CRS it does not know. */
export function crsTransformer(fromCode: string, toCode: string): CrsTransformer {
  const from = crsDefinition(fromCode);
  if (from === null) throw unknownCrs(fromCode);
  const to = crsDefinition(toCode);
  if (to === null) throw unknownCrs(toCode);
  const sameDatum = from.datum.code === to.datum.code;
  // The same coordinates either way: nothing is computed, so nothing is rounded.
  const identity = sameDatum && (from.code === to.code || (from.projection === null && to.projection === null));
  const operations = identity
    ? []
    : [
        ...projectionOperation(from, true),
        ...(sameDatum ? [] : [...datumOperations(from.datum, false), ...datumOperations(to.datum, true)]),
        ...projectionOperation(to, false),
      ];
  const accuracy = operations.reduce((sum, o) => sum + (o.accuracy ?? 0), 0);
  return {
    from,
    to,
    operations,
    accuracy,
    forward(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (identity) return from.kind === 'geographic' && !(Math.abs(y) <= 90 && Math.abs(x) <= 180) ? null : [x, y];
      const g = unproject(from, x, y);
      if (g === null) return null;
      let [phi, lambda] = g;
      if (!sameDatum) [phi, lambda] = shiftDatum(from.datum, to.datum, phi, lambda);
      const out = project(to, phi, lambda);
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : null;
    },
  };
}

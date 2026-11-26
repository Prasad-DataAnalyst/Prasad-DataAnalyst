/**
 * OGC GeoPackage 1.2 (OGC 12-128) on the SQLite file format of sqlite.ts: the writer of a
 * GeoPackage with one feature table, and a reader of the feature tables of any GeoPackage.
 *
 * A geometry is stored as GeoPackageBinary: the bytes "GP", version 0, a flags byte, the SRS ID
 * and an envelope, then the geometry in ISO Well-Known Binary. The writer gives a point no
 * envelope, an empty geometry the empty flag and no envelope, and every other geometry its
 * [min x, max x, min y, max y]; it writes little-endian throughout. The reader takes either byte
 * order, any envelope, and the Z, M and ZM types of ISO and of extended WKB; it keeps heights and
 * drops measures. geopackage.rs in the native engine follows the same rules.
 */
import type { Geometry, Position } from '@tw/model';
import {
  SqliteDatabase,
  SqliteFormatError,
  columnValue,
  parseCreateTable,
  sqlUpper,
  writeSqlite,
  type SqlValue,
  type SqliteColumn,
  type SqliteTableDef,
} from './sqlite';

/** "GPKG", the application ID of every GeoPackage. */
export const GPKG_APPLICATION_ID = 0x4750_4b47;
/** GeoPackage 1.2, which every current GIS reads. */
export const GPKG_USER_VERSION = 10_200;

export interface GpkgSrs {
  id: number;
  name: string;
  organization: string;
  code: number;
  definition: string;
  description: string | null;
}

/** The two rows every GeoPackage holds for coordinates in no known system. */
export const GPKG_UNDEFINED_SRS: readonly GpkgSrs[] = Object.freeze([
  {
    id: -1,
    name: 'Undefined Cartesian SRS',
    organization: 'NONE',
    code: -1,
    definition: 'undefined',
    description: 'undefined Cartesian coordinate reference system',
  },
  {
    id: 0,
    name: 'Undefined geographic SRS',
    organization: 'NONE',
    code: 0,
    definition: 'undefined',
    description: 'undefined geographic coordinate reference system',
  },
]);

const GEOMETRY_CODES: Record<Geometry['type'], number> = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
};
const GEOMETRY_TYPES = Object.fromEntries(Object.entries(GEOMETRY_CODES).map(([k, v]) => [v, k])) as Record<
  number,
  Geometry['type']
>;

/** The name gpkg_geometry_columns gives a geometry type: POINT, MULTIPOLYGON and so on. */
export function gpkgTypeName(type: Geometry['type']): string {
  return sqlUpper(type);
}

// ---------------------------------------------------------------------------------------------
// GeoPackageBinary

class Out {
  buf = new Uint8Array(64);
  view = new DataView(this.buf.buffer);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.room(1);
    this.buf[this.length++] = v;
  }

  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
  }

  i32(v: number): void {
    this.room(4);
    this.view.setInt32(this.length, v, true);
    this.length += 4;
  }

  f64(v: number): void {
    this.room(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function eachPosition(g: Geometry, visit: (p: Position) => void): void {
  switch (g.type) {
    case 'Point':
      if (g.coordinates.length > 0) visit(g.coordinates);
      return;
    case 'MultiPoint':
    case 'LineString':
      g.coordinates.forEach(visit);
      return;
    case 'MultiLineString':
    case 'Polygon':
      for (const part of g.coordinates) part.forEach(visit);
      return;
    case 'MultiPolygon':
      for (const polygon of g.coordinates) for (const ring of polygon) ring.forEach(visit);
      return;
    case 'GeometryCollection':
      for (const member of g.geometries) eachPosition(member, visit);
  }
}

/** [min x, max x, min y, max y] of a geometry's positions, or null when it has none. */
export function envelopeOf(g: Geometry): [number, number, number, number] | null {
  let box: [number, number, number, number] | null = null;
  eachPosition(g, (p) => {
    const x = p[0] as number;
    const y = p[1] as number;
    box =
      box === null
        ? [x, x, y, y]
        : [Math.min(box[0], x), Math.max(box[1], x), Math.min(box[2], y), Math.max(box[3], y)];
  });
  return box;
}

function wkb(out: Out, g: Geometry, z: boolean): void {
  out.u8(1);
  out.u32(GEOMETRY_CODES[g.type] + (z ? 1000 : 0));
  const position = (p: Position): void => {
    out.f64(p[0] as number);
    out.f64(p[1] as number);
    if (z) out.f64(p[2] as number);
  };
  const positions = (ps: readonly Position[]): void => {
    out.u32(ps.length);
    ps.forEach(position);
  };
  switch (g.type) {
    case 'Point':
      if (g.coordinates.length > 0) position(g.coordinates);
      else for (let i = 0; i < (z ? 3 : 2); i++) out.f64(Number.NaN);
      return;
    case 'LineString':
      positions(g.coordinates);
      return;
    case 'Polygon':
      out.u32(g.coordinates.length);
      g.coordinates.forEach(positions);
      return;
    case 'MultiPoint':
      out.u32(g.coordinates.length);
      for (const p of g.coordinates) wkb(out, { type: 'Point', coordinates: p }, z);
      return;
    case 'MultiLineString':
      out.u32(g.coordinates.length);
      for (const line of g.coordinates) wkb(out, { type: 'LineString', coordinates: line }, z);
      return;
    case 'MultiPolygon':
      out.u32(g.coordinates.length);
      for (const rings of g.coordinates) wkb(out, { type: 'Polygon', coordinates: rings }, z);
      return;
    case 'GeometryCollection':
      out.u32(g.geometries.length);
      for (const member of g.geometries) wkb(out, member, z);
  }
}

/**
 * A geometry as GeoPackageBinary in this SRS. With `z`, every position carries its third number
 * as the height; the caller has made sure each has one.
 */
export function gpkgGeometry(g: Geometry, srsId: number, z: boolean): Uint8Array {
  const box = envelopeOf(g);
  const out = new Out();
  out.u8(0x47);
  out.u8(0x50);
  out.u8(0);
  const envelope = box !== null && g.type !== 'Point';
  out.u8(0x01 | (envelope ? 0x02 : 0) | (box === null ? 0x10 : 0));
  out.i32(srsId);
  if (envelope) for (const v of box) out.f64(v);
  wkb(out, g, z);
  return out.done();
}

export interface GpkgGeometryRead {
  srsId: number;
  /** The header's empty flag. */
  empty: boolean;
  /** [min x, max x, min y, max y, …] as the header holds it, or null without one. */
  envelope: number[] | null;
  geometry: Geometry;
}

class In {
  private readonly view: DataView;
  little = true;

  constructor(
    readonly bytes: Uint8Array,
    public at: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(n: number): void {
    if (this.at + n > this.bytes.length) throw new SqliteFormatError('a geometry is cut short');
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.at++] as number;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at, this.little);
    this.at += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.at, this.little);
    this.at += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.at, this.little);
    this.at += 8;
    return v;
  }
}

function readWkb(r: In, depth: number): Geometry {
  if (depth > 32) throw new SqliteFormatError('a geometry is nested too deeply');
  const order = r.u8();
  if (order > 1) throw new SqliteFormatError(`a geometry has the byte order ${order}`);
  r.little = order === 1;
  const code = r.u32();
  // ISO WKB adds 1000 for Z, 2000 for M and 3000 for both; extended WKB sets the two high bits.
  let base = code & 0x0fff_ffff;
  let hasZ = (code & 0x8000_0000) !== 0;
  let hasM = (code & 0x4000_0000) !== 0;
  const thousands = Math.floor(base / 1000);
  if (thousands > 3) throw new SqliteFormatError(`a geometry has the unknown type ${code}`);
  base %= 1000;
  hasZ ||= thousands === 1 || thousands === 3;
  hasM ||= thousands === 2 || thousands === 3;
  const type = GEOMETRY_TYPES[base];
  if (type === undefined) throw new SqliteFormatError(`a geometry has the unknown type ${code}`);
  const little = r.little;
  const position = (): Position => {
    const x = r.f64();
    const y = r.f64();
    const zv = hasZ ? r.f64() : null;
    if (hasM) r.f64();
    return zv === null ? [x, y] : [x, y, zv];
  };
  const count = (size: number): number => {
    const n = r.u32();
    r.need(n * size);
    return n;
  };
  const dims = 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0);
  const positions = (): Position[] => Array.from({ length: count(dims) }, position);
  const member = (want: Geometry['type']): Geometry => {
    const g = readWkb(r, depth + 1);
    r.little = little;
    if (g.type !== want) throw new SqliteFormatError(`a ${type} holds a ${g.type}`);
    return g;
  };
  switch (type) {
    case 'Point': {
      const p = position();
      return { type, coordinates: p.every((v) => Number.isNaN(v)) ? [] : p };
    }
    case 'LineString':
      return { type, coordinates: positions() };
    case 'Polygon':
      return { type, coordinates: Array.from({ length: count(4) }, positions) };
    case 'MultiPoint':
      return {
        type,
        coordinates: Array.from({ length: count(5) }, () => (member('Point') as { coordinates: Position }).coordinates),
      };
    case 'MultiLineString':
      return {
        type,
        coordinates: Array.from(
          { length: count(9) },
          () => (member('LineString') as { coordinates: Position[] }).coordinates,
        ),
      };
    case 'MultiPolygon':
      return {
        type,
        coordinates: Array.from(
          { length: count(9) },
          () => (member('Polygon') as { coordinates: Position[][] }).coordinates,
        ),
      };
    case 'GeometryCollection':
      return {
        type,
        geometries: Array.from({ length: count(5) }, () => {
          const g = readWkb(r, depth + 1);
          r.little = little;
          return g;
        }),
      };
  }
}

/** Reads GeoPackageBinary: its header and its geometry. */
export function readGpkgGeometry(blob: Uint8Array): GpkgGeometryRead {
  const r = new In(blob, 0);
  if (r.u8() !== 0x47 || r.u8() !== 0x50) throw new SqliteFormatError('a geometry does not start with "GP"');
  const version = r.u8();
  if (version !== 0) throw new SqliteFormatError(`a geometry is of GeoPackageBinary version ${version + 1}`);
  const flags = r.u8();
  if ((flags & 0x20) !== 0) throw new SqliteFormatError('a geometry is of an extended GeoPackageBinary type');
  r.little = (flags & 0x01) !== 0;
  const indicator = (flags >> 1) & 0x07;
  const sizes = [0, 4, 6, 6, 8];
  const size = sizes[indicator];
  if (size === undefined) throw new SqliteFormatError(`a geometry has the envelope indicator ${indicator}`);
  const srsId = r.i32();
  const envelope = size === 0 ? null : Array.from({ length: size }, () => r.f64());
  const geometry = readWkb(r, 0);
  return { srsId, empty: (flags & 0x10) !== 0, envelope, geometry };
}

// ---------------------------------------------------------------------------------------------
// The writer

export interface GpkgWriteColumn {
  name: string;
  /** The declared type: TEXT, REAL, INTEGER, BOOLEAN, DATE or DATETIME. */
  type: string;
}

export interface GpkgWriteHeader {
  /** The feature table. */
  table: string;
  /** gpkg_contents.identifier: the name a GIS shows for the layer. */
  identifier: string;
  /** gpkg_contents.last_change, YYYY-MM-DDTHH:MM:SS.SSSZ. */
  lastChange: string;
  /** Every row of gpkg_spatial_ref_sys: the undefined systems, WGS 84 and the system of the data. */
  srs: readonly GpkgSrs[];
  /** The srs_id of the features. */
  srsId: number;
  fidColumn: string;
  geometryColumn: string;
  /** POINT, LINESTRING… or GEOMETRY for a mix. */
  geometryType: string;
  /** 0: no heights, 1: every geometry has them, 2: some do. */
  z: 0 | 1 | 2;
  /** [min x, min y, max x, max y] of every geometry, or null without positions. */
  extent: readonly [number, number, number, number] | null;
  columns: readonly GpkgWriteColumn[];
  /** How many features follow; the table's AUTOINCREMENT sequence starts after them. */
  features: number;
}

export interface GpkgWriteFeature {
  geometry: Geometry | null;
  /** The geometry is written with heights. */
  z: boolean;
  values: readonly SqlValue[];
}

/** A name in double quotes, as SQL quotes identifiers. */
export function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const SRS_SQL =
  'CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, ' +
  'organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, ' +
  'description TEXT)';
const CONTENTS_SQL =
  "CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', " +
  "last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, " +
  'max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, ' +
  'CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))';
const GEOMETRY_COLUMNS_SQL =
  'CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, ' +
  'geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, ' +
  'CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), ' +
  'CONSTRAINT uk_gc_table_name UNIQUE (table_name), ' +
  'CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), ' +
  'CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))';
const SEQUENCE_SQL = 'CREATE TABLE sqlite_sequence(name,seq)';

/** The CREATE TABLE statement of the feature table. */
export function featureTableSql(h: GpkgWriteHeader): string {
  const columns = [
    `${quoteName(h.fidColumn)} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL`,
    `${quoteName(h.geometryColumn)} ${h.geometryType}`,
    ...h.columns.map((c) => `${quoteName(c.name)} ${c.type}`),
  ];
  return `CREATE TABLE ${quoteName(h.table)} (${columns.join(', ')})`;
}

/** A GeoPackage of one feature table, its features in fid order 1, 2, 3… */
export function writeGeoPackage(h: GpkgWriteHeader, features: Iterable<GpkgWriteFeature>): Uint8Array {
  const srs = [...h.srs].sort((a, b) => a.id - b.id);
  const e = h.extent;
  const tables: SqliteTableDef[] = [
    {
      name: 'gpkg_spatial_ref_sys',
      sql: SRS_SQL,
      rows: srs.map((s): readonly [bigint, SqlValue[]] => [
        BigInt(s.id),
        [s.name, null, s.organization, BigInt(s.code), s.definition, s.description],
      ]),
    },
    {
      name: 'gpkg_contents',
      sql: CONTENTS_SQL,
      rows: [
        [
          1n,
          [
            h.table,
            'features',
            h.identifier,
            '',
            h.lastChange,
            e === null ? null : e[0],
            e === null ? null : e[1],
            e === null ? null : e[2],
            e === null ? null : e[3],
            BigInt(h.srsId),
          ],
        ],
      ],
      indexes: [
        { name: 'sqlite_autoindex_gpkg_contents_1', entries: [[h.table, 1n]] },
        { name: 'sqlite_autoindex_gpkg_contents_2', entries: [[h.identifier, 1n]] },
      ],
    },
    {
      name: 'gpkg_geometry_columns',
      sql: GEOMETRY_COLUMNS_SQL,
      rows: [[1n, [h.table, h.geometryColumn, h.geometryType, BigInt(h.srsId), BigInt(h.z), 0n]]],
      indexes: [
        { name: 'sqlite_autoindex_gpkg_geometry_columns_1', entries: [[h.table, h.geometryColumn, 1n]] },
        { name: 'sqlite_autoindex_gpkg_geometry_columns_2', entries: [[h.table, 1n]] },
      ],
    },
    {
      name: h.table,
      sql: featureTableSql(h),
      rows: (function* () {
        let fid = 0n;
        for (const f of features) {
          fid++;
          const blob = f.geometry === null ? null : gpkgGeometry(f.geometry, h.srsId, f.z);
          yield [fid, [null, blob, ...f.values]] as const;
        }
      })(),
    },
    {
      name: 'sqlite_sequence',
      sql: SEQUENCE_SQL,
      rows: h.features > 0 ? [[1n, [h.table, BigInt(h.features)]]] : [],
    },
  ];
  return writeSqlite({ applicationId: GPKG_APPLICATION_ID, userVersion: GPKG_USER_VERSION }, tables);
}

// ---------------------------------------------------------------------------------------------
// The reader

export interface GpkgLayer {
  table: string;
  dataType: string;
  identifier: string | null;
  srsId: number | null;
  /** [min x, min y, max x, max y] as gpkg_contents holds it; a missing bound is null. */
  extent: [number | null, number | null, number | null, number | null];
  lastChange: string | null;
  /** The gpkg_geometry_columns row of a feature table. */
  geometry: { column: string; type: string; srsId: number; z: number; m: number } | null;
  /** Every column of the table, as its CREATE TABLE statement declares them. */
  columns: SqliteColumn[];
  root: number;
}

export interface GpkgFile {
  db: SqliteDatabase;
  applicationId: number;
  userVersion: number;
  srs: GpkgSrs[];
  layers: GpkgLayer[];
  /** The tables of the schema by name, with their root pages and statements. */
  tables: Map<string, { root: number; sql: string | null }>;
}

const num = (v: SqlValue | undefined): number | null =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
const text = (v: SqlValue | undefined): string | null => (typeof v === 'string' ? v : null);

/** The rows of a table by its columns' names, rowid aliases filled in. */
export function* namedRows(file: GpkgFile, table: string): Generator<Map<string, SqlValue>> {
  const t = file.tables.get(table);
  if (t === undefined || t.sql === null) return;
  const columns = parseCreateTable(t.sql).columns;
  for (const { rowid, values } of file.db.rows(t.root)) {
    yield new Map(columns.map((c, i) => [c.name, c.rowid ? rowid : columnValue(c, values[i] ?? null)]));
  }
}

/** A GeoPackage's systems and the tables gpkg_contents lists. */
export function readGeoPackage(bytes: Uint8Array): GpkgFile {
  const db = new SqliteDatabase(bytes);
  const tables = new Map<string, { root: number; sql: string | null }>();
  for (const row of db.schema()) if (row.type === 'table') tables.set(row.name, { root: row.root, sql: row.sql });
  const file: GpkgFile = {
    db,
    applicationId: db.applicationId,
    userVersion: db.userVersion,
    srs: [],
    layers: [],
    tables,
  };
  for (const r of namedRows(file, 'gpkg_spatial_ref_sys')) {
    file.srs.push({
      id: num(r.get('srs_id')) ?? 0,
      name: text(r.get('srs_name')) ?? '',
      organization: text(r.get('organization')) ?? '',
      code: num(r.get('organization_coordsys_id')) ?? 0,
      definition: text(r.get('definition')) ?? '',
      description: text(r.get('description')),
    });
  }
  const geometries = new Map<string, GpkgLayer['geometry']>();
  for (const r of namedRows(file, 'gpkg_geometry_columns')) {
    const table = text(r.get('table_name'));
    if (table === null) continue;
    geometries.set(table, {
      column: text(r.get('column_name')) ?? '',
      type: text(r.get('geometry_type_name')) ?? '',
      srsId: num(r.get('srs_id')) ?? 0,
      z: num(r.get('z')) ?? 0,
      m: num(r.get('m')) ?? 0,
    });
  }
  for (const r of namedRows(file, 'gpkg_contents')) {
    const table = text(r.get('table_name'));
    const t = table === null ? undefined : tables.get(table);
    if (table === null || t === undefined || t.sql === null) continue;
    file.layers.push({
      table,
      dataType: text(r.get('data_type')) ?? '',
      identifier: text(r.get('identifier')),
      srsId: num(r.get('srs_id')),
      extent: [num(r.get('min_x')), num(r.get('min_y')), num(r.get('max_x')), num(r.get('max_y'))],
      lastChange: text(r.get('last_change')),
      geometry: geometries.get(table) ?? null,
      columns: parseCreateTable(t.sql).columns,
      root: t.root,
    });
  }
  return file;
}

export interface GpkgFeature {
  fid: bigint;
  /** The geometry column's blob, or null. */
  blob: Uint8Array | null;
  /** The other columns' values, in the order of the layer's columns without the fid and geometry. */
  values: SqlValue[];
}

/** The features of a layer in fid order. */
export function* gpkgFeatures(file: GpkgFile, layer: GpkgLayer): Generator<GpkgFeature> {
  const g = layer.columns.findIndex((c) => c.name === layer.geometry?.column);
  for (const { rowid, values } of file.db.rows(layer.root)) {
    const blob = g < 0 ? null : values[g];
    yield {
      fid: rowid,
      blob: blob instanceof Uint8Array ? blob : null,
      values: layer.columns.flatMap((c, i) => (c.rowid || i === g ? [] : [columnValue(c, values[i] ?? null)])),
    };
  }
}

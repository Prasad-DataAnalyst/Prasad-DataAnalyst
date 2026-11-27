/**
 * The GeoPackage Importer used by ingest: one layer of a GeoPackage, read in memory with the
 * SQLite reader of sqlite.ts (SAD decision D-16).
 *
 * The layer is the table the options name, else the first table gpkg_contents lists as features,
 * else the first it lists as attributes; the others are named in the layer detection. Each row
 * is located by its feature ID (the table's rowid). Its fields are the table's columns in order,
 * but the feature ID and the geometry column: whole numbers as numbers (one beyond 2^53 as its
 * exact digits), 0 and 1 in a BOOLEAN column as booleans, reals as numbers, text as text (dates
 * and date-times as their text, which detection types) and blobs as hexadecimal text, as the
 * FlatGeobuf reader gives them. A whole number SQLite stored for a REAL column is a real.
 *
 * The geometry is read from GeoPackageBinary and carried beside the fields, kept as the file has
 * it: heights kept, measures dropped, a number that is not finite as null and -0 as 0. The CRS is
 * the layer's row of gpkg_spatial_ref_sys: its EPSG code when the organisation is EPSG, else the
 * EPSG code its WKT names; recorded, never applied.
 */
import {
  BATCH_ROWS,
  EngineError,
  detection,
  type ByteSource,
  type CrsRef,
  type Detection,
  type FormatOptions,
  type Geometry,
  type Importer,
  type JsonValue,
  type RawBatch,
  type RawField,
  type RawRow,
  type ReadContext,
  type SniffResult,
} from '@tw/model';
import { readGeoPackage, readGpkgGeometry, type GpkgFile, type GpkgLayer } from './gpkg';
import { SqliteFormatError, columnValue, sqlUpper, type SqlValue, type SqliteColumn } from './sqlite';

/** The largest GeoPackage read; the whole file is held in memory. */
export const GEOPACKAGE_IMPORT_MAX_BYTES = 1024 ** 3;

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;

const PARSE_FIX =
  'Save the layer again as a GeoPackage from the GIS tool (in QGIS: Export › Save Features As), then import the new file.';

function parseFailed(why: string): EngineError {
  return new EngineError('PARSE_FAILED', `The GeoPackage does not parse: ${why}.`, PARSE_FIX);
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new EngineError('CANCELLED', 'The import was cancelled.', 'Start the import again when you are ready.');
}

function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Runs a read of the file, a damaged file's error as a parse failure. */
function parsing<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof SqliteFormatError) throw parseFailed(e.message);
    throw e;
  }
}

async function open(src: ByteSource): Promise<GpkgFile> {
  if (src.size > GEOPACKAGE_IMPORT_MAX_BYTES) {
    throw new EngineError(
      'FORMAT_UNSUPPORTED',
      `The GeoPackage is larger than the ${GEOPACKAGE_IMPORT_MAX_BYTES / 1024 ** 3} GiB that is read.`,
      'Open it with the desktop edition, which reads it a page at a time, or save the layer alone as a GeoPackage and import that.',
    );
  }
  const bytes = await src.slice(0, src.size);
  return parsing(() => readGeoPackage(bytes));
}

// ---------------------------------------------------------------------------------------------
// The layer

/** The tables a GeoPackage holds data in, in the order gpkg_contents lists them. */
function dataLayers(file: GpkgFile): GpkgLayer[] {
  return file.layers.filter((l) => l.dataType === 'features' || l.dataType === 'attributes');
}

function layerOf(file: GpkgFile, wanted: string | null): GpkgLayer {
  const layers = dataLayers(file);
  if (layers.length === 0) {
    throw parseFailed(
      file.tables.has('gpkg_contents')
        ? 'its gpkg_contents table lists no table of features or attributes'
        : 'it is an SQLite database without the gpkg_contents table of a GeoPackage',
    );
  }
  if (wanted === null) return layers.find((l) => l.dataType === 'features') ?? (layers[0] as GpkgLayer);
  const found = layers.find((l) => l.table === wanted);
  if (found === undefined) {
    throw new EngineError(
      'INVALID_INPUT',
      `The GeoPackage has no layer named ${JSON.stringify(wanted)}.`,
      `Choose one of its layers: ${layers.map((l) => l.table).join(', ')}.`,
    );
  }
  return found;
}

/** The layer's geometry column: the one gpkg_geometry_columns names, when the table has it. */
function geometryColumn(layer: GpkgLayer): string | null {
  const name = layer.geometry?.column;
  return name !== undefined && layer.columns.some((c) => c.name === name) ? name : null;
}

/** The layer's columns of fields: every column but the feature ID and the geometry. */
function fieldColumns(layer: GpkgLayer): SqliteColumn[] {
  const geometry = geometryColumn(layer);
  return layer.columns.filter((c) => !c.rowid && c.name !== geometry);
}

// ---------------------------------------------------------------------------------------------
// Rows

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fieldOf(v: SqlValue, c: SqliteColumn): RawField {
  if (v === null || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') {
    if (sqlUpper(c.type) === 'BOOLEAN' && (v === 0n || v === 1n)) return v === 1n;
    return v >= -(2n ** 53n) + 1n && v <= 2n ** 53n - 1n ? Number(v) : v.toString();
  }
  return hex(v);
}

/** A number of a position as it is kept: -0 as 0, and what is not finite as null. */
function settled(x: number): number | null {
  return Number.isFinite(x) ? x + 0 : null;
}

function settle(c: unknown): unknown {
  return Array.isArray(c) ? c.map(settle) : typeof c === 'number' ? settled(c) : c;
}

function settleGeometry(g: Geometry): Geometry {
  return g.type === 'GeometryCollection'
    ? { type: g.type, geometries: g.geometries.map(settleGeometry) }
    : ({ type: g.type, coordinates: settle(g.coordinates) } as Geometry);
}

/** The rows of a layer in feature ID order, the first `limit` of them. */
function* rowsOf(file: GpkgFile, layer: GpkgLayer, limit = Infinity): Generator<RawRow> {
  const fields = fieldColumns(layer);
  const at = new Map(layer.columns.map((c, i) => [c, i]));
  const geometryName = geometryColumn(layer);
  const g = layer.columns.findIndex((c) => c.name === geometryName);
  const rows = file.db.rows(layer.root);
  for (let n = 0; n < limit; n++) {
    const next = parsing(() => rows.next());
    if (next.done === true) return;
    const { rowid, values } = next.value;
    if (rowid < 0n || rowid > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw parseFailed(`the feature ID ${rowid} is outside the range of row locations`);
    }
    const blob = g < 0 ? null : (values[g] ?? null);
    let geometry: Geometry | null = null;
    if (blob !== null) {
      if (!(blob instanceof Uint8Array)) {
        throw parseFailed(`the geometry of feature ${rowid} is not a GeoPackage geometry`);
      }
      try {
        geometry = settleGeometry(readGpkgGeometry(blob).geometry);
      } catch (e) {
        if (e instanceof SqliteFormatError)
          throw parseFailed(`the geometry of feature ${rowid} does not read: ${e.message}`);
        throw e;
      }
    }
    yield {
      srcLoc: Number(rowid),
      fields: fields.map((c) => fieldOf(columnValue(c, values[at.get(c) as number] ?? null), c)),
      ...(geometryName === null ? {} : { geometry }),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Detections

function crsDetection(file: GpkgFile, layer: GpkgLayer): Detection<CrsRef> {
  const det = (code: string, confidence: 'high' | 'low', method: string, evidence: string) =>
    detection<CrsRef>({ code: code as CrsRef['code'], source: 'geopackage-srs' }, confidence, method, evidence);
  const id = layer.geometry?.srsId ?? layer.srsId;
  const srs = file.srs.find((s) => s.id === id);
  if (id === null || srs === undefined) {
    return det(
      'unknown',
      'low',
      'geopackage-srs',
      `gpkg_spatial_ref_sys has no row for the layer's srs_id ${id ?? 'null'}, so the coordinate reference system is not known.`,
    );
  }
  const name = srs.name === '' ? '' : ` (${srs.name})`;
  if (sqlUpper(srs.organization) === 'EPSG' && srs.code > 0) {
    return det(
      `EPSG:${srs.code}`,
      'high',
      'geopackage-srs',
      `gpkg_spatial_ref_sys gives the layer the coordinate reference system EPSG:${srs.code}${name}.`,
    );
  }
  if (sqlUpper(srs.organization) === 'NONE' || id === 0 || id === -1) {
    return det(
      'unknown',
      'low',
      'geopackage-srs',
      `The layer's srs_id ${id} is the undefined ${id === 0 ? 'geographic' : 'Cartesian'} system, so the coordinate reference system is not known.`,
    );
  }
  const authority = /AUTHORITY\["EPSG",[ ]*"?(\d{1,9})"?\]\][ \t\r\n]*$/.exec(srs.definition)?.[1];
  if (authority !== undefined) {
    return det(
      `EPSG:${Number(authority)}`,
      'high',
      'geopackage-srs-wkt',
      `gpkg_spatial_ref_sys describes the layer's system${name} with Well-Known Text that names EPSG:${Number(authority)}.`,
    );
  }
  return det(
    'unknown',
    'low',
    'geopackage-srs',
    `gpkg_spatial_ref_sys gives the layer the system ${srs.organization}:${srs.code}${name}, which has no EPSG code.`,
  );
}

function detectionsOf(
  file: GpkgFile,
  layer: GpkgLayer,
  sample: RawRow[],
  count: number,
): Record<string, Detection<JsonValue>> {
  const layers = dataLayers(file);
  const listed = layers.map((l) => `${l.table} (${l.dataType})`).join(', ');
  const encoding = file.db.encoding;
  const detections: Record<string, Detection<JsonValue>> = {
    encoding: detection(
      encoding,
      'high',
      'sqlite-header',
      `The SQLite header gives the text encoding ${encoding === 'utf-8' ? 'UTF-8' : encoding === 'utf-16le' ? 'UTF-16LE' : 'UTF-16BE'}.`,
    ),
    layer: detection(
      layer.table,
      'high',
      'geopackage-contents',
      layers.length === 1
        ? `The GeoPackage holds one table of data, ${listed}.`
        : `The GeoPackage holds ${layers.length} tables of data: ${listed}; ${layer.table} is read.`,
    ),
    rowCount: detection(count, 'high', 'geopackage-rows', `The table ${layer.table} holds ${formatCount(count)} rows.`),
  };
  if (geometryColumn(layer) !== null) {
    const crs = crsDetection(file, layer);
    detections['crs'] = { ...crs, value: { code: crs.value.code, source: crs.value.source } };
    const types: string[] = [];
    for (const r of sample) if (r.geometry != null && !types.includes(r.geometry.type)) types.push(r.geometry.type);
    const over = sample.length < count ? `the first ${formatCount(sample.length)}` : `all ${formatCount(count)}`;
    detections['geometryTypes'] = detection(
      types,
      'high',
      'geometry-types',
      `Found ${types.length === 0 ? 'no geometry types' : `geometry types ${types.join(', ')}`} over ${over} features.`,
    );
  }
  return detections;
}

// ---------------------------------------------------------------------------------------------
// The importer

const OPTIONS = (layer: GpkgLayer): FormatOptions => ({
  format: 'geopackage',
  geopackage: { layer: layer.table, geometry: geometryColumn(layer) },
});

async function sniff(src: ByteSource): Promise<SniffResult> {
  const file = await open(src);
  const layer = layerOf(file, null);
  const sample = [...rowsOf(file, layer, SAMPLE_ROWS)];
  const count = parsing(() => file.db.count(layer.root));
  return {
    format: 'geopackage',
    options: OPTIONS(layer),
    detections: detectionsOf(file, layer, sample, count),
    header: [fieldColumns(layer).map((c) => c.name)],
    sampleRows: sample,
    notes: [],
  };
}

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  if (opts.format !== 'geopackage') {
    throw new EngineError(
      'INVALID_INPUT',
      `The GeoPackage reader was given options for the "${opts.format}" format.`,
      'Correct the value passed to the function; this is a defect in the calling code, not in the data.',
    );
  }
  aborted(ctx.signal);
  const file = await open(src);
  const layer = layerOf(file, opts.geopackage.layer);
  ctx.onBytes(src.size);
  let batch: RawRow[] = [];
  for (const row of rowsOf(file, layer)) {
    batch.push(row);
    if (batch.length === BATCH_ROWS) {
      aborted(ctx.signal);
      yield { rows: batch };
      batch = [];
    }
  }
  if (batch.length > 0) yield { rows: batch };
}

export const geopackageImporter: Importer = {
  formats: ['geopackage'],
  sniff,
  read,
};

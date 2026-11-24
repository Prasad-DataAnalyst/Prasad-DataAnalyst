/**
 * The Google Earth profile's rules (SAD section 10.1), shared by its plan, its writer and the
 * expectation its read-back is held to: the placemark of each row, which columns XML can carry,
 * and the form each geometry takes once read back. KML holds WGS 84 longitude and latitude, so
 * only data in WGS 84 is written; a position keeps at most three numbers (longitude, latitude,
 * height). A multi-part geometry or a collection is a MultiGeometry, which a reader takes back as
 * a multi-part geometry when its members are all of one kind. The native engine (kml.rs) follows
 * the same rules.
 */
import { multiGeometry, type KmlPlacemark } from '@tw/formats-kml';
import { isGeometryCell, type CellValue, type ColumnSchema, type Geometry, type Position } from '@tw/model';
import { isGeometry, pointFromLatLon } from '@tw/geo';
import type { View } from '@tw/table';
import { headerFor } from './profiles';
import { exportable, textOf } from './values';

/** Characters XML 1.0 cannot carry: most control characters, U+FFFE, U+FFFF and lone surrogates. */
const NOT_XML =
  // eslint-disable-next-line no-control-regex -- the control characters are what this pattern finds.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A row's geometry, and whether a value had no valid shape. */
function rowGeometry(view: View, r: number, source: 'column' | 'latlon'): { g: Geometry | null; bad: boolean } {
  const schema = view.schema;
  if (source === 'column') {
    const v = schema.geometryColumn === null ? null : view.value(r, schema.geometryColumn);
    if (v === null) return { g: null, bad: false };
    return isGeometryCell(v) && isGeometry(v.geometry) ? { g: v.geometry, bad: false } : { g: null, bad: true };
  }
  const lat = schema.columns.find((c) => c.role.value === 'latitude');
  const lon = schema.columns.find((c) => c.role.value === 'longitude');
  const y = lat === undefined ? null : view.value(r, lat.id);
  const x = lon === undefined ? null : view.value(r, lon.id);
  return typeof x === 'number' && typeof y === 'number'
    ? { g: pointFromLatLon(y, x), bad: false }
    : { g: null, bad: false };
}

/** The most numbers any position of a geometry has. */
function longest(g: Geometry): number {
  let most = 0;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      most = Math.max(most, c.length);
      return;
    }
    for (const item of c) visit(item);
  };
  if (g.type === 'GeometryCollection') for (const m of g.geometries) most = Math.max(most, longest(m));
  else visit(g.coordinates);
  return most;
}

/** The attribute columns: every column of the view but the geometry column the places come from. */
export function kmlAttributes(view: View, source: 'column' | 'latlon'): ColumnSchema[] {
  return view
    .columnIds()
    .filter((id) => !(source === 'column' && id === view.schema.geometryColumn))
    .map((id) => view.columnSchema(id));
}

export interface KmlAnalysis {
  /** Rows whose geometry has no valid shape; their placemarks have none. */
  bad: number;
  /** Geometries with positions of more than three numbers. */
  long: number;
  /** Attribute columns holding text XML cannot carry. */
  unfit: string[];
}

export function analyseKml(view: View, source: 'column' | 'latlon', attributes: ColumnSchema[]): KmlAnalysis {
  let bad = 0;
  let long = 0;
  const unfit = new Set<string>();
  for (const r of view.rows()) {
    const { g, bad: isBad } = rowGeometry(view, r, source);
    if (isBad) bad++;
    if (g !== null && longest(g) > 3) long++;
    for (const c of attributes) {
      if (unfit.has(c.id)) continue;
      const v = exportable(view.value(r, c.id));
      if (v !== null && NOT_XML.test(textOf(v))) unfit.add(c.id);
    }
  }
  return { bad, long, unfit: attributes.filter((c) => unfit.has(c.id)).map((c) => c.id) };
}

/** The column that names each placemark: the first ID column, if any. */
function nameColumn(columns: ColumnSchema[]): ColumnSchema | undefined {
  return columns.find((c) => c.role.value === 'id');
}

/** Each row as a placemark: its name, its values by header, and its geometry. */
export function* placemarks(
  view: View,
  source: 'column' | 'latlon',
  columns: ColumnSchema[],
): IterableIterator<KmlPlacemark> {
  const named = nameColumn(columns);
  for (const r of view.rows()) {
    const name = named === undefined ? null : exportable(view.value(r, named.id));
    yield {
      name: name === null ? null : textOf(name),
      data: columns.map((c): [string, string | null] => {
        const v = exportable(view.value(r, c.id));
        return [headerFor(c), v === null ? null : textOf(v)];
      }),
      geometry: rowGeometry(view, r, source).g,
    };
  }
}

/** A geometry as a reader takes it back from KML. */
export function kmlForm(g: Geometry): Geometry {
  const p = (x: Position): Position => x.slice(0, 3);
  switch (g.type) {
    case 'Point':
      return { type: 'Point', coordinates: p(g.coordinates) };
    case 'LineString':
      return { type: 'LineString', coordinates: g.coordinates.map(p) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(p)) };
    case 'MultiPoint':
      return multiGeometry(g.coordinates.map((c) => ({ type: 'Point', coordinates: p(c) })));
    case 'MultiLineString':
      return multiGeometry(g.coordinates.map((l) => ({ type: 'LineString', coordinates: l.map(p) })));
    case 'MultiPolygon':
      return multiGeometry(
        g.coordinates.map((rings) => ({ type: 'Polygon', coordinates: rings.map((ring) => ring.map(p)) })),
      );
    case 'GeometryCollection':
      return multiGeometry(g.geometries.map(kmlForm));
  }
}

/** Each row's geometry in the form a reader takes back. */
export function* expectedKmlGeometries(view: View, source: 'column' | 'latlon'): IterableIterator<CellValue> {
  for (const r of view.rows()) {
    const { g } = rowGeometry(view, r, source);
    yield g === null ? null : { geometry: kmlForm(g) };
  }
}

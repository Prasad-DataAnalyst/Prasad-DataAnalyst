/**
 * A KML 2.2 writer (OGC 07-147r2): one Document of Placemarks, each with its values as
 * ExtendedData and its geometry, positions as longitude,latitude[,height] in WGS 84. Text is
 * escaped so that every XML parser gives it back exactly: a carriage return, which parsers turn
 * into a line feed, is written as a character reference. A multi-part geometry or a geometry
 * collection is a MultiGeometry. The native engine writes the same bytes (kml.rs).
 */
import { canonicalNumber, type Geometry, type Position } from '@tw/model';

export interface KmlPlacemark {
  /** The placemark's label, or null for none. */
  name: string | null;
  /** Each value by its column header; null for no value. */
  data: [string, string | null][];
  geometry: Geometry | null;
}

export const KML_NAMESPACE = 'http://www.opengis.net/kml/2.2';

/** Text as element content: &, < and > escaped, and a carriage return as a reference. */
export function escapeText(text: string): string {
  return text.replace(/[&<>\r]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#13;'));
}

/** Text as an attribute value: also quotes, and tab and line ends, which parsers turn into spaces. */
export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/["\t\n]/g, (c) => (c === '"' ? '&quot;' : c === '\t' ? '&#9;' : '&#10;'));
}

function position(p: Position): string {
  return p
    .slice(0, 3)
    .map((x) => canonicalNumber(x))
    .join(',');
}

function coordinates(ps: Position[]): string {
  return `<coordinates>${ps.map(position).join(' ')}</coordinates>`;
}

function ring(ps: Position[]): string {
  return `<LinearRing>${coordinates(ps)}</LinearRing>`;
}

function polygon(rings: Position[][]): string {
  const [outer, ...inner] = rings;
  return (
    '<Polygon>' +
    (outer === undefined ? '' : `<outerBoundaryIs>${ring(outer)}</outerBoundaryIs>`) +
    inner.map((r) => `<innerBoundaryIs>${ring(r)}</innerBoundaryIs>`).join('') +
    '</Polygon>'
  );
}

/** A geometry as KML. */
export function geometryXml(g: Geometry): string {
  switch (g.type) {
    case 'Point':
      return `<Point>${coordinates([g.coordinates])}</Point>`;
    case 'LineString':
      return `<LineString>${coordinates(g.coordinates)}</LineString>`;
    case 'Polygon':
      return polygon(g.coordinates);
    case 'MultiPoint':
      return `<MultiGeometry>${g.coordinates.map((p) => `<Point>${coordinates([p])}</Point>`).join('')}</MultiGeometry>`;
    case 'MultiLineString':
      return `<MultiGeometry>${g.coordinates.map((l) => `<LineString>${coordinates(l)}</LineString>`).join('')}</MultiGeometry>`;
    case 'MultiPolygon':
      return `<MultiGeometry>${g.coordinates.map(polygon).join('')}</MultiGeometry>`;
    case 'GeometryCollection':
      return `<MultiGeometry>${g.geometries.map(geometryXml).join('')}</MultiGeometry>`;
  }
}

export function writeKml(name: string, placemarks: Iterable<KmlPlacemark>): Uint8Array {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<kml xmlns="${KML_NAMESPACE}">\n`,
    '<Document>\n',
    `<name>${escapeText(name)}</name>\n`,
  ];
  for (const p of placemarks) {
    out.push('<Placemark>\n');
    if (p.name !== null) out.push(`<name>${escapeText(p.name)}</name>\n`);
    out.push('<ExtendedData>\n');
    for (const [header, value] of p.data) {
      out.push(`<Data name="${escapeAttribute(header)}"><value>${escapeText(value ?? '')}</value></Data>\n`);
    }
    out.push('</ExtendedData>\n');
    if (p.geometry !== null) out.push(`${geometryXml(p.geometry)}\n`);
    out.push('</Placemark>\n');
  }
  out.push('</Document>\n', '</kml>\n');
  return new TextEncoder().encode(out.join(''));
}

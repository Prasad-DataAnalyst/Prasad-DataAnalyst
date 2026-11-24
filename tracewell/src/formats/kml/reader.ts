/**
 * A KML 2.2 reader: the Document's Placemarks, each with its name, its ExtendedData values in
 * order and its geometry as GeoJSON. A MultiGeometry whose members are all points, all lines or
 * all polygons is read as a MultiPoint, MultiLineString or MultiPolygon, and any other as a
 * GeometryCollection. saxes expands only the predefined entities and character references,
 * never a DTD, so a file cannot pull in external entities; a file that declares one is refused.
 */
import { SaxesParser } from 'saxes';
import type { Geometry, Position } from '@tw/model';

export interface KmlReadPlacemark {
  name: string | null;
  data: [string, string][];
  geometry: Geometry | null;
  /** Geometry elements directly in the placemark; KML allows one. */
  geometries: number;
}

export interface KmlDocument {
  /** The root element's name and namespace. */
  root: string;
  namespace: string | null;
  documents: number;
  name: string | null;
  placemarks: KmlReadPlacemark[];
}

export class KmlFormatError extends Error {}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

/** A geometry being read: a point, line or polygon gathering coordinates, or a MultiGeometry. */
type Building =
  | { kind: 'Point' | 'LineString'; positions: Position[] }
  | { kind: 'Polygon'; rings: Position[][]; outer: boolean }
  | { kind: 'LinearRing'; positions: Position[] }
  | { kind: 'MultiGeometry'; members: Geometry[] };

function parsePositions(text: string): Position[] {
  const tuples = text.trim() === '' ? [] : text.trim().split(/\s+/);
  return tuples.map((t) =>
    t.split(',').map((x) => {
      const n = Number(x);
      if (x === '' || !Number.isFinite(n))
        throw new KmlFormatError(`the coordinates ${JSON.stringify(t)} are not numbers`);
      return n;
    }),
  );
}

/** A MultiGeometry as GeoJSON: a multi-part geometry when its members are all of one simple kind. */
export function multiGeometry(members: Geometry[]): Geometry {
  if (members.length > 0 && members.every((m) => m.type === 'Point')) {
    return { type: 'MultiPoint', coordinates: members.map((m) => (m as { coordinates: Position }).coordinates) };
  }
  if (members.length > 0 && members.every((m) => m.type === 'LineString')) {
    return { type: 'MultiLineString', coordinates: members.map((m) => (m as { coordinates: Position[] }).coordinates) };
  }
  if (members.length > 0 && members.every((m) => m.type === 'Polygon')) {
    return { type: 'MultiPolygon', coordinates: members.map((m) => (m as { coordinates: Position[][] }).coordinates) };
  }
  return { type: 'GeometryCollection', geometries: members };
}

export function readKml(bytes: Uint8Array): KmlDocument {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new KmlFormatError('it is not UTF-8 text');
  }
  const doc: KmlDocument = { root: '', namespace: null, documents: 0, name: null, placemarks: [] };
  const path: string[] = [];
  const geometry: Building[] = [];
  let placemark: KmlReadPlacemark | null = null;
  let buffer: string | null = null;
  let dataName: string | null = null;
  let value = '';

  const finish = (g: Geometry) => {
    const parent = geometry[geometry.length - 1];
    if (parent?.kind === 'MultiGeometry') parent.members.push(g);
    else if (placemark !== null) {
      placemark.geometries++;
      placemark.geometry = g;
    }
  };

  const sax = new SaxesParser<{ xmlns: false; position: false }>({ xmlns: false, position: false });
  sax.on('error', (e) => {
    throw new KmlFormatError(`it is not well-formed XML (${e.message})`);
  });
  sax.on('doctype', () => {
    throw new KmlFormatError('it declares a document type, which KML never needs');
  });
  sax.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (path.length === 0) {
      doc.root = name;
      doc.namespace = tag.attributes['xmlns'] ?? null;
    }
    const parent = path[path.length - 1];
    path.push(name);
    switch (name) {
      case 'Document':
        doc.documents++;
        break;
      case 'Placemark':
        placemark = { name: null, data: [], geometry: null, geometries: 0 };
        break;
      case 'name':
        if (parent === 'Placemark' || parent === 'Document') buffer = '';
        break;
      case 'Data':
        dataName = tag.attributes['name'] ?? '';
        value = '';
        break;
      case 'value':
        buffer = '';
        break;
      case 'coordinates':
        buffer = '';
        break;
      case 'Point':
      case 'LineString':
        geometry.push({ kind: name, positions: [] });
        break;
      case 'Polygon':
        geometry.push({ kind: 'Polygon', rings: [], outer: false });
        break;
      case 'LinearRing':
        geometry.push({ kind: 'LinearRing', positions: [] });
        break;
      case 'MultiGeometry':
        geometry.push({ kind: 'MultiGeometry', members: [] });
        break;
      case 'outerBoundaryIs': {
        const g = geometry[geometry.length - 1];
        if (g?.kind === 'Polygon') g.outer = true;
        break;
      }
    }
  });
  const onText = (t: string) => {
    if (buffer !== null) buffer += t;
  };
  sax.on('text', onText);
  sax.on('cdata', onText);
  sax.on('closetag', (tag) => {
    const name = localName(tag.name);
    path.pop();
    const parent = path[path.length - 1];
    switch (name) {
      case 'name':
        if (buffer !== null) {
          if (parent === 'Placemark' && placemark !== null) placemark.name = buffer;
          else if (parent === 'Document') doc.name = buffer;
        }
        buffer = null;
        break;
      case 'value':
        value = buffer ?? '';
        buffer = null;
        break;
      case 'Data':
        placemark?.data.push([dataName ?? '', value]);
        dataName = null;
        break;
      case 'coordinates': {
        const g = geometry[geometry.length - 1];
        const positions = parsePositions(buffer ?? '');
        buffer = null;
        if (g?.kind === 'Point' || g?.kind === 'LineString' || g?.kind === 'LinearRing') g.positions = positions;
        break;
      }
      case 'Point': {
        const g = geometry.pop() as { positions: Position[] };
        finish({ type: 'Point', coordinates: g.positions[0] ?? [] });
        break;
      }
      case 'LineString': {
        const g = geometry.pop() as { positions: Position[] };
        finish({ type: 'LineString', coordinates: g.positions });
        break;
      }
      case 'LinearRing': {
        const g = geometry.pop() as { positions: Position[] };
        const polygon = geometry[geometry.length - 1];
        if (polygon?.kind === 'Polygon') {
          // The outer boundary comes first, however the file orders it.
          if (polygon.outer) polygon.rings.unshift(g.positions);
          else polygon.rings.push(g.positions);
          polygon.outer = false;
        }
        break;
      }
      case 'Polygon': {
        const g = geometry.pop() as { rings: Position[][] };
        finish({ type: 'Polygon', coordinates: g.rings });
        break;
      }
      case 'MultiGeometry': {
        const g = geometry.pop() as { members: Geometry[] };
        finish(multiGeometry(g.members));
        break;
      }
      case 'Placemark':
        if (placemark !== null) doc.placemarks.push(placemark);
        placemark = null;
        break;
    }
  });
  try {
    sax.write(text).close();
  } catch (e) {
    if (e instanceof KmlFormatError) throw e;
    throw new KmlFormatError(e instanceof Error ? e.message : String(e));
  }
  return doc;
}

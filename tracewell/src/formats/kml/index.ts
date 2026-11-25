// Public entry point of the formats-kml module, imported elsewhere as '@tw/formats-kml': the
// OGC KML 2.2 writer Google Earth opens, and the reader the export read-back uses.

export type { KmlPlacemark } from './writer';
export { writeKml } from './writer';
export type { KmlDocument, KmlReadPlacemark } from './reader';
export { KmlFormatError, multiGeometry, readKml } from './reader';
export { KML_MAX_BYTES, KmlRows, kmlEncoding, kmlEntry, kmlImporter, kmlPositions } from './importer';

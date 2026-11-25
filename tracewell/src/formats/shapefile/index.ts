// Public entry point of the formats-shapefile module, imported elsewhere as
// '@tw/formats-shapefile': the importer of a zipped Shapefile (.shp, .dbf, .prj, .cpg).

export { SHAPEFILE_IMPORT_MAX_BYTES, readShapes, shapefileImporter, shpEntry } from './importer';

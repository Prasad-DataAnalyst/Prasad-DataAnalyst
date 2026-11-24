// Public entry point of the formats-flatgeobuf module, imported elsewhere as
// '@tw/formats-flatgeobuf': the FlatGeobuf writer QGIS, ArcGIS Pro and GDAL open, and the reader
// the export read-back uses. Both are written on a small FlatBuffers builder and reader of its own.

export type {
  FgbCrs,
  FgbWriteColumn,
  FgbWriteColumnType,
  FgbWriteFeature,
  FgbWriteHeader,
  FgbWriteValue,
} from './writer';
export { FGB_COLUMN, FGB_GEOMETRY, FGB_MAGIC, geometryTypeOf, writeFlatGeobuf } from './writer';
export type { FgbDocument, FgbReadColumn, FgbReadCrs, FgbReadFeature, FgbReadHeader, FgbReadValue } from './reader';
export { FlatGeobufFormatError, indexSize, readFlatGeobuf } from './reader';
export { FgbStreamReader } from './reader';
export { flatgeobufImporter } from './importer';

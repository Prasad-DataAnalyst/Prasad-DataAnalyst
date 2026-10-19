// Public entry point of the model module, imported elsewhere as '@tw/model': the shared vocabulary
// of types, canonical encodings, schemas, errors and constants. Files that hold only public types
// are re-exported whole; the others list their public names so internal helpers stay private.

export type * from './ids';
export type * from './schema';
export type * from './formats';
export type * from './units';
export type * from './rules';
export type * from './issues';
export type * from './audit';
export type * from './decisions';
export type * from './steps';
export type * from './export';
export type * from './project';
export type * from './dto';

export type {
  CellValue,
  DateCell,
  DateTimeCell,
  Geometry,
  GeometryCell,
  LogicalType,
  Position,
  RawField,
} from './values';
export { isDateCell, isDateTimeCell, isGeometryCell, rawToText } from './values';

export { canonicalCell, canonicalJson, canonicalNumber, utf8 } from './canonical';

export type { Assumption, Confidence, Detection } from './detection';
export { detection, userDetection } from './detection';

export type { EngineErrorData, ErrorCode } from './errors';
export { EngineError } from './errors';

export { schemas } from './schemas';

export {
  APP_NAME,
  AUDIT_GENESIS_PREFIX,
  BATCH_ROWS,
  EXCEL_MAX_CELL_CHARS,
  EXCEL_MAX_DATA_ROWS,
  MIN_REASON_LENGTH,
  PREVIEW_MAX_BYTES,
  ROW_WINDOW_MAX,
} from './constants';

/** The import specification: everything needed to replay an import deterministically. */
import type { ColumnPlan, CrsRef, Detection, FileId, FormatOptions, JsonValue } from '@tw/model';

export interface ImportSpec {
  fileId: FileId;
  fileName: string;
  size: number;
  options: FormatOptions;
  columns: ColumnPlan[];
  detections: Record<string, Detection<JsonValue>>;
  crs: Detection<CrsRef> | null;
  datasetName: string;
}

export function datasetNameFor(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return stem === '' ? 'dataset' : stem;
}

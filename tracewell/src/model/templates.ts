/**
 * Mapping templates (FR-IMP-06): how the columns of a recurring file are to be read, saved once
 * and applied automatically to every later file with the same columns. A template belongs to the
 * user, not to a project, and holds no data: only header text and column settings. Applying one
 * records each change it makes as a detection override with the template named in the reason, so
 * a project never depends on the template store to replay.
 */
import type { ColumnOverride } from './dto';
import type { IsoUtc } from './ids';
import type { ColumnRole, DateFormat, SourceFormat, TimezoneMode } from './schema';
import type { LogicalType } from './values';

/** 'mt_' + the first 12 hex characters of the SHA-256 of the template's name. */
export type TemplateId = string;

/** One column's settings, found in a file by the column's header text in the source. */
export interface TemplateColumn {
  /** The source header cells, one per header row, as ColumnPlan.sourceHeader holds them. */
  sourceHeader: string[];
  name: string;
  type: LogicalType;
  /** A unit registry code, or null for no unit. */
  unit: string | null;
  role: ColumnRole;
  nullMarkers: string[];
  dateFormat?: DateFormat;
  timezone?: TimezoneMode;
}

export interface MappingTemplate {
  id: TemplateId;
  name: string;
  /** The format of the file the template was saved from; a template applies to any format. */
  savedFrom: { fileName: string; format: SourceFormat };
  columns: TemplateColumn[];
  savedAt: IsoUtc;
  savedBy: string;
}

/** A template applied to an import preview: the overrides it makes to what was detected. */
export interface TemplateApplied {
  id: TemplateId;
  name: string;
  /** Overrides of detected settings; a template column that agrees with detection adds none. */
  overrides: ColumnOverride[];
}

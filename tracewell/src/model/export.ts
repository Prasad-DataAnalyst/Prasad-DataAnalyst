/**
 * Export vocabulary (SAD section 10): profiles are named by destination, and every package is
 * read back and re-verified before it is offered.
 */
import type { Assumption } from './detection';
import type { FileTarget } from './formats';
import type { AuditSeq, ColumnId, DatasetId, FileId, IsoUtc, ProjectId, Sha256Hex } from './ids';
import type { RulePackRef } from './rules';
import type { Step } from './steps';
import type { LogicalType } from './values';

export type ExportProfileId = 'excel' | 'csv' | 'parquet' | 'geojson';

export interface ExportProfile {
  id: ExportProfileId;
  label: string;
  destinations: string[];
  dataExtension: '.xlsx' | '.csv' | '.parquet' | '.geojson';
  description: string;
}

export interface ExportProfileStatus {
  profile: ExportProfile;
  available: boolean;
  /** Why the profile is unavailable, e.g. GeoJSON for data that is not WGS84 (TW-EXP-003). */
  reason?: string;
  fix?: string;
  substitutions: Substitution[];
}

export interface ExportRequest {
  datasetId: DatasetId;
  profile: ExportProfileId;
  baseName?: string;
  target?: FileTarget;
  /**
   * CSV data files only: put an apostrophe in front of text that a spreadsheet program would run
   * as a formula (text starting with = + - @, tab or carriage return). Read-back removes it again.
   */
  neutralizeFormulas?: boolean;
}

/** Settings that change how values are written, recorded in the manifest. */
export interface ExportOptions {
  neutralizeFormulas: boolean;
}

/** A format-limit substitution (TW-EXP-002), e.g. more than 1,048,575 rows delivered as CSV. */
export interface Substitution {
  ruleId: 'TW-EXP-002';
  what: string;
  why: string;
  instead: string;
}

export interface ValidationCheck {
  id:
    | 'RB-OPEN'
    | 'RB-ROWS'
    | 'RB-HEADER'
    | 'RB-VALUES'
    | 'RB-CSV-ENCODING'
    | 'RB-XLSX-TYPES'
    | 'RB-XLSX-STRUCTURE'
    | 'RB-GEOJSON-STRUCTURE'
    | 'RB-PARQUET-TYPES'
    | 'RB-PKG-CHECKSUMS'
    | 'RB-PKG-CONTENTS';
  ok: boolean;
  detail: string;
  file?: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
}

export interface ExportColumn {
  id: ColumnId;
  name: string;
  /** 'Name [unit]', or just the name when there is no unit. */
  header: string;
  type: LogicalType;
  unit: string | null;
  /** Column digest (SAD section 9.4). */
  sha256: Sha256Hex;
}

export interface OriginalFileInfo {
  fileId: FileId;
  name: string;
  size: number;
  mediaType: string;
  /** The `source.add` audit entry that added the file. */
  addedSeq: AuditSeq;
}

export interface ExportManifest {
  format: 'tracewell-export';
  formatVersion: '0.1';
  exportId: string;
  createdAt: IsoUtc;
  appVersion: string;
  owner: string;
  profile: ExportProfileId;
  project: { id: ProjectId; name: string };
  dataset: {
    id: DatasetId;
    name: string;
    rowCount: number;
    partial: boolean;
    columns: ExportColumn[];
    viewDigest: Sha256Hex;
  };
  sources: OriginalFileInfo[];
  rulePacks: RulePackRef[];
  unitRegistry: { version: string; sha256: Sha256Hex };
  steps: Step[];
  excludedRows: number;
  openIssues: { error: number; warning: number; note: number };
  assumptions: Assumption[];
  substitutions: Substitution[];
  /** Absent in packages written before slice 2. */
  options?: ExportOptions;
  files: { path: string; size: number; sha256: Sha256Hex; role: 'data' | 'readme' | 'audit' | 'issues' | 'manifest' }[];
  validation: ValidationReport;
  auditHead: { seq: AuditSeq; hash: Sha256Hex };
}

export interface ExportResult {
  exportId: string;
  ok: boolean;
  packageName: string;
  /** null when validation failed and no package is offered. */
  packageSha256: Sha256Hex | null;
  size: number;
  bytes?: Uint8Array;
  /** Where the package was written, when the request named a file or it was too large to hand back. */
  path?: string;
  manifest: ExportManifest;
  validation: ValidationReport;
}

export interface ExportRecord {
  exportId: string;
  profile: ExportProfileId;
  datasetId: DatasetId;
  packageName: string;
  packageSha256: Sha256Hex;
  createdAt: IsoUtc;
  ok: boolean;
}

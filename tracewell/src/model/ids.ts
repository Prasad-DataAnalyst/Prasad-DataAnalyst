/**
 * Identity vocabulary (SAD section 7.1). IDs are plain strings and numbers so that every document
 * stays JSON-serialisable; their shapes are enforced where documents cross a trust boundary
 * (see schemas.ts).
 */

/** 'p_' + 16 lowercase hex characters, from the injected IdSource. */
export type ProjectId = string;
/** Full SHA-256 hex of the original bytes: an original file is addressed by its content. */
export type FileId = string;
/** 'd1', 'd2', ... in the order of `source.add` audit entries. */
export type DatasetId = string;
/** 'c0'..'cN' by source position; a derived column is the source ID plus '~' and the unit, e.g. 'c3~kPa'. */
export type ColumnId = string;
/** 0-based data-row ordinal in the original; never reused or renumbered. */
export type RowId = number;
/** 'I-' + the first 12 hex characters of SHA-256(ruleId|datasetId|sorted columnIds). */
export type IssueId = string;
/** 's1', 's2', ... per project. */
export type StepId = string;
/** 'j1', 'j2', ... per engine session. */
export type JobId = string;
/** 1-based position in the audit log. */
export type AuditSeq = number;
/** 64 lowercase hex characters. */
export type Sha256Hex = string;
/** 'YYYY-MM-DDTHH:mm:ss.sssZ', always UTC with millisecond precision. */
export type IsoUtc = string;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** The only way engine code learns the time (SAD section 2.1, goal 6). */
export interface Clock {
  now(): Date;
}

/** The only source of randomness engine code may use; seeded in tests. */
export interface IdSource {
  newProjectId(): ProjectId;
  /** 'e_' + 8 lowercase hex characters. */
  newExportId(): string;
}

export interface UserProfile {
  id: string;
  name: string;
  role: 'Analyst';
}

/** WGS84 bounding box in RFC 7946 order. */
export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

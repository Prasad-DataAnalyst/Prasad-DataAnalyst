/** Declarative rule-packs (SAD section 7.8): each rule names one check primitive from a small closed set. */
import type { ImportNoteCode } from './formats';
import type { Sha256Hex } from './ids';
import type { ColumnRole, QuantityKind } from './schema';
import type { LogicalType } from './values';

export type Severity = 'error' | 'warning' | 'note';

export type RuleCategory =
  'completeness' | 'uniqueness' | 'validity' | 'range' | 'units' | 'time' | 'spatial' | 'import' | 'project' | 'export';

/** The whole dataset, or the columns matching every given filter ('all' matches every column). */
export type ColumnSelector =
  { dataset: true } | { roles?: ColumnRole[]; types?: LogicalType[]; quantities?: QuantityKind[]; all?: true };

export type CheckSpec =
  | { kind: 'not_null' }
  | { kind: 'duplicate_rows' }
  | { kind: 'duplicate_key' }
  | { kind: 'type_conformance' }
  | { kind: 'below_detection_limit' }
  | { kind: 'physical_range' }
  | { kind: 'null_marker' }
  | { kind: 'unit_known' }
  | { kind: 'unit_consistent' }
  | { kind: 'ts_duplicate' }
  | { kind: 'ts_order' }
  | { kind: 'ts_gap'; factor: number }
  | { kind: 'tz_specified' }
  | { kind: 'date_ambiguous' }
  | { kind: 'flatline'; minRun: number }
  | { kind: 'spike'; window: number; k: number }
  | { kind: 'geometry_valid' }
  | { kind: 'coord_range' }
  | { kind: 'latlon_swapped' }
  | { kind: 'within_area' }
  | { kind: 'crs_wgs84' }
  | { kind: 'geometry_present' }
  | { kind: 'import_note'; code: ImportNoteCode | 'TW-IMP-005' | 'TW-IMP-006' }
  | { kind: 'system' };

export type CheckKind = CheckSpec['kind'];

export interface RuleDef {
  id: string;
  version: string;
  title: string;
  category: RuleCategory;
  severity: Severity;
  appliesTo: ColumnSelector;
  check: CheckSpec;
  /** Template with the placeholders {column} {count} {unit} {min} {max} {detail}. */
  message: string;
  /** Plain-language explanation for the issues register (FR-VAL-03). */
  explanation: string;
  /** Citation or rationale. */
  source: string;
}

export interface RulePack {
  id: string;
  version: string;
  title: string;
  source: string;
  rules: RuleDef[];
}

/** Identifies the exact rule-pack text used; recorded in project and export manifests. */
export interface RulePackRef {
  id: string;
  version: string;
  sha256: Sha256Hex;
}

/**
 * A signed rule-pack file (.twrules, FR-RUL-01, SAD decision D-17), as a publisher's signing tool
 * (scripts/sign-rulepack.mjs) writes it: the pack, who signed it, and an Ed25519 signature of the
 * UTF-8 canonical JSON of the pack.
 */
export interface RulePackFile {
  format: 'tracewell-rules';
  formatVersion: '0.1';
  pack: RulePack;
  /** The key ID is the first 16 hex digits of the SHA-256 of the raw 32-byte public key. */
  publisher: { name: string; keyId: string };
  /** Base64 of the 64-byte Ed25519 signature. */
  signature: string;
}

/** What an administrator's policy file says about rule-packs (FR-RUL-04). */
export interface RulePackPolicy {
  /** Publishers whose packs may be installed: a name and an Ed25519 public key (32 bytes, base64). */
  trustedKeys: { name: string; publicKey: string }[];
  /** Locked versions: a pack whose ID is listed installs only at that version. */
  lockedVersions: Record<string, string>;
}

/** A rule-pack installed in a project from a signed file (FR-RUL-02). */
export interface InstalledRulePack {
  id: string;
  version: string;
  title: string;
  /** SHA-256 of the UTF-8 canonical JSON of the pack, as check runs record it. */
  sha256: Sha256Hex;
  publisher: string;
  keyId: string;
  rules: number;
}

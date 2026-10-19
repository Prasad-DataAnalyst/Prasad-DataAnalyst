/**
 * Detections (SAD section 7.3): every inferred property carries its confidence, how it was found
 * and the evidence, so assumptions are visible data rather than hidden defaults.
 */
import type { AuditSeq, ColumnId, DatasetId, JsonValue } from './ids';

export type Confidence = 'high' | 'medium' | 'low';

export interface Detection<T> {
  value: T;
  confidence: Confidence;
  /** True whenever confidence is not 'high' or the value is a default; the UI shows an "assumed" badge. */
  assumed: boolean;
  source: 'detected' | 'default' | 'user';
  /** Short machine-readable name of the method, e.g. 'bom' or 'delimiter-consistency'. */
  method: string;
  /** Plain-language reason shown to the user. */
  evidence: string;
  /** The `detection.override` audit entry that set this value. */
  overriddenBy?: AuditSeq;
}

/** A detection made by the engine; `assumed` follows from confidence and source. */
export function detection<T>(
  value: T,
  confidence: Confidence,
  method: string,
  evidence: string,
  source: 'detected' | 'default' = 'detected',
): Detection<T> {
  return { value, confidence, assumed: confidence !== 'high' || source === 'default', source, method, evidence };
}

/** A value the user set through the `detection.override` audit entry `seq`; never assumed. */
export function userDetection<T>(value: T, seq: AuditSeq): Detection<T> {
  return {
    value,
    confidence: 'high',
    assumed: false,
    source: 'user',
    method: 'user-override',
    evidence: `Set by the user in audit entry ${seq}.`,
    overriddenBy: seq,
  };
}

/** One assumed detection, as listed in the `detection.assume` audit entry and in export manifests. */
export interface Assumption {
  datasetId: DatasetId;
  /** null for dataset-level properties such as encoding, delimiter or CRS. */
  columnId: ColumnId | null;
  property: string;
  value: JsonValue;
  confidence: Confidence;
  evidence: string;
}

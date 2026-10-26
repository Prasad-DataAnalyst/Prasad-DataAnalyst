/** The assumption list for the `detection.assume` audit entry and export manifests (SAD section 7.3). */
import type { Assumption, ColumnPlan, DatasetId, Detection, JsonValue } from '@tw/model';

/** Column detections in the order they are listed: what a reviewer checks first comes first. */
const COLUMN_PROPERTIES = [
  'type',
  'role',
  'unit',
  'nullMarkers',
  'dateFormat',
  'timezone',
  'decimalSeparator',
] as const;

type ColumnProperty = (typeof COLUMN_PROPERTIES)[number];

function columnDetection(plan: ColumnPlan, property: ColumnProperty): Detection<JsonValue> | undefined {
  // Every column detection's value is JSON: strings, string arrays or null.
  return plan[property] as Detection<JsonValue> | undefined;
}

function toAssumption(
  datasetId: DatasetId,
  columnId: string | null,
  property: string,
  d: Detection<JsonValue>,
): Assumption {
  return { datasetId, columnId, property, value: d.value, confidence: d.confidence, evidence: d.evidence };
}

/**
 * Every assumed detection of a dataset: the dataset-level ones in `extra` (encoding, delimiter,
 * CRS, ...) first, in the order given, then each column's in column order.
 */
export function collectAssumptions(
  datasetId: DatasetId,
  plans: ColumnPlan[],
  extra: Record<string, Detection<JsonValue>>,
): Assumption[] {
  const dataset = Object.entries(extra)
    .filter(([, d]) => d.assumed)
    .map(([property, d]) => toAssumption(datasetId, null, property, d));
  const columns = plans.flatMap((plan) =>
    COLUMN_PROPERTIES.flatMap((property) => {
      const d = columnDetection(plan, property);
      return d?.assumed === true ? [toAssumption(datasetId, plan.id, property, d)] : [];
    }),
  );
  return [...dataset, ...columns];
}

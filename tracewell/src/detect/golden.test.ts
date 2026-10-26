import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureExpectation } from '@tw/fixtures';
import type { ColumnPlan } from '@tw/model';
import { planFixture } from './__fixtures__/sniff';

const DETECTIONS = ['dateFormat', 'decimalSeparator', 'nullMarkers', 'role', 'timezone', 'type', 'unit'] as const;

function summary(plan: ColumnPlan) {
  const assumed = DETECTIONS.filter((p) => plan[p]?.assumed === true);
  return {
    name: plan.name,
    type: plan.type.value,
    unit: plan.unit.value,
    role: plan.role.value,
    ...(assumed.length > 0 ? { assumed: [...assumed].sort() } : {}),
  };
}

// The plan requires the CSV and GeoJSON fixtures; the XLSX ones run too, since ingest plans them the same way.
describe('golden column plans for every fixture', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { plans } = planFixture(name);
    expect(plans.map(summary)).toEqual(fixtureExpectation(name).columns);
    expect(plans.map((p) => p.id)).toEqual(plans.map((_, i) => `c${i}`));
  });
});

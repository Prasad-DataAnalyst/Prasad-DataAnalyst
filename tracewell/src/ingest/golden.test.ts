import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureExpectation, fixtureSource } from '@tw/fixtures';
import { viewDigest } from '@tw/table';
import { importSource, previewSource } from './index';
import { context, fixtureSums, plainView, summary } from './__fixtures__/helpers';

const SUMS = fixtureSums();

function detectionValue(v: unknown): unknown {
  // CRS detections hold a CrsRef; the expectations name the code only.
  return typeof v === 'object' && v !== null && 'code' in v ? (v as { code: string }).code : v;
}

describe('golden import of every messy fixture', () => {
  it.each(FIXTURE_NAMES)('%s', async (name) => {
    const expected = fixtureExpectation(name);
    const src = fixtureSource(name);
    const preview = await previewSource(src);
    const outcome = await importSource(src, 'd1', preview.spec, context());

    expect(outcome.dataset.rowCount).toBe(expected.rowCount);
    expect(outcome.partial).toBe(false);
    expect(outcome.spec.columns.map(summary)).toEqual(expected.columns);

    const detections: Record<string, { value: unknown; confidence: string } | undefined> = {
      ...outcome.spec.detections,
      ...(outcome.spec.crs === null ? {} : { crs: outcome.spec.crs }),
    };
    for (const [key, value] of Object.entries(expected.detections)) {
      expect(detectionValue(detections[key]?.value), `detection ${key}`).toEqual(value);
      const confidence = expected.confidence[key as keyof typeof expected.confidence];
      if (confidence !== undefined) expect(detections[key]?.confidence, `confidence of ${key}`).toBe(confidence);
    }

    const codes = [...new Set(outcome.notes.map((n) => n.code))].sort();
    expect(codes).toEqual(expected.notes ?? []);
    expect(outcome.sha256).toBe(SUMS.get(name));
    expect(outcome.spec.fileId).toBe(outcome.sha256);

    if (expected.workingDigest !== undefined) {
      expect(viewDigest(plainView(outcome.dataset)).sha256).toBe(expected.workingDigest);
    }
  });
});

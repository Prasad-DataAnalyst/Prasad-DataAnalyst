import { describe, expect, it } from 'vitest';
import type { Confidence, DateFormat, LogicalType, RawField, TimezoneMode } from '@tw/model';
import cases from './__fixtures__/type-cases.json';
import { detectColumns, inferType, type DetectOptions } from './index';

interface TypeCase {
  name: string;
  values: RawField[];
  header?: string;
  options?: Pick<DetectOptions, 'decimalSeparator' | 'thousandsSeparator'>;
  expect: {
    type: LogicalType;
    confidence?: Confidence;
    assumed?: boolean;
    dateFormat?: DateFormat;
    dateFormatConfidence?: Confidence;
    dateFormatAssumed?: boolean;
    timezone?: TimezoneMode;
    timezoneAssumed?: boolean;
  };
}

const DOT: DetectOptions = { decimalSeparator: '.', thousandsSeparator: '' };

/** Inference for a case: through detectColumns when it has a header, so header hints apply. */
function infer(c: TypeCase) {
  const o: DetectOptions = { ...DOT, ...c.options };
  if (c.header === undefined) return inferType(c.values, o);
  const sample = c.values.map((v, i) => ({ srcLoc: i + 2, fields: [v] }));
  const [plan] = detectColumns([[c.header]], sample, o);
  if (plan === undefined) throw new Error('no column planned');
  return plan;
}

describe('inferType (table-driven, __fixtures__/type-cases.json)', () => {
  it.each((cases.cases as TypeCase[]).map((c) => [c.name, c] as const))('%s', (_, c) => {
    const result = infer(c);
    const e = c.expect;
    expect(result.type.value).toBe(e.type);
    if (e.confidence !== undefined) expect(result.type.confidence).toBe(e.confidence);
    if (e.assumed !== undefined) expect(result.type.assumed).toBe(e.assumed);
    if (e.dateFormat !== undefined) expect(result.dateFormat?.value).toBe(e.dateFormat);
    if (e.dateFormatConfidence !== undefined) expect(result.dateFormat?.confidence).toBe(e.dateFormatConfidence);
    if (e.dateFormatAssumed !== undefined) expect(result.dateFormat?.assumed).toBe(e.dateFormatAssumed);
    if (e.timezone !== undefined) expect(result.timezone?.value).toBe(e.timezone);
    if (e.timezoneAssumed !== undefined) expect(result.timezone?.assumed).toBe(e.timezoneAssumed);
  });
});

describe('inferType details', () => {
  it('gives no date format or timezone to non-date columns', () => {
    const r = inferType(['1', '2'], DOT);
    expect(r.dateFormat).toBeUndefined();
    expect(r.timezone).toBeUndefined();
  });

  it('gives a timezone only to datetime columns', () => {
    expect(inferType(['2026-01-31'], DOT).timezone).toBeUndefined();
  });

  it('explains its decision in plain language', () => {
    const r = inferType(['2026-02-01', '2026-02-02', '3 Feb 2026', '2026-02-04', '2026-02-05'], DOT);
    expect(r.type.evidence).toBe('4 of 5 non-empty sample values read as dates; the others keep their text.');
    expect(r.type.source).toBe('detected');
  });

  it('falls back to text below the 80 % share', () => {
    expect(inferType(['1', '2', 'x', 'y'], DOT).type.value).toBe('string');
  });
});

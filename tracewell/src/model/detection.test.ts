import { describe, expect, it } from 'vitest';
import { detection, userDetection, type Confidence } from './detection';

describe('detection', () => {
  it.each<[Confidence, 'detected' | 'default', boolean]>([
    ['high', 'detected', false],
    ['medium', 'detected', true],
    ['low', 'detected', true],
    ['high', 'default', true],
    ['medium', 'default', true],
    ['low', 'default', true],
  ])('confidence %s from source %s gives assumed = %s', (confidence, source, assumed) => {
    expect(detection('utf-8', confidence, 'bom', 'evidence', source).assumed).toBe(assumed);
  });

  it("defaults the source to 'detected'", () => {
    expect(detection(',', 'high', 'delimiter-consistency', 'Every line has 4 commas.')).toEqual({
      value: ',',
      confidence: 'high',
      assumed: false,
      source: 'detected',
      method: 'delimiter-consistency',
      evidence: 'Every line has 4 commas.',
    });
  });

  it('has no overriddenBy key, so it is not mistaken for a user value', () => {
    expect('overriddenBy' in detection(1, 'low', 'm', 'e')).toBe(false);
  });

  it('keeps structured values as given', () => {
    const value = ['NA', '-999'];
    expect(detection(value, 'medium', 'null-markers', 'Seen in 12 rows.').value).toBe(value);
  });
});

describe('userDetection', () => {
  it('is never assumed and points at the override entry', () => {
    expect(userDetection('psia', 17)).toEqual({
      value: 'psia',
      confidence: 'high',
      assumed: false,
      source: 'user',
      method: 'user-override',
      evidence: 'Set by the user in audit entry 17.',
      overriddenBy: 17,
    });
  });
});

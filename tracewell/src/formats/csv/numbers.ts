/**
 * Decimal and thousands separator detection from the number-like fields of the sample.
 *
 * Each field is classified by its shape. Some shapes prove a separator ('12,5' can only be a
 * decimal comma, '1.234,5' proves both separators); '1,234' and '1.234' could be either a
 * fraction or a grouped whole number, so they only count as weak evidence, read the way the
 * delimiter suggests: semicolon files come from locales that write decimal commas.
 */
import { detection, type CsvOptions, type Detection, type RawRow } from '@tw/model';
import { plural } from './errors';

type Decimal = CsvOptions['decimalSeparator'];
type Thousands = CsvOptions['thousandsSeparator'];

type Shape =
  | 'point' // 12.5
  | 'comma' // 12,5
  | 'commaGroupedPoint' // 1,234.5
  | 'pointGroupedComma' // 1.234,5
  | 'commaGroups' // 1,234,567
  | 'pointGroups' // 1.234.567
  | 'spaceGroups' // 1 234 567
  | 'spaceGroupedPoint' // 1 234.5
  | 'spaceGroupedComma' // 1 234,5
  | 'ambiguousComma' // 1,234
  | 'ambiguousPoint'; // 1.234

/** Order matters: the first matching pattern decides the shape. */
const SHAPES: readonly [Shape, RegExp][] = [
  ['ambiguousComma', /^[1-9]\d{0,2},\d{3}$/],
  ['ambiguousPoint', /^[1-9]\d{0,2}\.\d{3}$/],
  ['commaGroupedPoint', /^[1-9]\d{0,2}(?:,\d{3})+\.\d+$/],
  ['pointGroupedComma', /^[1-9]\d{0,2}(?:\.\d{3})+,\d+$/],
  ['commaGroups', /^[1-9]\d{0,2}(?:,\d{3}){2,}$/],
  ['pointGroups', /^[1-9]\d{0,2}(?:\.\d{3}){2,}$/],
  ['spaceGroups', /^[1-9]\d{0,2}(?: \d{3})+$/],
  ['spaceGroupedPoint', /^[1-9]\d{0,2}(?: \d{3})+\.\d+$/],
  ['spaceGroupedComma', /^[1-9]\d{0,2}(?: \d{3})+,\d+$/],
  ['point', /^(?:\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?$/],
  ['comma', /^\d+,\d+$/],
];

export interface NumberEvidence {
  counts: Partial<Record<Shape, number>>;
  /** The first field seen of each shape, quoted in the evidence text. */
  examples: Partial<Record<Shape, string>>;
}

function shapeOf(text: string): Shape | null {
  const t = text.trim().replace(/^[+-]/, '');
  if (t === '' || t.length > 40) return null;
  for (const [shape, pattern] of SHAPES) if (pattern.test(t)) return shape;
  return null;
}

export function collectNumberEvidence(rows: readonly RawRow[]): NumberEvidence {
  const evidence: NumberEvidence = { counts: {}, examples: {} };
  for (const row of rows) {
    for (const field of row.fields) {
      if (typeof field !== 'string') continue;
      const shape = shapeOf(field);
      if (shape === null) continue;
      evidence.counts[shape] = (evidence.counts[shape] ?? 0) + 1;
      evidence.examples[shape] ??= field.trim();
    }
  }
  return evidence;
}

function total(e: NumberEvidence, shapes: readonly Shape[]): number {
  return shapes.reduce((sum, s) => sum + (e.counts[s] ?? 0), 0);
}

function example(e: NumberEvidence, shapes: readonly Shape[]): string {
  for (const s of shapes) {
    const value = e.examples[s];
    if (value !== undefined) return JSON.stringify(value);
  }
  return '';
}

const COMMA_DECIMAL: readonly Shape[] = ['comma', 'pointGroupedComma', 'pointGroups', 'spaceGroupedComma'];
const POINT_DECIMAL: readonly Shape[] = ['point', 'commaGroupedPoint', 'commaGroups', 'spaceGroupedPoint'];
const AMBIGUOUS: readonly Shape[] = ['ambiguousComma', 'ambiguousPoint'];

function votes(n: number, e: NumberEvidence, shapes: readonly Shape[]): string {
  return `${plural(n, 'value')} such as ${example(e, shapes)}`;
}

/** The verb form that agrees with a count: one value "uses", two values "use". */
function agree(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

export function detectDecimal(e: NumberEvidence, delimiter: CsvOptions['delimiter']): Detection<Decimal> {
  const comma = total(e, COMMA_DECIMAL);
  const point = total(e, POINT_DECIMAL);
  if (comma > 0 && point > 0) return conflictingDecimal(e, comma, point, delimiter);
  if (comma > 0) {
    const evidence = `${votes(comma, e, COMMA_DECIMAL)} ${agree(comma, 'uses', 'use')} a comma before the fractional part.`;
    return detection(',', comma >= 3 ? 'high' : 'medium', 'number-shapes', evidence);
  }
  if (point > 0) {
    // In a comma-separated file a decimal comma needs quotes, so no quoted one is already evidence.
    const commaFile = delimiter === ',';
    const evidence =
      `${votes(point, e, POINT_DECIMAL)} ${agree(point, 'uses', 'use')} a point before the fractional part.` +
      (commaFile ? ' Fields are separated by commas, and no quoted value has a decimal comma.' : '');
    return detection('.', point >= 3 || commaFile ? 'high' : 'medium', 'number-shapes', evidence);
  }
  return decimalWithoutProof(e, delimiter);
}

function conflictingDecimal(
  e: NumberEvidence,
  comma: number,
  point: number,
  delimiter: CsvOptions['delimiter'],
): Detection<Decimal> {
  const value: Decimal = comma > point || (comma === point && delimiter === ';') ? ',' : '.';
  const choice =
    comma === point
      ? `Both are equally common, so the ${value === ',' ? 'comma, usual with semicolons,' : 'point'} is used.`
      : `The more common ${value === ',' ? 'comma' : 'point'} is used.`;
  const evidence =
    `The sample mixes both styles: ${votes(comma, e, COMMA_DECIMAL)} ` +
    `${agree(comma, 'has a decimal comma', 'have decimal commas')} and ${votes(point, e, POINT_DECIMAL)} ` +
    `${agree(point, 'has a decimal point', 'have decimal points')}. ${choice}`;
  return detection(value, 'low', 'number-shapes-conflict', evidence);
}

function decimalWithoutProof(e: NumberEvidence, delimiter: CsvOptions['delimiter']): Detection<Decimal> {
  if (delimiter === ',') {
    return detection(
      '.',
      'high',
      'comma-delimiter',
      'Fields are separated by commas, so numbers use a decimal point unless they are quoted, and no quoted value has a decimal comma.',
    );
  }
  const ambiguous = total(e, AMBIGUOUS);
  if (ambiguous > 0) {
    // '1,234' and '1.234' each mean a decimal comma in a semicolon file and a decimal point elsewhere.
    const value: Decimal = delimiter === ';' ? ',' : '.';
    const evidence =
      `${votes(ambiguous, e, AMBIGUOUS)} could be a fraction or a grouped whole number. ` +
      (value === ','
        ? 'Semicolon-separated files usually come from locales that write decimal commas, so a comma is assumed.'
        : 'A decimal point is assumed.');
    return detection(value, 'medium', 'number-shapes-ambiguous', evidence);
  }
  if (delimiter === ';') {
    const evidence =
      'No number in the sample has a fractional part. Semicolon-separated files often use decimal commas, ' +
      'so the point is only assumed.';
    return detection('.', 'medium', 'no-fractions', evidence, 'default');
  }
  return detection(
    '.',
    'high',
    'no-fractions',
    'No number in the sample has a fractional part or digit grouping, so the decimal point changes nothing that was read.',
  );
}

const GROUP_SHAPES: Readonly<Record<Exclude<Thousands, ''>, readonly Shape[]>> = {
  ',': ['commaGroups', 'commaGroupedPoint'],
  '.': ['pointGroups', 'pointGroupedComma'],
  ' ': ['spaceGroups', 'spaceGroupedPoint', 'spaceGroupedComma'],
};

const SEPARATOR_NAMES: Readonly<Record<Exclude<Thousands, ''>, string>> = {
  ',': 'comma',
  '.': 'point',
  ' ': 'space',
};

export function detectThousands(e: NumberEvidence, decimal: Decimal): Detection<Thousands> {
  const candidates: Exclude<Thousands, ''>[] = decimal === ',' ? ['.', ' '] : [',', ' '];
  const scored = candidates.map((sep) => ({ sep, n: total(e, GROUP_SHAPES[sep]) })).sort((a, b) => b.n - a.n);
  const [best, other] = scored;
  if (best !== undefined && best.n > 0) {
    const confidence = best.n >= 2 && (other?.n ?? 0) === 0 ? 'high' : 'medium';
    const evidence = `${votes(best.n, e, GROUP_SHAPES[best.sep])} ${agree(best.n, 'groups', 'group')} digits with a ${SEPARATOR_NAMES[best.sep]}.`;
    return detection(best.sep, confidence, 'number-shapes', evidence);
  }
  // With a decimal comma, '1.234' is a grouped whole number; with a decimal point, so is '1,234'.
  const weakShape: Shape = decimal === ',' ? 'ambiguousPoint' : 'ambiguousComma';
  const weak = e.counts[weakShape] ?? 0;
  if (weak > 0) {
    const sep: Thousands = decimal === ',' ? '.' : ',';
    const evidence =
      `${votes(weak, e, [weakShape])} ${agree(weak, 'reads as a whole number', 'read as whole numbers')} grouped with a ${SEPARATOR_NAMES[sep]}, ` +
      `given the decimal ${decimal === ',' ? 'comma' : 'point'}.`;
    return detection(sep, 'medium', 'number-shapes-ambiguous', evidence);
  }
  return detection('', 'high', 'no-grouping', 'No number in the sample groups its digits.');
}

/** True when `text` reads as a number in either decimal style. */
export function looksNumeric(text: string): boolean {
  const t = text.trim().replace(/^[+-]/, '');
  return t !== '' && (/^\d+(?:[eE][+-]?\d+)?$/.test(t) || shapeOf(t) !== null);
}

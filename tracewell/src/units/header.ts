/**
 * Units written in header text and in cells. Header units are detections: the confidence says how
 * explicit the header was, so a guess is always shown to the user as assumed.
 *   - brackets or parentheses, 'Pressure (psia)': high;
 *   - after ' / ' (a units row joined by detect, or quantity / unit notation), 'Pressure / psia': high;
 *   - a suffix after a space, '_' or ',', 'Depth ft' or 'rate_kg_h': medium;
 *   - a unit-like word elsewhere, 'WHP psig avg': low.
 * A unit written as a single letter is one confidence step lower outside brackets, and never read
 * from a word in the middle of a header. A low-confidence guess keeps the whole header as the column
 * name, so rejecting the guess loses nothing.
 */
import { detection, type Confidence, type Detection, type UnitDef } from '@tw/model';
import { normalizeUnitText } from './names';
import { findUnit } from './registry';

export interface HeaderUnit {
  name: string;
  unit: Detection<string> | null;
}

/**
 * Unit names that headers mostly use as ordinary words or abbreviations, so they are read as units
 * only inside brackets: 'min' (minimum), 'in' (the preposition), 'HP' (high pressure), 'MW'
 * (molecular weight), 'meter' (a metering device), 'second' (the ordinal), and 'day', 'hour' and
 * 'minute' (date and time parts).
 */
const WORDS_NOT_UNITS: ReadonlySet<string> = new Set([
  'min',
  'in',
  'hp',
  'mw',
  'meter',
  'meters',
  'second',
  'day',
  'hour',
  'minute',
]);

const OPENING = '([{';
const CLOSING = ')]}';

/** Splits a header into the tokens a unit suffix can start at. */
const SUFFIX_TOKEN = /[^\s_,;]+/gu;

/** Words for the low-confidence pass; brackets are separators here, so '(psia,' yields 'psia'. */
const WORD = /[^\s_,;()[\]{}]+/gu;

/** Separators left at the end of a name once its unit is removed: 'Pressure, ' or 'Pressure /'. */
const TRAILING_SEPARATORS = /[\s_,;:/\u2013\u2014-]+$/u;

interface Group {
  start: number;
  end: number;
  content: string;
}

/** Top-level bracket groups, in order. Nested brackets stay inside their group: 'kPa(g)'. */
function bracketGroups(text: string): Group[] {
  const groups: Group[] = [];
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (OPENING.includes(ch)) open.push(i);
    if (!CLOSING.includes(ch)) continue;
    const start = open.pop();
    if (start !== undefined && open.length === 0) groups.push({ start, end: i + 1, content: text.slice(start + 1, i) });
  }
  return groups;
}

function stripTrailing(text: string): string {
  return text.replace(TRAILING_SEPARATORS, '');
}

/** 'Depth, in ' → 'Depth': trailing separators and a dangling 'in' ('Time in hours') go. */
function cleanName(text: string): string {
  return stripTrailing(stripTrailing(text).replace(/\s+in$/iu, '')).trim();
}

function isSingleLetter(raw: string): boolean {
  return /^\p{L}$/u.test(normalizeUnitText(raw));
}

function isWordNotUnit(raw: string): boolean {
  return WORDS_NOT_UNITS.has(normalizeUnitText(raw).toLowerCase());
}

/** How evidence names the unit: '"psia"', or '"°F" (degF)' when the text differs from the code. */
function quoted(raw: string, unit: UnitDef): string {
  return raw === unit.code ? `"${raw}"` : `"${raw}" (${unit.code})`;
}

function found(name: string, unit: UnitDef, confidence: Confidence, method: string, evidence: string): HeaderUnit {
  return { name, unit: detection(unit.code, confidence, method, evidence) };
}

function fromBrackets(text: string): HeaderUnit | null {
  for (const group of bracketGroups(text).reverse()) {
    const raw = group.content.trim();
    const unit = findUnit(raw);
    if (unit === undefined) continue;
    const rest = `${cleanName(text.slice(0, group.start))} ${text.slice(group.end).trim()}`;
    const name = cleanName(rest) || text;
    return found(
      name,
      unit,
      'high',
      'header-brackets',
      `The header "${text}" gives the unit ${quoted(raw, unit)} in brackets.`,
    );
  }
  return null;
}

/** The unit a header suffix names; 'kg_h' is also tried as 'kg/h'. */
function suffixUnit(raw: string): UnitDef | undefined {
  if (isWordNotUnit(raw)) return undefined;
  return findUnit(raw) ?? (raw.includes('_') ? findUnit(raw.replace(/_/gu, '/')) : undefined);
}

function suffixDetection(text: string, name: string, raw: string, unit: UnitDef, unitRow: boolean): HeaderUnit {
  const single = isSingleLetter(raw);
  const guess = single ? ' A single letter is often not a unit, so this is a guess.' : '';
  if (unitRow) {
    const evidence = `The header "${text}" gives the unit ${quoted(raw, unit)} after " / ", as a units row does.${guess}`;
    return found(name, unit, single ? 'medium' : 'high', 'header-unit-row', evidence);
  }
  const evidence = `The header "${text}" ends with ${quoted(raw, unit)}, read as its unit.${guess}`;
  return single
    ? found(text, unit, 'low', 'header-suffix', evidence)
    : found(name, unit, 'medium', 'header-suffix', evidence);
}

/** The longest suffix that is a unit wins, so 'rate_kg_h' gives kg/h rather than h. */
function fromSuffix(text: string): HeaderUnit | null {
  const tokens = [...text.matchAll(SUFFIX_TOKEN)];
  for (let i = 1; i < tokens.length; i++) {
    const start = tokens[i]?.index ?? 0;
    const raw = text.slice(start).trim();
    const unit = suffixUnit(raw);
    const name = cleanName(text.slice(0, start));
    if (unit === undefined || name === '') continue;
    return suffixDetection(text, name, raw, unit, tokens[i - 1]?.[0] === '/');
  }
  return null;
}

function fromWord(text: string): HeaderUnit | null {
  const words = [...text.matchAll(WORD)].map((m) => m[0]).reverse();
  for (const word of words) {
    if (isSingleLetter(word) || isWordNotUnit(word)) continue;
    const unit = findUnit(word);
    if (unit === undefined) continue;
    const evidence = `The header "${text}" contains the word ${quoted(word, unit)}, which may be its unit.`;
    return found(text, unit, 'low', 'header-word', evidence);
  }
  return null;
}

/**
 * Splits a header into the column name and the unit it names, if any. The detection's value is a
 * registry unit code. A header that is only a unit keeps its text as the name.
 */
export function parseHeaderUnit(header: string): HeaderUnit {
  const text = header.trim();
  return fromBrackets(text) ?? fromSuffix(text) ?? fromWord(text) ?? { name: text, unit: null };
}

/**
 * A number followed by a unit: an optional sign, digits with any grouping or decimal separators,
 * an optional exponent, then the unit text. The value text is returned as written, because its
 * separators are interpreted later with the column's decimal settings.
 */
const VALUE_THEN_UNIT = /^([-+\u2212]?(?:\d|[.,]\d)(?:[\d.,'\u00a0\u202f ]*\d)?(?:[eE][+-]?\d+)?)\s*(\D.*)$/su;

/** Splits '12.5 psi' into '12.5' and the psi unit; null unless the text is a number then a known unit. */
export function splitValueUnit(text: string): { value: string; unit: UnitDef } | null {
  const match = VALUE_THEN_UNIT.exec(text.trim());
  const value = match?.[1];
  const unit = match?.[2] === undefined ? undefined : findUnit(match[2]);
  return value === undefined || unit === undefined ? null : { value, unit };
}

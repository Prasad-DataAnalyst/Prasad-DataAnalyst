/**
 * Units written in header text and in cells. Header units are detections: the confidence says how
 * explicit the header was, so a guess is always shown to the user as assumed.
 *   - brackets or parentheses, 'Pressure (psia)': high;
 *   - after ' / ' (a units row joined by detect, or quantity / unit notation), 'Pressure / psia': high;
 *   - a suffix after a space, '_' or ',', 'Depth ft' or 'rate_kg_h': medium;
 *   - a unit-like word elsewhere, 'WHP psig avg': low.
 * A unit written as a single letter is one confidence step lower outside brackets, and never read
 * from a word in the middle of a header. A low-confidence guess keeps the whole header as the column
 * name, so rejecting the guess loses nothing. A unit that leaves something unstated (psi: gauge or
 * absolute?) or that conflicts with another bracket is never high confidence.
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

/**
 * Codes whose usual spelling leaves the pressure reference unstated. The registry reads them as
 * absolute; the detection says so and is marked assumed, because gauge readings are as common.
 */
const REFERENCE_NOT_STATED: ReadonlyMap<string, string> = new Map([
  [
    'psi',
    ' "psi" does not say whether the pressure is gauge or absolute, so it is read as absolute (psia).' +
      ' If the readings are gauge, set the unit to psig.',
  ],
]);

/** ASCII brackets and their full-width forms, which spreadsheets in East Asian locales use. */
const OPENING = '([{\uff08\uff3b\uff5b';
const CLOSING = ')]}\uff09\uff3d\uff5d';

/**
 * Longest text that is tried as a unit. Every registry name is far shorter; the bound keeps parsing
 * linear, so a header of any length cannot stall the import preview.
 */
const MAX_UNIT_TEXT = 64;

/** Splits a header into the tokens a unit suffix can start at. */
const SUFFIX_TOKEN = /[^\s_,;]+/gu;

/** Words for the low-confidence pass; brackets are separators here, so '(psia,' yields 'psia'. */
const WORD = /[^\s_,;()[\]{}\uff08\uff09\uff3b\uff3d\uff5b\uff5d]+/gu;

/** One separator that may be left at the end of a name once its unit is removed: 'Pressure, '. */
const SEPARATOR = /[\s_,;:/\u2013\u2014-]/u;

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

/** Removes trailing separators. A loop rather than a regex, which would be quadratic on long runs. */
function stripTrailing(text: string): string {
  let end = text.length;
  while (end > 0 && SEPARATOR.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** 'Depth in' → 'Depth': the preposition that introduced a suffix unit, as in 'Depth in ft'. */
function dropDanglingIn(text: string): string {
  return /\sin$/iu.test(text.slice(-3)) ? stripTrailing(text.slice(0, -2)) : text;
}

/** 'Pressure, ' → 'Pressure'. With `beforeSuffix`, also 'Time in ' → 'Time' ('Time in hours'). */
function cleanName(text: string, beforeSuffix = false): string {
  const stripped = stripTrailing(text);
  return (beforeSuffix ? dropDanglingIn(stripped) : stripped).trim();
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

/** Units whose text leaves something unstated are at most medium confidence, and say why. */
function found(name: string, unit: UnitDef, confidence: Confidence, method: string, evidence: string): HeaderUnit {
  const note = REFERENCE_NOT_STATED.get(unit.code);
  if (note === undefined) return { name, unit: detection(unit.code, confidence, method, evidence) };
  const capped = confidence === 'high' ? 'medium' : confidence;
  return { name, unit: detection(unit.code, capped, method, evidence + note) };
}

/** A unit-sized text that names a registry unit, or undefined. */
function unitText(raw: string): UnitDef | undefined {
  return raw.length > MAX_UNIT_TEXT ? undefined : findUnit(raw);
}

interface BracketUnit {
  group: Group;
  raw: string;
  unit: UnitDef;
}

function bracketUnits(text: string): BracketUnit[] {
  const units: BracketUnit[] = [];
  for (const group of bracketGroups(text)) {
    const raw = group.content.trim();
    const unit = unitText(raw);
    if (unit !== undefined) units.push({ group, raw, unit });
  }
  return units;
}

/** The header without the group: 'Pressure (psia) avg' → 'Pressure avg', 'P (psia), avg' → 'P, avg'. */
function withoutGroup(text: string, group: Group): string {
  const after = text.slice(group.end).trim();
  const glue = /^[,;:.]/u.test(after) ? '' : ' ';
  return cleanName(`${cleanName(text.slice(0, group.start))}${glue}${after}`);
}

/** The last bracketed unit wins; another bracket naming a different unit makes it a guess. */
function fromBrackets(text: string): HeaderUnit | null {
  const units = bracketUnits(text);
  const last = units.at(-1);
  if (last === undefined) return null;
  const { group, raw, unit } = last;
  const name = withoutGroup(text, group) || text;
  const others = [...new Set(units.map((u) => u.unit.code))].filter((code) => code !== unit.code);
  const evidence = `The header "${text}" gives the unit ${quoted(raw, unit)} in brackets.`;
  if (others.length === 0) return found(name, unit, 'high', 'header-brackets', evidence);
  const conflict = ` Another bracket also names ${others.join(', ')}, so the last one is taken as a guess.`;
  return found(name, unit, 'medium', 'header-brackets', evidence + conflict);
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
    if (text.length - start > MAX_UNIT_TEXT) continue;
    const raw = text.slice(start).trim();
    const unit = suffixUnit(raw);
    if (unit === undefined) continue;
    const name = cleanName(text.slice(0, start), true);
    if (name === '') continue;
    return suffixDetection(text, name, raw, unit, tokens[i - 1]?.[0] === '/');
  }
  return null;
}

function fromWord(text: string): HeaderUnit | null {
  const words = [...text.matchAll(WORD)].map((m) => m[0]).reverse();
  for (const word of words) {
    if (word.length > MAX_UNIT_TEXT || isSingleLetter(word) || isWordNotUnit(word)) continue;
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

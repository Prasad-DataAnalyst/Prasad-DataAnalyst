/**
 * Header rows: one, or two when the row under the names is mostly units ('psia', '[degC]',
 * 'bbl/d'). A cell only counts as a unit when the column holds numbers further down, because
 * a short word such as 'Producer' looks like a unit on its own but sits above more text.
 *
 * The unit list here only recognises a units row; the units module still parses every header.
 */
import { detection, type Detection } from '@tw/model';
import { formatCount, plural } from './errors';
import { looksNumeric } from './numbers';

/** Rows under a candidate units row that are inspected for numbers. */
const ROWS_BELOW = 50;
/** Share of a column's non-empty cells below the units row that must be numbers. */
const NUMERIC_SHARE = 0.6;

// Lower case. Not exhaustive: a cell that is not listed can still match UNIT_PATTERN.
const KNOWN_UNITS: ReadonlySet<string> = new Set(
  [
    'psi psia psig kpa kpaa kpag mpa pa bar bara barg mbar atm inhg mmhg',
    'degc degf degr degk °c °f °r c f k deg °',
    'm km cm mm ft in mi yd m2 m3 km2 ft2 ft3 ha acre',
    'bbl stb bbl/d stb/d bopd bwpd bfpd m3/d m3/h sm3 sm3/d nm3 nm3/h scf mscf mmscf scf/d mscf/d mmscf/d mmscfd',
    'mcf mmcf bcf scf/bbl l ml gal gpm l/s l/min kl',
    'kg g t tonne tonnes lb lbm klb kt kg/h kg/s t/d t/h lb/h',
    's sec min h hr hrs d day days yr',
    '% ppm ppb ppmv ppmw mg/l mg/kg g/l mol% vol% wt% frac fraction',
    'kg/m3 g/cm3 api °api sg lb/ft3',
    'w kw mw gw kwh mwh gj mj kj j btu mmbtu kcal',
    'v a hz rpm m/s ft/s km/h mph kn knots cp cst',
    'co2e tco2e kgco2e',
  ]
    .join(' ')
    .split(' '),
);

/** Letters with an optional power, joined by '/', '.', '·' or '*', with an optional gauge or absolute mark. */
const UNIT_PATTERN =
  /^(?:%|°[A-Za-z]?|[A-Za-zµμΩ°]{1,8}[23²³]?(?:\s?[/·.*]\s?[A-Za-zµμΩ°]{1,8}[23²³]?){0,3}(?:\s?\((?:a|g|abs)\))?)$/u;

/** Words that fill an empty cell rather than name a unit. */
const NULL_LIKE: ReadonlySet<string> = new Set(['na', 'n/a', '#n/a', 'null', 'nan', 'none', 'nd', 'n.d.', '-', '--', '?']);

/** Date and time format hints such as 'yyyy-mm-dd' or 'hh:mm', which a units row may hold above dates. */
const FORMAT_HINT = /^[ymdhs]{1,4}(?:[-/.: T][ymdhs]{1,4})*$/i;

type UnitKind = 'known' | 'pattern' | null;

function unitKind(cell: string): UnitKind {
  const raw = cell.trim();
  const bracketed = /^(?:\[.*\]|\(.*\))$/.test(raw);
  const text = bracketed ? raw.slice(1, -1).trim() : raw;
  // '[-]' and '(1)' are the usual marks of a dimensionless quantity.
  if (bracketed && (text === '-' || text === '1')) return 'known';
  if (text === '' || text.length > 16 || looksNumeric(text) || NULL_LIKE.has(text.toLowerCase())) return null;
  if (KNOWN_UNITS.has(text.toLowerCase())) return 'known';
  return UNIT_PATTERN.test(text) ? 'pattern' : null;
}

function numericBelow(rows: readonly (readonly string[])[], col: number): boolean {
  let filled = 0;
  let numbers = 0;
  for (const row of rows) {
    const value = row[col]?.trim() ?? '';
    if (value === '') continue;
    filled++;
    if (looksNumeric(value)) numbers++;
  }
  return filled > 0 && numbers / filled >= NUMERIC_SHARE;
}

interface UnitsRowScan {
  /** Non-empty cells, not counting date format hints. */
  filled: number;
  units: number;
  knownUnits: number;
  numbers: number;
  examples: string[];
}

function scanUnitsRow(candidate: readonly string[], below: readonly (readonly string[])[]): UnitsRowScan {
  const scan: UnitsRowScan = { filled: 0, units: 0, knownUnits: 0, numbers: 0, examples: [] };
  candidate.forEach((cell, col) => {
    const text = cell.trim();
    if (text === '' || FORMAT_HINT.test(text)) return;
    scan.filled++;
    if (looksNumeric(text)) scan.numbers++;
    const kind = unitKind(text);
    if (kind === null || !numericBelow(below, col)) return;
    scan.units++;
    if (kind === 'known') scan.knownUnits++;
    if (scan.examples.length < 3) scan.examples.push(JSON.stringify(text));
  });
  return scan;
}

function allNumbers(row: readonly string[]): boolean {
  const filled = row.filter((cell) => cell.trim() !== '');
  return filled.length > 0 && filled.every(looksNumeric);
}

/**
 * Header row count for a table whose rows start at the header (`rows[0]`), blank lines removed.
 */
export function detectHeaderRows(rows: readonly (readonly string[])[]): Detection<number> {
  const [header, candidate] = rows;
  if (header === undefined) {
    return detection(1, 'low', 'empty', 'The file has no rows, so one header row is assumed.', 'default');
  }
  if (allNumbers(header)) {
    const evidence =
      'Every cell of the first row is a number, so the file may have no header row. ' +
      'The first row is still used as the header.';
    return detection(1, 'low', 'header-looks-like-data', evidence);
  }
  if (candidate === undefined) {
    return detection(1, 'high', 'no-data', 'The file has a header row and no data rows.');
  }
  const scan = scanUnitsRow(candidate, rows.slice(2, 2 + ROWS_BELOW));
  if (scan.numbers === 0 && scan.units > 0 && scan.units * 2 >= scan.filled) {
    const confidence = scan.units >= 2 && scan.knownUnits === scan.units ? 'high' : 'medium';
    const evidence =
      `The second row holds units (${scan.examples.join(', ')}) above ${plural(scan.units, 'numeric column')}, ` +
      'so the header is two rows: names, then units.';
    return detection(2, confidence, 'units-row', evidence);
  }
  if (scan.units > 0) {
    const evidence =
      `${formatCount(scan.units)} of the ${formatCount(scan.filled)} cells in the second row look like units ` +
      `(${scan.examples.join(', ')}), but not most of them, so the second row is read as data.`;
    return detection(1, 'medium', 'units-row-partial', evidence);
  }
  return detection(1, 'high', 'single-header', 'The row under the header holds data, not units.');
}

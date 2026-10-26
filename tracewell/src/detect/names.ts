/**
 * Header text: flattening multi-row headers into column names, and splitting names into the
 * lower-case words that role and type hints look for.
 */

/** Joins the parts of a flattened multi-row header ('Pressure / psia'); units.parseHeaderUnit reads the unit after it. */
const PART_SEPARATOR = ' / ';

/** The name given to a column whose header cells are all empty: 'Column 1', 'Column 2', ... */
export function placeholderName(index: number): string {
  return `Column ${index + 1}`;
}

/** Non-empty, trimmed header parts of one column, top to bottom, without immediate repeats (vertical merges). */
function columnParts(rows: string[][], index: number): string[] {
  const parts: string[] = [];
  for (const row of rows) {
    const part = (row[index] ?? '').trim();
    if (part !== '' && parts[parts.length - 1] !== part) parts.push(part);
  }
  return parts;
}

/** Makes names unique in order: the second 'Pressure' becomes 'Pressure (2)', the third 'Pressure (3)'. */
export function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate); n++) candidate = `${name} (${n})`;
    taken.add(candidate);
    return candidate;
  });
}

/** Number of columns a header describes: the widest header row. */
export function headerWidth(rows: string[][]): number {
  return rows.reduce((width, row) => Math.max(width, row.length), 0);
}

/**
 * One name per column from header rows (top to bottom): the non-empty parts joined with ' / ',
 * an empty header named by position, and duplicates made unique with ' (2)', ' (3)', ...
 */
export function flattenHeader(rows: string[][]): string[] {
  const names: string[] = [];
  for (let i = 0; i < headerWidth(rows); i++) {
    const parts = columnParts(rows, i);
    names.push(parts.length === 0 ? placeholderName(i) : parts.join(PART_SEPARATOR));
  }
  return uniqueNames(names);
}

/** Lower-case words of a name: 'WellID' → ['well', 'id'], 'gas_rate' → ['gas', 'rate']. */
export function nameTokens(name: string): string[] {
  const spaced = name.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '');
}

/** Words that name a date or time, used only to read numbers as Excel serial dates. */
const DATE_WORDS: ReadonlySet<string> = new Set([
  'date',
  'datetime',
  'timestamp',
  'time',
  'dt',
  'datum',
  'spud',
  'dated',
]);

export function hasDateHint(tokens: string[]): boolean {
  return tokens.some((t) => DATE_WORDS.has(t));
}

const BOOLEAN_PREFIXES: ReadonlySet<string> = new Set(['is', 'has', 'was', 'can']);
const BOOLEAN_WORDS: ReadonlySet<string> = new Set(['flag', 'active', 'enabled', 'valid', 'bool', 'boolean']);

/** Header words that make a 1/0 column a boolean rather than a count. */
export function hasBooleanHint(tokens: string[]): boolean {
  const first = tokens[0];
  return (first !== undefined && BOOLEAN_PREFIXES.has(first)) || tokens.some((t) => BOOLEAN_WORDS.has(t));
}

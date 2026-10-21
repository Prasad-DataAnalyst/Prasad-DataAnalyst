/**
 * Delimiter and preamble detection by field-count consistency.
 *
 * The sample is tokenized once per candidate delimiter (, ; tab |). For each, the modal field
 * count among lines with at least two fields is the table width, and the header is the first
 * line that fits it; the lines before the header are a title block. A candidate is plausible
 * when most lines from its header on fit. Among plausible candidates the one that explains the
 * most leading lines wins: in a semicolon file with decimal commas, splitting on commas also
 * gives a consistent width, but only from the second line on, because the header has no commas.
 */
import { detection, type Confidence, type Detection } from '@tw/model';
import { formatCount, plural } from './errors';
import { isBlankRecord } from './shape';
import { CSV_DELIMITERS, tokenizeAll, type CsvDialect, type CsvRecord } from './tokenizer';

export type Delimiter = CsvDialect['delimiter'];

/** Share of lines from the header on that must fit the width for a candidate to be plausible. */
const PLAUSIBLE = 0.8;
/** At or above this share, and with no rival, a delimiter is detected with high confidence. */
const CONSISTENT = 0.99;
/** Title blocks are short; a "header" found later than this is not trusted as one. */
const MAX_PREAMBLE_LINES = 50;
/** Share of full-width lines ending in an empty field above which lines one field short also fit. */
const TRAILING_DELIMITER_SHARE = 0.9;
/** Below PLAUSIBLE but above this share, a delimiter no other candidate competes with is still medium. */
const MESSY_SHARE = 0.5;

const DELIMITER_NAMES: Readonly<Record<Delimiter, string>> = {
  ',': 'comma',
  ';': 'semicolon',
  '\t': 'tab',
  '|': 'pipe',
};

export function delimiterName(d: Delimiter): string {
  return DELIMITER_NAMES[d];
}

export interface Candidate {
  delimiter: Delimiter;
  /** Every record of the sample, blank lines included. */
  records: CsvRecord[];
  /** The records that are not blank lines. */
  lines: CsvRecord[];
  /** Table width: the modal field count among lines with two or more fields; 0 when there are none. */
  width: number;
  /** Index in `lines` of the header. */
  headerIndex: number;
  /** Lines from the header on that fit the width. */
  fitting: number;
  /** Share of lines from the header on that fit the width. */
  consistency: number;
}

function modalCount(lines: readonly CsvRecord[]): number {
  const counts = new Map<number, number>();
  for (const { fields } of lines) {
    if (fields.length >= 2) counts.set(fields.length, (counts.get(fields.length) ?? 0) + 1);
  }
  let best = 0;
  let bestFrequency = 0;
  for (const [count, frequency] of counts) {
    if (frequency > bestFrequency || (frequency === bestFrequency && count > best)) {
      best = count;
      bestFrequency = frequency;
    }
  }
  return best;
}

/**
 * Whether a line fits the width, allowing for trailing delimiters: a header with one more field
 * that is empty, or, when the data lines end in an empty field, a line with one field fewer.
 */
function fitter(lines: readonly CsvRecord[], width: number): (r: CsvRecord) => boolean {
  const full = lines.filter((r) => r.fields.length === width);
  const endEmpty = full.filter((r) => r.fields[width - 1] === '').length;
  const shortFits = full.length > 0 && endEmpty / full.length >= TRAILING_DELIMITER_SHARE;
  return ({ fields }) =>
    fields.length === width ||
    (fields.length === width + 1 && fields[width] === '') ||
    (shortFits && fields.length === width - 1);
}

export function analyseCandidate(text: string, delimiter: Delimiter): Candidate {
  const records = tokenizeAll(text, { delimiter, quote: '"' });
  const lines = records.filter((r) => !isBlankRecord(r.fields));
  const width = modalCount(lines);
  const empty = { delimiter, records, lines, width, headerIndex: 0, fitting: 0, consistency: 0 };
  if (width === 0) return empty;
  const fits = fitter(lines, width);
  const first = lines.findIndex(fits);
  const titled = fitFrom(lines, first >= 0 && first <= MAX_PREAMBLE_LINES ? first : 0, fits);
  // A title block is only believable above a consistent table; otherwise the header is the first line.
  const fit = titled.consistency >= PLAUSIBLE ? titled : fitFrom(lines, 0, fits);
  return { ...empty, ...fit };
}

function fitFrom(
  lines: readonly CsvRecord[],
  headerIndex: number,
  fits: (r: CsvRecord) => boolean,
): Pick<Candidate, 'headerIndex' | 'fitting' | 'consistency'> {
  const rest = lines.slice(headerIndex);
  const fitting = rest.filter(fits).length;
  return { headerIndex, fitting, consistency: rest.length === 0 ? 0 : fitting / rest.length };
}

function preferred(fileName: string): Delimiter {
  return /\.(?:tsv|tab)$/i.test(fileName) ? '\t' : ',';
}

/** Most lines from the header on fit a table of two or more columns. */
function isPlausible(c: Candidate): boolean {
  return c.width >= 2 && c.consistency >= PLAUSIBLE;
}

/** Share of all non-blank lines that fit the width from the header on. */
function score(c: Candidate): number {
  return c.lines.length === 0 ? 0 : c.fitting / c.lines.length;
}

/**
 * Orders candidates best first: plausible ones by fewest preamble lines, the rest by fitting share;
 * ties go to the wider table, then to the file type's usual delimiter, then to the list order.
 */
function compare(a: Candidate, b: Candidate, prefer: Delimiter): number {
  const plausibleA = isPlausible(a);
  if (plausibleA !== isPlausible(b)) return plausibleA ? -1 : 1;
  if (plausibleA && a.headerIndex !== b.headerIndex) return a.headerIndex - b.headerIndex;
  if (score(a) !== score(b)) return score(b) - score(a);
  if (a.width !== b.width) return b.width - a.width;
  if (a.delimiter === prefer || b.delimiter === prefer) return a.delimiter === prefer ? -1 : 1;
  return CSV_DELIMITERS.indexOf(a.delimiter) - CSV_DELIMITERS.indexOf(b.delimiter);
}

export interface DelimiterChoice {
  candidate: Candidate;
  detection: Detection<Delimiter>;
}

export function chooseDelimiter(text: string, fileName: string): DelimiterChoice {
  const prefer = preferred(fileName);
  const ranked = CSV_DELIMITERS.map((d) => analyseCandidate(text, d)).sort((a, b) => compare(a, b, prefer));
  const best = ranked[0] as Candidate;
  if (best.width < 2) {
    const fallback = ranked.find((c) => c.delimiter === prefer) ?? best;
    return { candidate: fallback, detection: noDelimiter(prefer, best.lines.length) };
  }
  return { candidate: best, detection: delimiterDetection(best, ranked.slice(1)) };
}

function noDelimiter(prefer: Delimiter, lines: number): Detection<Delimiter> {
  const evidence =
    lines === 0
      ? `The file has no lines to inspect, so the ${delimiterName(prefer)} is assumed.`
      : `No comma, semicolon, tab or pipe splits the lines into two or more fields, so the file reads as a ` +
        `single column and the ${delimiterName(prefer)} is assumed.`;
  return detection(prefer, 'low', 'default', evidence, 'default');
}

function delimiterDetection(best: Candidate, others: readonly Candidate[]): Detection<Delimiter> {
  const name = delimiterName(best.delimiter);
  const rest = best.lines.length - best.headerIndex;
  const rival = others.find((c) => isPlausible(c) && c.headerIndex <= best.headerIndex);
  const share = `${formatCount(best.fitting)} of ${plural(rest, 'line')}`;
  let evidence = `Splitting on the ${name} gives ${formatCount(best.width)} fields on ${share} from the header on.`;
  if (rival !== undefined) {
    evidence += ` Splitting on the ${delimiterName(rival.delimiter)} is almost as consistent, so this is uncertain.`;
  }
  if (rest < 2) {
    return detection(best.delimiter, 'medium', 'field-count-consistency', `${evidence} The sample has no data lines.`);
  }
  return detection(best.delimiter, delimiterConfidence(best, others, rival), 'field-count-consistency', evidence);
}

/**
 * Ragged rows lower the confidence, but less when no other delimiter splits the lines at all:
 * then the delimiter is clear and only the rows are messy.
 */
function delimiterConfidence(best: Candidate, others: readonly Candidate[], rival: Candidate | undefined): Confidence {
  if (best.consistency >= CONSISTENT && rival === undefined) return 'high';
  if (best.consistency >= PLAUSIBLE) return 'medium';
  const competitor = others.some((c) => c.width >= 2 && score(c) >= MESSY_SHARE);
  return best.consistency >= MESSY_SHARE && !competitor ? 'medium' : 'low';
}

/**
 * Lines to skip before the header: the title block the candidate found, plus any blank lines
 * around it. The header is the first line with the table's width, so the evidence is only as
 * strong as the table's consistency.
 */
export function detectSkipLines(c: Candidate): Detection<number> {
  const header = c.lines[c.headerIndex];
  if (header === undefined) {
    return detection(0, 'high', 'empty', 'The file has no lines with text, so there is nothing to skip.');
  }
  const skip = header.line - 1;
  if (c.width < 2) return singleColumnSkip(skip);
  if (c.headerIndex === 0) return noTitleSkip(c, skip);
  return titleBlockSkip(c, skip);
}

function singleColumnSkip(skip: number): Detection<number> {
  const evidence =
    'No delimiter splits the lines into fields, so title rows cannot be told from the header by their ' +
    `field count. The first line with text, line ${formatCount(skip + 1)}, is taken as the header.`;
  return detection(skip, 'medium', 'single-column', evidence);
}

function noTitleSkip(c: Candidate, skip: number): Detection<number> {
  const evidence =
    skip === 0
      ? `The first line already has the table's ${formatCount(c.width)} fields, so it is the header and no lines are skipped.`
      : `The first ${plural(skip, 'line')} ${skip === 1 ? 'is' : 'are'} empty, so the header is on line ` +
        `${formatCount(skip + 1)} and the empty ${skip === 1 ? 'line is' : 'lines are'} skipped.`;
  return detection(skip, c.consistency >= PLAUSIBLE ? 'high' : 'medium', 'field-count-consistency', evidence);
}

function titleBlockSkip(c: Candidate, skip: number): Detection<number> {
  const preamble = c.lines.slice(0, c.headerIndex);
  const allShort = preamble.every((r) => r.fields.length < c.width);
  const shape = allShort ? 'fewer fields than' : 'a different number of fields from';
  const evidence =
    `The first ${plural(preamble.length, 'line')} with text ${preamble.length === 1 ? 'has' : 'have'} ${shape} ` +
    `the table's ${formatCount(c.width)}, so ${preamble.length === 1 ? 'it is' : 'they are'} read as a title block. ` +
    `The header is on line ${formatCount(skip + 1)} and the ${plural(skip, 'line')} above it ${skip === 1 ? 'is' : 'are'} skipped.`;
  const confidence = allShort && c.consistency >= CONSISTENT ? 'high' : 'medium';
  return detection(skip, confidence, 'title-block', evidence);
}

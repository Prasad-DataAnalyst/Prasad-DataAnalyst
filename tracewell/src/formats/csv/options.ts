/**
 * Validation of the options callers pass in. The import settings only offer valid values, so a
 * bad option is a defect in the calling code and fails fast with INVALID_INPUT rather than being
 * read as something else.
 */
import type { CsvOptions, FormatOptions } from '@tw/model';
import { invalidArgument } from './errors';
import { CSV_DELIMITERS, type CsvDialect } from './tokenizer';

const DECIMALS: readonly CsvOptions['decimalSeparator'][] = ['.', ','];
const THOUSANDS: readonly CsvOptions['thousandsSeparator'][] = ['', ',', '.', ' '];

export function checkCount(name: 'skipLines' | 'headerRows' | 'bomLength', value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw invalidArgument(`The CSV option ${name} must be a whole number of 0 or more, not ${String(value)}.`, {
      [name]: String(value),
    });
  }
}

export function checkDelimiter(delimiter: string): asserts delimiter is CsvDialect['delimiter'] {
  if (!(CSV_DELIMITERS as readonly string[]).includes(delimiter)) {
    throw invalidArgument(`The CSV delimiter ${JSON.stringify(delimiter)} is not one of , ; tab or |.`, {
      delimiter: String(delimiter),
    });
  }
}

export function checkDecimal(decimal: string): void {
  if (!(DECIMALS as readonly string[]).includes(decimal)) {
    throw invalidArgument(`The decimal separator ${JSON.stringify(decimal)} is not '.' or ','.`, {
      decimalSeparator: String(decimal),
    });
  }
}

export function checkThousands(thousands: string): void {
  if (!(THOUSANDS as readonly string[]).includes(thousands)) {
    throw invalidArgument(`The thousands separator ${JSON.stringify(thousands)} is not '', ',', '.' or ' '.`, {
      thousandsSeparator: String(thousands),
    });
  }
}

export function checkSeparatorsDiffer(decimal: string, thousands: string): void {
  if (thousands === decimal) {
    throw invalidArgument(`The thousands and decimal separators are both ${JSON.stringify(decimal)}.`, {
      decimalSeparator: decimal,
      thousandsSeparator: thousands,
    });
  }
}

/** The CSV options of `opts`, checked; anything but a CSV or TSV format is refused. */
export function csvOptionsOf(opts: FormatOptions): CsvOptions {
  if (opts.format !== 'csv' && opts.format !== 'tsv') {
    throw invalidArgument(`The CSV reader was given options for the ${String(opts.format)} format.`, {
      format: String(opts.format),
    });
  }
  const csv = opts.csv;
  checkDelimiter(csv.delimiter);
  if (csv.quote !== '"') {
    throw invalidArgument(`The CSV quote ${JSON.stringify(csv.quote)} is not supported; only " is.`, {
      quote: String(csv.quote),
    });
  }
  checkCount('bomLength', csv.bomLength);
  checkCount('skipLines', csv.skipLines);
  checkCount('headerRows', csv.headerRows);
  checkDecimal(csv.decimalSeparator);
  checkThousands(csv.thousandsSeparator);
  checkSeparatorsDiffer(csv.decimalSeparator, csv.thousandsSeparator);
  return csv;
}

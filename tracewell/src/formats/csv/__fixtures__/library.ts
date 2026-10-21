/**
 * Test-only access to the committed messy-file library (fixtures/messy). Files are read straight
 * from disk rather than through '@tw/fixtures', which is a separate module this one does not
 * depend on. Until the library's SHA256SUMS exists, the tests that need it are skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MESSY_DIR = fileURLToPath(new URL('../../../../fixtures/messy/', import.meta.url));

/** True once the fixtures module has delivered the library. */
export const MESSY_READY = existsSync(`${MESSY_DIR}SHA256SUMS`);

/** The CSV and TSV entries of the library. */
export const LIBRARY_CSV_NAMES = [
  'csv_well_daily_golden.csv',
  'csv_semicolon_decimalcomma_cp1252.csv',
  'csv_utf8_bom_crlf.csv',
  'tsv_utf16le_bom.tsv',
  'csv_title_rows_units_in_header.csv',
  'csv_null_markers.csv',
  'csv_quoted_newlines_ragged.csv',
  'csv_duplicates_rows_and_keys.csv',
  'csv_dates_ambiguous_and_mixed.csv',
  'csv_leading_zero_ids_ndl.csv',
  'csv_latlon_swapped_out_of_range.csv',
  'csv_timeseries_gaps_dups_flatline_spike.csv',
  'csv_mixed_units_in_cells.csv',
  'csv_pipe_delimited.csv',
  'csv_physical_impossible.csv',
] as const;

/** The parts of a library expectation this module is responsible for. */
export interface LibraryExpectation {
  detections?: Partial<Record<'encoding' | 'delimiter' | 'decimalSeparator' | 'skipLines' | 'headerRows', unknown>>;
  rowCount?: number;
}

export function libraryBytes(name: string): Uint8Array {
  const buffer = readFileSync(`${MESSY_DIR}${name}`);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** The expectation file, named `<name>.expected.json` with or without the data file's extension. */
export function libraryExpectation(name: string): LibraryExpectation | null {
  const candidates = [`${name}.expected.json`, `${name.replace(/\.[^.]+$/, '')}.expected.json`];
  const path = candidates.map((c) => `${MESSY_DIR}${c}`).find((p) => existsSync(p));
  return path === undefined ? null : (JSON.parse(readFileSync(path, 'utf8')) as LibraryExpectation);
}

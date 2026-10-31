// @ts-check
/**
 * Helpers shared by the fixture generators. Generators are plain Node scripts, so they cannot import
 * fixtures/index.ts; fixtures.test.ts checks that ALL_FIXTURES equals FIXTURE_NAMES there.
 */
export { isEntryScript } from '../../scripts/is-entry.mjs';

/** Every committed fixture in fixtures/messy, in the order of fixtures/index.ts. */
export const ALL_FIXTURES = Object.freeze([
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
  'xlsx_merged_two_row_header_units.xlsx',
  'xlsx_text_and_serial_dates.xlsx',
  'xlsx_two_tables_one_sheet.xlsx',
  'xlsx_date1904.xlsx',
  'xlsx_hidden_sheets_formulas.xlsx',
  'xlsx_numbers_as_text.xlsx',
  'xls_merged_two_row_header_units.xls',
  'xls_date1904.xls',
  'geojson_wells_points_wgs84.geojson',
  'geojson_legacy_crs_27700.geojson',
  'geojson_invalid_geometries.geojson',
  'geojson_swapped_lonlat.geojson',
  'geojson_mixed_geometry_nested_props.geojson',
  'json_api_wrapper_nested.json',
  'jsonl_well_tests_crlf.jsonl',
  'parquet_well_daily_typed.parquet',
]);

/**
 * Mulberry32: a small seeded generator with a 32-bit state. The same seed gives the same sequence
 * on every platform, because it uses only 32-bit integer arithmetic (Math.imul and shifts).
 * @param {number} seed
 * @returns {() => number} values in [0, 1)
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Uniform noise in [-amplitude, amplitude).
 * @param {() => number} rand
 * @param {number} amplitude
 */
export function noise(rand, amplitude) {
  return (rand() * 2 - 1) * amplitude;
}

/** Rule TW-TIME-007: Hampel identifier, window 7 (3 each side), k = 3, MAD scaled by 1.4826. */
const HALF_WINDOW = 3;
const K = 3;
const MAD_SCALE = 1.4826;

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? NaN) : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
}

/**
 * Indexes the Hampel identifier flags in a series. `strict` widens the definition of
 * fixtures/README.md to every reasonable variant at once: points near either end are tested over
 * the part of the window that exists, and a window with MAD 0 flags any point that differs from
 * its median. Generated series are kept clean under the strict form, so their expected spike
 * counts hold whichever variant a rules implementation picks.
 * @param {readonly number[]} values
 * @param {boolean} [strict]
 * @returns {number[]}
 */
export function hampelFlags(values, strict = false) {
  /** @type {number[]} */
  const flagged = [];
  for (let i = 0; i < values.length; i++) {
    const from = i - HALF_WINDOW;
    const to = i + HALF_WINDOW;
    if (!strict && (from < 0 || to >= values.length)) continue;
    const window = values.slice(Math.max(from, 0), Math.min(to, values.length - 1) + 1);
    const m = median(window);
    const mad = median(window.map((v) => Math.abs(v - m)));
    const deviation = Math.abs((values[i] ?? m) - m);
    if ((mad > 0 || strict) && deviation > K * MAD_SCALE * mad) flagged.push(i);
  }
  return flagged;
}

/**
 * Length of the longest run of identical consecutive values (rule TW-TIME-006 flags runs of 6).
 * @param {readonly unknown[]} values
 */
export function longestRun(values) {
  let longest = values.length > 0 ? 1 : 0;
  let run = 1;
  for (let i = 1; i < values.length; i++) {
    run = values[i] === values[i - 1] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

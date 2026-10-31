/** The committed fixtures of fixtures/messy (README.md describes each). */

export type FixtureName =
  | 'csv_well_daily_golden.csv'
  | 'csv_semicolon_decimalcomma_cp1252.csv'
  | 'csv_utf8_bom_crlf.csv'
  | 'tsv_utf16le_bom.tsv'
  | 'csv_title_rows_units_in_header.csv'
  | 'csv_null_markers.csv'
  | 'csv_quoted_newlines_ragged.csv'
  | 'csv_duplicates_rows_and_keys.csv'
  | 'csv_dates_ambiguous_and_mixed.csv'
  | 'csv_leading_zero_ids_ndl.csv'
  | 'csv_latlon_swapped_out_of_range.csv'
  | 'csv_timeseries_gaps_dups_flatline_spike.csv'
  | 'csv_mixed_units_in_cells.csv'
  | 'csv_pipe_delimited.csv'
  | 'csv_physical_impossible.csv'
  | 'xlsx_merged_two_row_header_units.xlsx'
  | 'xlsx_text_and_serial_dates.xlsx'
  | 'xlsx_two_tables_one_sheet.xlsx'
  | 'xlsx_date1904.xlsx'
  | 'xlsx_hidden_sheets_formulas.xlsx'
  | 'xlsx_numbers_as_text.xlsx'
  | 'xls_merged_two_row_header_units.xls'
  | 'xls_date1904.xls'
  | 'geojson_wells_points_wgs84.geojson'
  | 'geojson_legacy_crs_27700.geojson'
  | 'geojson_invalid_geometries.geojson'
  | 'geojson_swapped_lonlat.geojson'
  | 'geojson_mixed_geometry_nested_props.geojson'
  | 'json_api_wrapper_nested.json'
  | 'jsonl_well_tests_crlf.jsonl'
  | 'parquet_well_daily_typed.parquet';

export const FIXTURE_NAMES: readonly FixtureName[] = Object.freeze([
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

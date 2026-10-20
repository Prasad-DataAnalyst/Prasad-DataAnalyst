/**
 * Canned content of the stub engine: one small daily well-test file, its detected columns, the
 * three rules that fire on it, a handful of units and the export profiles. The values are chosen
 * so that every view of the UI has something to show: an error, a warning, a note and assumptions.
 */
import {
  detection,
  utf8,
  type Assumption,
  type ColumnSchema,
  type ExportProfile,
  type QuantityKind,
  type RuleDef,
  type RulePack,
  type UnitConvention,
  type UnitInfo,
} from '@tw/model';

export const STUB_ENGINE_NAME = 'tracewell-stub';
export const STUB_ENGINE_VERSION = '0.1.0';
export const STUB_REGISTRY_VERSION = '2026.1';
export const STUB_MEMORY_BUDGET = 1_500_000_000;

/** Every stub timestamp counts whole seconds from this instant, so runs are reproducible. */
export const STUB_EPOCH_MS = Date.UTC(2026, 9, 19, 8, 0, 0);

/**
 * A deterministic stand-in for SHA-256 (FNV-1a rounds), so stub IDs and hashes look like the real
 * ones. It is not a cryptographic hash: the stub never claims to verify anything.
 */
export function stubHex(text: string, length = 64): string {
  let out = '';
  for (let round = 0; out.length < length; round++) {
    let h = (0x811c9dc5 ^ round) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

export const SOURCE_HEADER = ['Well', 'Date', 'Oil rate [m3/d]', 'THP [psia]', 'Water cut'];

/** The data rows as text, exactly as they appear in the file; RowId is the index. */
export const SOURCE_ROWS: readonly (readonly string[])[] = [
  ['W-01', '2026-01-01', '152.4', '1450.2', '12.5'],
  ['W-01', '2026-01-02', '150.9', '1448.7', '12.7'],
  ['W-01', '2026-01-03', '149.8', '1447.0', '12.9'],
  ['W-01', '2026-01-04', '151.2', '1446.1', '13.0'],
  ['W-01', '2026-01-05', '148.6', 'NA', '13.2'],
  ['W-02', '2026-01-01', '98.3', '1210.4', '30.1'],
  ['W-02', '2026-01-02', '-4.0', '1208.9', '30.4'],
  ['W-02', '2026-01-03', '97.1', 'NA', '30.6'],
  ['W-02', '2026-01-04', '96.5', '1205.2', '30.9'],
  ['W-02', '2026-01-05', '95.8', '1204.0', '31.2'],
];

const SOURCE_TEXT = [SOURCE_HEADER, ...SOURCE_ROWS].map((r) => r.join(',')).join('\r\n') + '\r\n';

export const SOURCE_FILE = {
  name: 'well_daily.csv',
  size: utf8(SOURCE_TEXT).byteLength,
  fileId: stubHex(SOURCE_TEXT),
  mediaType: 'text/csv',
};

/** CSV physical line of a data row: the header is line 1. */
export function sourceLine(rowId: number): number {
  return rowId + 2;
}

const NO_UNIT = detection<string | null>(null, 'high', 'no-unit', 'Neither the header nor the values name a unit.');
const NO_MARKERS = detection<string[]>([], 'high', 'null-marker-scan', 'No null markers were found in the sample.');

function measure(id: string, index: number, name: string, unit: string, quantity: QuantityKind): ColumnSchema {
  return {
    id,
    name,
    sourceHeader: [SOURCE_HEADER[index] ?? name],
    sourceIndex: index,
    type: detection('number', 'high', 'value-parse', 'All non-empty values parse as decimal numbers.'),
    role: detection('measure', 'high', 'type-and-unit', 'A numeric column with a unit is a measurement.'),
    unit: detection<string | null>(unit, 'high', 'header-unit', `The header "${SOURCE_HEADER[index]}" names the unit.`),
    quantity,
    nullMarkers: NO_MARKERS,
    decimalSeparator: detection<'.' | ','>('.', 'high', 'decimal-scan', 'Decimal points, no decimal commas.'),
  };
}

/** The columns as detection planned them, before any override. */
export function sourceColumns(): ColumnSchema[] {
  const thp = measure('c3', 3, 'THP', 'psia', 'pressure_abs');
  thp.nullMarkers = detection(['NA'], 'medium', 'null-marker-scan', 'The text "NA" appears in 2 of 10 rows of a numeric column.');
  const waterCut = measure('c4', 4, 'Water cut', '%', 'fraction');
  waterCut.unit = detection<string | null>(
    '%',
    'low',
    'value-range',
    'The header names no unit; values between 12.5 and 31.2 look like percentages.',
  );
  return [
    {
      id: 'c0',
      name: 'Well',
      sourceHeader: ['Well'],
      sourceIndex: 0,
      type: detection('string', 'high', 'value-parse', 'Values are text identifiers.'),
      role: detection('id', 'high', 'header-name', 'The header "Well" names an asset identifier.'),
      unit: NO_UNIT,
      quantity: null,
      nullMarkers: NO_MARKERS,
    },
    {
      id: 'c1',
      name: 'Date',
      sourceHeader: ['Date'],
      sourceIndex: 1,
      type: detection('date', 'high', 'value-parse', 'All values are ISO 8601 dates.'),
      role: detection('time', 'high', 'type', 'The only date column is the time axis.'),
      unit: NO_UNIT,
      quantity: null,
      nullMarkers: NO_MARKERS,
      dateFormat: detection('iso', 'high', 'date-pattern', 'Every value matches YYYY-MM-DD.'),
    },
    measure('c2', 2, 'Oil rate', 'm3/d', 'volume_rate'),
    thp,
    waterCut,
  ];
}

export const ENCODING_ASSUMPTION = {
  property: 'encoding',
  value: 'utf-8',
  confidence: 'medium' as const,
  evidence: 'The file has no byte-order mark and every byte sequence is valid UTF-8.',
};

/** Every assumed detection of a dataset: the dataset-level encoding plus assumed column detections. */
export function assumptionsOf(datasetId: string, columns: ColumnSchema[]): Assumption[] {
  const list: Assumption[] = [{ datasetId, columnId: null, ...ENCODING_ASSUMPTION }];
  for (const c of columns) {
    for (const [property, d] of [
      ['type', c.type],
      ['role', c.role],
      ['unit', c.unit],
      ['nullMarkers', c.nullMarkers],
    ] as const) {
      if (d.assumed) list.push({ datasetId, columnId: c.id, property, value: d.value, confidence: d.confidence, evidence: d.evidence });
    }
  }
  return list;
}

export const RULE_NOT_NULL: RuleDef = {
  id: 'TW-DQ-001',
  version: '0.1.0',
  title: 'Missing values',
  category: 'completeness',
  severity: 'warning',
  appliesTo: { roles: ['measure'] },
  check: { kind: 'not_null' },
  message: '{count} missing values in {column}',
  explanation: 'Some rows have no value in this column. Decide whether to fill them, accept them or exclude the rows.',
  source: 'Tracewell generic data-quality rules (FR-VAL-01).',
};

export const RULE_PHYSICAL_RANGE: RuleDef = {
  id: 'TW-DQ-005',
  version: '0.1.0',
  title: 'Physically impossible value',
  category: 'range',
  severity: 'error',
  appliesTo: { quantities: ['volume_rate', 'pressure_abs', 'fraction'] },
  check: { kind: 'physical_range' },
  message: '{count} physically impossible values in {column}',
  explanation: 'A rate cannot be negative, an absolute pressure cannot be below zero and a fraction must lie within 0 to 100 %.',
  source: 'Physical limits of the quantity; unit definitions from NIST SP 811 (2008).',
};

export const RULE_NULL_MARKER: RuleDef = {
  id: 'TW-DQ-006',
  version: '0.1.0',
  title: 'Null marker converted',
  category: 'validity',
  severity: 'note',
  appliesTo: { all: true },
  check: { kind: 'null_marker' },
  message: '{count} values in {column} matched a null marker and were read as missing',
  explanation: 'Text such as NA or -999 was read as a missing value. The original text is kept and shown in the cell lineage.',
  source: 'Tracewell import rules (SAD section 7.2).',
};

export const STUB_RULE_PACK: RulePack = {
  id: 'tracewell.generic-dq',
  version: '0.1.0',
  title: 'Generic data quality',
  source: 'Tracewell built-in rule-pack (stub excerpt).',
  rules: [RULE_NOT_NULL, RULE_PHYSICAL_RANGE, RULE_NULL_MARKER],
};

export const STUB_RULE_PACK_REF = {
  id: STUB_RULE_PACK.id,
  version: STUB_RULE_PACK.version,
  sha256: stubHex('rule-pack:tracewell.generic-dq@0.1.0'),
};

export const STUB_REGISTRY_REF = { version: STUB_REGISTRY_VERSION, sha256: stubHex('unit-registry:2026.1') };

export interface StubUnit extends UnitInfo {
  toSI: { factor: number; offset: number };
  source: string;
}

const NIST = 'NIST SP 811 (2008) Appendix B.8';
const BARREL = 'API MPMS Chapter 11.1; NIST SP 811 (2008) Appendix B.8';

function unit(
  code: string,
  label: string,
  quantity: QuantityKind,
  factor: number,
  source: string,
  convention: UnitConvention | null = null,
): StubUnit {
  return { code, label, quantity, convention, toSI: { factor, offset: 0 }, source };
}

/** An excerpt of the unit registry; enough to exercise compatible, convention and gauge cases. */
export const STUB_UNITS: readonly StubUnit[] = [
  unit('m3/d', 'cubic metre per day', 'volume_rate', 1 / 86_400, NIST),
  unit('bbl/d', 'barrel per day', 'volume_rate', 0.158987294928 / 86_400, BARREL),
  unit('stb/d', 'stock-tank barrel per day (60 °F, 14.696 psia)', 'std_volume_rate', 0.158987294928 / 86_400, BARREL, 'std-60F-14.696psia'),
  unit('kPa', 'kilopascal (absolute)', 'pressure_abs', 1000, 'SI Brochure (2019)'),
  unit('bar', 'bar (absolute)', 'pressure_abs', 100_000, NIST),
  unit('psia', 'pound-force per square inch, absolute', 'pressure_abs', 6894.757293168361, NIST),
  unit('psig', 'pound-force per square inch, gauge', 'pressure_gauge', 6894.757293168361, NIST, 'gauge'),
  unit('fraction', 'fraction (0 to 1)', 'fraction', 1, 'SI Brochure (2019)'),
  unit('%', 'percent', 'fraction', 0.01, 'SI Brochure (2019)'),
];

export function findUnit(code: string | null): StubUnit | undefined {
  return code === null ? undefined : STUB_UNITS.find((u) => u.code === code);
}

/** Physical limits in SI units for the quantities the stub checks (rule TW-DQ-005). */
export const SI_LIMITS: Partial<Record<QuantityKind, { min: number; max: number }>> = {
  volume_rate: { min: 0, max: Infinity },
  pressure_abs: { min: 0, max: Infinity },
  fraction: { min: 0, max: 1 },
};

export const STUB_PROFILES: readonly ExportProfile[] = [
  {
    id: 'excel',
    label: 'Microsoft Excel',
    destinations: ['Microsoft Excel', 'LibreOffice Calc'],
    dataExtension: '.xlsx',
    description: 'Workbook with Data, Report and Log sheets.',
  },
  {
    id: 'csv',
    label: 'Databases, Python, R, BI tools (CSV)',
    destinations: ['Databases', 'Python', 'R', 'BI tools'],
    dataExtension: '.csv',
    description: 'UTF-8 CSV (RFC 4180) with a single "Name [unit]" header row.',
  },
  {
    id: 'geojson',
    label: 'QGIS / ArcGIS / web maps (GeoJSON)',
    destinations: ['QGIS', 'ArcGIS', 'Web maps'],
    dataExtension: '.geojson',
    description: 'RFC 7946 FeatureCollection in WGS84 longitude/latitude order.',
  },
];

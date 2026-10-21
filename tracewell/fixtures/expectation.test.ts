/**
 * The loader's check of expected files: it accepts every committed file (fixtures.test.ts) and
 * names the first wrong field of a malformed one.
 */
import { describe, expect, it } from 'vitest';
import { parseExpectation } from './expectation';
import type { FixtureName } from './names';

type Doc = Record<string, unknown>;

const NAME: FixtureName = 'csv_leading_zero_ids_ndl.csv';

function valid(): Doc {
  return {
    file: NAME,
    format: 'csv',
    detections: { encoding: 'utf-8', delimiter: ',', decimalSeparator: '.', skipLines: 0, headerRows: 1 },
    confidence: {
      encoding: 'high',
      delimiter: 'high',
      decimalSeparator: 'high',
      skipLines: 'high',
      headerRows: 'high',
    },
    rowCount: 10,
    columns: [
      { name: 'sample_id', type: 'string', unit: null, role: 'id' },
      { name: 'Benzene', type: 'number', unit: 'ppm', role: 'measure', assumed: ['type', 'unit'] },
    ],
    issues: { 'TW-DQ-007': 4 },
    notes: [],
  };
}

function withChange(change: (doc: Doc) => void): Doc {
  const doc = valid();
  change(doc);
  return doc;
}

const detections = (d: Doc): Doc => d['detections'] as Doc;
const confidence = (d: Doc): Doc => d['confidence'] as Doc;
function column(d: Doc, i: number): Doc {
  const c = (d['columns'] as Doc[])[i];
  if (c === undefined) throw new Error(`No column ${i}.`);
  return c;
}

const REFUSALS: { label: string; change: (d: Doc) => void; message: RegExp }[] = [
  { label: 'another fixture name', change: (d) => (d['file'] = 'csv_pipe_delimited.csv'), message: /^file must be/ },
  { label: 'an unknown field', change: (d) => (d['extra'] = 1), message: /unknown fields \(found extra\)/ },
  { label: 'an unknown format', change: (d) => (d['format'] = 'xls'), message: /^format must be one of/ },
  { label: 'an unknown detection', change: (d) => (detections(d)['quote'] = '"'), message: /detections must be free/ },
  { label: 'a bad delimiter', change: (d) => (detections(d)['delimiter'] = ':'), message: /detections\.delimiter/ },
  { label: 'a missing confidence', change: (d) => delete confidence(d)['skipLines'], message: /confidence\.skipLines/ },
  {
    label: 'a confidence without a detection',
    change: (d) => (confidence(d)['crs'] = 'high'),
    message: /confidence must be free/,
  },
  { label: 'a negative row count', change: (d) => (d['rowCount'] = -1), message: /rowCount must be a whole number/ },
  { label: 'no columns', change: (d) => (d['columns'] = []), message: /columns must be an array of at least 1/ },
  { label: 'an unknown type', change: (d) => (column(d, 0)['type'] = 'text'), message: /columns\[0\]\.type/ },
  { label: 'an empty unit', change: (d) => (column(d, 0)['unit'] = ''), message: /columns\[0\]\.unit/ },
  {
    label: 'unsorted assumptions',
    change: (d) => (column(d, 1)['assumed'] = ['unit', 'type']),
    message: /assumed must be unique and sorted/,
  },
  {
    label: 'an unknown assumption',
    change: (d) => (column(d, 1)['assumed'] = ['crs']),
    message: /assumed\[0\] must be one of/,
  },
  {
    label: 'an empty assumption list',
    change: (d) => (column(d, 1)['assumed'] = []),
    message: /assumed must be an array of at least 1/,
  },
  { label: 'a key that is not a rule ID', change: (d) => (d['issues'] = { 'DQ-1': 1 }), message: /keyed by a rule ID/ },
  { label: 'a zero count', change: (d) => (d['issues'] = { 'TW-DQ-001': 0 }), message: /at least 1/ },
  {
    label: 'unsorted notes',
    change: (d) => (d['notes'] = ['TW-IMP-004', 'TW-IMP-001']),
    message: /notes must be unique and sorted/,
  },
  { label: 'an unknown note code', change: (d) => (d['notes'] = ['TW-IMP-005']), message: /notes\[0\] must be one of/ },
  { label: 'a fractional locator', change: (d) => (d['locators'] = { rows: [1.5] }), message: /locators\.rows\[0\]/ },
  { label: 'an upper-case digest', change: (d) => (d['workingDigest'] = 'A'.repeat(64)), message: /workingDigest/ },
];

describe('parseExpectation', () => {
  it('accepts a well-formed document and returns it unchanged', () => {
    const doc = valid();
    expect(parseExpectation(doc, NAME)).toBe(doc);
  });

  it('accepts the optional locators and working digest', () => {
    const doc = withChange((d) => {
      d['locators'] = { rows: [2, 3], notes: { 'TW-IMP-001': [3] } };
      d['workingDigest'] = 'a'.repeat(64);
    });
    expect(() => parseExpectation(doc, NAME)).not.toThrow();
  });

  it('refuses a document that is not an object', () => {
    expect(() => parseExpectation([], NAME)).toThrow(/the document must be an object/);
  });

  it.each(REFUSALS)('refuses $label', ({ change, message }) => {
    expect(() => parseExpectation(withChange(change), NAME)).toThrow(message);
  });
});

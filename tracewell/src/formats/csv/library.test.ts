/**
 * Golden check against the committed messy-file library: for each CSV/TSV fixture, the format
 * detections this adapter makes and the rows it reads equal the fixture's expectation file.
 * Skipped until the fixtures module has delivered the library.
 */
import { describe, expect, it } from 'vitest';
import { bytesSource } from '@tw/io';
import { readAll } from './__fixtures__/harness';
import { LIBRARY_CSV_NAMES, libraryBytes, libraryExpectation, MESSY_READY } from './__fixtures__/library';
import { csvImporter } from './reader';

/** Expectation files may name a delimiter by its character or by its name. */
const DELIMITER_NAMES: Readonly<Record<string, string>> = { comma: ',', semicolon: ';', tab: '\t', pipe: '|' };

/** The detections this adapter makes; others in the file (such as a CRS) belong to later stages. */
const CSV_KEYS = ['encoding', 'delimiter', 'decimalSeparator', 'skipLines', 'headerRows'] as const;

function normalised(key: string, value: unknown): unknown {
  return key === 'delimiter' && typeof value === 'string' ? (DELIMITER_NAMES[value] ?? value) : value;
}

describe.skipIf(!MESSY_READY)('the messy-file library', () => {
  it.each(LIBRARY_CSV_NAMES)('%s: detections and row count match its expectation', async (name) => {
    const expected = libraryExpectation(name);
    expect(expected, `${name} has no expectation file`).not.toBeNull();
    const src = bytesSource(libraryBytes(name), name);
    const sniff = await csvImporter.sniff(src);
    for (const key of CSV_KEYS) {
      const value = expected?.detections?.[key];
      if (value === undefined) continue;
      expect(sniff.detections[key]?.value, `${name}: ${key}`).toEqual(normalised(key, value));
    }
    if (expected?.rowCount !== undefined) {
      const read = await readAll(src, sniff.options);
      expect(
        read.batches.reduce((n, b) => n + b.rows.length, 0),
        `${name}: rows`,
      ).toBe(expected.rowCount);
    }
  });
});

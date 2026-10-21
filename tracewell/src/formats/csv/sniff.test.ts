import { describe, expect, it } from 'vitest';
import { bytesSource } from '@tw/io';
import { EngineError, PREVIEW_MAX_BYTES } from '@tw/model';
import { generatedCsv } from './__fixtures__/harness';
import { SAMPLE_NAMES, SAMPLES, sampleText, type DetectionKey } from './__fixtures__/samples';
import { csvImporter } from './reader';
import { sniffCsvText } from './sniff';

const UTF8 = { encoding: 'utf-8', bomLength: 0, fileName: 'sample.csv' } as const;

function sniffSample(name: (typeof SAMPLE_NAMES)[number]) {
  return csvImporter.sniff(bytesSource(SAMPLES[name].bytes, name));
}

describe('csvImporter.sniff on the named fixtures', () => {
  it('csv_semicolon_decimalcomma_cp1252.csv gives ";", decimal "," and windows-1252 assumed', async () => {
    const r = await sniffSample('csv_semicolon_decimalcomma_cp1252.csv');
    expect(r.options).toMatchObject({
      format: 'csv',
      csv: { delimiter: ';', decimalSeparator: ',', encoding: 'windows-1252' },
    });
    expect(r.detections['encoding']).toMatchObject({ value: 'windows-1252', assumed: true, source: 'default' });
    expect(r.notes[0]).toMatchObject({ code: 'TW-IMP-004' });
    expect(r.notes[0]?.message).toContain('windows-1252');
  });

  it('csv_title_rows_units_in_header.csv gives skipLines 3 and a two-row header', async () => {
    const r = await sniffSample('csv_title_rows_units_in_header.csv');
    expect(r.options).toMatchObject({ csv: { skipLines: 3, headerRows: 2 } });
    expect(r.detections['skipLines']).toMatchObject({ method: 'title-block' });
    expect(r.detections['headerRows']).toMatchObject({ method: 'units-row' });
    expect(r.sampleRows[0]).toEqual({ srcLoc: 6, fields: ['NB-01', '2026-03-01', '1250', '3400', '1850.5'] });
    expect(r.notes).toEqual([expect.objectContaining({ code: 'TW-IMP-003', srcLoc: 4 })]);
  });

  it('tsv_utf16le_bom.tsv gives tab, utf-16le and the tsv format', async () => {
    const r = await sniffSample('tsv_utf16le_bom.tsv');
    expect(r.format).toBe('tsv');
    expect(r.options).toMatchObject({ format: 'tsv', csv: { delimiter: '\t', encoding: 'utf-16le', bomLength: 2 } });
  });

  it('csv_pipe_delimited.csv gives "|" although every data line also has commas', async () => {
    const r = await sniffSample('csv_pipe_delimited.csv');
    expect(r.options).toMatchObject({ csv: { delimiter: '|', thousandsSeparator: ',' } });
    expect(r.sampleRows[0]?.fields).toEqual(['W-101', 'North Sea', 'Block 7, Area B', '1,250.5', '3,400.0']);
  });

  it('csv_utf8_bom_crlf.csv gives "," and utf-8 with bomLength 3', async () => {
    const r = await sniffSample('csv_utf8_bom_crlf.csv');
    expect(r.options).toMatchObject({ csv: { delimiter: ',', encoding: 'utf-8', bomLength: 3 } });
    expect(r.header[0]?.[0]).toBe('well');
  });

  describe.each(SAMPLE_NAMES)('%s', (name) => {
    const expected = SAMPLES[name].expected;

    it('matches every detection value and confidence in its expectation', async () => {
      const r = await sniffSample(name);
      const found = Object.fromEntries(
        Object.entries(r.detections).map(([k, d]) => [k, { value: d.value, confidence: d.confidence }]),
      );
      expect(found).toEqual(expected.detections);
    });

    it('marks exactly the detections that are not high or are defaults as assumed', async () => {
      const r = await sniffSample(name);
      for (const d of Object.values(r.detections)) {
        expect(d.assumed).toBe(d.confidence !== 'high' || d.source === 'default');
        expect(d.evidence.length).toBeGreaterThan(20);
      }
    });

    it('gives the expected format, header, options and notes', async () => {
      const r = await sniffSample(name);
      expect(r.format).toBe(expected.format);
      expect(r.header).toEqual(expected.header);
      expect(r.notes.map((n) => n.code)).toEqual(expected.sniffNotes);
      const d = (key: DetectionKey) => expected.detections[key].value;
      expect(r.options).toEqual({
        format: expected.format,
        csv: {
          encoding: d('encoding'),
          bomLength: expected.bomLength,
          delimiter: d('delimiter'),
          quote: '"',
          skipLines: d('skipLines'),
          headerRows: d('headerRows'),
          decimalSeparator: d('decimalSeparator'),
          thousandsSeparator: d('thousandsSeparator'),
        },
      });
    });

    it('samples every data row of the small file, each at the header width', async () => {
      const r = await sniffSample(name);
      expect(r.sampleRows).toHaveLength(expected.rowCount);
      const width = expected.header[0]?.length;
      for (const row of r.sampleRows) expect(row.fields).toHaveLength(width ?? 0);
    });
  });
});

describe('sniffCsvText', () => {
  it('reports ragged sample rows with their lines', () => {
    const r = sniffCsvText(sampleText('csv_quoted_newlines_ragged.csv'), UTF8);
    expect(r.notes.map((n) => n.srcLoc)).toEqual([5, 9]);
    expect(r.sampleRows.map((row) => row.srcLoc)).toEqual([2, 4, 5, 6, 9, 10, 11, 13, 14, 15, 16, 18]);
    expect(r.sampleRows[2]?.fields).toEqual(['W-003', 'short, row', '980', null]);
  });

  it('does not include the encoding, which the caller decided', () => {
    const r = sniffCsvText('a,b\n1,2\n', UTF8);
    expect(r.detections['encoding']).toBeUndefined();
    expect(r.options).toMatchObject({ csv: { encoding: 'utf-8', bomLength: 0 } });
  });

  it('prefers the tab for a .tsv file that no delimiter splits', () => {
    const r = sniffCsvText('only\none\ncolumn\n', { ...UTF8, fileName: 'list.tsv' });
    expect(r.detections['delimiter']).toMatchObject({ value: '\t', confidence: 'low', source: 'default' });
    expect(r.format).toBe('tsv');
    expect(r.sampleRows.map((row) => row.fields)).toEqual([['one'], ['column']]);
  });

  it('reads an empty text as an empty table with assumed defaults', () => {
    const r = sniffCsvText('', UTF8);
    expect(r.header).toEqual([]);
    expect(r.sampleRows).toEqual([]);
    expect(r.detections['delimiter']).toMatchObject({ value: ',', assumed: true });
    expect(r.detections['headerRows']).toMatchObject({ value: 1, assumed: true });
  });

  it('warns when fields look single-quoted', () => {
    const r = sniffCsvText("name,comment\n'A-1','ok'\n'A-2','shut in'\n", UTF8);
    expect(r.detections['quote']).toMatchObject({ value: '"', confidence: 'medium', method: 'single-quotes-seen' });
  });

  it('keeps blank lines out of the rows of a multi-column table', () => {
    const r = sniffCsvText('a,b\n1,2\n\n3,4\n', UTF8);
    expect(r.sampleRows).toEqual([
      { srcLoc: 2, fields: ['1', '2'] },
      { srcLoc: 4, fields: ['3', '4'] },
    ]);
  });

  it('lowers the decimal confidence of a semicolon file without fractions', () => {
    const r = sniffCsvText('well;rate\nA;12\nB;13\n', UTF8);
    expect(r.detections['decimalSeparator']).toMatchObject({ value: '.', confidence: 'medium', assumed: true });
  });

  it('reads 1.234 in a semicolon file as a decimal comma file with grouped thousands assumed', () => {
    const r = sniffCsvText('well;volume\nA;1.234\nB;2.500\n', UTF8);
    expect(r.detections['decimalSeparator']).toMatchObject({ value: ',', confidence: 'medium' });
    expect(r.detections['thousandsSeparator']).toMatchObject({ value: '.', confidence: 'medium' });
  });

  describe('with overrides from the import settings', () => {
    const text = sampleText('csv_semicolon_decimalcomma_cp1252.csv');
    const cp1252 = { encoding: 'windows-1252', bomLength: 0, fileName: 'x.csv' } as const;

    it('a delimiter override changes the column count and is marked as set by the user', () => {
      const detected = sniffCsvText(text, cp1252);
      const forced = sniffCsvText(text, { ...cp1252, overrides: { delimiter: ',' } });
      expect(detected.header[0]).toHaveLength(6);
      expect(forced.header[0]).toHaveLength(4);
      expect(forced.detections['delimiter']).toMatchObject({
        value: ',',
        source: 'user',
        assumed: false,
        method: 'user-override',
      });
      expect(forced.options).toMatchObject({ csv: { delimiter: ',' } });
    });

    it('skipLines and headerRows overrides shape the table as given', () => {
      const r = sniffCsvText(sampleText('csv_title_rows_units_in_header.csv'), {
        ...UTF8,
        overrides: { skipLines: 3, headerRows: 1 },
      });
      expect(r.header).toEqual([['Well', 'Date', 'Oil rate', 'Gas rate', 'Tubing pressure']]);
      expect(r.sampleRows[0]).toEqual({ srcLoc: 5, fields: ['', '', 'bbl/d', 'Mscf/d', 'psia'] });
      expect(r.notes).toEqual([]);
    });

    it('headerRows 0 takes the table width from the first line and keeps it as data', () => {
      const r = sniffCsvText('1,2,3\n4,5,6\n', { ...UTF8, overrides: { headerRows: 0 } });
      expect(r.header).toEqual([]);
      expect(r.sampleRows.map((row) => row.fields)).toEqual([
        ['1', '2', '3'],
        ['4', '5', '6'],
      ]);
    });

    it('a thousands override that clashes with the detected decimal turns the decimal round', () => {
      const r = sniffCsvText('a,b\n"1,5",2\n"2,25",3\n"3,5",4\n', { ...UTF8, overrides: { thousandsSeparator: ',' } });
      expect(r.options).toMatchObject({ csv: { decimalSeparator: '.', thousandsSeparator: ',' } });
      expect(r.detections['decimalSeparator']).toMatchObject({ method: 'implied-by-settings', confidence: 'high' });
    });

    it('refuses invalid values as a defect in the caller', () => {
      const bad = [
        { delimiter: ':' as ',' },
        { skipLines: -1 },
        { headerRows: 1.5 },
        { decimalSeparator: ';' as '.' },
        { thousandsSeparator: '_' as '' },
        { decimalSeparator: '.' as const, thousandsSeparator: '.' as const },
      ];
      for (const overrides of bad) {
        expect(() => sniffCsvText('a,b\n', { ...UTF8, overrides })).toThrow(
          expect.objectContaining({ code: 'INVALID_INPUT' }) as EngineError,
        );
      }
    });
  });
});

describe('csvImporter.sniff on a file larger than the preview limit', () => {
  const big = generatedCsv(120_000);

  it('reads at most PREVIEW_MAX_BYTES and samples at most 1,000 rows', async () => {
    expect(big.byteLength).toBeGreaterThan(PREVIEW_MAX_BYTES);
    let sliced = 0;
    const src = bytesSource(big, 'big.csv');
    const counting = {
      ...src,
      slice: (start: number, end: number) => ((sliced += end - start), src.slice(start, end)),
    };
    const r = await csvImporter.sniff(counting);
    expect(sliced).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(r.sampleRows).toHaveLength(1000);
    expect(r.sampleRows[999]).toEqual({ srcLoc: 1001, fields: ['1000', 'row 1000', '250.00'] });
  });

  it('leaves out a record cut off inside an open quote at the end of the sample', () => {
    const text = 'id,comment\n1,"complete"\n2,"cut off\ninside the quote';
    const r = sniffCsvText(text, { ...UTF8, truncated: true });
    expect(r.sampleRows).toEqual([{ srcLoc: 2, fields: ['1', 'complete'] }]);
  });

  it('leaves out a last line cut off without a line break', () => {
    const r = sniffCsvText('id,v\n1,2\n3,4', { ...UTF8, truncated: true });
    expect(r.sampleRows).toEqual([{ srcLoc: 2, fields: ['1', '2'] }]);
  });
});

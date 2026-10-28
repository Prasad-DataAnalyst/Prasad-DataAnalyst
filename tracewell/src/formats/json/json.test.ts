import { describe, expect, it } from 'vitest';
import { bytesSource } from '@tw/io';
import type { ByteSource, FormatOptions, RawRow } from '@tw/model';
import { fixtureExpectation, fixtureSource } from '@tw/fixtures';
import { detectLayout, jsonImporter } from './index';

const enc = (t: string) => new TextEncoder().encode(t);

/** A source whose stream delivers the bytes in chunks of exactly `size` bytes. */
function chunkedSource(bytes: Uint8Array, size: number, name = 'chunked.json'): ByteSource {
  const base = bytesSource(bytes, name);
  return {
    name,
    size: bytes.byteLength,
    slice: (start, end) => base.slice(start, end),
    stream: () => {
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(at, at + size));
          at += size;
        },
      });
    },
  };
}

async function readAll(src: ByteSource, options: FormatOptions): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
  for await (const batch of jsonImporter.read(src, options, ctx)) rows.push(...batch.rows);
  return rows;
}

describe('detectLayout', () => {
  it('tells an array, JSON Lines and an object holding records apart', () => {
    expect(detectLayout('  [{"a":1}]', true).options).toEqual({ layout: 'array', member: '', nested: 'json-text' });
    expect(detectLayout('{"a":1}\r\n{"a":2}\r\n', true).options.layout).toBe('lines');
    expect(detectLayout('{\n  "count": 2,\n  "rows": [\n    {"a": 1}\n  ]\n}', true).options).toEqual({
      layout: 'member',
      member: 'rows',
      nested: 'json-text',
    });
  });

  it('skips members that hold no objects when looking for the records', () => {
    const text = '{"ids": [1, 2], "meta": {"page": 1}, "items": [{"a": 1}]}';
    expect(detectLayout(text, true).options).toMatchObject({ layout: 'member', member: 'items' });
  });

  it('reads one object on one line with no records in it as a single row', () => {
    expect(detectLayout('{"a":1,"b":"x"}', true)).toMatchObject({ options: { layout: 'lines' }, confidence: 'medium' });
  });

  it('refuses JSON that holds no records, saying what it found', () => {
    expect(() => detectLayout('"just text"', true)).toThrow(/does not start with a JSON array or object/);
    expect(() => detectLayout('{\n "a": 1,\n "b": [1, 2]\n}', true)).toThrow(/no array of objects/);
    expect(() => detectLayout('', true)).toThrow(/empty/);
  });
});

describe('jsonImporter', () => {
  it('reads the wrapped API fixture: rows from "data", keys in first-seen order, nested values as JSON text', async () => {
    const sniff = await jsonImporter.sniff(fixtureSource('json_api_wrapper_nested.json'));
    expect(sniff.options).toEqual({ format: 'json', json: { layout: 'member', member: 'data', nested: 'json-text' } });
    expect(sniff.header).toEqual([
      ['well_id', 'test_date', 'Oil rate (bbl/d)', 'Water cut (%)', 'choke', 'flowing', 'comment'],
    ]);
    expect(sniff.detections['nestedKeys']?.value).toEqual(['choke']);
    const rows = sniff.sampleRows;
    expect(rows.map((r) => r.srcLoc)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows[0]?.fields).toEqual(['NS-B01', '2026-03-02', 1250.5, 12.5, '{"size":32,"unit":"64ths"}', true]);
    expect(rows[2]?.fields).toEqual(['NS-B03', '2026-03-03', 0, null, null, false]);
    // NS-B04 lacks the water cut key: the field is null, not shifted.
    expect(rows[3]?.fields).toEqual(['NS-B04', '2026-03-03', 1105.75, null, '{"size":30,"unit":"64ths"}', true]);
    expect(rows[4]?.fields.at(-1)).toBe('after workover');
  });

  it('reads JSON Lines by line number, skipping blank lines and CRLF endings', async () => {
    const src = fixtureSource('jsonl_well_tests_crlf.jsonl');
    const sniff = await jsonImporter.sniff(src);
    expect(sniff.options).toMatchObject({ json: { layout: 'lines' } });
    const rows = await readAll(src, sniff.options);
    expect(rows.map((r) => r.srcLoc)).toEqual(fixtureExpectation('jsonl_well_tests_crlf.jsonl').locators?.rows);
    expect(rows[3]?.fields).toEqual(['WT-04', '2026-02-02T18:00:00Z', -999.25, 838]);
    expect(rows[5]?.fields.at(-1)).toBe('choke changed to 40/64');
  });

  it('streams the same rows whatever the chunk size', async () => {
    const records = Array.from({ length: 2500 }, (_, i) => ({ id: i, name: `ü-${i}`, v: i / 4, tags: [i % 3] }));
    const bytes = enc(JSON.stringify({ total: records.length, records }));
    const options: FormatOptions = { format: 'json', json: { layout: 'member', member: 'records', nested: 'json-text' } };
    const whole = await readAll(bytesSource(bytes, 'r.json'), options);
    expect(whole).toHaveLength(2500);
    expect(whole[2499]).toEqual({ srcLoc: 2499, fields: [2499, 'ü-2499', 624.75, '[0]'] });
    for (const size of [1, 7, 4096]) {
      expect(await readAll(chunkedSource(bytes, size), options)).toEqual(whole);
    }
  });

  it('names the record and line that is not an object, or not JSON', async () => {
    const array: FormatOptions = { format: 'json', json: { layout: 'array', member: '', nested: 'json-text' } };
    await expect(readAll(bytesSource(enc('[{"a":1}, 5]'), 'a.json'), array)).rejects.toThrow(
      /Record 1 is a number, not an object/,
    );
    const lines: FormatOptions = { format: 'json', json: { layout: 'lines', member: '', nested: 'json-text' } };
    await expect(readAll(bytesSource(enc('{"a":1}\n{"a":\n'), 'a.jsonl'), lines)).rejects.toMatchObject({
      code: 'PARSE_FAILED',
      message: expect.stringContaining('line 2'),
    });
    await expect(readAll(bytesSource(enc('[{"a":1}'), 'cut.json'), array)).rejects.toMatchObject({
      code: 'PARSE_FAILED',
    });
  });

  it('keeps numbers beyond the double range visible as text', async () => {
    const array: FormatOptions = { format: 'json', json: { layout: 'array', member: '', nested: 'json-text' } };
    const rows = await readAll(bytesSource(enc('[{"x":1e400,"y":-2}]'), 'big.json'), array);
    expect(rows[0]?.fields).toEqual(['Infinity', -2]);
  });
});

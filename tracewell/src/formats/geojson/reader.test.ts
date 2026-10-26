import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  utf8,
  type ByteSource,
  type CrsRef,
  type JsonValue,
  type RawRow,
  type SniffResult,
} from '@tw/model';
import { bytesSource } from '@tw/io';
import { fixtureBytes, fixtureExpectation, fixtureSource, type FixtureName } from '@tw/fixtures';
import { detectLegacyCrs, geojsonImporter } from './index';

const OPTIONS = { format: 'geojson', geojson: { nested: 'json-text' } } as const;

/** A source whose stream delivers the bytes in chunks of exactly `size` bytes. */
function chunkedSource(bytes: Uint8Array, size: number, name = 'chunked.geojson'): ByteSource {
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

interface ReadOutcome {
  rows: RawRow[];
  batches: number;
  bytes: number;
}

async function readAll(src: ByteSource, signal: AbortSignal = new AbortController().signal): Promise<ReadOutcome> {
  const out: ReadOutcome = { rows: [], batches: 0, bytes: 0 };
  const ctx = {
    signal,
    onBytes: (n: number) => {
      out.bytes += n;
    },
    note: () => undefined,
  };
  for await (const batch of geojsonImporter.read(src, OPTIONS, ctx)) {
    out.batches++;
    out.rows.push(...batch.rows);
  }
  return out;
}

function text(json: JsonValue): ByteSource {
  return bytesSource(utf8(JSON.stringify(json)), 'test.geojson');
}

function crsOf(result: SniffResult): { value: CrsRef; confidence: string; assumed: boolean } {
  const d = result.detections['crs'];
  if (d === undefined) throw new Error('no crs detection');
  return { value: d.value as unknown as CrsRef, confidence: d.confidence, assumed: d.assumed };
}

/** Expected property columns: every column but the geometry one, matched by name and header unit. */
function expectColumns(header: readonly string[], name: FixtureName): void {
  const expected = fixtureExpectation(name).columns.filter((c) => c.type !== 'geometry');
  expect(header).toHaveLength(expected.length);
  expected.forEach((c, i) => {
    const h = header[i] ?? '';
    expect(h.startsWith(c.name)).toBe(true);
    if (c.unit !== null) expect(h).toContain(`(${c.unit})`);
  });
}

describe('geojson fixtures', () => {
  it('geojson_wells_points_wgs84.geojson: rows, property columns and the CRS84 default', async () => {
    const name = 'geojson_wells_points_wgs84.geojson';
    const sniff = await geojsonImporter.sniff(fixtureSource(name));
    expect(sniff.format).toBe('geojson');
    expect(sniff.options).toEqual(OPTIONS);
    expectColumns(sniff.header[0] ?? [], name);
    expect(sniff.detections['encoding']?.value).toBe('utf-8');
    expect(crsOf(sniff)).toEqual({
      value: { code: 'OGC:CRS84', source: 'rfc7946-default' },
      confidence: 'high',
      assumed: false,
    });
    expect(sniff.detections['geometryTypes']?.value).toEqual(['Point']);
    expect(sniff.detections['nestedProperties']).toBeUndefined();
    expect(Object.values(sniff.detections).some((d) => d.assumed)).toBe(false);

    const { rows, bytes } = await readAll(fixtureSource(name));
    expect(rows).toHaveLength(fixtureExpectation(name).rowCount);
    expect(rows.map((r) => r.srcLoc)).toEqual([...rows.keys()]);
    expect(bytes).toBe(fixtureBytes(name).byteLength);
    expect(rows[0]?.fields).toEqual(['NS-W01', 'Alfa Øst', 'producing', '2014-03-11', 3520.5, 91.2]);
    expect(rows[0]?.geometry).toEqual({ type: 'Point', coordinates: [1.8901, 58.4412] });
  });

  it('geojson_legacy_crs_27700.geojson: the legacy crs member gives EPSG:27700', async () => {
    const name = 'geojson_legacy_crs_27700.geojson';
    const sniff = await geojsonImporter.sniff(fixtureSource(name));
    expect(crsOf(sniff)).toEqual({
      value: { code: 'EPSG:27700', source: 'geojson-crs-member' },
      confidence: 'high',
      assumed: false,
    });
    expectColumns(sniff.header[0] ?? [], name);
    const { rows } = await readAll(fixtureSource(name));
    expect(rows).toHaveLength(fixtureExpectation(name).rowCount);
    expect(rows[0]?.geometry).toEqual({ type: 'Point', coordinates: [391820.5, 79410] });
  });

  it('geojson_mixed_geometry_nested_props.geojson: nested properties become JSON text, assumed', async () => {
    const name = 'geojson_mixed_geometry_nested_props.geojson';
    const sniff = await geojsonImporter.sniff(fixtureSource(name));
    expectColumns(sniff.header[0] ?? [], name);
    const nested = sniff.detections['nestedProperties'];
    expect(nested?.value).toEqual(['operator', 'tags']);
    expect(nested?.assumed).toBe(true);
    expect(sniff.detections['geometryTypes']?.value).toEqual([
      'Point',
      'LineString',
      'Polygon',
      'MultiPoint',
      'MultiLineString',
      'MultiPolygon',
      'GeometryCollection',
    ]);

    const { rows } = await readAll(fixtureSource(name));
    expect(rows).toHaveLength(fixtureExpectation(name).rowCount);
    const header = sniff.header[0] ?? [];
    const col = (key: string): number => header.indexOf(key);
    expect(rows[0]?.fields[col('operator')]).toBe('{"name":"Alder Basin Energy","share":0.6}');
    expect(rows[0]?.fields[col('tags')]).toBe('["subsea","gas"]');
    expect(rows[4]?.fields[col('tags')]).toBe('[]');
    // Mixed value types in one property are kept as they are; detection decides the column type.
    expect(rows[3]?.fields[col('Capacity (MMscf/d)')]).toBe('pending');
    expect(rows[1]?.fields[col('Capacity (MMscf/d)')]).toBe(310);
    expect(rows[3]?.fields[col('active')]).toBe(false);
    // MX-07 has no commissioned date: an absent key reads as null.
    expect(rows[6]?.fields[col('commissioned')]).toBeNull();
    expect(rows.map((r) => (r.geometry as { type: string } | null)?.type)).toContain('GeometryCollection');
  });

  it('geojson_invalid_geometries.geojson: every feature is imported, geometry kept as written', async () => {
    const name = 'geojson_invalid_geometries.geojson';
    const { rows } = await readAll(fixtureSource(name));
    expect(rows).toHaveLength(fixtureExpectation(name).rowCount);
    expect(rows[7]?.geometry).toEqual({ type: 'Point', coordinates: [null, 57.1] });
    expect(rows[9]?.geometry).toEqual({ type: 'MultiPolygon', coordinates: [] });
    expect(rows[10]?.geometry).toBeNull();
    expect(rows[11]?.geometry).toEqual({ type: 'Circle', coordinates: [1.8, 57.5], radius: 500 });
    const sniff = await geojsonImporter.sniff(fixtureSource(name));
    expect(sniff.detections['geometryTypes']?.evidence).toContain('1 features have no geometry');
  });
});

describe('document shapes', () => {
  it('a bare Geometry gives one row without properties', async () => {
    const src = text({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
    const { rows } = await readAll(src);
    expect(rows).toEqual([
      {
        srcLoc: 0,
        fields: [],
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
    ]);
    const sniff = await geojsonImporter.sniff(src);
    expect(sniff.header).toEqual([[]]);
    expect(sniff.sampleRows).toHaveLength(1);
  });

  it('a single Feature gives one row', async () => {
    const src = text({ properties: { id: 'W1', depth: 12 }, geometry: null, type: 'Feature' });
    const { rows } = await readAll(src);
    expect(rows).toEqual([{ srcLoc: 0, fields: ['W1', 12], geometry: null }]);
  });

  it('takes the union of property keys in first-seen order and pads earlier rows only up to their own keys', async () => {
    const src = text({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { a: 1, b: 'x' }, geometry: null },
        { type: 'Feature', properties: { c: true, a: 2 }, geometry: null },
        { type: 'Feature', properties: null, geometry: null },
      ],
    });
    const sniff = await geojsonImporter.sniff(src);
    expect(sniff.header).toEqual([['a', 'b', 'c']]);
    const { rows } = await readAll(src);
    expect(rows.map((r) => r.fields)).toEqual([
      [1, 'x'],
      [2, null, true],
      [null, null, null],
    ]);
  });

  it('an empty FeatureCollection gives no rows', async () => {
    const { rows, batches } = await readAll(text({ type: 'FeatureCollection', features: [] }));
    expect(rows).toEqual([]);
    expect(batches).toBe(0);
  });

  it('refuses JSON that is not a GeoJSON object', async () => {
    await expect(readAll(text([1, 2]))).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    await expect(readAll(text({ type: 'Topology' }))).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    await expect(readAll(text({ features: {} }))).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });

  it('refuses malformed and truncated JSON', async () => {
    const broken = bytesSource(utf8('{"type":"FeatureCollection","features":[{"type":"Feature",}]}'), 'b.geojson');
    await expect(readAll(broken)).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    const truncated = bytesSource(utf8('{"type":"FeatureCollection","features":[{"type":"Feature"'), 't.geojson');
    await expect(readAll(truncated)).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    await expect(geojsonImporter.sniff(truncated)).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readAll(fixtureSource('geojson_wells_points_wgs84.geojson'), controller.signal)).rejects.toMatchObject(
      {
        code: 'CANCELLED',
      },
    );
  });

  it('refuses options for another format', async () => {
    const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
    const opts = {
      format: 'xlsx',
      xlsx: { sheet: 'a', tableIndex: 0, headerRowStart: 0, headerRowEnd: 0, dataStartRow: 1, firstCol: 0, lastCol: 0 },
    } as const;
    const it = geojsonImporter.read(text({ type: 'Point', coordinates: [0, 0] }), opts, ctx)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('streaming', () => {
  it('1-byte chunks give the same rows as 64 KiB chunks', async () => {
    for (const name of ['geojson_mixed_geometry_nested_props.geojson', 'geojson_wells_points_wgs84.geojson'] as const) {
      const bytes = fixtureBytes(name);
      const small = await readAll(chunkedSource(bytes, 1));
      const large = await readAll(chunkedSource(bytes, 65_536));
      expect(small.rows.length).toBeGreaterThan(0);
      expect(canonicalJson(small.rows as unknown as JsonValue)).toBe(canonicalJson(large.rows as unknown as JsonValue));
      expect(small.bytes).toBe(bytes.byteLength);
    }
  });

  it('a multi-byte character split across chunks survives', async () => {
    const bytes = utf8(JSON.stringify({ type: 'Feature', properties: { name: 'Sør 🛢' }, geometry: null }));
    const { rows } = await readAll(chunkedSource(bytes, 1));
    expect(rows[0]?.fields).toEqual(['Sør 🛢']);
  });

  it('batches hold at most BATCH_ROWS rows and keys found late extend the columns', async () => {
    const features = Array.from({ length: 70_000 }, (_, i) => ({
      type: 'Feature',
      properties: i === 69_999 ? { n: i, late: 'yes' } : { n: i },
      geometry: { type: 'Point', coordinates: [i / 1000, 1] },
    }));
    const { rows, batches } = await readAll(text({ type: 'FeatureCollection', features }));
    expect(batches).toBe(2);
    expect(rows).toHaveLength(70_000);
    expect(rows[69_999]?.fields).toEqual([69_999, 'yes']);
    expect(rows[69_999]?.srcLoc).toBe(69_999);
  });

  it('sniff reads at most 1 MiB, samples at most 1,000 rows and marks a partial scan medium', async () => {
    const features = Array.from({ length: 30_000 }, (_, i) => ({
      type: 'Feature',
      properties: { id: `W-${i}`, value: i * 1.5 },
      geometry: { type: 'Point', coordinates: [i / 1000, 1] },
    }));
    const src = text({ type: 'FeatureCollection', features });
    expect(src.size).toBeGreaterThan(1_048_576);
    const sniff = await geojsonImporter.sniff(src);
    expect(sniff.sampleRows).toHaveLength(1000);
    expect(sniff.header).toEqual([['id', 'value']]);
    expect(sniff.detections['propertyKeys']?.confidence).toBe('medium');
    expect(crsOf(sniff).confidence).toBe('high');
  });
});

describe('detectLegacyCrs', () => {
  const head = (crs: unknown): string => JSON.stringify({ type: 'FeatureCollection', crs, features: [] });

  it('reads the common name forms', () => {
    const cases: [string, string][] = [
      ['urn:ogc:def:crs:EPSG::27700', 'EPSG:27700'],
      ['urn:ogc:def:crs:EPSG:6.6:4326', 'EPSG:4326'],
      ['EPSG:3857', 'EPSG:3857'],
      ['urn:ogc:def:crs:OGC:1.3:CRS84', 'OGC:CRS84'],
      ['http://www.opengis.net/def/crs/EPSG/0/32631', 'EPSG:32631'],
      ['http://www.opengis.net/def/crs/OGC/1.3/CRS84', 'OGC:CRS84'],
    ];
    for (const [name, code] of cases) {
      const d = detectLegacyCrs(head({ type: 'name', properties: { name } }));
      expect(d?.value).toEqual({ code, source: 'geojson-crs-member' });
      expect(d?.confidence).toBe('high');
    }
  });

  it('reads the 2008 EPSG form', () => {
    expect(detectLegacyCrs(head({ type: 'EPSG', properties: { code: 2193 } }))?.value.code).toBe('EPSG:2193');
  });

  it('reports unrecognised, linked and null CRS members as unknown with low confidence', () => {
    for (const crs of [
      null,
      { type: 'link', properties: { href: 'x.prj' } },
      { type: 'name', properties: { name: 'local grid' } },
    ]) {
      const d = detectLegacyCrs(head(crs));
      expect(d?.value.code).toBe('unknown');
      expect(d?.confidence).toBe('low');
      expect(d?.assumed).toBe(true);
    }
  });

  it('returns null without a top-level crs member, ignoring nested ones and truncated heads', () => {
    expect(detectLegacyCrs(JSON.stringify({ type: 'FeatureCollection', features: [] }))).toBeNull();
    expect(detectLegacyCrs('{"type":"Feature","properties":{"crs":"EPSG:27700"}')).toBeNull();
    const truncated = head({ type: 'name', properties: { name: 'EPSG:27700' } }).slice(0, -5);
    expect(detectLegacyCrs(truncated)?.value.code).toBe('EPSG:27700');
  });
});

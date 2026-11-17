import { describe, expect, it } from 'vitest';
import { readZip } from '@tw/io';
import type { CellValue } from '@tw/model';
import { CTX, COLS, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { buildExport, profileStatuses } from './index';
import { fieldNames, geometryOfRecord, ringArea, shapeRecord, SHAPE } from './shapefile';
import { readDbf, readShp, readShx } from './shapefile-reader';
import { DEFAULT_WRITERS } from './writers';

const WGS84 = { code: 'OGC:CRS84', source: 'rfc7946-default' } as const;
const GEO_COLS = [
  { name: 'well_id', type: 'string' as const, role: 'id' as const },
  { name: 'geometry', type: 'geometry' as const, role: 'geometry' as const },
];

async function exported(rows: CellValue[][], crs: { code: string; source: string } = WGS84) {
  const view = viewOf(datasetOf(GEO_COLS, rows, crs as never, 'c1'));
  const result = await buildExport(inputOf(view, { profile: 'shapefile' }), CTX);
  const zip = readZip(result.bytes ?? new Uint8Array());
  return { result, zip, view };
}

const square = (x: number, y: number, size: number, clockwise: boolean) => {
  const ring = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
  return clockwise ? [...ring].reverse() : ring;
};

describe('Shapefile export', () => {
  it('writes points from latitude and longitude, with .prj, .cpg and the field list, and passes read-back', async () => {
    const view = viewOf(datasetOf());
    const result = await buildExport(inputOf(view, { profile: 'shapefile' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.validation.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['RB-SHP-STRUCTURE', 'RB-SHP-GEOMETRY', 'RB-VALUES', 'RB-HEADER', 'RB-ROWS']),
    );
    const zip = readZip(result.bytes ?? new Uint8Array());
    expect(result.manifest.files.filter((f) => f.role === 'data').map((f) => f.path)).toEqual([
      'data.shp',
      'data.shx',
      'data.dbf',
      'data.prj',
      'data.cpg',
      'data.fields.csv',
    ]);
    expect(zip.readText('data.prj')).toMatch(/^GEOGCS\["GCS_WGS_1984"/);
    expect(zip.readText('data.cpg')).toBe('UTF-8');
    expect(zip.readText('data.fields.csv').split('\r\n')).toEqual([
      'field,name,unit,type',
      'well_id,well_id,,string',
      'date,date,,date',
      'reading_ti,reading time,,datetime',
      'Pressure,Pressure,psia,number',
      'Choke,Choke,,integer',
      'lat,lat,,number',
      'lon,lon,,number',
      'Online,Online,,boolean',
      'Note,Note,,string',
      '',
    ]);
    const shp = readShp(zip.read('data.shp'));
    expect(shp.shapeType).toBe(SHAPE.point);
    expect(shp.records.map((r) => r.record?.parts[0]?.[0] ?? null)).toEqual([
      [1.7501, 57.4802],
      [1.8, 57.51],
      null,
      [151.2, -33.9],
    ]);
    expect(readShx(zip.read('data.shx')).entries).toHaveLength(4);
    const dbf = readDbf(zip.read('data.dbf'));
    expect(dbf.fields.map((f) => [f.name, f.type, f.width, f.decimals])).toEqual([
      ['well_id', 'C', 6, 0],
      ['date', 'D', 8, 0],
      ['reading_ti', 'C', 24, 0],
      ['Pressure', 'N', 24, 15],
      ['Choke', 'N', 18, 0],
      ['lat', 'N', 24, 15],
      ['lon', 'N', 24, 15],
      ['Online', 'L', 1, 0],
      ['Note', 'C', 24, 0],
    ]);
    expect(dbf.rows[1]).toEqual([
      'NS-A02',
      '20260101',
      '2026-01-01T06:15:30.250Z',
      '0.30000000000000004',
      '28',
      '57.51',
      '1.8',
      'F',
      null,
    ]);
    expect(dbf.rows[3]?.[8]).toBe('émission ° Förderrate');
  });

  it('writes polygons with outer rings clockwise and holes anticlockwise, and multipolygons as one record', async () => {
    const rows: CellValue[][] = [
      ['P', { geometry: { type: 'Polygon', coordinates: [square(0, 0, 10, false), square(2, 2, 2, true)] } }],
      [
        'M',
        {
          geometry: {
            type: 'MultiPolygon',
            coordinates: [[square(20, 0, 5, false)], [square(30, 0, 5, true)]],
          },
        },
      ],
      ['N', null],
    ];
    const { result, zip } = await exported(rows);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const shp = readShp(zip.read('data.shp'));
    expect(shp.shapeType).toBe(SHAPE.polygon);
    const [p, m, n] = shp.records;
    expect(p?.record?.parts.map(ringArea).map(Math.sign)).toEqual([-1, 1]);
    expect(m?.record?.parts.map(ringArea).map(Math.sign)).toEqual([-1, -1]);
    expect(n?.shapeType).toBe(SHAPE.null);
    expect(geometryOfRecord(m?.record ?? null, SHAPE.polygon)?.type).toBe('MultiPolygon');
    expect(shp.box).toEqual([0, 0, 35, 10]);
  });

  it('keeps heights in a Z Shapefile and writes points and multipoints as multipoints', async () => {
    const rows: CellValue[][] = [
      ['A', { geometry: { type: 'Point', coordinates: [1, 2, 30] } }],
      [
        'B',
        {
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [3, 4, -5],
              [5, 6, 7],
            ],
          },
        },
      ],
    ];
    const { result, zip } = await exported(rows);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const shp = readShp(zip.read('data.shp'));
    expect(shp.shapeType).toBe(SHAPE.multipointZ);
    expect(shp.zRange).toEqual([-5, 30]);
    expect(shp.records[0]?.record?.parts).toEqual([[[1, 2, 30]]]);
  });

  it('writes British National Grid coordinates as they are, with the British National Grid .prj', async () => {
    const cols = [
      { name: 'well', type: 'string' as const, role: 'id' as const },
      { name: 'Easting', type: 'number' as const, role: 'easting' as const },
      { name: 'Northing', type: 'number' as const, role: 'northing' as const },
    ];
    const rows: CellValue[][] = [
      ['W1', 651409.903, 313177.27],
      ['W2', null, 250000],
    ];
    const view = viewOf(datasetOf(cols, rows, { code: 'EPSG:27700', source: 'user' }));
    const result = await buildExport(inputOf(view, { profile: 'shapefile' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    const zip = readZip(result.bytes ?? new Uint8Array());
    expect(zip.readText('data.prj')).toMatch(/^PROJCS\["British_National_Grid"/);
    expect(readShp(zip.read('data.shp')).records.map((r) => r.record?.parts[0]?.[0] ?? null)).toEqual([
      [651409.903, 313177.27],
      null,
    ]);
  });

  it('moves text a .dbf field cannot hold exactly to a CSV beside it, and says so', async () => {
    const cols = [...GEO_COLS, { name: 'Remarks', type: 'string' as const, role: 'text' as const }];
    const point: CellValue = { geometry: { type: 'Point', coordinates: [1, 2] } };
    const rows: CellValue[][] = [
      ['A', point, 'x'.repeat(255)],
      ['B', point, ' padded'],
    ];
    const view = viewOf(datasetOf(cols, rows, WGS84, 'c1'));
    const result = await buildExport(inputOf(view, { profile: 'shapefile' }), CTX);
    expect(result.validation.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.manifest.substitutions).toEqual([
      expect.objectContaining({ ruleId: 'TW-EXP-002', what: 'the column Remarks' }),
    ]);
    const zip = readZip(result.bytes ?? new Uint8Array());
    expect(zip.readText('data-long-text.csv')).toContain(' padded');
    expect(readDbf(zip.read('data.dbf')).fields.map((f) => f.name)).toEqual(['well_id']);
  });

  it('refuses what one Shapefile cannot hold, with the reason and a fix', () => {
    const point: CellValue = { geometry: { type: 'Point', coordinates: [1, 2] } };
    const line: CellValue = {
      geometry: {
        type: 'LineString',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
    };
    const status = (rows: CellValue[][], crs: { code: string; source: string } = WGS84) => {
      const view = viewOf(datasetOf(GEO_COLS, rows, crs as never, 'c1'));
      return profileStatuses(view, view.schema.crs).find((s) => s.profile.id === 'shapefile');
    };
    expect(
      status([
        ['A', point],
        ['B', line],
      ]),
    ).toMatchObject({
      available: false,
      reason: 'A Shapefile holds one kind of geometry, and this dataset has lines and points.',
    });
    expect(
      status([
        ['A', point],
        ['B', { geometry: { type: 'Point', coordinates: [1, 2, 3] } }],
      ])?.reason,
    ).toContain('all with heights or all without');
    expect(status([['A', point]], { code: 'EPSG:3857', source: 'user' })?.reason).toContain(
      'EPSG:3857 is not one this edition can describe',
    );
    expect(status([['A', point]], { code: 'unknown', source: 'user' })?.fix).toBe(
      'Set the coordinate reference system of the dataset first.',
    );
    const plain = viewOf(datasetOf(COLS.slice(0, 5), [[null, null, null, null, null]]));
    expect(profileStatuses(plain, plain.schema.crs).find((s) => s.profile.id === 'shapefile')?.available).toBe(false);
  });

  it('names fields in 10 characters, uniquely whatever the case', () => {
    expect(
      fieldNames(['Pressure [kPa]', 'pressure', 'PRESSURE', '1st reading', 'Température', 'Pressure annulus']),
    ).toEqual(['Pressure__', 'pressure', 'PRESSURE_1', 'F1st_readi', 'Temp_ratur', 'Pressure_a']);
  });

  it('turns a record back into the geometry a reader makes of it', () => {
    const line = shapeRecord(
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
      SHAPE.polyline,
      false,
    );
    expect(geometryOfRecord(line, SHAPE.polyline)).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(shapeRecord({ type: 'MultiPoint', coordinates: [] }, SHAPE.multipoint, false)).toBeNull();
  });

  it('fails read-back when a shape is changed after writing', async () => {
    const view = viewOf(
      datasetOf(GEO_COLS, [['A', { geometry: { type: 'Point', coordinates: [1, 2] } }]], WGS84, 'c1'),
    );
    const writers = {
      ...DEFAULT_WRITERS,
      shapefile: (input: Parameters<typeof DEFAULT_WRITERS.shapefile>[0]) => {
        const out = DEFAULT_WRITERS.shapefile(input);
        new DataView(out.shp.buffer, out.shp.byteOffset).setFloat64(112, 1.5, true);
        return out;
      },
    };
    const result = await buildExport(inputOf(view, { profile: 'shapefile' }), CTX, writers);
    expect(result.ok).toBe(false);
    expect(result.validation.checks.filter((c) => !c.ok).map((c) => c.id)).toContain('RB-SHP-GEOMETRY');
  });
});

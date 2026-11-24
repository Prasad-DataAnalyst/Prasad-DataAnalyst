import { describe, expect, it } from 'vitest';
import type { Geometry } from '@tw/model';
import { KmlFormatError, readKml, writeKml } from './index';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('KML', () => {
  it('writes a Document of placemarks with extended data, and reads it back exactly', () => {
    const polygon: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
        [
          [0.2, 0.2],
          [0.4, 0.2],
          [0.4, 0.4],
          [0.2, 0.2],
        ],
      ],
    };
    const bytes = writeKml('Wells & <lines>', [
      {
        name: 'W1',
        data: [
          ['Pressure [kPa]', '1205.3'],
          ['Note', 'line one\r\nline "two" & <three>'],
        ],
        geometry: { type: 'Point', coordinates: [1.75, 57.48, -1200] },
      },
      {
        name: null,
        data: [
          ['Pressure [kPa]', null],
          ['Note', '  padded  '],
        ],
        geometry: polygon,
      },
      {
        name: 'empty',
        data: [
          ['Pressure [kPa]', null],
          ['Note', null],
        ],
        geometry: null,
      },
    ]);
    expect(text(bytes)).toContain('<name>Wells &amp; &lt;lines&gt;</name>');
    expect(text(bytes)).toContain('line one&#13;\nline "two" &amp; &lt;three&gt;');
    const doc = readKml(bytes);
    expect([doc.root, doc.namespace, doc.documents, doc.name]).toEqual([
      'kml',
      'http://www.opengis.net/kml/2.2',
      1,
      'Wells & <lines>',
    ]);
    expect(doc.placemarks.map((p) => [p.name, p.data, p.geometry])).toEqual([
      [
        'W1',
        [
          ['Pressure [kPa]', '1205.3'],
          ['Note', 'line one\r\nline "two" & <three>'],
        ],
        { type: 'Point', coordinates: [1.75, 57.48, -1200] },
      ],
      [
        null,
        [
          ['Pressure [kPa]', ''],
          ['Note', '  padded  '],
        ],
        polygon,
      ],
      [
        'empty',
        [
          ['Pressure [kPa]', ''],
          ['Note', ''],
        ],
        null,
      ],
    ]);
  });

  it('writes multi-part geometries and collections as MultiGeometry, read back by their members', () => {
    const read = (g: Geometry) =>
      readKml(writeKml('x', [{ name: null, data: [], geometry: g }])).placemarks[0]?.geometry;
    const multi: Geometry = {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    };
    expect(read(multi)).toEqual(multi);
    expect(read({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }] })).toEqual({
      type: 'MultiPoint',
      coordinates: [[1, 2]],
    });
    const mixed: Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 2] },
        {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    };
    expect(read(mixed)).toEqual(mixed);
    expect(read({ type: 'MultiPoint', coordinates: [] })).toEqual({ type: 'GeometryCollection', geometries: [] });
  });

  it('escapes attribute values so parsers give them back unchanged', () => {
    const doc = readKml(writeKml('x', [{ name: null, data: [['a\tb\nc "d"', 'v']], geometry: null }]));
    expect(doc.placemarks[0]?.data).toEqual([['a\tb\nc "d"', 'v']]);
  });

  it('refuses what is not KML text or declares a document type', () => {
    expect(() => readKml(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(KmlFormatError);
    expect(() => readKml(new TextEncoder().encode('<!DOCTYPE kml SYSTEM "x"><kml/>'))).toThrow(/document type/);
    expect(() =>
      readKml(
        new TextEncoder().encode('<kml><Placemark><Point><coordinates>a,b</coordinates></Point></Placemark></kml>'),
      ),
    ).toThrow(/not numbers/);
  });
});

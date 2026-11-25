import { describe, expect, it } from 'vitest';
import { writeZip } from '@tw/io';
import type { ByteSource, RawRow } from '@tw/model';
import { kmlImporter } from './index';

function source(bytes: Uint8Array, name = 'wells.kml', chunk = 11): ByteSource {
  return {
    name,
    size: bytes.byteLength,
    slice: (start, end) => Promise.resolve(bytes.slice(start, end)),
    stream: () => {
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.length) controller.close();
          else {
            controller.enqueue(bytes.slice(at, at + chunk));
            at += chunk;
          }
        },
      });
    },
  };
}

async function readAll(src: ByteSource, entry: string | null = null): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  const ctx = { signal: new AbortController().signal, onBytes: () => undefined, note: () => undefined };
  for await (const batch of kmlImporter.read(src, { format: 'kml', kml: { entry } }, ctx)) rows.push(...batch.rows);
  return rows;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

const EARTH = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>Assets</name>
  <Style id="s"><IconStyle><scale>1.1</scale></IconStyle></Style>
  <Folder>
    <name>Wells</name>
    <Folder>
      <name>North &amp; East</name>
      <Placemark>
        <name>W-01</name>
        <description><![CDATA[<b>Producer</b>, 2 slots]]></description>
        <ExtendedData>
          <Data name="Depth (m)"><displayName>Depth</displayName><value>1250.5</value></Data>
          <Data name="status"><value>active</value></Data>
        </ExtendedData>
        <Point><altitudeMode>absolute</altitudeMode><coordinates>1.75,57.48,12</coordinates></Point>
      </Placemark>
    </Folder>
    <Placemark>
      <name>W-02</name>
      <TimeStamp><when>2020-07-15</when></TimeStamp>
      <ExtendedData><SchemaData schemaUrl="#w"><SimpleData name="status">shut in</SimpleData></SchemaData></ExtendedData>
      <Point><coordinates> 1.8,57.51 </coordinates></Point>
    </Placemark>
  </Folder>
  <Placemark>
    <name>Pipeline</name>
    <TimeSpan><begin>2018-11-30</begin><end>2030-01-01</end></TimeSpan>
    <LineString><tessellate>1</tessellate><coordinates>
      1.75,57.48,0 1.8,57.51,0
      2,58,0
    </coordinates></LineString>
  </Placemark>
  <Placemark>
    <name>Block</name>
    <Polygon>
      <innerBoundaryIs><LinearRing><coordinates>1,1 2,1 2,2 1,1</coordinates></LinearRing></innerBoundaryIs>
      <outerBoundaryIs><LinearRing><coordinates>0,0 9,0 9,9 0,0</coordinates></LinearRing></outerBoundaryIs>
    </Polygon>
  </Placemark>
  <Placemark><name>Pads</name><MultiGeometry><Point><coordinates>1,2</coordinates></Point><Point><coordinates>3,4</coordinates></Point></MultiGeometry></Placemark>
  <Placemark><name>Site</name><MultiGeometry><Point><coordinates>1,2</coordinates></Point><LineString><coordinates>1,2 3,4</coordinates></LineString></MultiGeometry></Placemark>
  <Placemark><name>Fence</name><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></Placemark>
  <Placemark><name>Odd</name><Point><coordinates>abc,-0,1e999</coordinates></Point></Placemark>
  <Placemark><name>Track</name><gx:Track><gx:coord>1 2 3</gx:coord></gx:Track></Placemark>
  <Placemark><name></name></Placemark>
</Document>
</kml>
`;

describe('kmlImporter', () => {
  it('reads every placemark as a row of its fields in first-seen order, with its geometry', async () => {
    const rows = await readAll(source(utf8(EARTH)));
    expect(rows.map((r) => r.fields)).toEqual([
      ['Wells / North & East', 'W-01', '<b>Producer</b>, 2 slots', '1250.5', 'active'],
      ['Wells', 'W-02', null, null, 'shut in', '2020-07-15'],
      [null, 'Pipeline', null, null, null, null, '2018-11-30', '2030-01-01'],
      [null, 'Block', null, null, null, null, null, null],
      [null, 'Pads', null, null, null, null, null, null],
      [null, 'Site', null, null, null, null, null, null],
      [null, 'Fence', null, null, null, null, null, null],
      [null, 'Odd', null, null, null, null, null, null],
      [null, 'Track', null, null, null, null, null, null],
      [null, '', null, null, null, null, null, null],
    ]);
    expect(rows.map((r) => r.srcLoc)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows.map((r) => r.geometry)).toEqual([
      { type: 'Point', coordinates: [1.75, 57.48, 12] },
      { type: 'Point', coordinates: [1.8, 57.51] },
      {
        type: 'LineString',
        coordinates: [
          [1.75, 57.48, 0],
          [1.8, 57.51, 0],
          [2, 58, 0],
        ],
      },
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [9, 0],
            [9, 9],
            [0, 0],
          ],
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
      {
        type: 'MultiPoint',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
      {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [1, 2] },
          {
            type: 'LineString',
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
      },
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      },
      { type: 'Point', coordinates: [null, 0, null] },
      null,
      null,
    ]);
  });

  it('sniffs the field names, the WGS 84 CRS of the specification and the geometry types', async () => {
    const sniff = await kmlImporter.sniff(source(utf8(EARTH)));
    expect(sniff.format).toBe('kml');
    expect(sniff.options).toEqual({ format: 'kml', kml: { entry: null } });
    expect(sniff.header).toEqual([
      ['folder', 'name', 'description', 'Depth (m)', 'status', 'timestamp', 'begin', 'end'],
    ]);
    expect(sniff.detections['crs']).toMatchObject({
      value: { code: 'OGC:CRS84', source: 'kml-specification' },
      confidence: 'high',
    });
    expect(sniff.detections['encoding']).toMatchObject({ value: 'utf-8', method: 'xml-declaration' });
    expect(sniff.detections['geometryTypes']?.value).toEqual([
      'Point',
      'LineString',
      'Polygon',
      'MultiPoint',
      'GeometryCollection',
    ]);
    expect(sniff.sampleRows).toHaveLength(10);
  });

  it('reads the first KML document of a KMZ archive', async () => {
    const kmz = writeZip([
      { path: 'files/icon.png', data: new Uint8Array([137, 80, 78, 71]) },
      { path: 'doc.kml', data: utf8(EARTH) },
      { path: 'other.kml', data: utf8('<kml/>') },
    ]);
    const src = source(kmz, 'assets.kmz');
    const sniff = await kmlImporter.sniff(src);
    expect(sniff.options).toEqual({ format: 'kml', kml: { entry: 'doc.kml' } });
    expect(await readAll(src, 'doc.kml')).toHaveLength(10);
  });

  it('reads ISO-8859-1 as its declaration says, and samples a document longer than a MiB', async () => {
    const latin = new Uint8Array([
      ...utf8('<?xml version="1.0" encoding="ISO-8859-1"?><kml><Placemark><name>Ca'),
      0xf1,
      ...utf8('on</name></Placemark></kml>'),
    ]);
    expect((await readAll(source(latin)))[0]?.fields).toEqual(['Cañon']);
    const many = utf8(
      `<kml><Document>${Array.from({ length: 20_000 }, (_, i) => `<Placemark><name>P-${i}</name><Point><coordinates>${i},1</coordinates></Point></Placemark>`).join('\n')}</Document></kml>`,
    );
    expect(many.length).toBeGreaterThan(1 << 20);
    const sniff = await kmlImporter.sniff(source(many));
    expect(sniff.sampleRows).toHaveLength(1000);
    expect(sniff.detections['geometryTypes']?.confidence).toBe('medium');
    expect(await readAll(source(many, 'many.kml', 65_536))).toHaveLength(20_000);
  });

  it('refuses what is not KML, a document type, damaged XML and encodings it does not read', async () => {
    const fails = (text: string) => readAll(source(utf8(text)));
    await expect(fails('<gpx><wpt/></gpx>')).rejects.toMatchObject({
      code: 'PARSE_FAILED',
      message: 'The KML file does not parse: its root element is gpx, not kml.',
    });
    await expect(fails('<!DOCTYPE kml SYSTEM "x"><kml/>')).rejects.toMatchObject({
      message: 'The KML file does not parse: it declares a document type, which KML never needs.',
    });
    await expect(fails('<kml><Placemark></kml>')).rejects.toMatchObject({
      message: 'The KML file does not parse: it is not well-formed XML.',
    });
    await expect(fails('<?xml version="1.0" encoding="Shift_JIS"?><kml/>')).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
    });
    const empty = writeZip([{ path: 'readme.txt', data: utf8('no KML here') }]);
    await expect(readAll(source(empty, 'x.kmz'))).rejects.toMatchObject({
      message: 'The KML file does not parse: the KMZ archive holds no KML document.',
    });
  });
});

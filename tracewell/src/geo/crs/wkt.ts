/**
 * The ESRI form of Well-Known Text for each CRS of the registry, as a Shapefile's .prj file holds it
 * (FR-EXP-04): the names ESRI gives each system, datum and ellipsoid, the parameters of its
 * projection in degrees and metres, and every number to 15 significant digits, as ESRI writes
 * them. A datum is described without a transformation; this edition uses no grid files. geodesy.rs
 * in the native engine writes the same text from the same registry.
 */
import REGISTRY from './registry.json';

interface RawEllipsoid {
  esri: string;
  a: number;
  invF?: number;
  b?: number;
}

interface RawProjected {
  esri: string;
  base: string;
  method: string;
  lat0?: number;
  lon0?: number;
  k0?: number;
  latF?: number;
  lonF?: number;
  lat1?: number;
  lat2?: number;
  fe: number;
  fn: number;
}

/** A number as ESRI WKT writes it: 15 significant digits, and a whole number with ".0". */
export function wktNumber(x: number): string {
  const text = String(Number(x.toPrecision(15)));
  return /[.e]/.test(text) ? text : `${text}.0`;
}

function geogcs(code: string): string | null {
  const g = (REGISTRY.geographic as Record<string, { esri: string; datum: string }>)[code];
  if (g === undefined) return null;
  const datum = (REGISTRY.datums as Record<string, { esri: string; ellipsoid: string }>)[g.datum];
  const el = datum === undefined ? undefined : (REGISTRY.ellipsoids as Record<string, RawEllipsoid>)[datum.ellipsoid];
  if (datum === undefined || el === undefined) return null;
  const invF = el.invF ?? el.a / (el.a - (el.b as number));
  return (
    `GEOGCS["${g.esri}",DATUM["${datum.esri}",SPHEROID["${el.esri}",${wktNumber(el.a)},${wktNumber(invF)}]],` +
    `PRIMEM["Greenwich",0.0],UNIT["Degree",${wktNumber(Math.PI / 180)}]]`
  );
}

function parameter(name: string, value: number): string {
  return `PARAMETER["${name}",${wktNumber(value)}]`;
}

function projcs(name: string, raw: Omit<RawProjected, 'esri'>): string | null {
  const base = geogcs(raw.base);
  if (base === null) return null;
  const params =
    raw.method === '9807'
      ? [
          parameter('False_Easting', raw.fe),
          parameter('False_Northing', raw.fn),
          parameter('Central_Meridian', raw.lon0 as number),
          parameter('Scale_Factor', raw.k0 as number),
          parameter('Latitude_Of_Origin', raw.lat0 as number),
        ]
      : [
          parameter('False_Easting', raw.fe),
          parameter('False_Northing', raw.fn),
          parameter('Central_Meridian', raw.lonF as number),
          parameter('Standard_Parallel_1', raw.lat1 as number),
          parameter('Standard_Parallel_2', raw.lat2 as number),
          parameter('Latitude_Of_Origin', raw.latF as number),
        ];
  const projection = raw.method === '9807' ? 'Transverse_Mercator' : 'Lambert_Conformal_Conic';
  return `PROJCS["${name}",${base},PROJECTION["${projection}"],${params.join(',')},UNIT["Meter",1.0]]`;
}

/** The ESRI WKT of a CRS the registry holds, or null. OGC:CRS84 is described as WGS 84. */
export function esriWkt(code: string): string | null {
  if (code === 'OGC:CRS84') return geogcs('4326');
  const m = /^EPSG:(\d{4,5})$/.exec(code);
  if (m === null) return null;
  const n = m[1] as string;
  const projected = (REGISTRY.projected as Record<string, RawProjected>)[n];
  if (projected !== undefined) return projcs(projected.esri, projected);
  const geographic = geogcs(n);
  if (geographic !== null) return geographic;
  const number = Number(n);
  for (const u of REGISTRY.utm) {
    const zone = number - u.first + u.firstZone;
    if (zone < u.firstZone || zone > u.lastZone) continue;
    return projcs(u.esri.replace('{zone}', String(zone)), {
      base: u.base,
      method: '9807',
      lat0: 0,
      lon0: zone * 6 - 183,
      k0: 0.9996,
      fe: 500000,
      fn: u.south ? 10000000 : 0,
    });
  }
  return null;
}

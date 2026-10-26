/**
 * CRS detection for GeoJSON (SAD section 7.6). RFC 7946 removed the `crs` member and fixed the CRS
 * to OGC:CRS84, but files written to the 2008 specification (and by many GIS tools since) still
 * carry one. It is recorded, never applied: slice 1 does not transform coordinates.
 */
import { detection, type CrsRef, type Detection } from '@tw/model';
import { JSONParser } from '@streamparser/json';
import { isRecord } from './json';

type CrsCode = CrsRef['code'];

/** Largest code accepted as an EPSG code; anything longer is not an EPSG identifier. */
const MAX_EPSG_CODE = 999_999;

/** Named CRS forms that are lon/lat on a WGS84-compatible datum, and the OGC names for NAD datums. */
const OGC_NAMES: Readonly<Record<string, CrsCode>> = {
  CRS84: 'OGC:CRS84',
  CRS83: 'EPSG:4269',
  CRS27: 'EPSG:4267',
};

/**
 * The CRS name forms seen in the wild: the OGC URN (with or without a version), the OGC HTTP URI,
 * and the short 'EPSG:n' form. Each pattern captures the authority and the code.
 */
const NAME_PATTERNS: readonly RegExp[] = [
  /^urn:ogc:def:crs:(EPSG|OGC):[^:]*:([A-Za-z0-9]+)$/i,
  /^https?:\/\/www\.opengis\.net\/def\/crs\/(EPSG|OGC)\/[^/]+\/([A-Za-z0-9]+)$/i,
  /^(EPSG|OGC):{1,2}([A-Za-z0-9]+)$/i,
];

function epsgCode(text: string): CrsCode | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= MAX_EPSG_CODE ? `EPSG:${n}` : null;
}

function codeFor(authority: string, code: string): CrsCode | null {
  if (authority.toUpperCase() === 'EPSG') return epsgCode(code);
  return OGC_NAMES[code.toUpperCase()] ?? null;
}

/** The CRS code a 2008-style CRS name stands for, or null when the name is not recognised. */
export function crsCodeFromName(name: string): CrsCode | null {
  const trimmed = name.trim();
  const bare = OGC_NAMES[trimmed.toUpperCase()];
  if (bare !== undefined) return bare;
  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined) return codeFor(match[1], match[2]);
  }
  return null;
}

function member(crs: unknown, key: string): unknown {
  return isRecord(crs) && isRecord(crs['properties']) ? crs['properties'][key] : undefined;
}

function found(code: CrsCode, evidence: string): Detection<CrsRef> {
  return detection<CrsRef>({ code, source: 'geojson-crs-member' }, 'high', 'geojson-crs-member', evidence);
}

function unknownCrs(evidence: string): Detection<CrsRef> {
  return detection<CrsRef>({ code: 'unknown', source: 'geojson-crs-member' }, 'low', 'geojson-crs-member', evidence);
}

function fromNamed(name: unknown): Detection<CrsRef> {
  if (typeof name !== 'string') return unknownCrs('The legacy "crs" member is of type "name" but gives no name.');
  const code = crsCodeFromName(name);
  if (code === null) return unknownCrs(`The legacy "crs" member names "${name}", which is not a recognised CRS name.`);
  return found(code, `The legacy "crs" member names "${name}" (${code}).`);
}

function fromEpsg(code: unknown): Detection<CrsRef> {
  const parsed = typeof code === 'number' || typeof code === 'string' ? epsgCode(String(code)) : null;
  if (parsed === null) return unknownCrs('The legacy "crs" member is of type "EPSG" but its code is not valid.');
  return found(parsed, `The legacy "crs" member gives EPSG code ${String(code)} (${parsed}).`);
}

/**
 * The detection for the value of a top-level `crs` member. A null member means "no CRS can be
 * assumed" in the 2008 specification, so it is reported as unknown rather than as the default.
 */
export function crsDetectionOf(crs: unknown): Detection<CrsRef> {
  if (crs === null) return unknownCrs('The legacy "crs" member is null, which declares that no CRS can be assumed.');
  const type = isRecord(crs) ? crs['type'] : undefined;
  if (type === 'name') return fromNamed(member(crs, 'name'));
  if (type === 'EPSG') return fromEpsg(member(crs, 'code'));
  if (type === 'link')
    return unknownCrs('The legacy "crs" member links to an external CRS definition, which is not read.');
  return unknownCrs('The legacy "crs" member has a form that is not recognised.');
}

/** The RFC 7946 default, which applies whenever there is no `crs` member. */
export function defaultCrsDetection(evidence: string): Detection<CrsRef> {
  return detection<CrsRef>({ code: 'OGC:CRS84', source: 'rfc7946-default' }, 'high', 'rfc7946-default', evidence);
}

/**
 * Finds a legacy top-level `crs` member in the first part of a GeoJSON text. The head may stop in
 * the middle of the document; a syntax error stops the search with what was found before it.
 * Returns null when the head holds no top-level `crs` member.
 */
export function detectLegacyCrs(head: string): Detection<CrsRef> | null {
  let crs: { value: unknown } | null = null;
  const parser = new JSONParser({ paths: ['$.crs'], keepStack: false });
  parser.onValue = ({ value }) => {
    crs ??= { value };
  };
  try {
    parser.write(head);
  } catch {
    // A broken or truncated document: the member, if it came before the damage, was already seen.
  }
  return crs === null ? null : crsDetectionOf((crs as { value: unknown }).value);
}

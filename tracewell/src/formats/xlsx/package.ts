/**
 * The Open Packaging Conventions layer of an XLSX file: part lookup and relationships. Part names
 * are case-insensitive in OPC but ZIP names are not, so lookups fall back to a case-insensitive
 * match; relationship targets are resolved relative to the part that owns them.
 */
import type { ZipReader } from '@tw/io';
import { damagedWorkbook } from './errors';
import { attr, parseXml } from './xml';

export interface Relationship {
  type: string;
  /** Package path without a leading slash, e.g. 'xl/worksheets/sheet1.xml'; external targets are left as written. */
  target: string;
  external: boolean;
}

export class Package {
  readonly #zip: ZipReader;
  readonly #byLowerCase: Map<string, string>;

  constructor(zip: ZipReader) {
    this.#zip = zip;
    this.#byLowerCase = new Map(zip.paths().map((p) => [p.toLowerCase(), p]));
  }

  /** The ZIP entry name of a part, or null when the package does not have it. */
  find(part: string): string | null {
    if (this.#zip.has(part)) return part;
    return this.#byLowerCase.get(part.toLowerCase()) ?? null;
  }

  read(part: string): Uint8Array {
    const entry = this.find(part);
    if (entry === null) throw damagedWorkbook(`the part ${part} is missing.`, { part });
    return this.#zip.read(entry);
  }

  /** The relationships of a part by ID; an empty map when the part has none. */
  relationships(part: string): Map<string, Relationship> {
    const relsPart = relsPartOf(part);
    const rels = new Map<string, Relationship>();
    if (this.find(relsPart) === null) return rels;
    parseXml(this.read(relsPart), relsPart, {
      open(name, attrs) {
        if (name !== 'Relationship') return;
        const id = attr(attrs, 'Id');
        const target = attr(attrs, 'Target');
        if (id === undefined || target === undefined) return;
        const external = attr(attrs, 'TargetMode') === 'External';
        rels.set(id, {
          type: attr(attrs, 'Type') ?? '',
          target: external ? target : resolveTarget(part, target),
          external,
        });
      },
    });
    return rels;
  }
}

/** 'xl/workbook.xml' -> 'xl/_rels/workbook.xml.rels'; '' (the package itself) -> '_rels/.rels'. */
function relsPartOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** Resolves a relationship target against its source part, following '.' and '..' segments. */
export function resolveTarget(sourcePart: string, target: string): string {
  const absolute = target.startsWith('/');
  const base = absolute ? [] : sourcePart.split('/').slice(0, -1);
  const segments = [...base, ...target.split('/')];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(decodeSegment(segment));
  }
  return out.join('/');
}

/** Targets are URIs, so a space may be written as %20; a malformed escape is kept as written. */
function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Matches transitional and strict relationship types by their last segment, e.g. 'worksheet'. */
export function isRelType(rel: Relationship, kind: string): boolean {
  return rel.type.endsWith(`/${kind}`);
}

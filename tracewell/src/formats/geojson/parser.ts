/**
 * Streaming GeoJSON document parser over decoded text. It accepts a FeatureCollection (whose
 * `features` array is streamed element by element), a single Feature, or a bare Geometry, which
 * becomes one feature without properties.
 *
 * Only `$.features.*` and a few top-level members are emitted by the JSON parser. Nothing at the
 * root is emitted as a whole, so each feature is dropped from the parser's tree once it is handed
 * over and memory stays bounded by the largest single feature.
 */
import { EngineError } from '@tw/model';
import { JSONParser } from '@streamparser/json';
import { brokenJson, formatCount, notGeoJson } from './errors';
import { GEOMETRY_TYPES, isRecord } from './json';

/** One element of the features array (or the single Feature or Geometry), by its 0-based index. */
export interface ParsedFeature {
  index: number;
  geometry: unknown;
  properties: unknown;
}

/** Top-level members kept for a single Feature, a bare Geometry and the CRS detection. */
const ROOT_MEMBERS = ['type', 'crs', 'properties', 'geometry', 'coordinates', 'geometries', 'bbox'] as const;

const WHITESPACE = /\s/;

interface EmittedValue {
  value?: unknown;
  key?: string | number | undefined;
  parent?: unknown;
  stack: readonly unknown[];
}

export class GeoJsonTextParser {
  private readonly parser: JSONParser;
  private readonly root = new Map<string, unknown>();
  private featureCount = 0;
  private sawRoot = false;
  private finished = false;

  constructor(private readonly onFeature: (f: ParsedFeature) => void) {
    this.parser = new JSONParser({ paths: ['$.features.*', ...ROOT_MEMBERS.map((m) => `$.${m}`)], keepStack: false });
    this.parser.onValue = (info) => {
      this.handle(info);
    };
  }

  /** Features handed over so far. */
  get features(): number {
    return this.featureCount;
  }

  /** True once the features array has started, i.e. at least one element was handed over. */
  get inFeatures(): boolean {
    return this.featureCount > 0;
  }

  /** Whether a top-level `crs` member was seen, and its value. */
  get crs(): { present: boolean; value: unknown } {
    return { present: this.root.has('crs'), value: this.root.get('crs') };
  }

  /** Feeds the next piece of text. Throws PARSE_FAILED on malformed JSON, FORMAT_UNSUPPORTED on a non-object root. */
  write(text: string): void {
    if (!this.sawRoot) this.checkRootStart(text);
    try {
      this.parser.write(text);
    } catch (e) {
      throw this.parseError(e);
    }
  }

  /**
   * Ends the document: checks it was complete and hands over the single Feature or Geometry.
   * Throws when the text was not a GeoJSON object this parser reads.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.sawRoot) throw notGeoJson('The file is empty: it holds no GeoJSON object.');
    if (!this.parser.isEnded) {
      try {
        this.parser.end();
      } catch (e) {
        throw this.parseError(e);
      }
    }
    this.emitRootFeature();
  }

  private checkRootStart(text: string): void {
    for (const ch of text) {
      if (WHITESPACE.test(ch)) continue;
      if (ch !== '{') {
        throw notGeoJson('The file is JSON but not a GeoJSON object: its top level is not an object.', {
          firstChar: ch,
        });
      }
      this.sawRoot = true;
      return;
    }
  }

  private parseError(e: unknown): Error {
    // Errors raised by this class from inside the JSON parser's callback pass through unchanged.
    if (e instanceof EngineError) return e;
    const reason = e instanceof Error ? e.message : String(e);
    return brokenJson(`${reason} (after ${formatCount(this.featureCount)} features).`, {
      featuresRead: this.featureCount,
    });
  }

  private handle(info: EmittedValue): void {
    if (info.stack.length === 1 && typeof info.key === 'string') {
      this.root.set(info.key, info.value);
      return;
    }
    if (!Array.isArray(info.parent)) {
      throw notGeoJson('The "features" member is not an array.');
    }
    // A top-level "features" array is a foreign member when the type says Feature or Geometry.
    const type = this.root.get('type');
    if (type !== undefined && type !== 'FeatureCollection') return;
    this.emitFeature(info.value);
  }

  private emitFeature(value: unknown): void {
    const feature = isRecord(value) ? value : {};
    this.onFeature({ index: this.featureCount, geometry: feature['geometry'], properties: feature['properties'] });
    this.featureCount++;
  }

  private emitRootFeature(): void {
    const type = this.root.get('type');
    if (type === 'FeatureCollection') return;
    if (type === 'Feature' || (typeof type === 'string' && GEOMETRY_TYPES.has(type))) {
      if (this.featureCount > 0) {
        throw notGeoJson(`The top-level object is a ${type} but also holds a "features" array before its type.`);
      }
      const single = type === 'Feature' ? this.featureMembers() : { geometry: this.geometryMembers(type) };
      this.emitFeature(single);
      return;
    }
    const detail = typeof type === 'string' ? { type } : undefined;
    throw notGeoJson(
      typeof type === 'string'
        ? `The top-level object has type "${type}", which is not a GeoJSON object type.`
        : 'The top-level object has no "type" member, so it is not a GeoJSON object.',
      detail,
    );
  }

  private featureMembers(): Record<string, unknown> {
    return { geometry: this.root.get('geometry'), properties: this.root.get('properties') };
  }

  /** The bare geometry with its members in the RFC 7946 order: type, then coordinates or geometries, then bbox. */
  private geometryMembers(type: string): Record<string, unknown> {
    const geometry: Record<string, unknown> = { type };
    for (const key of ['coordinates', 'geometries', 'bbox'] as const) {
      if (this.root.has(key)) geometry[key] = this.root.get(key);
    }
    return geometry;
  }
}

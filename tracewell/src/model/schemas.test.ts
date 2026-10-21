import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AuditEntry } from './audit';
import { canonicalJson, utf8 } from './canonical';
import { AUDIT_GENESIS_PREFIX } from './constants';
import type { JsonValue } from './ids';
import type { ProjectManifest } from './project';
import { schemas } from './schemas';

type SchemaName = keyof typeof schemas;

/** Fixture stem of each schema: src/model/__fixtures__/valid-<stem>.json and invalid-<stem>.json. */
const FIXTURE_STEMS: Record<SchemaName, string> = {
  auditEntry: 'audit-entry',
  rulePack: 'rule-pack',
  stepInput: 'step-input',
  decision: 'decision',
  projectManifest: 'project-manifest',
  exportManifest: 'export-manifest',
  unitRegistry: 'unit-registry',
};

type PatchOp = { op: 'add' | 'replace'; path: string; value: JsonValue } | { op: 'remove'; path: string };

/** An invalid sample: a whole document, or a valid sample changed by RFC 6902 operations. */
type InvalidSample = { why: string; doc: JsonValue } | { why: string; base: number; patch: PatchOp[] };

const FIXTURES = new URL('./__fixtures__/', import.meta.url);

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}

function validSamples(name: SchemaName): JsonValue[] {
  return readFixture<JsonValue[]>(`valid-${FIXTURE_STEMS[name]}.json`);
}

function invalidSamples(name: SchemaName): InvalidSample[] {
  return readFixture<InvalidSample[]>(`invalid-${FIXTURE_STEMS[name]}.json`);
}

function pointerTokens(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`Not a JSON pointer: ${path}`);
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

type Container = JsonValue[] | { [k: string]: JsonValue };

function child(node: JsonValue, token: string): Container {
  const next = Array.isArray(node) ? node[Number(token)] : (node as Record<string, JsonValue>)[token];
  if (next === null || typeof next !== 'object') throw new Error(`Pointer token ${token} does not reach a container`);
  return next;
}

function applyOp(doc: JsonValue, op: PatchOp): void {
  const tokens = pointerTokens(op.path);
  const last = tokens.pop() as string;
  const parent = tokens.reduce<Container>((node, token) => child(node, token), doc as Container);
  if (Array.isArray(parent)) {
    const index = last === '-' ? parent.length : Number(last);
    if (op.op === 'remove') parent.splice(index, 1);
    else parent.splice(index, op.op === 'replace' ? 1 : 0, op.value);
    return;
  }
  if (op.op !== 'add' && !(last in parent)) throw new Error(`${op.op} of a missing member ${op.path}`);
  if (op.op === 'remove') delete parent[last];
  else parent[last] = op.value;
}

function materialise(name: SchemaName, sample: InvalidSample): JsonValue {
  if ('doc' in sample) return sample.doc;
  const base = validSamples(name)[sample.base];
  if (base === undefined) throw new Error(`No valid sample ${sample.base} for ${name}`);
  const doc = structuredClone(base);
  for (const op of sample.patch) applyOp(doc, op);
  return doc;
}

function sha256(text: string): string {
  return createHash('sha256').update(utf8(text)).digest('hex');
}

const SCHEMA_NAMES = Object.keys(FIXTURE_STEMS) as SchemaName[];

describe('schemas', () => {
  it('has fixtures for every schema', () => {
    expect(Object.keys(schemas).sort()).toEqual([...SCHEMA_NAMES].sort());
  });

  it('cannot be modified', () => {
    expect(Object.isFrozen(schemas)).toBe(true);
  });

  describe.each(SCHEMA_NAMES)('%s', (name) => {
    const schema = schemas[name] as { safeParse(v: unknown): { success: boolean; data?: unknown } };

    it.each(validSamples(name).map((doc, i) => [i, doc] as const))('accepts valid sample %i unchanged', (_i, doc) => {
      const result = schema.safeParse(doc);
      expect(result.success).toBe(true);
      // Nothing is stripped, defaulted or transformed: persisted documents must hash the same after parsing.
      expect(result.data).toEqual(doc);
    });

    it.each(invalidSamples(name).map((sample) => [sample.why, sample] as const))('rejects: %s', (_why, sample) => {
      const doc = materialise(name, sample);
      if ('base' in sample) expect(doc).not.toEqual(validSamples(name)[sample.base]);
      expect(schema.safeParse(doc).success).toBe(false);
    });
  });

  it.each<[SchemaName, string]>([
    ['decision', 'missing reason on edit_cell'],
    ['auditEntry', 'bad sha256 length'],
    ['auditEntry', 'unknown action'],
    ['projectManifest', 'bad sha256 length'],
    ['exportManifest', 'bad sha256 length'],
  ])('%s fixtures include the invalid case "%s"', (name, why) => {
    expect(invalidSamples(name).map((s) => s.why)).toContain(why);
  });
});

describe('audit entry fixture', () => {
  const entries = validSamples('auditEntry') as unknown as AuditEntry[];
  const [project] = validSamples('projectManifest') as unknown as ProjectManifest[];

  it('is a real hash chain, so other modules can use it as a conformance vector', () => {
    if (project === undefined) throw new Error('missing project manifest fixture');
    let prev = sha256(AUDIT_GENESIS_PREFIX + project.projectId);
    entries.forEach((entry, i) => {
      const { hash, ...unhashed } = entry;
      expect(entry.seq).toBe(i + 1);
      expect(entry.prev).toBe(prev);
      expect(hash).toBe(sha256(canonicalJson(unhashed as unknown as JsonValue)));
      prev = hash;
    });
    expect(project.auditHead).toEqual({ seq: entries.length, hash: prev });
  });

  it('still validates after a canonical JSON round trip', () => {
    for (const entry of entries) {
      const line = canonicalJson(entry as unknown as JsonValue);
      expect(schemas.auditEntry.safeParse(JSON.parse(line)).success).toBe(true);
    }
  });
});

describe('schema details', () => {
  const [edit] = validSamples('decision');

  it('rejects an explicit undefined where a member is optional', () => {
    expect(schemas.decision.safeParse({ ...(edit as object), issueId: undefined }).success).toBe(false);
  });

  it('accepts a derived column ID and rejects malformed ones', () => {
    const step = (columnId: string) => ({ kind: 'convert_unit', columnId, toUnit: 'kPa', mode: 'replace' });
    expect(schemas.stepInput.safeParse(step('c3~kPa')).success).toBe(true);
    expect(schemas.stepInput.safeParse(step('c12')).success).toBe(true);
    for (const bad of ['c', 'c01', 'C3', 'c3~', 'c3~k Pa', 'd3']) {
      expect(schemas.stepInput.safeParse(step(bad)).success).toBe(false);
    }
  });

  it('accepts leap days and rejects impossible dates', () => {
    const at = (date: string) => ({ ...(edit as object), value: { value: { date } } });
    expect(schemas.decision.safeParse(at('2024-02-29')).success).toBe(true);
    expect(schemas.decision.safeParse(at('2026-02-29')).success).toBe(false);
    expect(schemas.decision.safeParse(at('2026-13-01')).success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const area = (n: number) => ({ kind: 'set_project_area', bbox: [n, 0, 1, 1], reason: 'Licence block' });
    expect(schemas.decision.safeParse(area(0)).success).toBe(true);
    expect(schemas.decision.safeParse(area(Infinity)).success).toBe(false);
    expect(schemas.decision.safeParse(area(NaN)).success).toBe(false);
  });

  it('checks that a bounding box lies on the WGS84 globe, allowing one that crosses the antimeridian', () => {
    const area = (bbox: number[]) => ({ kind: 'set_project_area', bbox, reason: 'Licence block' });
    expect(schemas.decision.safeParse(area([-180, -90, 180, 90])).success).toBe(true);
    expect(schemas.decision.safeParse(area([170, -20, -170, -10])).success).toBe(true);
    expect(schemas.decision.safeParse(area([0, 0, 0, 0])).success).toBe(true);
    for (const bad of [
      [-181, 0, 1, 1],
      [0, 0, 180.5, 1],
      [0, -90.1, 1, 1],
      [0, 0, 1, 91],
      [0, 10, 1, 5],
    ]) {
      expect(schemas.decision.safeParse(area(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    const insideFilter = { kind: 'filter', predicate: { bbox: [0, 10, 1, 5], lat: 'c1', lon: 'c2' } };
    expect(schemas.stepInput.safeParse(insideFilter).success).toBe(false);
  });
});

describe('JSON members', () => {
  const [entry] = validSamples('auditEntry') as unknown as AuditEntry[];
  const withPayload = (payload: unknown): unknown => ({ ...(entry as object), payload });

  it("keep an own '__proto__' key, so a parsed audit line hashes exactly as written", () => {
    const line = JSON.stringify(entry).replace(/}$/, ',"payload":{"__proto__":{"rate":1},"x":[{"__proto__":2}]}}');
    const input = JSON.parse(line) as unknown;
    const result = schemas.auditEntry.safeParse(input);
    expect(result.success).toBe(true);
    const parsed = result.data as unknown as JsonValue;
    expect(canonicalJson(parsed)).toBe(canonicalJson(input as JsonValue));
    expect(Object.keys((result.data?.payload ?? {}) as object)).toEqual(['__proto__', 'x']);
  });

  it("keep an own '__proto__' key in a decision value", () => {
    const decision = JSON.parse(
      '{"kind":"override_detection","datasetId":"d1","property":"crs","value":{"__proto__":{"code":"EPSG:4326"}},' +
        '"reason":"Survey report"}',
    ) as unknown;
    const result = schemas.decision.safeParse(decision);
    expect(result.success).toBe(true);
    expect(canonicalJson(result.data as unknown as JsonValue)).toBe(canonicalJson(decision as JsonValue));
  });

  it.each<[string, unknown]>([
    ['NaN', { a: NaN }],
    ['Infinity', [Infinity]],
    ['an undefined member', { a: undefined }],
    ['an array hole', [1, , 3]], // eslint-disable-line no-sparse-arrays
    ['a Date', { at: new Date(0) }],
    ['a Map', new Map([['a', 1]])],
    ['a typed array', new Uint8Array(2)],
    ['a bigint', 1n],
    [
      'a class instance',
      new (class Point {
        x = 1;
      })(),
    ],
  ])('reject %s, which JSON cannot hold', (_name, payload) => {
    expect(schemas.auditEntry.safeParse(withPayload(payload)).success).toBe(false);
  });

  it('reject a reference cycle, which canonicalJson cannot encode', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(schemas.auditEntry.safeParse(withPayload(cyclic)).success).toBe(false);
  });

  it('accept every JSON document unchanged, so it hashes the same after parsing', () => {
    // Keys that name Object.prototype members are where copying parsers lose data.
    const awkwardKeys = fc.object({
      key: fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty', 'a'),
      maxDepth: 3,
      values: [
        fc.integer(),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.string(),
        fc.boolean(),
        fc.constant(null),
      ],
    });
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), awkwardKeys), (payload) => {
        const input = withPayload(payload);
        const result = schemas.auditEntry.safeParse(input);
        expect(result.success).toBe(true);
        expect(canonicalJson(result.data as unknown as JsonValue)).toBe(canonicalJson(input as JsonValue));
      }),
      { numRuns: 300 },
    );
  });

  it('accept a shared, acyclic sub-object and objects without a prototype', () => {
    const shared = { k: 1 };
    const bare = Object.assign(Object.create(null) as object, { b: 1 });
    expect(schemas.auditEntry.safeParse(withPayload({ a: shared, b: [shared, bare] })).success).toBe(true);
  });
});

describe('nesting depth', () => {
  const [entry] = validSamples('auditEntry') as unknown as AuditEntry[];
  const [edit] = validSamples('decision');
  const arrays = (depth: number): unknown => JSON.parse(`${'['.repeat(depth)}1${']'.repeat(depth)}`);
  const nots = (depth: number): unknown =>
    JSON.parse(`${'{"not":'.repeat(depth)}{"column":"c1","op":"is_null"}${'}'.repeat(depth)}`);
  const collections = (depth: number): unknown =>
    JSON.parse(
      `${'{"type":"GeometryCollection","geometries":['.repeat(depth)}{"type":"Point","coordinates":[1,2]}` +
        ']}'.repeat(depth),
    );

  // JSON.parse builds these without complaint, so a tampered audit line or manifest can carry them.
  const tooDeep: [string, SchemaName, (depth: number) => unknown][] = [
    ['an audit payload', 'auditEntry', (d) => ({ ...(entry as object), payload: arrays(d) })],
    ['a filter predicate', 'stepInput', (d) => ({ kind: 'filter', predicate: nots(d) })],
    [
      'a geometry cell value',
      'decision',
      (d) => ({ ...(edit as object), value: { value: { geometry: collections(d) } } }),
    ],
    [
      'a detection override value',
      'decision',
      (d) => ({ ...(edit as object), kind: 'override_detection', value: arrays(d) }),
    ],
  ];

  it.each(tooDeep)('rejects %s nested 200,000 levels deep without throwing', (_what, name, build) => {
    const doc = build(200_000);
    let success: boolean | undefined;
    expect(() => (success = schemas[name].safeParse(doc).success)).not.toThrow();
    expect(success).toBe(false);
  });

  it('accepts a document nested up to 256 levels and rejects one nested 257 levels', () => {
    // The entry object adds one level around its payload.
    expect(schemas.auditEntry.safeParse({ ...(entry as object), payload: arrays(255) }).success).toBe(true);
    expect(schemas.auditEntry.safeParse({ ...(entry as object), payload: arrays(256) }).success).toBe(false);
  });

  it('accepts what canonicalJson can encode, so every valid entry can be hashed', () => {
    const doc = { ...(entry as object), payload: arrays(255) } as unknown as JsonValue;
    expect(schemas.auditEntry.safeParse(doc).success).toBe(true);
    expect(() => canonicalJson(doc)).not.toThrow();
  });

  it('rejects a cycle reached through shared objects quickly', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { x: a, y: a, z: a };
    Object.assign(a, { x: b, y: b, z: b });
    expect(schemas.auditEntry.safeParse({ ...(entry as object), payload: a }).success).toBe(false);
  });
});

describe('package paths', () => {
  const [project] = validSamples('projectManifest') as unknown as ProjectManifest[];
  const withEntryPath = (path: string): unknown => {
    const doc = structuredClone(project) as ProjectManifest;
    (doc.entries[0] as { path: string }).path = path;
    return doc;
  };

  it('accepts nested relative paths with non-ASCII names', () => {
    expect(schemas.projectManifest.safeParse(withEntryPath('originals/ab/Bohrloch \u00fc 10.csv')).success).toBe(true);
  });

  // The io ZIP writer and CHECKSUMS.sha256 refuse these, so a manifest naming one describes a package
  // that cannot exist.
  it.each([
    ['a Windows drive letter', 'C:/data/x.csv'],
    ['a line feed', 'audit\n.jsonl'],
    ['a carriage return', 'audit\r.jsonl'],
    ['a lone surrogate', 'originals/\ud800.csv'],
    ['a backslash', 'originals\\x.csv'],
    ['a trailing slash', 'originals/'],
  ])('rejects a path with %s', (_why, path) => {
    expect(schemas.projectManifest.safeParse(withEntryPath(path)).success).toBe(false);
  });
});

describe('versions and unit codes', () => {
  const [pack] = validSamples('rulePack');
  const [registry] = validSamples('unitRegistry') as unknown as { version: string; units: { code: string }[] }[];
  const packAt = (version: string): unknown => ({ ...(pack as object), version });

  it.each(['0.1.0', '10.20.30', '1.0.0-beta.1', '1.0.0-rc-2'])('accepts the version %s', (version) => {
    expect(schemas.rulePack.safeParse(packAt(version)).success).toBe(true);
  });

  // 0.1.0 and 00.1.0 would otherwise be two pack versions, and the manifests' uniqueness checks would let both in.
  it.each(['00.1.0', '0.01.0', '1.0.0-', '1.0.0-beta..1', '1.0.0-.'])('rejects the version %s', (version) => {
    expect(schemas.rulePack.safeParse(packAt(version)).success).toBe(false);
  });

  // A derived column is named '<column>~<unit code>', which the column ID pattern must accept.
  it.each(['k Pa', 'kPa~a', ' kPa', 'kPa\t'])('rejects the unit code %j', (code) => {
    const doc = structuredClone(registry) as { units: { code: string }[] };
    (doc.units[2] as { code: string }).code = code;
    expect(schemas.unitRegistry.safeParse(doc).success).toBe(false);
  });
});

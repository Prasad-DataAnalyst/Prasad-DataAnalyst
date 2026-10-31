/**
 * Native engine parity (slice 2, SAD section 4.3 phase B): the Rust + DuckDB engine, spawned as a
 * real process and spoken to over stdio, must agree with the TypeScript reference engine on the
 * audit format and on every value it imports. The suite runs when the engine has been built with
 * `npm run build:native`; without the binary it is skipped and says so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from '@tw/audit';
import { PROTOCOL_VERSION, type EngineClient } from '@tw/engine-api';
import { FIXTURE_NAMES, fixturePath } from '@tw/fixtures';
import { readBack } from '@tw/export';
import { readZip } from '@tw/io';
import {
  canonicalJson,
  type AuditEntry,
  type CheckSummary,
  type ExportResult,
  type DatasetSummary,
  type Issue,
  type IssueOccurrence,
  type ImportPreview,
  type ProjectManifest,
  type ProjectOpenReport,
  type SaveResult,
  type JsonValue,
  type RowWindow,
} from '@tw/model';
import { columnDigest } from '@tw/table';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_FACTORIES, PROFILE, START } from './harness';
import { NATIVE_BINARY, nativeBuilt, startNative, stopNative, type NativeProcess } from './native-process';

async function allRows(engine: EngineClient, datasetId: string): Promise<RowWindow['rows']> {
  const rows: RowWindow['rows'] = [];
  for (let offset = 0; ; offset += 1000) {
    const w = await engine.getRows({ datasetId, stage: 'working', offset, limit: 1000 });
    rows.push(...w.rows);
    if (offset + 1000 >= w.totalRows) return rows;
  }
}

function digests(rows: RowWindow['rows'], columns: number): string[] {
  return Array.from({ length: columns }, (_, j) => columnDigest(rows.map((r) => r.cells[j] ?? null)));
}

/** An audit entry without the parts that depend on when and after what it was written. */
function content(e: AuditEntry): Partial<AuditEntry> {
  const { at: _at, prev: _prev, hash: _hash, ...rest } = e;
  return rest;
}

const CSV_FIXTURES = FIXTURE_NAMES.filter((n) => /\.(csv|tsv)$/.test(n));

describe.skipIf(!nativeBuilt)('native engine parity (tracewell-native over a real pipe)', () => {
  let native: NativeProcess;
  let reference: EngineClient;
  const imported: string[] = [];
  const refused: string[] = [];
  /** The project file the native engine saved, for the tests that open it again. */
  let savedByNative: Uint8Array | null = null;
  /** Dataset IDs per fixture, native and reference. */
  const pairs = new Map<string, { nat: string; ref: string }>();

  beforeAll(async () => {
    native = startNative(['--fixed-clock', START, '--seed', '1', '--threads', '2', '--owner', 'Prasad']);
    reference = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
  });

  afterAll(() => {
    stopNative(native);
    reference.close();
  });

  it('speaks the same protocol major version and spills to disk', async () => {
    const info = await native.client.hello();
    expect(info.name).toBe('tracewell-native');
    expect(info.protocol.split('.')[0]).toBe(PROTOCOL_VERSION.split('.')[0]);
    expect(info.capabilities.spillToDisk).toBe(true);
  });

  it('writes the first audit entry byte for byte as the reference engine does', async () => {
    const a = await native.client.newProject({ name: 'Parity', profile: { ...PROFILE } });
    const b = await reference.newProject({ name: 'Parity', profile: { ...PROFILE } });
    expect(a.id).toBe(b.id);
    expect(a.createdAt).toBe(b.createdAt);
    const [na] = (await native.client.listAudit({})).items;
    const [nb] = (await reference.listAudit({})).items;
    expect(canonicalJson(na as unknown as JsonValue)).toBe(canonicalJson(nb as unknown as JsonValue));
  });

  it.each(CSV_FIXTURES)('%s imports to the same plan, schema and values, or is refused clearly', async (name) => {
    const file = { kind: 'path' as const, path: fixturePath(name) };
    const preview: ImportPreview = await reference.sniff(file);
    const ref = await reference.awaitJob<DatasetSummary>(await reference.importFile(file, { preview }));
    let nat: DatasetSummary;
    try {
      nat = await native.client.awaitJob<DatasetSummary>(await native.client.importFile(file, { preview }));
    } catch (e) {
      refused.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      // A plan the spike cannot execute yet is refused with the reason, never imported differently.
      expect(e).toMatchObject({ code: 'PROTOCOL_MISMATCH', message: expect.stringContaining('does not support') });
      return;
    }
    expect(nat.rowCount).toBe(ref.rowCount);
    expect(await native.client.getSchema(nat.id)).toEqual({
      ...(await reference.getSchema(ref.id)),
      datasetId: nat.id,
    });

    const [natRows, refRows] = [await allRows(native.client, nat.id), await allRows(reference, ref.id)];
    expect(natRows.map((r) => r.rowId)).toEqual(refRows.map((r) => r.rowId));
    expect(digests(natRows, nat.columnCount)).toEqual(digests(refRows, ref.columnCount));
    expect(natRows.map((r) => r.cells)).toEqual(refRows.map((r) => r.cells));
    expect(natRows.map((r) => r.locator)).toEqual(refRows.map((r) => r.locator));
    imported.push(name);
    pairs.set(name, { nat: nat.id, ref: ref.id });

    const natAdd = (await native.client.listAudit({ action: ['source.add'], order: 'desc', limit: 1 }))
      .items[0] as AuditEntry;
    const refAdd = (await reference.listAudit({ action: ['source.add'], order: 'desc', limit: 1 }))
      .items[0] as AuditEntry;
    expect(content(natAdd)).toEqual({
      ...content(refAdd),
      seq: natAdd.seq,
      target: { ...refAdd.target, datasetId: nat.id },
    });
  });

  it.each(CSV_FIXTURES)('%s raises the same issues with the same rows and messages', async (name) => {
    const pair = pairs.get(name);
    expect(pair, 'imported by both engines').toBeDefined();
    const { nat, ref } = pair as { nat: string; ref: string };
    const [natSummary, refSummary] = [
      await native.client.awaitJob<CheckSummary>(await native.client.runChecks(nat)),
      await reference.awaitJob<CheckSummary>(await reference.runChecks(ref)),
    ];
    const { durationMs: _a, datasetId: _b, ...natRest } = natSummary;
    const { durationMs: _c, datasetId: _d, ...refRest } = refSummary;
    expect(natRest).toEqual(refRest);
    const natIssues = (await native.client.listIssues({ datasetId: nat, limit: 1000 })).items;
    const refIssues = (await reference.listIssues({ datasetId: ref, limit: 1000 })).items;
    // Issue IDs hash the dataset ID, which differs between the two projects; the rest must agree.
    const comparable = (i: Issue) => {
      const { id: _id, datasetId: _ds, firstSeenSeq: _f, lastCheckedSeq: _l, ...rest } = i;
      return rest;
    };
    expect(natIssues.map(comparable)).toEqual(refIssues.map(comparable));
    const { datasetId: _h1, ...natHealth } = await native.client.getHealth(nat);
    const { datasetId: _h2, ...refHealth } = await reference.getHealth(ref);
    expect(natHealth).toEqual(refHealth);
    if (process.env['TW_DEBUG'] === '1')
      console.log(name, natIssues.map((i) => `${i.ruleId}:${i.counts.open}`).join(' '));
    for (const [i, issue] of natIssues.entries()) {
      const other = refIssues[i] as Issue;
      const page = { offset: 0, limit: 50 };
      const [a, b] = [
        await native.client.listOccurrences(issue.id, page),
        await reference.listOccurrences(other.id, page),
      ];
      const strip = (o: IssueOccurrence) => ({ ...o, issueId: '' });
      expect({ ...a, items: a.items.map(strip) }, issue.ruleId).toEqual({ ...b, items: b.items.map(strip) });
    }
  });

  it.each(CSV_FIXTURES)('%s exports CSV and Parquet packages that both engines verify', async (name) => {
    const { nat, ref } = pairs.get(name) as { nat: string; ref: string };
    for (const profile of ['csv', 'parquet'] as const) {
      const a = await native.client.awaitJob<ExportResult>(await native.client.exportData({ datasetId: nat, profile }));
      const b = await reference.awaitJob<ExportResult>(await reference.exportData({ datasetId: ref, profile }));
      expect(
        a.validation.checks.filter((c) => !c.ok),
        `${profile}: native checks`,
      ).toEqual([]);
      expect([a.ok, b.ok]).toEqual([true, true]);
      expect(a.manifest.dataset.columns, profile).toEqual(b.manifest.dataset.columns);
      expect(a.manifest.dataset.viewDigest).toBe(b.manifest.dataset.viewDigest);
      expect(a.validation.checks.map((c) => `${c.id} ${c.file ?? ''}`)).toEqual(
        b.validation.checks.map((c) => `${c.id} ${c.file ?? ''}`),
      );
      // The reference engine's readers verify the native package and its data file independently.
      const zip = a.bytes as Uint8Array;
      expect(readBack.package(zip, a.manifest).filter((c) => !c.ok)).toEqual([]);
      const dataFile = `data.${profile}`;
      const data = readZip(zip).read(dataFile);
      const shape = { rowCount: a.manifest.dataset.rowCount, columns: a.manifest.dataset.columns };
      const checks =
        profile === 'csv' ? readBack.csv(data, shape, dataFile) : await readBack.parquet(data, shape, dataFile);
      expect(
        checks.filter((c) => !c.ok),
        `${profile}: reference read-back of the native file`,
      ).toEqual([]);
      // Both engines write the same CSV, byte for byte.
      if (profile === 'csv') expect(data).toEqual(readZip(b.bytes as Uint8Array).read(dataFile));
    }
    // And the same with formulas neutralised.
    const req = { profile: 'csv' as const, neutralizeFormulas: true };
    const a = await native.client.awaitJob<ExportResult>(await native.client.exportData({ datasetId: nat, ...req }));
    const b = await reference.awaitJob<ExportResult>(await reference.exportData({ datasetId: ref, ...req }));
    expect([a.ok, b.ok, a.manifest.options]).toEqual([true, true, { neutralizeFormulas: true }]);
    const csv = (r: ExportResult) => readZip(r.bytes as Uint8Array).read('data.csv');
    expect(csv(a)).toEqual(csv(b));
  });

  it('writes a large package to the file it is given rather than through the pipe', async () => {
    const pair = pairs.get('csv_well_daily_golden.csv') as { nat: string };
    const path = join(native.workdir, 'golden.zip');
    const a = await native.client.awaitJob<ExportResult>(
      await native.client.exportData({ datasetId: pair.nat, profile: 'parquet', target: { kind: 'path', path } }),
    );
    expect(a).toMatchObject({ ok: true, path });
    expect(a.bytes).toBeUndefined();
    expect(readBack.package(new Uint8Array(readFileSync(path)), a.manifest).filter((c) => !c.ok)).toEqual([]);
    const created = (await native.client.listAudit({ action: ['export.create'], order: 'desc', limit: 1 })).items[0];
    expect(created?.payload).toMatchObject({ record: { packageSha256: a.packageSha256, profile: 'parquet' } });
  });

  it('imports every delimited fixture, and would refuse a plan it cannot execute rather than guess', () => {
    // Parity grows by moving names from refused to imported; it never drops silently.
    if (process.env['TW_DEBUG'] === '1') console.log(JSON.stringify({ imported, refused }, null, 1));
    expect(refused).toEqual([]);
    expect(imported).toHaveLength(CSV_FIXTURES.length);
  });

  it('keeps an audit chain the reference engine verifies', async () => {
    const summary = await native.client.getProject();
    const entries = (await native.client.listAudit({ limit: 1000 })).items;
    expect(entries.length).toBeGreaterThan(1);
    const jsonl = entries.map((e) => `${canonicalJson(e as unknown as JsonValue)}\n`).join('');
    const { report } = AuditLog.fromJsonl(summary.id, jsonl);
    expect(report).toEqual({ ok: true, entries: entries.length });
    expect(await native.client.verifyAudit()).toEqual({ ok: true, entries: entries.length });
  });

  it('computes the same column statistics on the golden well file', async () => {
    const file = { kind: 'path' as const, path: fixturePath('csv_well_daily_golden.csv') };
    const preview = await reference.sniff(file);
    const nat = await native.client.awaitJob<DatasetSummary>(await native.client.importFile(file, { preview }));
    const ref = await reference.awaitJob<DatasetSummary>(await reference.importFile(file, { preview }));
    const schema = await reference.getSchema(ref.id);
    for (const c of schema.columns) {
      const [a, b] = [await native.client.getColumnStats(nat.id, c.id), await reference.getColumnStats(ref.id, c.id)];
      const pick = (s: typeof a) => ({
        count: s.count,
        nulls: s.nulls,
        rawRejected: s.rawRejected,
        distinct: s.distinct,
        min: s.min,
        max: s.max,
      });
      expect(pick(a), c.name).toEqual(pick(b));
      if (b.mean !== null) expect(Math.abs((a.mean ?? 0) - b.mean) / Math.max(1, Math.abs(b.mean))).toBeLessThan(1e-12);
    }
  });

  it('saves a project file that the TypeScript engine opens with every check passing', async () => {
    const saved = await native.client.awaitJob<SaveResult>(await native.client.saveProject());
    expect(saved.fileName).toBe('Parity.twp');
    const bytes = saved.bytes as Uint8Array;
    savedByNative = bytes;
    expect(saved.size).toBe(bytes.byteLength);
    const zip = readZip(bytes);
    const manifest = JSON.parse(zip.readText('manifest.json')) as ProjectManifest;
    expect(manifest.formatVersion).toBe('0.2');
    expect(manifest.caches?.length).toBe(3 * manifest.datasets.length);

    const opener = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
    try {
      const report = await opener.awaitJob<ProjectOpenReport>(
        await opener.openProject({ kind: 'bytes', bytes, name: saved.fileName }),
      );
      // Every dataset rebuilt by the TypeScript engine from the originals matches the native digests.
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.readOnly).toBe(false);
      const all = async (e: EngineClient) => {
        const out: AuditEntry[] = [];
        for (let offset = 0; ; offset += 500) {
          const page = await e.listAudit({ offset, limit: 500 });
          out.push(...page.items);
          if (offset + 500 >= page.total) return out;
        }
      };
      expect(await all(opener)).toEqual(await all(native.client));
    } finally {
      opener.close();
    }
  });

  const allAudit = async (e: EngineClient): Promise<AuditEntry[]> => {
    const out: AuditEntry[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await e.listAudit({ offset, limit: 500 });
      out.push(...page.items);
      if (offset + 500 >= page.total) return out;
    }
  };

  /** A fresh native engine opening a project file: its open report, then the engine itself. */
  const openNatively = async (bytes: Uint8Array): Promise<{ report: ProjectOpenReport; opened: NativeProcess }> => {
    const opened = startNative(['--fixed-clock', START, '--seed', '1', '--threads', '2', '--owner', 'Prasad']);
    const report = await opened.client.awaitJob<ProjectOpenReport>(
      await opened.client.openProject({ kind: 'bytes', bytes, name: 'Parity.twp' }),
    );
    return { report, opened };
  };

  it('opens its own project file from the saved working data, with the same log and issues', async () => {
    const { report, opened } = await openNatively(savedByNative as Uint8Array);
    try {
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.readOnly).toBe(false);
      expect(report.checks.find((c) => c.id === 'replay-digest')?.detail).toContain(
        'restored from their saved working data',
      );
      expect(await allAudit(opened.client)).toEqual(await allAudit(native.client));
      const issues = async (e: EngineClient) => (await e.listIssues({ limit: 1000 })).items;
      expect(await issues(opened.client)).toEqual(await issues(native.client));
      const first = pairs.get('csv_well_daily_golden.csv') as { nat: string };
      expect(await allRows(opened.client, first.nat)).toEqual(await allRows(native.client, first.nat));
    } finally {
      stopNative(opened);
    }
  });

  it("opens the TypeScript engine's project file by importing its originals again", async () => {
    const saved = await reference.awaitJob<SaveResult>(await reference.saveProject());
    const { report, opened } = await openNatively(saved.bytes as Uint8Array);
    try {
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.checks.find((c) => c.id === 'replay-digest')?.detail).toContain('rebuilt from the originals');
      expect(await allAudit(opened.client)).toEqual(await allAudit(reference));
    } finally {
      stopNative(opened);
    }
  });

  it('opens a project file with a damaged cache read-only, its data rebuilt from the original', async () => {
    const bytes = (savedByNative as Uint8Array).slice();
    const zip = readZip(bytes);
    const path = 'data/d1/rows.parquet';
    const at = new TextDecoder('latin1')
      .decode(bytes)
      .indexOf(new TextDecoder('latin1').decode(zip.read(path).subarray(0, 64)));
    expect(at).toBeGreaterThan(0);
    bytes[at + 100] = (bytes[at + 100] as number) ^ 0xff;
    const { report, opened } = await openNatively(bytes);
    try {
      expect(report.readOnly).toBe(true);
      expect(report.checks.filter((c) => !c.ok).map((c) => [c.id, c.target])).toEqual([['entry-checksum', path]]);
      expect(report.checks.find((c) => c.id === 'replay-digest')).toMatchObject({ ok: true });
      await expect(opened.client.runChecks('d1')).rejects.toMatchObject({ code: 'READ_ONLY_PROJECT' });
    } finally {
      stopNative(opened);
    }
  });

  it('refuses what it does not support yet with a reason and a fix', async () => {
    await expect(native.client.listRulePacks()).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
      fix: expect.any(String),
    });
    await expect(
      native.client.importFile({ kind: 'path', path: fixturePath('csv_pipe_delimited.csv') }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      fix: expect.stringContaining('Preview'),
    });
  });
});

if (!nativeBuilt) {
  describe('native engine parity', () => {
    it.skip(`needs the native engine: run npm run build:native (looked for ${NATIVE_BINARY})`, () => undefined);
  });
}

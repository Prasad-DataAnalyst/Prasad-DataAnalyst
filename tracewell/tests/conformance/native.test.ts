/**
 * Native engine parity (slice 2, SAD section 4.3 phase B): the Rust + DuckDB engine, spawned as a
 * real process and spoken to over stdio, must agree with the TypeScript reference engine on the
 * audit format and on every value it imports. The suite runs when the engine has been built with
 * `npm run build:native`; without the binary it is skipped and says so.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '@tw/audit';
import { EngineClient, PROTOCOL_VERSION, stdioTransport } from '@tw/engine-api';
import { FIXTURE_NAMES, fixturePath } from '@tw/fixtures';
import {
  canonicalJson,
  type AuditEntry,
  type DatasetSummary,
  type ImportPreview,
  type JsonValue,
  type RowWindow,
} from '@tw/model';
import { columnDigest } from '@tw/table';
import { ENGINE_FACTORIES, PROFILE, START } from './harness';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINARY = join(ROOT, 'crates', 'tracewell-engine', 'target', 'release', 'tracewell-engine');
const built = existsSync(BINARY);

interface Native {
  client: EngineClient;
  child: ChildProcessWithoutNullStreams;
  workdir: string;
}

function startNative(): Native {
  const workdir = mkdtempSync(join(tmpdir(), 'tw-native-'));
  const child = spawn(BINARY, ['serve', '--workdir', workdir, '--fixed-clock', START, '--seed', '1', '--threads', '2']);
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`[native] ${d.toString()}`));
  const client = new EngineClient(
    stdioTransport({
      readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      write: (bytes) =>
        new Promise<void>((resolve, reject) => child.stdin.write(bytes, (e) => (e ? reject(e) : resolve()))),
    }),
  );
  return { client, child, workdir };
}

function stopNative(n: Native): void {
  n.client.close();
  n.child.stdin.end();
  n.child.kill();
  rmSync(n.workdir, { recursive: true, force: true });
}

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

describe.skipIf(!built)('native engine parity (tracewell-native over a real pipe)', () => {
  let native: Native;
  let reference: EngineClient;
  const imported: string[] = [];
  const refused: string[] = [];

  beforeAll(async () => {
    native = startNative();
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

  it('refuses what it does not support yet with a reason and a fix', async () => {
    await expect(native.client.runChecks('d1')).rejects.toMatchObject({
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

if (!built) {
  describe('native engine parity', () => {
    it.skip(`needs the native engine: run npm run build:native (looked for ${BINARY})`, () => undefined);
  });
}

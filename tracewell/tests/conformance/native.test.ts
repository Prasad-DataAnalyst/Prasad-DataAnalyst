/**
 * Native engine parity (slice 2, SAD section 4.3 phase B): the Rust + DuckDB engine, spawned as a
 * real process and spoken to over stdio, must agree with the TypeScript reference engine on the
 * audit format and on every value it imports. The suite runs when the engine has been built with
 * `npm run build:native`; without the binary it is skipped and says so.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '@tw/audit';
import { EngineClient, inProcessTransport, PROTOCOL_VERSION } from '@tw/engine-api';
import { LocalEngine, fixedClock, seededIds } from '@tw/engine';
import { nodeFs } from '@tw/io/node';
import { FIXTURE_NAMES, fixturePath } from '@tw/fixtures';
import { readBack } from '@tw/export';
import { readZip, writeZip } from '@tw/io';
import {
  canonicalJson,
  type AuditEntry,
  type CheckSummary,
  type ExportResult,
  type DatasetSummary,
  type Issue,
  type IssueOccurrence,
  type ImportPreview,
  type ImportRequestOptions,
  type MappingTemplate,
  type ProjectManifest,
  type Decision,
  type Recipe,
  type RecipePlan,
  type RecipeRun,
  type ProjectOpenReport,
  type SaveResult,
  type StepInput,
  type StepPreview,
  type StepResult,
  type JsonValue,
  type RowWindow,
} from '@tw/model';
import { columnDigest } from '@tw/table';
import { parquetWriteBuffer } from 'hyparquet-writer';
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

const EXCEL_FIXTURES = FIXTURE_NAMES.filter((n) => /\.xlsx?$/.test(n));

const SPREADSHEET =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface HandSheet {
  name: string;
  state?: string;
  /** The worksheet's content: sheetData and anything after it. */
  xml?: string;
  /** Before the worksheet element, such as a document type declaration. */
  prolog?: string;
  chart?: boolean;
  /** The relationship target, relative to the workbook part. */
  target?: string;
}

/**
 * A workbook written part by part, for the cell types, layouts and damage no fixture has. Shared
 * strings that start with '<' are rich text; numFmts and xfs make the styles part.
 */
function handWorkbook(
  sheets: HandSheet[],
  o: { date1904?: boolean; strings?: string[]; numFmts?: string; xfs?: number[] } = {},
): Uint8Array {
  const text = (t: string) => new TextEncoder().encode(t);
  const rels = sheets.map((s, i) =>
    s.chart
      ? `<Relationship Id="rId${i + 1}" Type="${RELATIONSHIP}/chartsheet" Target="chartsheets/sheet${i + 1}.xml"/>`
      : `<Relationship Id="rId${i + 1}" Type="${RELATIONSHIP}/worksheet" Target="${s.target ?? `worksheets/sheet${i + 1}.xml`}"/>`,
  );
  const entries = [
    {
      path: '_rels/.rels',
      data: text(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIP}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      path: 'xl/workbook.xml',
      data: text(
        `<?xml version="1.0" encoding="UTF-8"?><workbook ${SPREADSHEET}><workbookPr${o.date1904 === true ? ' date1904="1"' : ''}/><sheets>${sheets
          .map(
            (s, i) =>
              `<sheet name="${s.name}" sheetId="${i + 1}"${s.state === undefined ? '' : ` state="${s.state}"`} r:id="rId${i + 1}"/>`,
          )
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      data: text(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}<Relationship Id="rIdS" Type="${RELATIONSHIP}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="${RELATIONSHIP}/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    {
      path: 'xl/sharedStrings.xml',
      data: text(
        `<?xml version="1.0"?><sst ${SPREADSHEET}>${(o.strings ?? [])
          .map((t) => (t.startsWith('<') ? `<si>${t}</si>` : `<si><t xml:space="preserve">${t}</t></si>`))
          .join('')}</sst>`,
      ),
    },
    {
      path: 'xl/styles.xml',
      data: text(
        `<?xml version="1.0"?><styleSheet ${SPREADSHEET}>${o.numFmts === undefined ? '' : `<numFmts>${o.numFmts}</numFmts>`}<cellXfs>${(
          o.xfs ?? [0]
        )
          .map((id) => `<xf numFmtId="${id}"/>`)
          .join('')}</cellXfs></styleSheet>`,
      ),
    },
  ];
  sheets.forEach((s, i) => {
    if (s.chart === true) {
      entries.push({ path: `xl/chartsheets/sheet${i + 1}.xml`, data: text(`<chartsheet ${SPREADSHEET}/>`) });
      return;
    }
    const target = s.target ?? `worksheets/sheet${i + 1}.xml`;
    const path = decodeURIComponent(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    entries.push({
      path,
      data: text(
        `<?xml version="1.0"?>${s.prolog ?? ''}<worksheet ${SPREADSHEET}>${s.xml ?? '<sheetData/>'}</worksheet>`,
      ),
    });
  });
  return writeZip(entries);
}

/** A cell element: its reference, content and attributes such as ' t="s"'. */
const cell = (ref: string, inner: string, attrs = '') => `<c r="${ref}"${attrs}>${inner}</c>`;
const val = (x: string | number) => `<v>${x}</v>`;

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

  const issuesOf = async (e: EngineClient, datasetId: string) => (await e.listIssues({ datasetId, limit: 1000 })).items;
  // Issue IDs hash the dataset ID, so the same rule on the same columns names an issue in both.
  const issueKey = (i: Issue) => `${i.ruleId}|${i.columns.join(',')}`;
  const comparableIssue = (i: Issue) => {
    const { id: _id, datasetId: _ds, firstSeenSeq: _f, lastCheckedSeq: _l, comments, ...rest } = i;
    return { ...rest, comments: comments.map((c) => ({ by: c.by, text: c.text })) };
  };
  /** What an entry says, without what depends on its place in each engine's log and project. */
  const said = (e: AuditEntry) => {
    const { seq: _s, at: _a, prev: _p, hash: _h, target, payload, ...rest } = e;
    const t: Record<string, unknown> = { ...target };
    for (const k of ['datasetId', 'issueId', 'seq']) if (k in t) t[k] = k;
    const pay = payload as Record<string, unknown> | undefined;
    const keep =
      pay !== undefined && 'previousEditSeq' in pay
        ? { ...pay, previousEditSeq: pay['previousEditSeq'] !== null }
        : pay;
    return { ...rest, target: t, ...(keep === undefined ? {} : { payload: keep }) };
  };
  /** Occurrences with the action of the entry that decided each, rather than its seq. */
  const occurrencesOf = async (e: EngineClient, id: string) => {
    const log = await allAudit(e);
    const items = (await e.listOccurrences(id, { offset: 0, limit: 1000 })).items;
    return items.map((o) => ({
      ...o,
      issueId: '',
      decidedBy: o.decidedBy === null ? null : (log.find((x) => x.seq === o.decidedBy)?.action ?? 'missing'),
    }));
  };
  /** A dataset as both engines show it: issues, occurrences, health, rows, statistics, summary. */
  const samePair = async (n: string, r: string, why: string) => {
    const [a, b] = [await issuesOf(native.client, n), await issuesOf(reference, r)];
    expect(a.map(comparableIssue), `${why}: issues of ${n}`).toEqual(b.map(comparableIssue));
    for (const [i, x] of a.entries()) {
      expect(await occurrencesOf(native.client, x.id), `${why}: ${x.ruleId}`).toEqual(
        await occurrencesOf(reference, (b[i] as Issue).id),
      );
    }
    const [ha, hb] = [await native.client.getHealth(n), await reference.getHealth(r)];
    expect({ ...ha, datasetId: '' }, `${why}: health`).toEqual({ ...hb, datasetId: '' });
    const [ra, rb] = [await allRows(native.client, n), await allRows(reference, r)];
    const grid = (x: RowWindow['rows'][number]) => [x.rowId, x.cells, x.edited, x.issue];
    expect(ra.map(grid), `${why}: rows`).toEqual(rb.map(grid));
    const [sa, sb] = [await native.client.getSchema(n), await reference.getSchema(r)];
    expect(sa.rowCount, `${why}: schema`).toBe(sb.rowCount);
    for (const c of sb.columns) {
      const pickStats = (x: Awaited<ReturnType<EngineClient['getColumnStats']>>) => ({
        count: x.count,
        nulls: x.nulls,
        rawRejected: x.rawRejected,
        distinct: x.distinct,
        min: x.min,
        max: x.max,
      });
      expect(pickStats(await native.client.getColumnStats(n, c.id)), `${why}: ${c.name}`).toEqual(
        pickStats(await reference.getColumnStats(r, c.id)),
      );
    }
    const summary = async (e: EngineClient, id: string) => {
      const p = await e.getProject();
      const d = p.datasets.find((x) => x.id === id);
      return { area: p.projectArea, rows: d?.rowCount, output: d?.outputRowCount };
    };
    expect(await summary(native.client, n), `${why}: project`).toEqual(await summary(reference, r));
  };

  it('takes the same decisions, with the same entries, issues, rows, health and export', async () => {
    const { nat, ref } = pairs.get('csv_duplicates_rows_and_keys.csv') as { nat: string; ref: string };
    const geo = pairs.get('csv_latlon_swapped_out_of_range.csv') as { nat: string; ref: string };
    const issue = async (ruleId: string) => {
      const a = (await issuesOf(native.client, nat)).find((i) => i.ruleId === ruleId && i.scope === 'rows') as Issue;
      const b = (await issuesOf(reference, ref)).find((i) => issueKey(i) === issueKey(a)) as Issue;
      return { a, b };
    };
    const agree = async (why: string) => {
      await samePair(nat, ref, why);
      await samePair(geo.nat, geo.ref, why);
    };
    const both = async (
      why: string,
      make: (ids: { dataset: string; issue: (i: { a: Issue; b: Issue }) => string; seq: number }) => Decision,
      seqs?: [number, number],
    ) => {
      const a = await native.client.decide(make({ dataset: nat, issue: (i) => i.a.id, seq: seqs?.[0] ?? 0 }));
      const b = await reference.decide(make({ dataset: ref, issue: (i) => i.b.id, seq: seqs?.[1] ?? 0 }));
      expect(a.map(said), `${why}: entries`).toEqual(b.map(said));
      await agree(why);
      return [(a[0] as AuditEntry).seq, (b[0] as AuditEntry).seq] as [number, number];
    };

    const dup = await issue('TW-DQ-003');
    const time = await issue('TW-TIME-001');
    await both('comment', (x) => ({
      kind: 'comment_issue',
      issueId: x.issue(dup),
      text: '  Checked with the field team  ',
    }));
    const first = dup.a.openRows.ranges[0]?.[0] as number;
    const accepted = await both('accept', (x) => ({
      kind: 'accept_issue',
      issueId: x.issue(dup),
      rows: [first],
      reason: 'Confirmed by the operator',
    }));
    const excluded = await both('exclude by issue', (x) => ({
      kind: 'exclude_rows',
      datasetId: x.dataset,
      rows: { issueId: x.issue(time) },
      reason: 'Test records from commissioning',
    }));
    await both('exclude rows', (x) => ({
      kind: 'exclude_rows',
      datasetId: x.dataset,
      rows: [0, 1],
      reason: 'Header rows sent twice',
    }));
    await both(
      'revert the acceptance',
      (x) => ({ kind: 'revert', seq: x.seq, reason: 'Accepted by mistake' }),
      accepted,
    );
    await both('project area', () => ({
      kind: 'set_project_area',
      bbox: [-10, 40, 10, 60],
      reason: 'North Sea licence area',
    }));
    await both(
      'revert the exclusion',
      (x) => ({ kind: 'revert', seq: x.seq, reason: 'The records are real' }),
      excluded,
    );
    await both('accept everything open', (x) => ({
      kind: 'accept_issue',
      issueId: x.issue(dup),
      rows: 'all',
      reason: 'Known duplicates from the historian',
    }));

    // Refusals give the same code and message in both engines.
    const refusal = async (make: (dataset: string, issueId: string) => Decision) => {
      const out: unknown[] = [];
      for (const [e, dataset, id] of [
        [native.client, nat, dup.a.id],
        [reference, ref, dup.b.id],
      ] as const) {
        out.push(
          await e.decide(make(dataset, id)).then(
            () => 'accepted',
            (err: unknown) => ({
              code: (err as { code: string }).code,
              message: (err as Error).message.replaceAll(id, 'ID').replaceAll(dataset, 'DS'),
            }),
          ),
        );
      }
      expect(out[0]).toEqual(out[1]);
      expect(out[0]).not.toBe('accepted');
    };
    await refusal((_, id) => ({ kind: 'accept_issue', issueId: id, rows: [first], reason: 'ab' }));
    await refusal((_, id) => ({ kind: 'accept_issue', issueId: id, rows: [first, 99999], reason: 'Already done' }));
    await refusal((_, id) => ({ kind: 'accept_issue', issueId: id, rows: 'all', reason: 'Nothing left open' }));
    await refusal((dataset) => ({
      kind: 'exclude_rows',
      datasetId: dataset,
      rows: [0, 1],
      reason: 'Excluded already',
    }));
    await refusal((dataset) => ({
      kind: 'exclude_rows',
      datasetId: dataset,
      rows: [5, 123456],
      reason: 'Past the end',
    }));
    await refusal((_, id) => ({ kind: 'comment_issue', issueId: id, text: '   ' }));
    await refusal(() => ({ kind: 'set_project_area', bbox: [10, 60, -10, 40], reason: 'South above north' }));
    await refusal(() => ({ kind: 'revert', seq: 99999, reason: 'No such entry' }));
    await refusal(() => ({ kind: 'revert', seq: 1, reason: 'Undo the project' }));
    await refusal(() => ({ kind: 'accept_issue', issueId: 'I-000000000000', rows: 'all', reason: 'Unknown issue' }));

    // The export leaves the excluded rows out, and both engines describe it the same way.
    const a = await native.client.awaitJob<ExportResult>(
      await native.client.exportData({ datasetId: nat, profile: 'parquet' }),
    );
    const b = await reference.awaitJob<ExportResult>(
      await reference.exportData({ datasetId: ref, profile: 'parquet' }),
    );
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect([a.manifest.dataset.rowCount, a.manifest.excludedRows]).toEqual([
      b.manifest.dataset.rowCount,
      b.manifest.excludedRows,
    ]);
    expect(a.manifest.excludedRows).toBeGreaterThan(0);
    expect(a.manifest.dataset.viewDigest).toBe(b.manifest.dataset.viewDigest);
    expect(a.manifest.openIssues).toEqual(b.manifest.openIssues);
  });

  it('edits cells the same way, with the same entries, values, issues and refusals', async () => {
    const dates = pairs.get('csv_dates_ambiguous_and_mixed.csv') as { nat: string; ref: string };
    const nulls = pairs.get('csv_null_markers.csv') as { nat: string; ref: string };
    const column = async (datasetId: string, name: string) =>
      (await reference.getSchema(datasetId)).columns.find((c) => c.name.startsWith(name))?.id as string;
    const [logged, pressure] = [await column(dates.ref, 'logged'), await column(nulls.ref, 'Pressure')];
    const pick = (o: { nat: string; ref: string }, engine: 'nat' | 'ref') => o[engine];
    /** An edit in both engines; the entries must say the same and the datasets agree after it. */
    const edit = async (
      why: string,
      on: { nat: string; ref: string },
      make: (dataset: string, seq: number) => Decision,
      seqs?: [number, number],
    ) => {
      const a = await native.client.decide(make(pick(on, 'nat'), seqs?.[0] ?? 0));
      const b = await reference.decide(make(pick(on, 'ref'), seqs?.[1] ?? 0));
      expect(a.map(said), `${why}: entries`).toEqual(b.map(said));
      await samePair(on.nat, on.ref, why);
      return [(a[0] as AuditEntry).seq, (b[0] as AuditEntry).seq] as [number, number];
    };
    const refusal = async (
      on: { nat: string; ref: string },
      make: (dataset: string, seq: number) => Decision,
      seqs?: [number, number],
    ) => {
      const out: unknown[] = [];
      for (const [e, dataset, seq] of [
        [native.client, on.nat, seqs?.[0] ?? 0],
        [reference, on.ref, seqs?.[1] ?? 0],
      ] as const) {
        out.push(
          await e.decide(make(dataset, seq)).then(
            () => 'accepted',
            (err: unknown) => ({
              code: (err as { code: string }).code,
              message: (err as Error).message.replaceAll(dataset, 'DS').replace(/entry \d+/g, 'entry N'),
            }),
          ),
        );
      }
      expect(out[0]).toEqual(out[1]);
      expect(out[0]).not.toBe('accepted');
    };

    // A date that did not parse, corrected: its row leaves the issue and its raw text stops counting.
    await edit('correct a date', dates, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 2,
      columnId: logged,
      value: { text: '2026-02-03' },
      reason: 'Field log says 3 February',
    }));
    // A null marker replaced, then edited again, then the edits reverted in turn.
    const first = await edit('replace a null marker', nulls, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 1,
      columnId: pressure,
      value: { text: '1510.0' },
      reason: 'Gauge read from the chart',
    }));
    const second = await edit('edit it again', nulls, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 1,
      columnId: pressure,
      value: { value: 1511.5 },
      reason: 'Chart re-read at the office',
    }));
    await refusal(nulls, (_, seq) => ({ kind: 'revert', seq, reason: 'Back to the marker' }), first);
    await edit(
      'revert the second edit',
      nulls,
      (_, seq) => ({ kind: 'revert', seq, reason: 'Office reading was wrong' }),
      second,
    );
    await edit('empty a cell', nulls, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 3,
      columnId: pressure,
      value: { value: null },
      reason: 'Transmitter fault that day',
    }));
    await refusal(dates, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 0,
      columnId: logged,
      value: { text: 'yesterday' },
      reason: 'Not a date',
    }));
    await refusal(nulls, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 0,
      columnId: pressure,
      value: { value: 'high' },
      reason: 'Text in a number',
    }));
    await refusal(nulls, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 999,
      columnId: pressure,
      value: { value: 1 },
      reason: 'Past the end',
    }));
    await refusal(nulls, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 0,
      columnId: 'c99',
      value: { value: 1 },
      reason: 'No such column',
    }));
    await refusal(nulls, (d) => ({
      kind: 'edit_cell',
      datasetId: d,
      rowId: 0,
      columnId: pressure,
      value: { value: 1 },
      reason: 'x',
    }));

    // The edited values reach the exports, in row order, as the reference engine writes them.
    for (const profile of ['csv', 'parquet'] as const) {
      const a = await native.client.awaitJob<ExportResult>(
        await native.client.exportData({ datasetId: nulls.nat, profile }),
      );
      const b = await reference.awaitJob<ExportResult>(await reference.exportData({ datasetId: nulls.ref, profile }));
      expect([a.ok, b.ok], profile).toEqual([true, true]);
      expect(a.manifest.dataset.viewDigest, profile).toBe(b.manifest.dataset.viewDigest);
      if (profile === 'csv') {
        const csv = (r: ExportResult) => readZip(r.bytes as Uint8Array).read('data.csv');
        expect(csv(a)).toEqual(csv(b));
      }
    }
  });

  it('applies the same steps, with the same previews, results, views, refusals and export', async () => {
    const { nat, ref } = pairs.get('csv_well_daily_golden.csv') as { nat: string; ref: string };
    const cols = (await reference.getSchema(ref)).columns;
    const id = (name: string) => cols.find((c) => c.name === name)?.id as string;
    const [pressure, temperature, date, well] = [id('Pressure'), id('Temperature'), id('date'), id('well_id')];
    const kpa = `${pressure}~kPa`;
    const degC = `${temperature}~degC`;
    const preview = async (s: StepInput) => {
      const shape = (x: StepPreview) =>
        x.ok ? x : { ok: false, error: { code: x.error?.code, message: x.error?.message }, description: x.description };
      const [a, b] = [await native.client.previewStep(nat, s), await reference.previewStep(ref, s)];
      expect(shape(a), JSON.stringify(s)).toEqual(shape(b));
      return a;
    };
    /** Both engines' output stage: schema and rows. */
    const sameOutput = async (why: string) => {
      // A converted column's unit names the entry that set it; the logs differ in length.
      const schemaOf = async (e: EngineClient, datasetId: string, stage: 'working' | 'output') =>
        JSON.parse(
          JSON.stringify({ ...(await e.getSchema(datasetId, stage)), datasetId: '' })
            .replace(/audit entry \d+/g, 'audit entry N')
            .replace(/"overriddenBy":\d+/g, '"overriddenBy":0'),
        ) as unknown;
      for (const stage of ['working', 'output'] as const) {
        expect(await schemaOf(native.client, nat, stage), `${why}: ${stage} schema`).toEqual(
          await schemaOf(reference, ref, stage),
        );
      }
      const rows = async (e: EngineClient, datasetId: string) => {
        const out: RowWindow[] = [];
        for (let offset = 0; ; offset += 100) {
          const w = await e.getRows({ datasetId, stage: 'output', offset, limit: 100 });
          out.push({ ...w, datasetId: '' });
          if (offset + 100 >= w.totalRows) return out;
        }
      };
      expect(await rows(native.client, nat), `${why}: output rows`).toEqual(await rows(reference, ref));
    };
    const apply = async (why: string, s: StepInput) => {
      await preview(s);
      const run = async (e: EngineClient, datasetId: string) =>
        e.awaitJob<StepResult>(await e.applyStep(datasetId, s, `Step: ${why}`));
      const [a, b] = [await run(native.client, nat), await run(reference, ref)];
      const shape = (x: StepResult) => ({ ...x, audit: said(x.audit), step: { ...x.step, seq: 0 } });
      expect(shape(a), `${why}: result`).toEqual(shape(b));
      await samePair(nat, ref, why);
      await sameOutput(why);
      return [a.audit.seq, b.audit.seq] as [number, number];
    };
    const refused = async (why: string, run: (e: EngineClient, datasetId: string) => Promise<unknown>) => {
      const out: unknown[] = [];
      for (const [e, datasetId] of [
        [native.client, nat],
        [reference, ref],
      ] as const) {
        out.push(
          await run(e, datasetId).then(
            () => 'accepted',
            (err: unknown) => ({
              code: (err as { code: string }).code,
              message: (err as Error).message.replaceAll(datasetId, 'DS').replace(/entry \d+/g, 'entry N'),
            }),
          ),
        );
      }
      expect(out[0], why).toEqual(out[1]);
      expect(out[0], why).not.toBe('accepted');
    };

    // Previews that are refused, with the reason.
    for (const s of [
      { kind: 'convert_unit', columnId: well, toUnit: 'kPa', mode: 'replace' },
      { kind: 'convert_unit', columnId: pressure, toUnit: 'm', mode: 'replace' },
      { kind: 'convert_unit', columnId: pressure, toUnit: 'psig', mode: 'replace' },
      { kind: 'convert_unit', columnId: pressure, toUnit: 'furlongs', mode: 'replace' },
      { kind: 'convert_unit', columnId: 'c99', toUnit: 'kPa', mode: 'replace' },
      { kind: 'filter', predicate: { column: 'c99', op: 'is_null' } },
      { kind: 'filter', predicate: { column: pressure, op: 'contains', text: '18' } },
      { kind: 'filter', predicate: { column: pressure, op: 'gt', value: 'high' } },
      { kind: 'select_columns', columnIds: [] },
      { kind: 'select_columns', columnIds: [well, well] },
    ] as StepInput[]) {
      expect((await preview(s)).ok, JSON.stringify(s)).toBe(false);
    }

    await apply('pressure to kPa', { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'replace' });
    await apply('temperature in degC too', {
      kind: 'convert_unit',
      columnId: temperature,
      toUnit: 'degC',
      mode: 'add_column',
    });
    expect((await preview({ kind: 'convert_unit', columnId: temperature, toUnit: 'degC', mode: 'replace' })).ok).toBe(
      false,
    );
    const filter = await apply('high pressure in December', {
      kind: 'filter',
      predicate: {
        all: [
          { column: kpa, op: 'ge', value: 13000 },
          { not: { column: well, op: 'in', values: ['NS-A03'] } },
          {
            any: [
              {
                column: date,
                op: 'between',
                low: { datetime: '2025-12-01T00:00:00.000Z' },
                high: { datetime: '2025-12-15T00:00:00.000Z' },
              },
              { column: degC, op: 'lt', value: 80 },
            ],
          },
        ],
      },
    });
    await apply('a few columns', { kind: 'select_columns', columnIds: [well, date, kpa, degC] });
    // The steps reach the export: rows filtered, columns selected and converted, in order.
    for (const profile of ['csv', 'parquet'] as const) {
      const a = await native.client.awaitJob<ExportResult>(await native.client.exportData({ datasetId: nat, profile }));
      const b = await reference.awaitJob<ExportResult>(await reference.exportData({ datasetId: ref, profile }));
      expect([a.ok, b.ok], profile).toEqual([true, true]);
      expect(a.manifest.dataset, profile).toEqual({ ...b.manifest.dataset, id: nat });
      expect(a.manifest.steps.map((x) => ({ ...x, seq: 0 }))).toEqual(b.manifest.steps.map((x) => ({ ...x, seq: 0 })));
      const text = (r: ExportResult, f: string) => new TextDecoder().decode(readZip(r.bytes as Uint8Array).read(f));
      expect(text(a, 'README.txt').split('STEPS')[1]?.split('ASSUMPTIONS')[0]).toBe(
        text(b, 'README.txt').split('STEPS')[1]?.split('ASSUMPTIONS')[0],
      );
      if (profile === 'csv') expect(text(a, 'data.csv')).toBe(text(b, 'data.csv'));
    }

    await refused('edit a converted cell', (e, d) =>
      e.decide({
        kind: 'edit_cell',
        datasetId: d,
        rowId: 0,
        columnId: kpa,
        value: { value: 1 },
        reason: 'Converted value',
      }),
    );
    await refused('remove the conversion the filter uses', (e, d) => e.removeStep(d, 's1', 'No longer needed'));
    await refused('remove a step that is not there', (e, d) => e.removeStep(d, 's99', 'Not there'));
    const removed = await Promise.all([
      native.client.removeStep(nat, 's4', 'All columns again'),
      reference.removeStep(ref, 's4', 'All columns again'),
    ]);
    expect(said(removed[0])).toEqual(said(removed[1]));
    await samePair(nat, ref, 'selection removed');
    await sameOutput('selection removed');
    for (const [e, d, seq] of [
      [native.client, nat, filter[0]],
      [reference, ref, filter[1]],
    ] as const) {
      await e.decide({ kind: 'revert', seq, reason: 'Every row again' });
      void d;
    }
    await samePair(nat, ref, 'filter reverted');
    await sameOutput('filter reverted');
  });

  it('explains cells the same way: source text, parsing, history and current value', async () => {
    const explain = async (
      fixture: string,
      rowId: number,
      column: (cols: { id: string; name: string }[]) => string,
    ) => {
      const { nat, ref } = pairs.get(fixture) as { nat: string; ref: string };
      const columnId = column((await reference.getSchema(ref)).columns);
      const shape = (x: Awaited<ReturnType<EngineClient['explainCell']>>) => ({
        ...x,
        datasetId: '',
        source: { ...x.source },
        history: x.history.map(({ seq: _s, at: _a, ...rest }) => rest),
      });
      const [a, b] = [
        await native.client.explainCell(nat, rowId, columnId),
        await reference.explainCell(ref, rowId, columnId),
      ];
      expect(shape(a), `${fixture} row ${rowId} ${columnId}`).toEqual(shape(b));
      return a;
    };
    const named = (start: string) => (cols: { id: string; name: string }[]) =>
      cols.find((c) => c.name.startsWith(start))?.id as string;
    // A converted value (Pressure, converted to kPa in place): the step is in its history, with the method.
    const converted = await explain('csv_well_daily_golden.csv', 0, named('Pressure'));
    expect(converted.history.some((h) => h.action === 'step.apply' && h.method !== undefined)).toBe(true);
    // A clean value, read again from the original file.
    expect((await explain('csv_well_daily_golden.csv', 5, named('Oil'))).source.rawText).not.toBeNull();
    // A null marker, edited twice and reverted.
    await explain('csv_null_markers.csv', 1, named('Pressure'));
    // A date that did not parse, then corrected.
    expect((await explain('csv_dates_ambiguous_and_mixed.csv', 2, named('logged'))).parse.ok).toBe(false);
    // An excluded row.
    await explain('csv_duplicates_rows_and_keys.csv', 0, (cols) => cols[0]?.id as string);
  });

  it('keeps mapping templates the same way, in a store that outlives the engine', async () => {
    const golden = pairs.get('csv_well_daily_golden.csv') as { nat: string; ref: string };
    const nulls = pairs.get('csv_null_markers.csv') as { nat: string; ref: string };
    const list = async (e: EngineClient) => (await e.listMappingTemplates()).map((t) => ({ ...t, savedAt: '' }));
    const save = async (name: string, on: { nat: string; ref: string }) => {
      const [a, b] = [
        await native.client.saveMappingTemplate({ datasetId: on.nat, name }),
        await reference.saveMappingTemplate({ datasetId: on.ref, name }),
      ];
      expect({ ...a, savedAt: '' }, name).toEqual({ ...b, savedAt: '' });
    };
    const refused = async (run: (e: EngineClient, d: { nat: string; ref: string }) => Promise<unknown>) => {
      const out: unknown[] = [];
      for (const e of [native.client, reference]) {
        out.push(
          await run(e, golden).then(
            () => 'accepted',
            (err: { code: string; message: string }) => [err.code, err.message],
          ),
        );
      }
      expect(out[0]).toEqual(out[1]);
      expect(out[0]).not.toBe('accepted');
    };
    await save('  Daily wells  ', golden);
    await save('Null markers', nulls);
    await save('Daily wells', golden);
    expect(await list(native.client)).toEqual(await list(reference));
    expect((await list(native.client)).map((t) => t.name)).toEqual(['Daily wells', 'Null markers']);
    await refused((e, d) => e.saveMappingTemplate({ datasetId: e === native.client ? d.nat : d.ref, name: '   ' }));
    await refused((e, d) =>
      e.saveMappingTemplate({ datasetId: e === native.client ? d.nat : d.ref, name: 'x'.repeat(201) }),
    );
    await refused((e) => e.deleteMappingTemplate('mt_000000000000'));
    // A new engine on the same store sees the templates.
    const again = startNative(['--templates', join(native.workdir, 'mapping-templates.json')]);
    try {
      expect(await list(again.client)).toEqual(await list(native.client));
    } finally {
      stopNative(again);
    }
    const id = (await native.client.listMappingTemplates())[0]?.id as string;
    await native.client.deleteMappingTemplate(id);
    await reference.deleteMappingTemplate(id);
    expect(await list(native.client)).toEqual(await list(reference));
  });

  it('previews delimited files the same way: detection, settings, templates and refusals', async () => {
    const settle = (e: EngineClient, run: (e: EngineClient) => Promise<unknown>) =>
      run(e).then(
        (v) => v,
        (err: { code: string; message: string }) => ({ code: err.code, message: err.message }),
      );
    const same = async (label: string, run: (e: EngineClient) => Promise<unknown>, a = native.client, b = reference) =>
      expect(await settle(a, run), label).toEqual(await settle(b, run));

    // Every fixture as detected, with the mapping template both engines now hold.
    for (const name of CSV_FIXTURES) {
      await same(name, (e) => e.sniff({ kind: 'path', path: fixturePath(name) }));
    }

    // Files longer than the first MiB the preview reads: the sample stops at the last whole line,
    // a quoted field open at the cut is left out, the row count is estimated, and a character cut
    // in two leaves the encoding assumed.
    const folder = mkdtempSync(join(tmpdir(), 'tw-preview-'));
    try {
      const golden = readFileSync(fixturePath('csv_well_daily_golden.csv'), 'utf8').replace(/[^\t\n\r -~]/g, '');
      const [head, ...rows] = golden.split('\n').filter((l) => l !== '');
      const long = (n: number, tweak: (l: string, i: number) => string = (l) => l) =>
        `${[head, ...Array.from({ length: n }, (_, i) => tweak(rows[i % rows.length] as string, i))].join('\n')}\n`;
      const text = long(20_000);
      const cut = 1_048_576;
      const files: [string, string][] = [
        ['long.csv', text],
        [
          'long_ragged.csv',
          long(20_000, (l, i) =>
            i % 700 === 3 ? `${l},extra` : i % 900 === 5 ? l.split(',').slice(0, 4).join(',') : l,
          ),
        ],
        ['long_semicolon.txt', long(20_000, (l) => l.replace(/,/g, ';').replace(/\./g, ','))],
        ['long_open_quote.csv', `${text.slice(0, cut - 40)}"open${'x'.repeat(100)}\n${text.slice(cut - 40)}`],
        ['long_cut_character.csv', `${text.slice(0, cut - 1)}\u00e9${text.slice(cut - 1)}`],
        ['long_crlf.dat', text.replace(/\n/g, '\r\n')],
        ['units_row.csv', 'name,depth,rate\n,[m],(bbl/d)\nW1,100,2\nW2,200,3\n'],
        ['title_block', 'Daily report\nExported 2025-12-01\n\na;b;c\n1,5;2.000,25;3\n4,5;5;6\n'],
        ['single_quotes.csv', "x;y\n'a;b';c\n'd';e\n"],
        ['no_delimiter.csv', 'only\none\ncolumn\n'],
        ['empty.csv', ''],
      ];
      for (const [name, body] of files) {
        const path = join(folder, name);
        writeFileSync(path, body);
        await same(name, (e) => e.sniff({ kind: 'path', path }));
      }
      // windows-1252 bytes in otherwise ASCII text.
      const latin = join(folder, 'latin.csv');
      writeFileSync(latin, Uint8Array.from([...Buffer.from('name,temp\nW1,20\nCaf'), 0xe9, ...Buffer.from(',21\n')]));
      await same('latin.csv', (e) => e.sniff({ kind: 'path', path: latin }));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    // Settings chosen in the import settings are taken as given; invalid ones are refused alike.
    const delimited = [
      'csv_well_daily_golden.csv',
      'csv_semicolon_decimalcomma_cp1252.csv',
      'tsv_utf16le_bom.tsv',
    ] as const;
    for (const name of delimited) {
      const file = { kind: 'path' as const, path: fixturePath(name) };
      const { options } = (await reference.sniff(file, { template: null })).sniff;
      if (options.format !== 'csv' && options.format !== 'tsv') throw new Error(`${name} is not delimited text`);
      const changes: Partial<typeof options.csv>[] = [
        {},
        { delimiter: ';', headerRows: 2 },
        { delimiter: '|', headerRows: 0, skipLines: 1 },
        { decimalSeparator: ',', thousandsSeparator: '.' },
        { encoding: 'windows-1252', bomLength: 0 },
        { encoding: 'utf-16le', bomLength: 0 },
        { decimalSeparator: ',', thousandsSeparator: ',' },
      ];
      for (const change of changes) {
        const chosen = { ...options, csv: { ...options.csv, ...change } };
        await same(`${name} ${JSON.stringify(change)}`, (e) => e.sniff(file, { options: chosen, template: null }));
      }
    }

    // A file sent as bytes reads as the same file on disk.
    const bytes = new Uint8Array(readFileSync(fixturePath('csv_null_markers.csv')));
    await same('upload', (e) => e.sniff({ kind: 'bytes', name: 'upload.csv', bytes }));

    // Templates: the one covering the most columns, then the newest; its changes are applied and
    // credited to it; a chosen template that does not fit, or does not exist, is refused alike.
    const goldenFile = { kind: 'path' as const, path: fixturePath('csv_well_daily_golden.csv') };
    const plain = await reference.sniff(goldenFile, { template: null });
    const columns: MappingTemplate['columns'] = plain.columns.map((c) => ({
      sourceHeader: [...c.sourceHeader],
      name: c.name,
      type: c.type.value,
      unit: c.unit.value,
      role: c.role.value,
      nullMarkers: [...c.nullMarkers.value],
      ...(c.dateFormat === undefined ? {} : { dateFormat: c.dateFormat.value }),
      ...(c.timezone === undefined ? {} : { timezone: c.timezone.value }),
    }));
    const changed = columns.map((c, i) => {
      if (i === 0) return { ...c, name: 'Well' };
      if (i === 1) return { ...c, dateFormat: 'dmy' as const, timezone: 'utc' as const };
      if (i === 2) return { ...c, role: 'measure' as const };
      if (i === 3) return { ...c, type: 'string' as const };
      if (i === 4) return { ...c, unit: 'kPa' };
      if (i === 5) return { ...c, unit: null };
      if (i === 6) return { ...c, nullMarkers: ['-999.25', 'n/a'] };
      return c;
    });
    const template = (
      id: string,
      name: string,
      savedAt: string,
      cols: MappingTemplate['columns'],
    ): MappingTemplate => ({
      id,
      name,
      savedFrom: { fileName: 'csv_well_daily_golden.csv', format: 'csv' },
      columns: cols,
      savedAt,
      savedBy: 'Prasad',
    });
    const templates = [
      template('mt_00000000000a', 'As detected', '2026-01-01T00:00:00.000Z', columns),
      template('mt_00000000000b', 'Hand made', '2026-02-01T00:00:00.000Z', changed),
      template('mt_00000000000c', 'Two columns', '2026-03-01T00:00:00.000Z', changed.slice(0, 2)),
      template('mt_00000000000d', 'Not this file', '2026-03-01T00:00:00.000Z', [
        { ...columns[0], sourceHeader: ['Nope'] } as MappingTemplate['columns'][number],
      ]),
      template(
        'mt_00000000000e',
        'Unknown unit',
        '2025-01-01T00:00:00.000Z',
        changed.map((c, i) => (i === 4 ? { ...c, unit: 'furlong' } : c)),
      ),
    ];
    const home = mkdtempSync(join(tmpdir(), 'tw-templates-'));
    const store = join(home, 'mapping-templates.json');
    writeFileSync(store, JSON.stringify({ format: 'tracewell-mapping-templates', version: 1, templates }));
    const withStore = startNative(['--fixed-clock', START, '--seed', '1', '--owner', 'Prasad', '--templates', store]);
    const lite = new EngineClient(
      inProcessTransport(
        new LocalEngine({
          appVersion: '0.1.0',
          owner: 'Prasad',
          clock: fixedClock(START),
          ids: seededIds(1),
          fs: nodeFs(),
          templates: { load: () => Promise.resolve(structuredClone(templates)), save: () => Promise.resolve() },
        }),
      ),
    );
    try {
      const choices: (string | null | undefined)[] = [
        undefined,
        null,
        'mt_00000000000a',
        'mt_00000000000c',
        'mt_00000000000d',
        'mt_00000000000e',
        'mt_ffffffffffff',
      ];
      for (const choice of choices) {
        const o = choice === undefined ? {} : { template: choice as never };
        await same(`template ${String(choice)}`, (e) => e.sniff(goldenFile, o), withStore.client, lite);
      }
      const matched = await withStore.client.sniff(goldenFile);
      expect(matched.template?.name).toBe('Hand made');
      expect(matched.columns[0]?.name).toBe('Well');
      expect(matched.columns[4]?.unit).toMatchObject({ value: 'kPa', method: 'mapping-template' });
      expect(matched.crs).toBeNull();
      const other = { kind: 'path' as const, path: fixturePath('csv_pipe_delimited.csv') };
      await same('no template fits', (e) => e.sniff(other), withStore.client, lite);

      // Imports plan themselves and choose the same template, whose changes become overrides.
      await withStore.client.newProject({ name: 'Templates', profile: { ...PROFILE } });
      await lite.newProject({ name: 'Templates', profile: { ...PROFILE } });
      for (const o of [{}, { template: null as never }, { template: 'mt_00000000000a' as never }]) {
        const nat = await withStore.client.awaitJob<DatasetSummary>(await withStore.client.importFile(goldenFile, o));
        const ref = await lite.awaitJob<DatasetSummary>(await lite.importFile(goldenFile, o));
        expect(await withStore.client.getSchema(nat.id)).toEqual(await lite.getSchema(ref.id));
        expect(digests(await allRows(withStore.client, nat.id), nat.columnCount)).toEqual(
          digests(await allRows(lite, ref.id), ref.columnCount),
        );
      }
      const audit = async (e: EngineClient) => (await e.listAudit({})).items.map(content);
      expect(await audit(withStore.client)).toEqual(await audit(lite));
    } finally {
      stopNative(withStore);
      lite.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads Parquet the same way: every stored type, previews, imports, checks, lineage and overrides', async () => {
    // A file of the types the readers convert differently: dates, legacy and logical timestamps of
    // every unit (local and UTC), decimals, integers past 2^53, NaN and infinities, raw and fixed
    // bytes, UUIDs, JSON and unsigned 64-bit integers. (DuckDB keeps a UTC nanosecond timestamp
    // to the microsecond, so the UTC nanosecond values here are whole microseconds.)
    const schema = [
      { name: 'root', num_children: 14 },
      { name: 'd', type: 'INT32', converted_type: 'DATE', repetition_type: 'OPTIONAL' },
      { name: 'tms', type: 'INT64', converted_type: 'TIMESTAMP_MILLIS', repetition_type: 'OPTIONAL' },
      { name: 'tus', type: 'INT64', converted_type: 'TIMESTAMP_MICROS', repetition_type: 'OPTIONAL' },
      {
        name: 'tns_local',
        type: 'INT64',
        logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: false, unit: 'NANOS' },
        repetition_type: 'OPTIONAL',
      },
      {
        name: 'tns_utc',
        type: 'INT64',
        logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'NANOS' },
        repetition_type: 'OPTIONAL',
      },
      { name: 'dec', type: 'INT32', converted_type: 'DECIMAL', scale: 2, precision: 9, repetition_type: 'OPTIONAL' },
      { name: 'big', type: 'INT64', repetition_type: 'OPTIONAL' },
      { name: 'dbl', type: 'DOUBLE', repetition_type: 'OPTIONAL' },
      { name: 'flt', type: 'FLOAT', repetition_type: 'OPTIONAL' },
      { name: 'raw', type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL' },
      { name: 'fixed', type: 'FIXED_LEN_BYTE_ARRAY', type_length: 2, repetition_type: 'OPTIONAL' },
      {
        name: 'uuid',
        type: 'FIXED_LEN_BYTE_ARRAY',
        type_length: 16,
        logical_type: { type: 'UUID' },
        repetition_type: 'OPTIONAL',
      },
      { name: 'json', type: 'BYTE_ARRAY', converted_type: 'JSON', repetition_type: 'OPTIONAL' },
      { name: 'u64', type: 'INT64', converted_type: 'UINT_64', repetition_type: 'OPTIONAL' },
    ];
    const columnData = [
      { name: 'd', data: [19000, 0, -1, null] },
      { name: 'tms', data: [1577836800123n, 0n, -1n, null] },
      { name: 'tus', data: [1577836800123456n, 1577836800123000n, -1n, null] },
      { name: 'tns_local', data: [1577836800123456789n, 1577836800000000000n, 5n, null] },
      { name: 'tns_utc', data: [1577836800123456000n, 1577836800000000000n, -1000n, null] },
      { name: 'dec', data: [12.5, -0.05, 0, null] },
      { name: 'big', data: [9007199254740993n, 5n, -9007199254740993n, null] },
      { name: 'dbl', data: [NaN, Infinity, 1.5, -0] },
      { name: 'flt', data: [1.5, 0.1, -2, null] },
      { name: 'raw', data: [new Uint8Array([104, 105]), new Uint8Array([0xff, 0x41]), new Uint8Array([]), null] },
      { name: 'fixed', data: [new Uint8Array([0, 255]), new Uint8Array([1, 2]), new Uint8Array([3, 4]), null] },
      {
        name: 'uuid',
        data: ['a8098c1a-f86e-11da-bd1a-00112444be1e', '00000000-0000-0000-0000-000000000000', null, null],
      },
      { name: 'json', data: [{ z: 1, a: [1.0, 2.5, 'x'] }, 'text', 7, null] },
      { name: 'u64', data: [18446744073709551615n, 1n, 9007199254740993n, null] },
    ];
    const folder = mkdtempSync(join(tmpdir(), 'tw-parquet-'));
    const generated = join(folder, 'types.parquet');
    writeFileSync(
      generated,
      new Uint8Array(parquetWriteBuffer({ columnData: columnData as never, schema: schema as never })),
    );
    const nat = startNative(['--fixed-clock', START, '--seed', '1', '--owner', 'Prasad']);
    const lite = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
    const settle = (run: () => Promise<unknown>) =>
      run().then(
        (v) => v,
        (err: { code: string; message: string }) => ({ code: err.code, message: err.message }),
      );
    const same = async (why: string, run: (e: EngineClient) => Promise<unknown>) => {
      const [a, b] = [await settle(() => run(nat.client)), await settle(() => run(lite))];
      expect(a, why).toEqual(b);
      return a;
    };
    try {
      for (const e of [nat.client, lite]) await e.newProject({ name: 'Parquet', profile: { ...PROFILE } });
      const files = [fixturePath('parquet_well_daily_typed.parquet'), generated];
      for (const [i, path] of files.entries()) {
        const file = { kind: 'path' as const, path };
        const id = `d${i + 1}`;
        await same(`${path}: preview`, (e) => e.sniff(file));
        await same(`${path}: preview with its settings`, async (e) =>
          e.sniff(file, { options: { format: 'parquet', parquet: { nested: 'json-text' } } }),
        );
        await same(`${path}: import`, async (e) => e.awaitJob<DatasetSummary>(await e.importFile(file)));
        await same(`${path}: schema`, (e) => e.getSchema(id));
        await same(`${path}: rows`, async (e) => allRows(e, id));
        const { columns } = await lite.getSchema(id);
        for (const c of columns) {
          for (const row of [0, 1, 2, 3]) {
            await same(`${path}: lineage of ${c.id} row ${row}`, async (e) => ({
              ...(await e.explainCell(id, row, c.id)),
              history: [],
            }));
          }
        }
        await same(`${path}: checks`, async (e) => {
          const { durationMs: _d, ...run } = await e.awaitJob<CheckSummary>(await e.runChecks(id));
          return run;
        });
        await same(`${path}: issues`, async (e) => (await e.listIssues({ datasetId: id, limit: 1000 })).items);
      }
      // Overrides read the Parquet file again, and reading settings do not apply to it.
      const override = (property: string, value: unknown, columnId?: string) => (e: EngineClient) =>
        e.decide({
          kind: 'override_detection',
          datasetId: 'd2',
          property,
          value,
          reason: 'Checked against the source system',
          ...(columnId === undefined ? {} : { columnId }),
        } as Decision);
      await same('a column read as text', async (e) => (await override('type', 'string', 'c5')(e)).map(content));
      await same('a timestamp column read as text', async (e) =>
        (await override('type', 'string', 'c3')(e)).map(content),
      );
      await same('a reading setting', async (e) => override('delimiter', ';')(e));
      await same('rows after the overrides', async (e) => allRows(e, 'd2'));
      await same('schema after the overrides', (e) => e.getSchema('d2'));
      // The project file opens to the same state in both engines.
      const saved = await nat.client.awaitJob<SaveResult>(await nat.client.saveProject());
      const { report, opened } = await openNatively(saved.bytes as Uint8Array);
      try {
        expect(report.checks.filter((c) => !c.ok)).toEqual([]);
        await sameState(opened.client, lite);
      } finally {
        stopNative(opened);
      }
    } finally {
      stopNative(nat);
      lite.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('reads JSON and JSON Lines the same way: layouts, key order, previews, imports, checks, lineage and refusals', async () => {
    // Records whose keys arrive in different orders and kinds (integer-like keys come first in
    // JavaScript), repeated keys, escapes, numbers past what a double holds, nested values, a
    // member holding the records, blank and CRLF lines, and files past the 1 MiB preview window
    // (wide records, so a few thousand of them are enough).
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `W-${i}`,
        rate: i * 1.5,
        ok: i % 2 === 0,
        tags: i % 7 === 0 ? ['a', i] : null,
        [String(i % 3)]: i,
        note: `Well test ${i}: choke changed, separator stable. `.repeat(6),
      }));
    const generated: [string, string][] = [
      [
        'keys.json',
        JSON.stringify([
          { b: 1, '2': 'two', a: 3, '1': 'one', b2: { y: 1, '0': 2 } },
          { a: 5, c: 'new' },
        ]),
      ],
      ['repeated.json', '[{"a":1,"b":2,"a":3},{"b":4}]'],
      ['escapes.json', '[{"t":"\\u0041\\n\\"q\\"\\\\/","n":1e400,"m":-0,"x":12345678901234567890,"s":"é"}]'],
      ['member.json', '{"meta":{"rows":[1,2]},"count":2,"items":[{"k":1},{"k":2,"j":[1,{"z":null}]}],"tail":true}'],
      ['single.json', '{"a": 1, "b": "x"}'],
      ['spaced.jsonl', '{"a":1}\n\n   \n{"a":2,"b":3}\r\n{"b":4}'],
      ['large.json', JSON.stringify(many(4000))],
      [
        'large.jsonl',
        many(4000)
          .map((r) => JSON.stringify(r))
          .join('\n'),
      ],
      ['large-member.json', JSON.stringify({ status: 'ok', data: many(4000) })],
      // A key first seen past the preview window is not in the plan the preview made.
      ['late-key.json', JSON.stringify([...many(4000), { id: 'W-late', late: 1 }])],
    ];
    // Files that are not records, or not JSON at all.
    const broken: [string, string][] = [
      ['not-records.json', '{\n"a": [1, 2]\n}'],
      ['not-object.json', '[{"a":1}, 5]'],
      [
        'truncated.jsonl',
        `${many(4000)
          .map((r) => JSON.stringify(r))
          .join('\n')}\n{"broken": `,
      ],
      ['truncated.json', JSON.stringify(many(4000)).slice(0, -40)],
      ['scalar-line.jsonl', '{"a":1}\n7\n'],
      ['trailing.json', '[{"a":1}] x'],
      ['bad-line.jsonl', '{"a":1}\n{"a":2,}\n'],
    ];
    const folder = mkdtempSync(join(tmpdir(), 'tw-json-'));
    for (const [name, body] of [...generated, ...broken]) writeFileSync(join(folder, name), body);
    for (const name of [
      'large.json',
      'large.jsonl',
      'large-member.json',
      'late-key.json',
      'truncated.json',
      'truncated.jsonl',
    ]) {
      expect(statSync(join(folder, name)).size, `${name} is past the preview window`).toBeGreaterThan(1 << 20);
    }
    const nat = startNative(['--fixed-clock', START, '--seed', '1', '--owner', 'Prasad']);
    const lite = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
    // Why a parser stopped is worded by the parser (the reference engine's differs between
    // browsers), so that reason is left out; where the file broke, and everything else, is compared.
    const settle = (run: () => Promise<unknown>) =>
      run().then(
        (v) => v,
        (err: { code: string; message: string; fix: string }) => {
          const parsed =
            /^(The JSON file is not valid JSON: (?:line [\d,]+: )?).*?((?: \(after [\d,]+ records\)\.)?)$/s.exec(
              err.message,
            );
          const message = err.code === 'PARSE_FAILED' && parsed !== null ? `${parsed[1]}…${parsed[2]}` : err.message;
          return { code: err.code, message, fix: err.fix };
        },
      );
    const same = async (why: string, run: (e: EngineClient) => Promise<unknown>) => {
      const [a, b] = [await settle(() => run(nat.client)), await settle(() => run(lite))];
      expect(a, why).toEqual(b);
      return a;
    };
    const json = (layout: 'array' | 'lines' | 'member', member = '') => ({
      options: { format: 'json' as const, json: { layout, member, nested: 'json-text' as const } },
    });
    try {
      for (const e of [nat.client, lite]) await e.newProject({ name: 'JSON', profile: { ...PROFILE } });
      const files = [
        fixturePath('json_api_wrapper_nested.json'),
        fixturePath('jsonl_well_tests_crlf.jsonl'),
        ...generated.map(([name]) => join(folder, name)),
      ];
      for (const [i, path] of files.entries()) {
        const file = { kind: 'path' as const, path };
        const id = `d${i + 1}`;
        await same(`${path}: preview`, (e) => e.sniff(file));
        await same(`${path}: import`, async (e) => e.awaitJob<DatasetSummary>(await e.importFile(file)));
        await same(`${path}: schema`, (e) => e.getSchema(id));
        await same(`${path}: rows`, async (e) => allRows(e, id));
        const { columns } = await lite.getSchema(id);
        for (const c of columns.slice(0, 8)) {
          for (const row of [0, 1]) {
            await same(`${path}: lineage of ${c.id} row ${row}`, async (e) => ({
              ...(await e.explainCell(id, row, c.id)),
              history: [],
            }));
          }
        }
        await same(`${path}: checks`, async (e) => {
          const { durationMs: _d, ...run } = await e.awaitJob<CheckSummary>(await e.runChecks(id));
          return run;
        });
        await same(`${path}: issues`, async (e) => (await e.listIssues({ datasetId: id, limit: 1000 })).items);
      }
      // A layout named in the settings is read as named, or refused when the file does not hold it.
      const api = { kind: 'path' as const, path: fixturePath('json_api_wrapper_nested.json') };
      const lines = { kind: 'path' as const, path: fixturePath('jsonl_well_tests_crlf.jsonl') };
      await same('the records member named', (e) => e.sniff(api, json('member', 'data')));
      await same('a member that is missing', (e) => e.sniff(api, json('member', 'missing')));
      await same('a member that holds no records', (e) => e.sniff(api, json('member', 'meta')));
      await same('an object read as lines', (e) => e.sniff(api, json('lines')));
      await same('lines read as an array', (e) => e.sniff(lines, json('array')));
      await same('lines read as lines', (e) => e.sniff(lines, json('lines')));
      for (const [name] of broken) {
        const file = { kind: 'path' as const, path: join(folder, name) };
        await same(`${name}: preview`, (e) => e.sniff(file));
        const refusal = await same(`${name}: import`, async (e) =>
          e.awaitJob<DatasetSummary>(await e.importFile(file)),
        );
        expect(refusal, `${name} is refused`).toMatchObject({ code: expect.any(String) });
      }
      // Overrides read the JSON file again, and reading settings do not apply to it.
      const override = (property: string, value: unknown, columnId?: string) => (e: EngineClient) =>
        e.decide({
          kind: 'override_detection',
          datasetId: 'd1',
          property,
          value,
          reason: 'Checked against the source system',
          ...(columnId === undefined ? {} : { columnId }),
        } as Decision);
      const { columns } = await lite.getSchema('d1');
      const numeric = columns.find((c) => c.type.value === 'number');
      expect(numeric, 'a number column to read as text').toBeDefined();
      await same('a column read as text', async (e) => (await override('type', 'string', numeric?.id)(e)).map(content));
      await same('a reading setting', async (e) => override('delimiter', ';')(e));
      await same('rows after the overrides', async (e) => allRows(e, 'd1'));
      await same('schema after the overrides', (e) => e.getSchema('d1'));
      // The project file opens to the same state in both engines.
      const saved = await nat.client.awaitJob<SaveResult>(await nat.client.saveProject());
      const { report, opened } = await openNatively(saved.bytes as Uint8Array);
      try {
        expect(report.checks.filter((c) => !c.ok)).toEqual([]);
        await sameState(opened.client, lite);
      } finally {
        stopNative(opened);
      }
    } finally {
      stopNative(nat);
      lite.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('reads Excel workbooks the same way: sheets, tables, headers, cell types, choices, overrides and refusals', async () => {
    // Shared strings: rich text with a phonetic guide and an escaped line break among them.
    const strings = [
      'Monthly report',
      'Well',
      'Date',
      'Rate',
      'Flag',
      '[bbl/d]',
      'W-1',
      'W-2',
      '<r><t>Ri</t></r><r><t xml:space="preserve">ch </t></r><rPh sb="0" eb="1"><t>ignored</t></rPh><r><t>W_x000D_3</t></r>',
      'A note',
      'Other',
      'Value',
    ];
    // A title merged across the table, a units row, a merged data cell, rows and cells out of
    // order or without references, booleans, errors, formulas with and without a cached result,
    // ISO dates, dates and times by number format, and a second table after a gap.
    const edge = [
      `<row r="1">${cell('A1', val(0), ' t="s"')}</row>`,
      `<row r="3">${['A3', 'B3', 'C3', 'D3'].map((r, i) => cell(r, val(i + 1), ' t="s"')).join('')}</row>`,
      `<row r="4">${cell('C4', val(5), ' t="s"')}</row>`,
      `<row r="5">${cell('A5', val(6), ' t="s"')}${cell('B5', val(45000), ' s="1"')}${cell('C5', val(1250.5))}${cell('D5', val(1), ' t="b"')}</row>`,
      `<row r="7">${cell('D7', val('#DIV/0!'), ' t="e"')}${cell('C7', `<f>C5*2</f>${val(2501)}`)}${cell('B7', val('2023-03-17T06:30:00Z'), ' t="d"')}${cell('A7', '<is><t>W_x005F_x0041_ inline</t></is>', ' t="inlineStr"')}</row>`,
      `<row r="6">${cell('A6', val(7), ' t="s"')}${cell('B6', val(45001.25), ' s="2"')}<c r="C6"><f>C5+1</f></c>${cell('D6', val('true'), ' t="b"')}</row>`,
      `<row r="8"><c t="s">${val(8)}</c><c s="1">${val(45003)}</c><c>${val('  12.5 ')}</c><c t="str">${val('maybe')}</c></row>`,
      `<row r="9">${cell('A9', val(6), ' t="s"')}${cell('B9', val(45004), ' s="1"')}${cell('C9', val(1300))}${cell('D9', val(0), ' t="b"')}</row>`,
      `<row r="10">${cell('A10', val(7), ' t="s"')}${cell('B10', val('2023-03-19'), ' t="d"')}${cell('C10', val('1e3'))}${cell('D10', val(' '), ' t="str"')}</row>`,
      `<row r="14">${cell('A14', val(10), ' t="s"')}${cell('B14', val(11), ' t="s"')}</row>`,
      `<row r="15">${cell('A15', val(9), ' t="s"')}${cell('B15', val(1))}</row>`,
      `<row r="16">${cell('A16', val(9), ' t="s"')}${cell('B16', val(2))}</row>`,
    ].join('');
    const generated: [string, Uint8Array][] = [
      [
        'edge.xlsx',
        handWorkbook(
          [
            {
              name: 'Data',
              xml: `<sheetData>${edge}</sheetData><mergeCells><mergeCell ref="A1:D1"/><mergeCell ref="A9:A10"/></mergeCells>`,
            },
          ],
          { strings, numFmts: '<numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/>', xfs: [0, 14, 164] },
        ),
      ],
      // A hidden sheet with a table, an empty sheet, a chart sheet, and the data on a sheet whose
      // name needs quotes in a locator and whose part is named by an escaped absolute target.
      [
        'sheets.xlsx',
        handWorkbook(
          [
            {
              name: 'Lookup',
              state: 'hidden',
              xml: `<sheetData><row r="1">${cell('A1', val(1), ' t="s"')}${cell('B1', val(3), ' t="s"')}</row><row r="2">${cell('A2', val(6), ' t="s"')}${cell('B2', val(1))}</row><row r="3">${cell('A3', val(7), ' t="s"')}${cell('B3', val(2))}</row></sheetData>`,
            },
            { name: 'Empty' },
            { name: 'Chart', chart: true },
            {
              name: "Well 'A' data",
              target: '/xl/worksheets/data%20sheet.xml',
              xml: `<sheetData><row r="2">${cell('B2', val(1), ' t="s"')}${cell('C2', val(2), ' t="s"')}</row><row r="3">${cell('B3', val(6), ' t="s"')}${cell('C3', val(45010))}</row><row r="4">${cell('B4', val(7), ' t="s"')}${cell('C4', val(45011))}</row></sheetData>`,
            },
          ],
          { date1904: true, strings },
        ),
      ],
      [
        'no-table.xlsx',
        handWorkbook(
          [{ name: 'Only', xml: `<sheetData><row r="2">${cell('B2', val(9), ' t="s"')}</row></sheetData>` }],
          { strings },
        ),
      ],
    ];
    // What is not a workbook, or a damaged one.
    const valid = handWorkbook([{ name: 'D' }]);
    const broken: [string, Uint8Array][] = [
      ['no-workbook.xlsx', writeZip([{ path: 'word/document.xml', data: new TextEncoder().encode('<document/>') }])],
      [
        'bad-xml.xlsx',
        handWorkbook([{ name: 'Bad', xml: '<sheetData><row r="1"><c r="A1"><v>1</c></row></sheetData>' }]),
      ],
      [
        'missing-string.xlsx',
        handWorkbook([{ name: 'S', xml: `<sheetData><row r="1">${cell('A1', val(99), ' t="s"')}</row></sheetData>` }], {
          strings,
        }),
      ],
      ['doctype.xlsx', handWorkbook([{ name: 'D', prolog: '<!DOCTYPE worksheet [<!ENTITY x "y">]>' }])],
      [
        'bad-reference.xlsx',
        handWorkbook([{ name: 'R', xml: `<sheetData><row r="1">${cell('A0', val(1))}</row></sheetData>` }]),
      ],
      ['truncated.xlsx', valid.slice(0, valid.length - 30)],
      ['compound-header.xls', readFileSync(fixturePath('xls_date1904.xls')).subarray(0, 512)],
    ];
    const folder = mkdtempSync(join(tmpdir(), 'tw-xlsx-'));
    for (const [name, bytes] of [...generated, ...broken]) writeFileSync(join(folder, name), bytes);
    const nat = startNative(['--fixed-clock', START, '--seed', '1', '--owner', 'Prasad']);
    const lite = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
    // Why an XML parser stopped is worded by the parser, so that reason is left out.
    const settle = (run: () => Promise<unknown>) =>
      run().then(
        (v) => v,
        (err: { code: string; message: string; fix: string }) => ({
          code: err.code,
          message: err.message.replace(/is not well-formed XML \(.*\)\.$/s, 'is not well-formed XML (…).'),
          fix: err.fix,
        }),
      );
    const same = async (why: string, run: (e: EngineClient) => Promise<unknown>) => {
      const [a, b] = [await settle(() => run(nat.client)), await settle(() => run(lite))];
      expect(a, why).toEqual(b);
      return a;
    };
    try {
      for (const e of [nat.client, lite]) await e.newProject({ name: 'Workbooks', profile: { ...PROFILE } });
      const files = [...EXCEL_FIXTURES.map((n) => fixturePath(n)), ...generated.map(([name]) => join(folder, name))];
      for (const [i, path] of files.entries()) {
        const file = { kind: 'path' as const, path };
        const id = `d${i + 1}`;
        await same(`${path}: preview`, (e) => e.sniff(file));
        await same(`${path}: import`, async (e) => e.awaitJob<DatasetSummary>(await e.importFile(file)));
        await same(`${path}: schema`, (e) => e.getSchema(id));
        await same(`${path}: rows`, async (e) => allRows(e, id));
        const { columns } = await lite.getSchema(id);
        for (const c of columns) {
          for (const row of [0, 1, 2, 3, 4]) {
            await same(`${path}: lineage of ${c.id} row ${row}`, async (e) => ({
              ...(await e.explainCell(id, row, c.id)),
              history: [],
            }));
          }
        }
        await same(`${path}: checks`, async (e) => {
          const { durationMs: _d, ...run } = await e.awaitJob<CheckSummary>(await e.runChecks(id));
          return run;
        });
        await same(`${path}: issues`, async (e) => (await e.listIssues({ datasetId: id, limit: 1000 })).items);
      }
      for (const [name] of broken) {
        const file = { kind: 'path' as const, path: join(folder, name) };
        await same(`${name}: preview`, (e) => e.sniff(file));
        const refusal = await same(`${name}: import`, async (e) =>
          e.awaitJob<DatasetSummary>(await e.importFile(file)),
        );
        expect(refusal, `${name} is refused`).toMatchObject({ code: expect.any(String) });
      }
      // Another table or sheet chosen in the settings is read with its own header rows.
      const edgeFile = { kind: 'path' as const, path: join(folder, 'edge.xlsx') };
      const sheetsFile = { kind: 'path' as const, path: join(folder, 'sheets.xlsx') };
      const xlsx = async (file: typeof edgeFile) => {
        const o = (await lite.sniff(file)).sniff.options;
        if (o.format !== 'xlsx') throw new Error('not a workbook');
        return o;
      };
      const base = await xlsx(edgeFile);
      for (const [why, change] of [
        ['the second table', { tableIndex: 1 }],
        ['header rows given', { headerRowStart: 2, headerRowEnd: 2, dataStartRow: 4, firstCol: 0, lastCol: 2 }],
        ['a missing sheet', { sheet: 'Nope' }],
        ['impossible rows', { dataStartRow: 1 }],
      ] as const) {
        const options = { ...base, xlsx: { ...base.xlsx, ...change } };
        await same(`edge.xlsx: ${why}`, (e) => e.sniff(edgeFile, { options }));
      }
      const sheetsBase = await xlsx(sheetsFile);
      for (const sheet of ['Lookup', 'Empty', 'Chart']) {
        const options = { ...sheetsBase, xlsx: { ...sheetsBase.xlsx, sheet, tableIndex: 0 } };
        await same(`sheets.xlsx: the sheet ${sheet}`, (e) => e.sniff(sheetsFile, { options }));
      }
      // Overrides read the workbook again with the table or sheet chosen.
      const edgeId = `d${EXCEL_FIXTURES.length + 1}`;
      const override = (property: string, value: unknown) => (e: EngineClient) =>
        e.decide({
          kind: 'override_detection',
          datasetId: edgeId,
          property,
          value,
          reason: 'Checked against the source system',
        } as Decision);
      for (const [why, property, value] of [
        ['the second table', 'tableIndex', 1],
        ['a reading setting of text files', 'delimiter', ';'],
        ['the first table again', 'tableIndex', 0],
        ['a sheet the workbook does not have', 'sheet', 'Nope'],
      ] as const) {
        await same(`override: ${why}`, async (e) => {
          const out = await override(property, value)(e);
          return out.map(content);
        });
        await same(`rows after ${why}`, async (e) => allRows(e, edgeId));
        await same(`schema after ${why}`, (e) => e.getSchema(edgeId));
      }
      // A table chosen in the import settings is imported as detected, then read with the
      // choice, which the log records as an override with its reason.
      const chosen = { options: { ...base, xlsx: { ...base.xlsx, tableIndex: 1 } } };
      await same('an import with another table chosen and no reason', async (e) =>
        e.awaitJob<DatasetSummary>(await e.importFile(edgeFile, chosen)),
      );
      const summary = await same('an import with another table chosen', async (e) =>
        e.awaitJob<DatasetSummary>(
          await e.importFile(edgeFile, { ...chosen, overrideReason: 'The second table holds the readings' }),
        ),
      );
      expect(summary).not.toHaveProperty('code');
      const chosenId = (summary as DatasetSummary).id;
      await same('the choice in the log', async (e) =>
        (await e.listAudit({ action: ['detection.override'], order: 'desc', limit: 1 })).items.map(content),
      );
      await same('rows of the chosen table', async (e) => allRows(e, chosenId));
      await same('schema of the chosen table', (e) => e.getSchema(chosenId));
      // The project file opens to the same state in both engines.
      const saved = await nat.client.awaitJob<SaveResult>(await nat.client.saveProject());
      const { report, opened } = await openNatively(saved.bytes as Uint8Array);
      try {
        expect(report.checks.filter((c) => !c.ok)).toEqual([]);
        await sameState(opened.client, lite);
      } finally {
        stopNative(opened);
      }
    } finally {
      stopNative(nat);
      lite.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('overrides detection the same way: columns, reading settings, imports, templates, reverts and refusals', async () => {
    const golden = { kind: 'path' as const, path: fixturePath('csv_well_daily_golden.csv') };
    const semicolon = { kind: 'path' as const, path: fixturePath('csv_semicolon_decimalcomma_cp1252.csv') };
    // A template that renames the first column and reads pressure in kPa.
    const plain = await reference.sniff(golden, { template: null });
    const templates: MappingTemplate[] = [
      {
        id: 'mt_0000000000f1',
        name: 'Field names',
        savedFrom: { fileName: 'csv_well_daily_golden.csv', format: 'csv' },
        columns: plain.columns.map((c, i) => ({
          sourceHeader: [...c.sourceHeader],
          name: i === 0 ? 'Well' : c.name,
          type: c.type.value,
          unit: i === 4 ? 'kPa' : c.unit.value,
          role: c.role.value,
          nullMarkers: [...c.nullMarkers.value],
          ...(c.dateFormat === undefined ? {} : { dateFormat: c.dateFormat.value }),
          ...(c.timezone === undefined ? {} : { timezone: c.timezone.value }),
        })),
        savedAt: '2026-01-01T00:00:00.000Z',
        savedBy: 'Prasad',
      },
    ];
    const home = mkdtempSync(join(tmpdir(), 'tw-overrides-'));
    const store = join(home, 'mapping-templates.json');
    writeFileSync(store, JSON.stringify({ format: 'tracewell-mapping-templates', version: 1, templates }));
    const nat = startNative(['--fixed-clock', START, '--seed', '1', '--owner', 'Prasad', '--templates', store]);
    const lite = new EngineClient(
      inProcessTransport(
        new LocalEngine({
          appVersion: '0.1.0',
          owner: 'Prasad',
          clock: fixedClock(START),
          ids: seededIds(1),
          fs: nodeFs(),
          templates: { load: () => Promise.resolve(structuredClone(templates)), save: () => Promise.resolve() },
        }),
      ),
    );
    const settle = (run: () => Promise<unknown>) =>
      run().then(
        (v) => v,
        (err: { code: string; message: string }) => ({ code: err.code, message: err.message }),
      );
    const each = async (run: (e: EngineClient) => Promise<unknown>) => [
      await settle(() => run(nat.client)),
      await settle(() => run(lite)),
    ];
    /** Both engines show the same project: datasets, schemas, rows, issues, health and log. */
    const agree = async (why: string) => {
      await sameState(nat.client, lite);
      for (const d of (await lite.getProject()).datasets) {
        expect(await nat.client.getSchema(d.id), `${why}: schema of ${d.id}`).toEqual(await lite.getSchema(d.id));
      }
      expect((await allAudit(nat.client)).map(content), `${why}: log`).toEqual((await allAudit(lite)).map(content));
    };
    // Entries are compared without when they were written, which each engine's clock decides.
    const timeless = (v: unknown) =>
      Array.isArray(v)
        ? v.map((x: unknown) => (typeof x === 'object' && x !== null && 'hash' in x ? content(x as AuditEntry) : x))
        : v;
    const same = async (why: string, run: (e: EngineClient) => Promise<unknown>) => {
      const [a, b] = await each(run);
      expect(timeless(a), why).toEqual(timeless(b));
      await agree(why);
      return a;
    };
    /** The same as `same`, for a change both engines must make rather than refuse. */
    const done = async (why: string, run: (e: EngineClient) => Promise<unknown>) => {
      const a = await same(why, run);
      expect(a, why).not.toHaveProperty('code');
      return a;
    };
    const imported =
      (file: typeof golden, o: ImportRequestOptions = {}) =>
      (e: EngineClient) =>
        (async () => e.awaitJob<DatasetSummary>(await e.importFile(file, o)))();
    const override =
      (
        datasetId: string,
        property: Extract<Decision, { kind: 'override_detection' }>['property'],
        value: unknown,
        columnId?: string,
        reason = 'Checked against the well file',
      ) =>
      (e: EngineClient) =>
        e.decide({
          kind: 'override_detection',
          datasetId,
          property,
          value: value as never,
          reason,
          ...(columnId === undefined ? {} : { columnId }),
        } as Decision);
    try {
      for (const e of [nat.client, lite]) await e.newProject({ name: 'Overrides', profile: { ...PROFILE } });

      // The template that fits the file is recorded as overrides after the import.
      await done('import through a template', imported(golden));
      const fromTemplate = (await allAudit(nat.client)).filter((e) => e.action === 'detection.override');
      expect(fromTemplate.map((e) => [e.target.columnId, e.payload])).toEqual([
        ['c0', { property: 'name' }],
        ['c4', { property: 'unit' }],
      ]);
      await done('checks', async (e) => {
        const { durationMs: _d, ...run } = await e.awaitJob<CheckSummary>(await e.runChecks('d1'));
        return run;
      });

      // Column overrides change how a column is read; the rows stay, the checks run again.
      await done('name', override('d1', 'name', 'Reading time', 'c1'));
      await done('role', override('d1', 'role', 'measure', 'c2'));
      const retyped = (await done('type', override('d1', 'type', 'string', 'c3'))) as AuditEntry[];
      await done('null markers', override('d1', 'nullMarkers', ['2430.2'], 'c6'));
      await done('date format', override('d1', 'dateFormat', 'dmy', 'c1'));
      await done('time zone', override('d1', 'timezone', 'utc', 'c1'));
      await done('unit', override('d1', 'unit', 'degC', 'c5'));
      await done('no unit', override('d1', 'unit', null, 'c8'));
      await done('coordinate system', override('d1', 'crs', { code: 'EPSG:27700', source: 'user' }));
      await done('revert the type', (e) =>
        e.decide({ kind: 'revert', seq: (retyped[0] as AuditEntry).seq, reason: 'Longitude is a number' }),
      );

      // A cell's lineage lists the overrides of its column.
      for (const column of ['c1', 'c3', 'c6']) {
        const [a, b] = await each((e) => e.explainCell('d1', 3, column));
        const shape = (x: unknown) => ({
          ...(x as object),
          history: (x as { history: { at: string }[] }).history.map(({ at: _a, ...rest }) => rest),
        });
        expect(shape(a), `lineage of ${column}`).toEqual(shape(b));
        expect((a as { history: unknown[] }).history.length, column).toBeGreaterThan(0);
      }

      // Refusals give the same code and message.
      await same('unknown unit', override('d1', 'unit', 'furlong', 'c4'));
      await same('unknown type', override('d1', 'type', 'blob', 'c4'));
      await same('unknown column', override('d1', 'name', 'X', 'c99'));
      await same('unknown dataset', override('d9', 'name', 'X', 'c0'));
      await same('no reason', override('d1', 'name', 'X', 'c0', ' '));
      await same('a workbook setting', override('d1', 'sheet', 'Sheet1'));
      const excluded = (await done('exclude', (e) =>
        e.decide({ kind: 'exclude_rows', datasetId: 'd1', rows: [0], reason: 'Commissioning test' }),
      )) as AuditEntry[];
      await same('a reading setting over work', override('d1', 'delimiter', ';'));
      await done('revert the exclusion', (e) =>
        e.decide({ kind: 'revert', seq: (excluded[0] as AuditEntry).seq, reason: 'The record is real' }),
      );

      // Reading settings plan the whole file again and read it into new rows.
      await done('import a semicolon file', imported(semicolon));
      await done('checks of d2', async (e) => {
        const { durationMs: _d, ...run } = await e.awaitJob<CheckSummary>(await e.runChecks('d2'));
        return run;
      });
      await same('a decimal separator that clashes', override('d2', 'decimalSeparator', '.'));
      const decimal = (await done('decimal separator', override('d1', 'decimalSeparator', ','))) as AuditEntry[];
      await done('revert the decimal separator', (e) =>
        e.decide({ kind: 'revert', seq: (decimal[0] as AuditEntry).seq, reason: 'The file uses points' }),
      );
      await done('lines to skip', override('d2', 'skipLines', 1));
      await done('header rows', override('d2', 'headerRows', 0));
      await done('encoding', override('d2', 'encoding', 'utf-8'));
      await done('delimiter', override('d1', 'delimiter', ';'));
      await same('an invalid delimiter', override('d2', 'delimiter', ':'));

      // An import with the user's settings and column overrides records them, with the reason.
      const { options } = (await reference.sniff(semicolon, { template: null })).sniff;
      if (options.format !== 'csv') throw new Error('The semicolon fixture is not read as CSV.');
      const chosen = { ...options, csv: { ...options.csv, headerRows: 2, skipLines: 1 } };
      await same('settings without a reason', imported(semicolon, { options: chosen }));
      await same(
        'an override of a column the file lacks',
        imported(semicolon, { columnOverrides: [{ columnId: 'c99', name: 'X' }], overrideReason: 'Site names' }),
      );
      await done(
        'settings and overrides',
        imported(semicolon, {
          options: chosen,
          columnOverrides: [{ columnId: 'c0', name: 'Site', role: 'id' }],
          overrideReason: 'The export has two header rows',
        }),
      );

      // Both engines open the native engine's project file to the same state.
      const saved = await nat.client.awaitJob<SaveResult>(await nat.client.saveProject());
      const bytes = saved.bytes as Uint8Array;
      const opener = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
      const { report, opened } = await openNatively(bytes);
      try {
        const tsReport = await opener.awaitJob<ProjectOpenReport>(
          await opener.openProject({ kind: 'bytes', bytes, name: saved.fileName }),
        );
        expect(tsReport.checks.filter((c) => !c.ok)).toEqual([]);
        expect(report.checks.filter((c) => !c.ok)).toEqual([]);
        expect(report.readOnly).toBe(false);
        await sameState(opened.client, opener);
        await sameState(opened.client, nat.client);
      } finally {
        stopNative(opened);
        opener.close();
      }

      // An edit is stored in its column's storage type, so the native engine refuses a type change
      // that would store the edited column differently, rather than show the edit differently.
      await nat.client.decide({
        kind: 'edit_cell',
        datasetId: 'd3',
        rowId: 0,
        columnId: 'c0',
        value: { text: 'DE-08' },
        reason: 'Typo in the site name',
      });
      await expect(override('d3', 'type', 'number', 'c0')(nat.client)).rejects.toMatchObject({
        code: 'PROTOCOL_MISMATCH',
        message: expect.stringContaining('a column with edits'),
      });
    } finally {
      stopNative(nat);
      lite.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('saves, plans and runs recipes the same way, with the same deltas and refusals', async () => {
    const golden = pairs.get('csv_well_daily_golden.csv') as { nat: string; ref: string };
    const dates = pairs.get('csv_dates_ambiguous_and_mixed.csv') as { nat: string; ref: string };
    // The second import of the golden file (from the statistics test) is the recipe's new data.
    const second = async (e: EngineClient, first: string) =>
      (await e.getProject()).datasets
        .filter((d) => d.source.fileName === 'csv_well_daily_golden.csv' && d.id !== first)
        .at(-1)?.id as string;
    const next = { nat: await second(native.client, golden.nat), ref: await second(reference, golden.ref) };
    const strip = (r: Recipe) => ({ ...r, savedAt: '' });
    const refused = async (run: (e: EngineClient, side: 'nat' | 'ref') => Promise<unknown>) => {
      const out: unknown[] = [];
      for (const [e, side] of [
        [native.client, 'nat'],
        [reference, 'ref'],
      ] as const) {
        out.push(
          await run(e, side).then(
            () => 'accepted',
            (err: { code: string; message: string }) => [err.code, err.message],
          ),
        );
      }
      expect(out[0]).toEqual(out[1]);
      expect(out[0]).not.toBe('accepted');
    };
    const options = { name: 'Monthly wells', export: { profile: 'parquet' as const, neutralizeFormulas: false } };
    const [a, b] = [
      await native.client.saveRecipe({ datasetId: golden.nat, ...options }),
      await reference.saveRecipe({ datasetId: golden.ref, ...options }),
    ];
    expect({ ...strip(a.recipe), fileName: a.fileName }).toEqual({ ...strip(b.recipe), fileName: b.fileName });
    expect(JSON.parse(new TextDecoder().decode(a.bytes))).toEqual(a.recipe);
    const file = (r: { bytes: Uint8Array; fileName: string }) => ({
      kind: 'bytes' as const,
      bytes: r.bytes,
      name: r.fileName,
    });

    // The plan: on new data it fits; on a dataset without those columns it does not.
    const plan = async (on: { nat: string; ref: string }) => {
      const [x, y] = [await native.client.planRecipe(on.nat, file(a)), await reference.planRecipe(on.ref, file(b))];
      const shape = (pl: RecipePlan) => ({ ...pl, recipe: strip(pl.recipe), datasetId: '' });
      expect(shape(x)).toEqual(shape(y));
      return x;
    };
    expect((await plan(next)).fits).toBe(true);
    expect((await plan(dates)).fits).toBe(false);

    // Run on the new data: the same steps, checks and comparison with the baseline.
    const run = async (e: EngineClient, datasetId: string, f: ReturnType<typeof file>) =>
      e.awaitJob<RecipeRun>(await e.applyRecipe(datasetId, f, 'December figures from the historian'));
    const [x, y] = [await run(native.client, next.nat, file(a)), await run(reference, next.ref, file(b))];
    expect({ ...x, datasetId: '' }).toEqual({ ...y, datasetId: '' });
    await samePair(next.nat, next.ref, 'recipe run');
    for (const delta of [['new'], ['changed'], ['unchanged'], ['new', 'changed']] as const) {
      const list = async (e: EngineClient, datasetId: string) =>
        (await e.listIssues({ datasetId, delta: [...delta], limit: 1000 })).items.map(comparableIssue);
      expect(await list(native.client, next.nat), delta.join()).toEqual(await list(reference, next.ref));
    }
    // Saved again from the dataset it ran on: the next version.
    const again = await native.client.saveRecipe({ datasetId: next.nat, ...options });
    const againRef = await reference.saveRecipe({ datasetId: next.ref, ...options });
    expect(strip(again.recipe)).toEqual(strip(againRef.recipe));
    expect(again.recipe.version).toBe(2);

    await refused((e, side) => e.saveRecipe({ datasetId: golden[side], name: '  ', export: null }));
    await refused((e, side) =>
      e.saveRecipe({
        datasetId: golden[side],
        name: 'X',
        export: { profile: 'pdf' as never, neutralizeFormulas: false },
      }),
    );
    await refused((e, side) =>
      e.planRecipe(golden[side], { kind: 'bytes', bytes: new TextEncoder().encode('{nope'), name: 'bad.twr' }),
    );
    const tampered = { ...a.recipe, name: 'Weekly wells' };
    await refused((e, side) =>
      e.planRecipe(golden[side], {
        kind: 'bytes',
        bytes: new TextEncoder().encode(JSON.stringify(tampered)),
        name: 'w.twr',
      }),
    );
    await refused(async (e, side) => run(e, dates[side], file(side === 'nat' ? a : b)));
  });

  it('saves a project file that the TypeScript engine opens with every check passing', async () => {
    // A second check run of d1: its saved results stand in for both runs when the file is opened.
    await native.client.awaitJob<CheckSummary>(await native.client.runChecks('d1'));
    const saved = await native.client.awaitJob<SaveResult>(await native.client.saveProject());
    expect(saved.fileName).toBe('Parity.twp');
    const bytes = saved.bytes as Uint8Array;
    savedByNative = bytes;
    expect(saved.size).toBe(bytes.byteLength);
    const zip = readZip(bytes);
    const manifest = JSON.parse(zip.readText('manifest.json')) as ProjectManifest;
    expect(manifest.formatVersion).toBe('0.2');
    const caches = (kind: string) => (manifest.caches ?? []).filter((c) => c.kind === kind);
    for (const kind of ['rows', 'exceptions', 'notes']) expect(caches(kind)).toHaveLength(manifest.datasets.length);
    // One issues cache per checked dataset, after the last entry that could change its issues.
    const log = await allAudit(native.client);
    const checked = new Set(log.filter((e) => e.action === 'check.run').map((e) => e.target.datasetId));
    const after = new Map<unknown, unknown>();
    for (const id of checked) {
      const last = log.filter(
        (e) =>
          e.target.datasetId === id ||
          e.action === 'project.area' ||
          (e.action === 'entry.revert' && e.target.datasetId === undefined),
      );
      after.set(id, last[last.length - 1]?.seq);
    }
    expect(after.size).toBeGreaterThan(1);
    expect(new Map(caches('issues').map((c) => [c.datasetId, c.afterSeq]))).toEqual(after);

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

  /** Everything a user sees of the datasets, issues, decisions and health, the same in both engines. */
  const sameState = async (a: EngineClient, b: EngineClient) => {
    const [pa, pb] = [await a.getProject(), await b.getProject()];
    expect(pa.projectArea).toEqual(pb.projectArea);
    const shape = (p: typeof pa) => p.datasets.map((d) => [d.id, d.rowCount, d.outputRowCount]);
    expect(shape(pa)).toEqual(shape(pb));
    // What an open found wrong with its file (TW-PRJ) is the opened project's own, compared apart.
    const issuesOf = async (e: EngineClient) =>
      (await e.listIssues({ limit: 1000 })).items.filter((i) => !i.ruleId.startsWith('TW-PRJ'));
    const [ia, ib] = [await issuesOf(a), await issuesOf(b)];
    expect(ia).toEqual(ib);
    const page = { offset: 0, limit: 1000 };
    for (const i of ia) {
      expect((await a.listOccurrences(i.id, page)).items, i.ruleId).toEqual(
        (await b.listOccurrences(i.id, page)).items,
      );
    }
    for (const d of pa.datasets) {
      expect(await a.getHealth(d.id)).toEqual(await b.getHealth(d.id));
      expect(await allRows(a, d.id), d.id).toEqual(await allRows(b, d.id));
    }
  };

  it('opens its own project file from the saved working data, with the same log and issues', async () => {
    const { report, opened } = await openNatively(savedByNative as Uint8Array);
    try {
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.readOnly).toBe(false);
      const detail = report.checks.find((c) => c.id === 'replay-digest')?.detail;
      expect(detail).toContain('restored from their saved working data');
      expect(detail).toContain('Their issues were restored from the saved check results.');
      // The TypeScript engine's report on the same file reads the same, but for how the datasets were rebuilt.
      const ts = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
      try {
        const tsReport = await ts.awaitJob<ProjectOpenReport>(
          await ts.openProject({ kind: 'bytes', bytes: savedByNative as Uint8Array, name: 'Parity.twp' }),
        );
        const shape = (r: ProjectOpenReport) =>
          r.checks.map((c) => (c.id === 'replay-digest' ? { ...c, detail: '' } : c));
        expect(shape(report)).toEqual(shape(tsReport));
      } finally {
        ts.close();
      }
      expect(await allAudit(opened.client)).toEqual(await allAudit(native.client));
      await sameState(opened.client, native.client);
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
      // Replaying the reference engine's decisions, with the checks run again, ends where it did.
      await sameState(opened.client, reference);
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
      await sameFindings(opened.client, bytes, 'TW-PRJ-004', report);
    } finally {
      stopNative(opened);
    }
  });

  /**
   * What an open found wrong with a project file is listed as issues of the system rule pack, one
   * per rule, as the TypeScript engine lists them when it opens the same file.
   */
  const sameFindings = async (
    opened: EngineClient,
    bytes: Uint8Array,
    ruleId: string,
    nativeReport: ProjectOpenReport,
  ) => {
    const ts = await (ENGINE_FACTORIES['tracewell-ts'] as () => Promise<EngineClient>)();
    try {
      const report = await ts.awaitJob<ProjectOpenReport>(
        await ts.openProject({ kind: 'bytes', bytes, name: 'Parity.twp' }),
      );
      expect(report.readOnly).toBe(true);
      // The open reports agree check for check; only a passed replay says how the native engine
      // rebuilt the datasets (from its saved working data, or from the originals).
      const shape = (r: ProjectOpenReport) =>
        r.checks.map((c) => (c.id === 'replay-digest' && c.ok ? { ...c, detail: '' } : c));
      expect(shape(nativeReport)).toEqual(shape(report));
      const findings = async (e: EngineClient) =>
        (await e.listIssues({ limit: 1000 })).items.filter((i) => i.ruleId.startsWith('TW-PRJ'));
      const [a, b] = [await findings(opened), await findings(ts)];
      expect(a).toEqual(b);
      expect(a.map((i) => i.ruleId)).toContain(ruleId);
      for (const i of a) expect((await opened.listOccurrences(i.id, { offset: 0, limit: 10 })).total).toBe(0);
    } finally {
      ts.close();
    }
  };

  it('opens a project file whose original was changed read-only, with the same TW-PRJ-001 issue', async () => {
    const bytes = (savedByNative as Uint8Array).slice();
    const zip = readZip(bytes);
    const original = zip.paths().find((e) => e.startsWith('originals/')) as string;
    const content = zip.read(original);
    const at = new TextDecoder('latin1')
      .decode(bytes)
      .indexOf(new TextDecoder('latin1').decode(content.subarray(0, 64)));
    expect(at).toBeGreaterThan(0);
    bytes[at + 10] = (bytes[at + 10] as number) ^ 0x01;
    const { report, opened } = await openNatively(bytes);
    try {
      expect(report.readOnly).toBe(true);
      await sameFindings(opened.client, bytes, 'TW-PRJ-001', report);
    } finally {
      stopNative(opened);
    }
  });

  it('runs the checks again when the saved check results are damaged, and raises the same issues', async () => {
    const bytes = (savedByNative as Uint8Array).slice();
    const path = 'data/d1/issues.json';
    const latin1 = new TextDecoder('latin1');
    const text = latin1.decode(readZip(bytes).read(path));
    const at = latin1.decode(bytes).indexOf(text) + text.indexOf('"datasetId":"d1"');
    expect(at).toBeGreaterThan(0);
    bytes[at + 14] = '9'.charCodeAt(0);
    const { report, opened } = await openNatively(bytes);
    try {
      expect(report.readOnly).toBe(true);
      expect(report.checks.filter((c) => !c.ok).map((c) => [c.id, c.target])).toEqual([['entry-checksum', path]]);
      const replay = report.checks.find((c) => c.id === 'replay-digest');
      expect(replay?.ok).toBe(true);
      expect(replay?.detail).toContain('and 2 recorded check runs ran again');
      const issues = async (e: EngineClient) =>
        (await e.listIssues({ limit: 1000 })).items.filter((i) => !i.ruleId.startsWith('TW-PRJ'));
      expect(await issues(opened.client)).toEqual(await issues(native.client));
      await sameFindings(opened.client, bytes, 'TW-PRJ-004', report);
    } finally {
      stopNative(opened);
    }
  });

  it('replays the decisions with the checks run again when a dataset has no usable saved results', async () => {
    const { nat } = pairs.get('csv_duplicates_rows_and_keys.csv') as { nat: string };
    const bytes = (savedByNative as Uint8Array).slice();
    const path = `data/${nat}/issues.json`;
    const latin1 = new TextDecoder('latin1');
    const text = latin1.decode(readZip(bytes).read(path));
    const at = latin1.decode(bytes).indexOf(text) + text.indexOf('"rowCount":') + '"rowCount":'.length;
    expect(at).toBeGreaterThan(0);
    bytes[at] = '9'.charCodeAt(0);
    const { report, opened } = await openNatively(bytes);
    try {
      expect(report.checks.filter((c) => !c.ok).map((c) => [c.id, c.target])).toEqual([['entry-checksum', path]]);
      expect(report.checks.find((c) => c.id === 'replay-digest')).toMatchObject({ ok: true });
      await sameState(opened.client, native.client);
      await sameFindings(opened.client, bytes, 'TW-PRJ-004', report);
    } finally {
      stopNative(opened);
    }
  });

  it('lists the same rule packs and units', async () => {
    expect(await native.client.listRulePacks()).toEqual(await reference.listRulePacks());
    for (const q of [
      undefined,
      { quantity: 'pressure_abs' as const },
      { compatibleWith: 'psia' },
      { compatibleWith: 'bbl/d', quantity: 'volume_rate' as const },
    ]) {
      expect(await native.client.listUnits(q), JSON.stringify(q)).toEqual(await reference.listUnits(q));
    }
    const refusal = async (e: EngineClient) =>
      e.listUnits({ compatibleWith: 'furlong' }).then(
        () => 'accepted',
        (err: { code: string; message: string }) => [err.code, err.message],
      );
    expect(await refusal(native.client)).toEqual(await refusal(reference));
  });

  it('recovers unsaved work after a crash, only from an engine that has ended', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'tw-recovery-'));
    const home = mkdtempSync(join(tmpdir(), 'tw-userfiles-'));
    const args = ['--fixed-clock', START, '--seed', '1', '--threads', '2', '--owner', 'Prasad', '--recovery', folder];
    const crash = async (n: NativeProcess) => {
      const gone = new Promise((r) => n.child.once('exit', r));
      n.child.kill('SIGKILL');
      await gone;
      rmSync(n.workdir, { recursive: true, force: true });
    };
    try {
      // A file on the user's disk (named by the journal) and an upload (copied into it).
      const disk = join(home, 'golden.csv');
      copyFileSync(fixturePath('csv_well_daily_golden.csv'), disk);
      const a = startNative(args);
      await a.client.newProject({ name: 'Unsaved', profile: { ...PROFILE } });
      const onDisk = { kind: 'path' as const, path: disk };
      const d1 = await a.client.awaitJob<DatasetSummary>(
        await a.client.importFile(onDisk, { preview: await reference.sniff(onDisk) }),
      );
      const upload = {
        kind: 'bytes' as const,
        bytes: readFileSync(fixturePath('csv_null_markers.csv')),
        name: 'csv_null_markers.csv',
      };
      await a.client.awaitJob<DatasetSummary>(
        await a.client.importFile(upload, { preview: await reference.sniff(upload) }),
      );
      await a.client.awaitJob<CheckSummary>(await a.client.runChecks(d1.id));
      await a.client.decide({ kind: 'exclude_rows', datasetId: d1.id, rows: [0, 1], reason: 'Commissioning rows' });
      const pressure = (await a.client.getSchema(d1.id)).columns.find((c) => c.name === 'Pressure')?.id as string;
      await a.client.awaitJob<StepResult>(
        await a.client.applyStep(
          d1.id,
          { kind: 'convert_unit', columnId: pressure, toUnit: 'kPa', mode: 'replace' },
          'Report in kPa',
        ),
      );
      const state = async (e: EngineClient) => {
        const p = await e.getProject();
        const rows = [];
        for (const d of p.datasets) rows.push(await allRows(e, d.id));
        return {
          audit: await allAudit(e),
          issues: (await e.listIssues({ limit: 1000 })).items,
          datasets: p.datasets,
          rows,
        };
      };
      const before = await state(a.client);
      // While the engine runs, its work is not offered to another.
      const watcher = startNative(args);
      expect(await watcher.client.recoveryInfo()).toBeNull();
      stopNative(watcher);
      await crash(a);

      const b = startNative(args);
      expect(await b.client.recoveryInfo()).toMatchObject({
        name: 'Unsaved',
        entries: before.audit.length,
        unsaved: before.audit.length - 1,
      });
      const report = await b.client.awaitJob<ProjectOpenReport>(await b.client.recoverProject());
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(report.readOnly).toBe(false);
      expect(await state(b.client)).toEqual(before);
      // The recovered work is the new engine's own now.
      const other = startNative(args);
      expect(await other.client.recoveryInfo()).toBeNull();
      stopNative(other);

      // If the original on disk changed, the recovered project opens read-only, saying which.
      await crash(b);
      writeFileSync(disk, 'well_id\nchanged\n');
      const c = startNative(args);
      const damaged = await c.client.awaitJob<ProjectOpenReport>(await c.client.recoverProject());
      expect(damaged.readOnly).toBe(true);
      // The changed file fails its checksum (the upload's copy does not), and the replay of it stops.
      expect(damaged.checks.filter((x) => !x.ok && x.id === 'original-checksum').map((x) => x.target)).toEqual([
        d1.source.fileId,
      ]);
      expect(await c.client.recoveryInfo()).toBeNull();
      stopNative(c);

      // Saved work is not offered; unsaved work (an import and its assumptions) can be discarded.
      const saved = startNative(args);
      await saved.client.newProject({ name: 'Saved', profile: { ...PROFILE } });
      await saved.client.awaitJob<DatasetSummary>(
        await saved.client.importFile(upload, { preview: await reference.sniff(upload) }),
      );
      await saved.client.awaitJob<SaveResult>(
        await saved.client.saveProject({ kind: 'path', path: join(folder, 'saved.twp') }),
      );
      await crash(saved);
      const unsaved = startNative(args);
      expect(await unsaved.client.recoveryInfo()).toBeNull();
      await unsaved.client.newProject({ name: 'Draft', profile: { ...PROFILE } });
      await unsaved.client.awaitJob<DatasetSummary>(
        await unsaved.client.importFile(upload, { preview: await reference.sniff(upload) }),
      );
      await crash(unsaved);
      const last = startNative(args);
      expect(await last.client.recoveryInfo()).toMatchObject({ name: 'Draft', unsaved: 2 });
      await last.client.discardRecovery();
      expect(await last.client.recoveryInfo()).toBeNull();
      stopNative(last);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses what it does not support yet with a reason and a fix', async () => {
    const geojson = { kind: 'path' as const, path: fixturePath('geojson_wells_points_wgs84.geojson') };
    await expect(native.client.sniff(geojson)).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
      fix: expect.any(String),
    });
    await expect(native.client.importFile(geojson)).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
      message: expect.stringContaining('GeoJSON'),
    });
  });
});

if (!nativeBuilt) {
  describe('native engine parity', () => {
    it.skip(`needs the native engine: run npm run build:native (looked for ${NATIVE_BINARY})`, () => undefined);
  });
}

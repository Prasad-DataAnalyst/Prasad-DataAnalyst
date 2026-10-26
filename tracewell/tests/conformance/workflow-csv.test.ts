/** The CSV golden path on csv_well_daily_golden.csv, end to end through the engine protocol. */
import { expect } from 'vitest';
import type { ExportResult, Issue, JsonValue, StepResult } from '@tw/model';
import { defineConformance, expectedJson, importFixture, newProject, ruleCounts, runChecks } from './harness';

defineConformance(
  'workflow-csv: import, check, review, convert, filter and export the golden well file',
  async (engine) => {
    await newProject(engine);
    const ds = await importFixture(engine, 'csv_well_daily_golden.csv');
    const issues = await runChecks(engine, ds.id);
    const schema = await engine.getSchema(ds.id);
    const col = (name: string) => {
      const c = schema.columns.find((x) => x.name === name);
      if (c === undefined) throw new Error(`no column ${name}`);
      return c.id;
    };

    // Review: edit a pressure cell, accept the time-zone note, exclude the duplicate-key rows.
    const [edit] = await engine.decide({
      kind: 'edit_cell',
      datasetId: ds.id,
      rowId: 0,
      columnId: col('Pressure'),
      value: { text: '1860.5' },
      reason: 'Gauge re-read on site',
    });
    expect(edit).toMatchObject({ action: 'cell.edit', old: 1860, new: 1860.5, target: { locator: 'line 2, field 5' } });
    const tz = issues.find((i) => i.ruleId === 'TW-TIME-004') as Issue;
    await engine.decide({ kind: 'accept_issue', issueId: tz.id, rows: 'all', reason: 'Logger runs on UTC' });
    const dup = issues.find((i) => i.ruleId === 'TW-DQ-003') as Issue;
    await engine.decide({
      kind: 'exclude_rows',
      datasetId: ds.id,
      rows: { issueId: dup.id },
      reason: 'Duplicate transmissions',
    });

    // Process and extract.
    const convert = await engine.awaitJob<StepResult>(
      await engine.applyStep(
        ds.id,
        { kind: 'convert_unit', columnId: col('Pressure'), toUnit: 'kPa', mode: 'replace' },
        'Report in kPa',
      ),
    );
    expect(convert.method).toMatchObject({ from: 'psia', to: 'kPa', fromFactor: 6894.757293168361, toFactor: 1000 });
    expect(convert.method?.source).toMatch(/NIST/);
    const filter = await engine.awaitJob<StepResult>(
      await engine.applyStep(
        ds.id,
        {
          kind: 'filter',
          predicate: {
            column: col('date'),
            op: 'between',
            low: { datetime: '2026-01-01T00:00:00.000Z' },
            high: { datetime: '2026-01-31T23:59:59.999Z' },
          },
        },
        'January 2026 only',
      ),
    );

    const exports: Record<string, JsonValue> = {};
    for (const profile of ['excel', 'csv', 'geojson'] as const) {
      const result = await engine.awaitJob<ExportResult>(await engine.exportData({ datasetId: ds.id, profile }));
      expect(result.ok, profile).toBe(true);
      expect(
        result.validation.checks.filter((c) => !c.ok),
        profile,
      ).toEqual([]);
      expect(result.manifest.dataset.rowCount).toBe(filter.outputRows);
      exports[profile] = {
        rowCount: result.manifest.dataset.rowCount,
        viewDigest: result.manifest.dataset.viewDigest,
        columns: result.manifest.dataset.columns.map((c) => ({ header: c.header, sha256: c.sha256 })),
      };
    }

    const actual: JsonValue = { ruleCounts: ruleCounts(issues), outputRows: filter.outputRows, exports };
    expect(actual).toEqual(expectedJson('well_daily.json', actual));
  },
);

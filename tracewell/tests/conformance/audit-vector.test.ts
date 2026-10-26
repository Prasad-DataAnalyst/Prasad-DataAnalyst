/** The audit log of a three-entry session, byte for byte: the cross-engine audit format. */
import { expect } from 'vitest';
import { canonicalJson, type JsonValue } from '@tw/model';
import { defineConformance, expected, importFixture, newProject, runChecks } from './harness';

defineConformance('audit-vector: a three-entry session gives the committed audit.jsonl', async (engine) => {
  await newProject(engine, 'Audit vector');
  const ds = await importFixture(engine, 'csv_duplicates_rows_and_keys.csv');
  await runChecks(engine, ds.id);
  const entries = (await engine.listAudit({ limit: 1000 })).items;
  expect(entries.map((e) => e.action)).toEqual(['project.create', 'source.add', 'check.run']);
  const jsonl = entries.map((e) => `${canonicalJson(e as unknown as JsonValue)}\n`).join('');
  expect(jsonl).toBe(expected('audit-3.jsonl', jsonl));
  expect(await engine.verifyAudit()).toEqual({ ok: true, entries: 3 });
});

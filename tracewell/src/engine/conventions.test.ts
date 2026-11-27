/** Project conventions (FR-CNV-01, FR-CNV-02): set by a decision, logged, reverted, replayed and exported. */
import { describe, expect, it } from 'vitest';
import { readZip } from '@tw/io';
import { NO_CONVENTIONS, type Conventions, type Decision, type ExportResult, type SaveResult } from '@tw/model';
import { awaitJob, importFixture, open, withProject } from './__fixtures__/session';

const LNG: Conventions = {
  standardConditions: 'std-15C-101.325kPa',
  energyUnit: 'MMBtu',
  combustionTemperature: 15,
  meteringTemperature: 15.55,
  tonneToEnergy: { factor: 51.9, unit: 'MMBtu/t', source: '  Sales contract, clause 12.3 ' },
};

const set = (conventions: unknown, reason = 'Per the sales contract'): Decision =>
  ({ kind: 'set_conventions', conventions, reason }) as Decision;

describe('project conventions', () => {
  it('starts with none set, and records a choice with its reason as project.conventions', async () => {
    const engine = await withProject();
    expect((await engine.getProject()).conventions).toEqual(NO_CONVENTIONS);
    const [entry] = await engine.decide(set(LNG));
    const recorded = {
      ...LNG,
      tonneToEnergy: { factor: 51.9, unit: 'MMBtu/t', source: 'Sales contract, clause 12.3' },
    };
    expect(entry).toMatchObject({
      action: 'project.conventions',
      target: {},
      old: NO_CONVENTIONS,
      new: recorded,
      reason: 'Per the sales contract',
    });
    expect((await engine.getProject()).conventions).toEqual(recorded);
  });

  it('refuses a choice outside the lists, a factor without a source, an unchanged set and a missing reason', async () => {
    const engine = await withProject();
    const refused = async (conventions: unknown, reason?: string) =>
      engine.decide(set(conventions, reason)).catch((e: unknown) => e);
    expect(await refused({ ...LNG, standardConditions: 'std-20C-101.325kPa' })).toMatchObject({
      code: 'INVALID_INPUT',
      message:
        'The conventions are not valid: the standard conditions "std-20C-101.325kPa" is not one of "std-60F-14.696psia", "std-15C-101.325kPa", "std-0C-101.325kPa".',
    });
    expect(await refused({ ...LNG, meteringTemperature: 25 })).toMatchObject({
      message: expect.stringContaining('the metering reference temperature 25 is not one of 20, 15.55, 15, 0'),
    });
    expect(await refused({ ...LNG, tonneToEnergy: { factor: 0, unit: 'MMBtu/t', source: 'x' } })).toMatchObject({
      message: 'The conventions are not valid: the tonne-to-energy factor is not a number greater than 0.',
    });
    expect(await refused({ ...LNG, tonneToEnergy: { factor: 52, unit: 'MMBtu/t', source: ' ' } })).toMatchObject({
      message: 'The conventions are not valid: the tonne-to-energy factor names no source.',
    });
    expect(await refused({ ...LNG, extra: 1 })).toMatchObject({
      message: 'The conventions are not valid: the conventions has the unknown member extra.',
    });
    expect(await refused(NO_CONVENTIONS)).toMatchObject({ message: 'The project already works to these conventions.' });
    expect(await refused(LNG, ' ')).toMatchObject({ code: 'REASON_REQUIRED' });
    expect((await engine.getProject()).auditHead.seq).toBe(1);
  });

  it('is reverted to the conventions before it, and survives saving and opening the project', async () => {
    const engine = await withProject();
    const [first] = await engine.decide(set({ ...NO_CONVENTIONS, energyUnit: 'GJ' }));
    const [second] = await engine.decide(set(LNG, 'The contract was signed'));
    await engine.decide({ kind: 'revert', seq: second?.seq ?? 0, reason: 'Not signed after all' });
    expect((await engine.getProject()).conventions).toEqual({ ...NO_CONVENTIONS, energyUnit: 'GJ' });
    await engine.decide(set(LNG, 'Signed now'));
    const saved = await awaitJob<SaveResult>(engine, await engine.saveProject());
    const { engine: reopened, report } = await open(saved.bytes as Uint8Array);
    expect(report.readOnly).toBe(false);
    expect((await reopened.getProject()).conventions).toMatchObject({
      energyUnit: 'MMBtu',
      meteringTemperature: 15.55,
    });
    expect(first?.seq).toBeLessThan(second?.seq ?? 0);
  });

  it('is stated in an export package when set, and absent when none is', async () => {
    const engine = await withProject();
    const ds = await importFixture(engine, 'csv_well_daily_golden.csv');
    const exported = async () =>
      awaitJob<ExportResult>(engine, await engine.exportData({ datasetId: ds.id, profile: 'csv' }));
    const before = await exported();
    expect(before.manifest.conventions).toBeUndefined();
    expect(readZip(before.bytes as Uint8Array).readText('README.txt')).not.toContain('CONVENTIONS');
    await engine.decide(set(LNG));
    const after = await exported();
    expect(after.validation.ok).toBe(true);
    expect(after.manifest.conventions).toMatchObject({ standardConditions: 'std-15C-101.325kPa' });
    expect(readZip(after.bytes as Uint8Array).readText('README.txt')).toContain(
      'CONVENTIONS: standard conditions 15 °C and 101.325 kPa, energy in MMBtu, combustion at 15 °C, metering at 15.55 °C (60 °F), 51.9 MMBtu/t (Sales contract, clause 12.3)',
    );
  });
});

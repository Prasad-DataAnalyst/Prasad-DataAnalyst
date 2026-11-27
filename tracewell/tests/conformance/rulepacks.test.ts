/**
 * Signed rule-packs (FR-RUL-01, FR-RUL-02, FR-RUL-04, SAD decision D-17): a pack signed with the
 * publisher's tool verifies and installs; every other file is refused with its reason; installed
 * rules run in check runs and replay from the log alone.
 */
import { describe, expect, it } from 'vitest';
import { EngineClient, inProcessTransport } from '@tw/engine-api';
import { LocalEngine, fixedClock, seededIds } from '@tw/engine';
import { fixtureBytes } from '@tw/fixtures';
import type { CheckSummary, DatasetSummary, Issue, ProjectOpenReport, RulePackPolicy, SaveResult } from '@tw/model';
import { GENERIC_DQ, SYSTEM_RULES, packDigest, parsePolicy, verifyRulePackFile } from '@tw/rules';
import { PROFILE, START } from './harness';
import { PACK, publisherKey, signPack } from './rulepack-signing';

const acme = publisherKey();
const policy: RulePackPolicy = { trustedKeys: [{ name: 'ACME', publicKey: acme.publicKey }], lockedVersions: {} };
const enc = (t: string) => new TextEncoder().encode(t);
const signed = (pack: unknown = PACK, key = acme.privateKey) => enc(signPack(pack, key, 'ACME Ltd'));
const BUILTIN = [GENERIC_DQ, SYSTEM_RULES];

describe('verifyRulePackFile', () => {
  it('accepts a pack the trusted publisher signed, with the digest of its canonical JSON', async () => {
    const v = await verifyRulePackFile(signed(), policy, [], BUILTIN);
    expect(v.ref).toEqual({ id: 'acme.methane', version: '1.0.0', sha256: packDigest(v.pack) });
    expect(v.installed).toMatchObject({ publisher: 'ACME Ltd', rules: 1, title: 'ACME methane reporting' });
  });

  it('refuses every file that is not a trusted, intact, well-formed pack the policy allows', async () => {
    const refusal = async (bytes: Uint8Array, p: RulePackPolicy | undefined = policy, installed = [] as never[]) =>
      verifyRulePackFile(bytes, p, installed, BUILTIN).catch((e: unknown) => e);
    const file = JSON.parse(new TextDecoder().decode(signed())) as Record<string, unknown>;
    const tampered = { ...file, pack: { ...PACK, title: 'Changed after signing' } };
    expect(await refusal(enc(JSON.stringify(tampered)))).toMatchObject({
      code: 'INVALID_INPUT',
      message:
        'The signature of the rule-pack acme.methane 1.0.0 does not verify: the file was changed after it was signed, or signed with another key.',
    });
    expect(await refusal(signed(PACK, publisherKey().privateKey))).toMatchObject({
      message: expect.stringMatching(
        /^The rule-pack is signed by "ACME Ltd" \(key [0-9a-f]{16}\), a publisher the policy does not trust\.$/,
      ),
    });
    const noPolicy = await verifyRulePackFile(signed(), undefined, [], BUILTIN).catch((e: unknown) => e);
    expect(noPolicy).toMatchObject({ message: expect.stringContaining('a publisher the policy does not trust') });
    expect(await refusal(signed(), { ...policy, lockedVersions: { 'acme.methane': '0.9.0' } })).toMatchObject({
      message: 'The policy locks acme.methane at version 0.9.0, and this file is version 1.0.0.',
      fix: 'Install version 0.9.0, or ask the administrator to change the policy.',
    });
    expect(await refusal(enc('not json'))).toMatchObject({
      message: 'The file is not a rule-pack: it is not JSON text in UTF-8.',
    });
    expect(await refusal(enc(JSON.stringify({ ...file, formatVersion: '0.2' })))).toMatchObject({
      message: 'The file is not a Tracewell rule-pack (.twrules) of format 0.1.',
    });
    const broken = { ...PACK, rules: [{ ...PACK.rules[0], check: { kind: 'no_such_check' } }] };
    expect(await refusal(enc(JSON.stringify({ ...file, pack: broken })))).toMatchObject({
      message: 'The rule-pack does not follow the rule-pack format.',
    });
    const system = { ...PACK, rules: [{ ...PACK.rules[0], check: { kind: 'system' } }] };
    expect(await refusal(enc(JSON.stringify({ ...file, pack: system })))).toMatchObject({
      message: 'The rule-pack does not follow the rule-pack format.',
    });
    const clash = { ...PACK, rules: [{ ...PACK.rules[0], id: 'TW-DQ-001' }] };
    expect(await refusal(signed(clash))).toMatchObject({
      message: 'The rule TW-DQ-001 of acme.methane has the ID of a rule of tracewell.generic-dq.',
    });
    const builtin = { ...PACK, id: 'tracewell.system' };
    expect(await refusal(enc(JSON.stringify({ ...file, pack: builtin })))).toMatchObject({
      message: 'The rule-pack tracewell.system is built into Tracewell, and no file replaces it.',
    });
    const v = await verifyRulePackFile(signed(), policy, [], BUILTIN);
    expect(await refusal(signed(), policy, [{ pack: v.pack }] as never[])).toMatchObject({
      message: 'The rule-pack acme.methane 1.0.0 is installed already.',
    });
  });

  it('reads a policy file and refuses one that is not one', () => {
    const text = JSON.stringify({
      format: 'tracewell-policy',
      formatVersion: '0.1',
      trustedKeys: [{ name: ' ACME ', publicKey: acme.publicKey }],
      lockedVersions: { 'acme.methane': '1.0.0' },
    });
    expect(parsePolicy(text)).toEqual({
      trustedKeys: [{ name: 'ACME', publicKey: acme.publicKey }],
      lockedVersions: { 'acme.methane': '1.0.0' },
    });
    expect(() =>
      parsePolicy(
        '{"format":"tracewell-policy","formatVersion":"0.1","trustedKeys":[{"name":"x","publicKey":"AAAA"}]}',
      ),
    ).toThrow('The rule-pack policy is not valid: the key of x is not 32 bytes of base64.');
    expect(() => parsePolicy('[]')).toThrow('it is not a Tracewell policy file');
  });

  it('reads a pack ID that names an object property only as an ID', async () => {
    // JSON text, since an object literal's __proto__ member would set its prototype instead.
    const keys = JSON.stringify([{ name: 'ACME', publicKey: acme.publicKey }]);
    const locked = parsePolicy(
      `{"format":"tracewell-policy","formatVersion":"0.1","trustedKeys":${keys},"lockedVersions":{"__proto__":"2.0.0"}}`,
    );
    expect(Object.keys(locked.lockedVersions)).toEqual(['__proto__']);
    await expect(verifyRulePackFile(signed({ ...PACK, id: '__proto__' }), locked, [], BUILTIN)).rejects.toMatchObject({
      message: 'The policy locks __proto__ at version 2.0.0, and this file is version 1.0.0.',
    });
    const v = await verifyRulePackFile(signed({ ...PACK, id: 'constructor' }), policy, [], BUILTIN);
    expect(v.installed.id).toBe('constructor');
  });
});

function engineWith(p?: RulePackPolicy): EngineClient {
  const engine = new LocalEngine({
    appVersion: '0.1.0',
    owner: 'Prasad',
    clock: fixedClock(START),
    ids: seededIds(1),
    ...(p === undefined ? {} : { policy: p }),
  });
  return new EngineClient(inProcessTransport(engine));
}

describe('installing a rule-pack in a project', () => {
  it('logs the install with the pack, runs its rules after the built-in packs, and replays it from the log', async () => {
    const engine = engineWith(policy);
    await engine.newProject({ name: 'Methane', profile: { ...PROFILE } });
    const ds = await engine.awaitJob<DatasetSummary>(
      await engine.importFile({ kind: 'bytes', bytes: fixtureBytes('csv_null_markers.csv'), name: 'readings.csv' }),
    );
    const file = { kind: 'bytes' as const, bytes: signed(), name: 'acme.twrules' };
    await expect(engine.installRulePack(file, ' ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const [entry] = await engine.installRulePack(file, 'Methane reporting standard MR-7');
    expect(entry).toMatchObject({
      action: 'rulepack.install',
      old: null,
      new: { id: 'acme.methane', version: '1.0.0', publisher: 'ACME Ltd', rules: 1 },
      payload: { pack: PACK },
    });
    expect((await engine.getProject()).installedPacks.map((p) => `${p.id} ${p.version}`)).toEqual([
      'acme.methane 1.0.0',
    ]);
    const run = await engine.awaitJob<CheckSummary>(await engine.runChecks(ds.id));
    expect(run.packs.map((p) => p.id)).toEqual(['tracewell.generic-dq', 'tracewell.system', 'acme.methane']);
    const acmeIssues = (await engine.listIssues({ datasetId: ds.id, limit: 1000 })).items.filter(
      (i: Issue) => i.ruleId === 'ACME-001',
    );
    expect(acmeIssues.length).toBeGreaterThan(0);
    expect(acmeIssues[0]).toMatchObject({ packId: 'acme.methane', severity: 'error', title: 'Measured value present' });
    // A newer version replaces the pack.
    const [upgrade] = await engine.installRulePack(
      { ...file, bytes: signed({ ...PACK, version: '1.1.0' }) },
      'MR-7 revision 2',
    );
    expect(upgrade).toMatchObject({ old: { version: '1.0.0' }, new: { version: '1.1.0' } });
    const saved = await engine.awaitJob<SaveResult>(await engine.saveProject());
    engine.close();
    // Another installation without the policy opens the project: the log alone holds the packs.
    const reopened = engineWith();
    try {
      const report = await reopened.awaitJob<ProjectOpenReport>(
        await reopened.openProject({ kind: 'bytes', bytes: saved.bytes as Uint8Array, name: saved.fileName }),
      );
      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect((await reopened.getProject()).installedPacks.map((p) => p.version)).toEqual(['1.1.0']);
      const titles = (await reopened.listIssues({ datasetId: ds.id, limit: 1000 })).items
        .filter((i: Issue) => i.ruleId === 'ACME-001')
        .map((i) => i.title);
      expect(titles[0]).toBe('Measured value present');
    } finally {
      reopened.close();
    }
  });
});

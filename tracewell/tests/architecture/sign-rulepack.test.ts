/**
 * The rule-pack publisher's tool (scripts/sign-rulepack.mjs, SAD decision D-17): the key it makes
 * and the file it signs install where the policy trusts the key, because it signs the same
 * canonical JSON the engines verify.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson as modelCanonicalJson, type JsonValue } from '@tw/model';
import { GENERIC_DQ, SYSTEM_RULES, verifyRulePackFile } from '@tw/rules';
import { canonicalJson, outlineProblem } from '../../scripts/sign-rulepack.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tw-sign-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PACK = {
  id: 'acme.methane',
  version: '1.0.0',
  title: 'ACME methane reporting',
  source: 'ACME internal standard MR-7',
  rules: [
    {
      id: 'ACME-001',
      version: '1.0.0',
      title: 'Measured value present',
      category: 'completeness',
      severity: 'error',
      appliesTo: { roles: ['measure'] },
      check: { kind: 'not_null' },
      message: '{column} has {count} empty values.',
      explanation: 'Every measurement needs a value for the methane report.',
      source: 'MR-7 section 4.2',
    },
  ],
};

function tool(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['scripts/sign-rulepack.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('scripts/sign-rulepack.mjs', () => {
  it('writes the canonical JSON the engines sign and verify', () => {
    const v = { b: [1, -0, 1.5e300, 'x"\n'], a: { é: true, Z: null, '10': 2, '9': 1 } };
    expect(canonicalJson(v)).toBe(modelCanonicalJson(v as unknown as JsonValue));
    expect(outlineProblem({ ...PACK, id: 'tracewell.dq' })).toContain('kept for the packs built into Tracewell');
    expect(outlineProblem({ ...PACK, version: '1.0' })).toBe('the pack version is not MAJOR.MINOR.PATCH');
  });

  it('makes a key and signs a pack that installs where the policy trusts the key', async () => {
    const key = join(dir, 'acme.pem');
    const keygen = tool(['keygen', '--out', key]);
    expect(keygen.status, keygen.stderr).toBe(0);
    expect(statSync(key).mode & 0o077).toBe(0);
    const publicKey = /Public key \(for trustedKeys in the policy file\): (\S+)/.exec(keygen.stdout)?.[1] ?? '';
    writeFileSync(join(dir, 'pack.json'), JSON.stringify(PACK));
    const out = join(dir, 'pack.twrules');
    const signed = tool(['sign', join(dir, 'pack.json'), '--key', key, '--publisher', 'ACME Ltd', '--out', out]);
    expect(signed.status, signed.stderr).toBe(0);
    const trusted = { trustedKeys: [{ name: 'ACME', publicKey }], lockedVersions: {} };
    const v = await verifyRulePackFile(new Uint8Array(readFileSync(out)), trusted, [], [GENERIC_DQ, SYSTEM_RULES]);
    expect(v.installed).toMatchObject({ id: 'acme.methane', publisher: 'ACME Ltd', rules: 1 });
    // A key is never overwritten.
    expect(tool(['keygen', '--out', key]).status).not.toBe(0);
    expect(tool(['sign', join(dir, 'pack.json')]).stderr).toContain('Give --key <value>.');
  });
});

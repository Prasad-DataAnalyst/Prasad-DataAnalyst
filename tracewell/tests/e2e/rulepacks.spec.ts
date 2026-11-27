import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { POLICY_FILE } from './native-host';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/** Runs the publisher's tool (scripts/sign-rulepack.mjs) and returns what it printed. */
function signingTool(args: string[]): string {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sign-rulepack.mjs'), ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sign-rulepack.mjs ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

test('a rule-pack signed with the publisher tool installs only where the policy trusts its key', async ({
  app,
  page,
  engine,
}, testInfo) => {
  // The publisher makes a key and signs the pack; the key lives only in this test's output folder.
  const key = testInfo.outputPath('acme.pem');
  const publicKey = /Public key \(for trustedKeys in the policy file\): (\S+)/.exec(
    signingTool(['keygen', '--out', key]),
  )?.[1];
  const packFile = testInfo.outputPath('acme-methane.json');
  writeFileSync(packFile, JSON.stringify(PACK));
  const signed = testInfo.outputPath('acme-methane-1.0.0.twrules');
  signingTool(['sign', packFile, '--key', key, '--publisher', 'ACME Ltd', '--out', signed]);
  expect(JSON.parse(readFileSync(signed, 'utf8'))).toMatchObject({ format: 'tracewell-rules', pack: PACK });

  await app.open();
  await app.importFixture('csv_null_markers.csv');
  const rules = page.getByTestId('tw-status-rules');
  await expect(rules).toHaveText('Rules built-in');
  if (engine === 'native') {
    // The desktop engine reads the administrator's policy file at each install.
    const policy = { format: 'tracewell-policy', formatVersion: '0.1', trustedKeys: [{ name: 'ACME', publicKey }] };
    writeFileSync(testInfo.outputPath('native', POLICY_FILE), JSON.stringify(policy));
  }
  const chooser = page.waitForEvent('filechooser');
  await app.menu('Data', 'Install rule-pack…');
  await (await chooser).setFiles(signed);
  await app.giveReason('Methane reporting standard MR-7');

  if (engine === 'lite') {
    // This build was given no policy, so no publisher is trusted and nothing installs.
    await expect(page.getByRole('alert')).toContainText(
      /The rule-pack is signed by "ACME Ltd" \(key [0-9a-f]{16}\), a publisher the policy does not trust\./,
    );
    await expect(rules).toHaveText('Rules built-in');
    return;
  }
  await expect(rules).toHaveText('Rules built-in, acme.methane 1.0.0');
  await expect(rules).toHaveAttribute(
    'title',
    /ACME methane reporting, 1 rule, signed by ACME Ltd \(key [0-9a-f]{16}\)/,
  );
  await page.getByRole('tab', { name: 'Log' }).click();
  await expect(page.getByText('Rule-pack installed').first()).toBeVisible();
  await app.runChecks();
  await expect(rules).toHaveText('Rules generic-dq 0.1.0, system 0.1.0, acme.methane 1.0.0');
  const counts = await app.issueCounts();
  expect(counts['ACME-001']).toBeGreaterThan(0);
});

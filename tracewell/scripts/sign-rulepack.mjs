#!/usr/bin/env node
/**
 * The rule-pack publisher's tool (FR-RUL-01, SAD decision D-17): makes an Ed25519 signing key, and
 * signs a rule-pack JSON file into a .twrules file that Tracewell installs when the policy trusts
 * the key.
 *
 *   node scripts/sign-rulepack.mjs keygen --out <private-key.pem>
 *     Writes a new private key (PKCS #8 PEM, readable by its owner only) and prints the public key
 *     and its key ID for the policy file. Keep the private key out of every repository and share.
 *
 *   node scripts/sign-rulepack.mjs sign <pack.json> --key <private-key.pem> --publisher <name> --out <pack.twrules>
 *     Signs the UTF-8 canonical JSON of the pack (keys sorted by UTF-16 code unit, no whitespace,
 *     numbers as JavaScript writes them, -0 as 0), as the engines verify it.
 *
 * Tracewell checks the whole pack when it is installed; this tool checks its outline.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isEntryScript } from './is-entry.mjs';

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The JSON the engines sign and verify (model/canonical.ts canonicalJson). */
export function canonicalJson(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`The number ${v} has no canonical form.`);
    return Object.is(v, -0) ? '0' : String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

/** The raw 32 bytes of an Ed25519 public key, as base64. */
export function rawPublicKey(key) {
  const x = createPublicKey(key).export({ format: 'jwk' }).x;
  return Buffer.from(x, 'base64url').toString('base64');
}

/** A key's ID: the first 16 hex digits of the SHA-256 of its raw bytes. */
export function keyId(publicKeyBase64) {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 16);
}

/** Why a pack is not one to sign, or null: its outline only. */
export function outlineProblem(pack) {
  if (typeof pack !== 'object' || pack === null || Array.isArray(pack)) return 'the pack is not a JSON object';
  for (const k of ['id', 'title', 'source']) {
    if (typeof pack[k] !== 'string' || pack[k].trim() === '') return `the pack has no ${k}`;
  }
  if (typeof pack.version !== 'string' || !SEMVER.test(pack.version))
    return 'the pack version is not MAJOR.MINOR.PATCH';
  if (!Array.isArray(pack.rules) || pack.rules.length === 0) return 'the pack has no rules';
  if (pack.id.startsWith('tracewell.'))
    return 'IDs starting with "tracewell." are kept for the packs built into Tracewell';
  return null;
}

/** The .twrules text of a pack signed with this private key (PEM). */
export function signPack(pack, privateKeyPem, publisher) {
  const problem = outlineProblem(pack);
  if (problem !== null) throw new Error(`The rule-pack is not ready to sign: ${problem}.`);
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(canonicalJson(pack), 'utf8'), key).toString('base64');
  const file = {
    format: 'tracewell-rules',
    formatVersion: '0.1',
    pack,
    publisher: { name: publisher, keyId: keyId(rawPublicKey(key)) },
    signature,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) throw new Error(`Give ${name} <value>.`);
  return args[i + 1];
}

function main(args) {
  const [command, ...rest] = args;
  if (command === 'keygen') {
    const out = option(rest, '--out');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    const publicKey = rawPublicKey(privateKey);
    console.log(`Private key written to ${out}. Keep it out of every repository and share.`);
    console.log(`Public key (for trustedKeys in the policy file): ${publicKey}`);
    console.log(`Key ID: ${keyId(publicKey)}`);
    return;
  }
  if (command === 'sign') {
    const [packPath] = rest;
    if (packPath === undefined || packPath.startsWith('--')) throw new Error('Give the rule-pack JSON file to sign.');
    const pack = JSON.parse(readFileSync(packPath, 'utf8'));
    const text = signPack(pack, readFileSync(option(rest, '--key'), 'utf8'), option(rest, '--publisher'));
    writeFileSync(option(rest, '--out'), text);
    console.log(`Signed ${pack.id} ${pack.version}.`);
    return;
  }
  throw new Error(
    'Usage: sign-rulepack.mjs keygen --out <key.pem> | sign <pack.json> --key <key.pem> --publisher <name> --out <pack.twrules>',
  );
}

if (isEntryScript(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

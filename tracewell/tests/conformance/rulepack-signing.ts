/**
 * Signed rule-pack files for the tests, made as the publisher's tool (scripts/sign-rulepack.mjs)
 * makes them: an Ed25519 signature of the UTF-8 canonical JSON of the pack (SAD decision D-17).
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalJson, type JsonValue } from '@tw/model';

export const PACK = {
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

/** A publisher's key pair, and the raw 32 bytes of its public key as base64 (for a policy). */
export function publisherKey(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x as string;
  return { privateKey, publicKey: Buffer.from(x, 'base64url').toString('base64') };
}

/** A .twrules file as the publisher's tool (scripts/sign-rulepack.mjs) writes it. */
export function signPack(pack: unknown, privateKey: KeyObject, publisher: string): string {
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  const message = Buffer.from(canonicalJson(pack as JsonValue), 'utf8');
  return JSON.stringify({
    format: 'tracewell-rules',
    formatVersion: '0.1',
    pack,
    publisher: { name: publisher, keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16) },
    signature: sign(null, message, privateKey).toString('base64'),
  });
}

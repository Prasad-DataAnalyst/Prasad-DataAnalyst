/**
 * Signed rule-pack files (.twrules, FR-RUL-01, FR-RUL-02) and the administrator's policy
 * (FR-RUL-04), SAD decision D-17. A file holds a pack, its publisher and an Ed25519 signature of
 * the UTF-8 canonical JSON of the pack; it installs only when a publisher the policy trusts signed
 * it, the pack is well formed, and the policy's locked version, if any, is the file's. The
 * signature is checked with WebCrypto; the native engine (rulepacks.rs) checks with ed25519-dalek,
 * in the same order and with the same messages.
 */
import {
  EngineError,
  canonicalJson,
  schemas,
  type InstalledRulePack,
  type JsonValue,
  type RulePack,
  type RulePackPolicy,
  type RulePackRef,
} from '@tw/model';
import { sha256Hex } from '@tw/io';

/** The largest rule-pack file read. */
export const RULEPACK_FILE_MAX_BYTES = 1 << 20;

/** The packs built into Tracewell, which no file replaces. */
const BUILTIN_PACK_IDS = new Set(['tracewell.generic-dq', 'tracewell.system']);

const NO_POLICY: RulePackPolicy = Object.freeze({ trustedKeys: [], lockedVersions: {} });

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Bytes of standard base64 with its padding, or null when the text is not that. */
export function base64Bytes(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of clean) {
    value = (value << 6) | alphabet.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

/** A publisher key's ID: the first 16 hex digits of the SHA-256 of its 32 raw bytes. */
export function keyIdOf(publicKey: Uint8Array): string {
  return sha256Hex(publicKey).slice(0, 16);
}

function policyFailed(why: string): EngineError {
  return new EngineError(
    'INVALID_INPUT',
    `The rule-pack policy is not valid: ${why}.`,
    'Correct the policy file, or ask the administrator for one that follows the policy format.',
  );
}

/** Parses an administrator's policy file (tracewell-policy.json). */
export function parsePolicy(text: string): RulePackPolicy {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw policyFailed('it is not JSON text');
  }
  const o = v as Record<string, unknown>;
  if (typeof v !== 'object' || v === null || Array.isArray(v) || o['format'] !== 'tracewell-policy') {
    throw policyFailed('it is not a Tracewell policy file');
  }
  if (o['formatVersion'] !== '0.1')
    throw policyFailed(`its format version ${JSON.stringify(o['formatVersion'])} is not 0.1`);
  const keys = o['trustedKeys'] ?? [];
  const locked = o['lockedVersions'] ?? {};
  if (!Array.isArray(keys)) throw policyFailed('trustedKeys is not a list');
  const trustedKeys = keys.map((k: unknown, i) => {
    const key = k as Record<string, unknown>;
    const name = key?.['name'];
    const publicKey = key?.['publicKey'];
    if (typeof name !== 'string' || name.trim() === '') throw policyFailed(`trusted key ${i + 1} has no name`);
    if (typeof publicKey !== 'string' || base64Bytes(publicKey)?.length !== 32) {
      throw policyFailed(`the key of ${name} is not 32 bytes of base64`);
    }
    return { name: name.trim(), publicKey };
  });
  if (typeof locked !== 'object' || locked === null || Array.isArray(locked)) {
    throw policyFailed('lockedVersions is not an object');
  }
  // Without a prototype, a pack ID such as "constructor" or "__proto__" is only ever a key.
  const lockedVersions = Object.create(null) as Record<string, string>;
  for (const [id, version] of Object.entries(locked as Record<string, unknown>)) {
    if (typeof version !== 'string' || !SEMVER.test(version))
      throw policyFailed(`the locked version of ${id} is not a version`);
    lockedVersions[id] = version;
  }
  return { trustedKeys, lockedVersions };
}

/** A pack that passed every check, ready to install. */
export interface VerifiedRulePack {
  pack: RulePack;
  ref: RulePackRef;
  installed: InstalledRulePack;
}

const FIX_FILE = 'Get the rule-pack file again from its publisher, made with the Tracewell signing tool.';

function refused(message: string, fix: string): EngineError {
  return new EngineError('INVALID_INPUT', message, fix);
}

/** The pack's SHA-256, as check runs record it: of its UTF-8 canonical JSON. */
export function packDigest(pack: RulePack): string {
  return sha256Hex(canonicalJson(pack as unknown as JsonValue));
}

/**
 * Checks a .twrules file against the policy and the packs already installed, in this order: its
 * size, JSON, envelope and pack format, a built-in ID, the policy's lock, a trusted publisher,
 * the signature, rule IDs taken by other packs, and the same version installed already.
 */
export async function verifyRulePackFile(
  bytes: Uint8Array,
  policy: RulePackPolicy | undefined,
  installed: readonly { pack: RulePack }[],
  builtin: readonly RulePack[],
): Promise<VerifiedRulePack> {
  const p = policy ?? NO_POLICY;
  if (bytes.length > RULEPACK_FILE_MAX_BYTES) {
    throw refused(
      `The rule-pack file is larger than the ${RULEPACK_FILE_MAX_BYTES / (1 << 20)} MiB that is read.`,
      FIX_FILE,
    );
  }
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw refused('The file is not a rule-pack: it is not JSON text in UTF-8.', FIX_FILE);
  }
  const o = v as Record<string, unknown>;
  const publisher = o?.['publisher'] as Record<string, unknown> | undefined;
  const envelope =
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    o['format'] === 'tracewell-rules' &&
    o['formatVersion'] === '0.1' &&
    typeof o['pack'] === 'object' &&
    o['pack'] !== null &&
    typeof publisher === 'object' &&
    publisher !== null &&
    typeof publisher['name'] === 'string' &&
    typeof publisher['keyId'] === 'string' &&
    typeof o['signature'] === 'string';
  if (!envelope) throw refused('The file is not a Tracewell rule-pack (.twrules) of format 0.1.', FIX_FILE);
  const parsed = schemas.rulePack.safeParse(o['pack']);
  if (!parsed.success || parsed.data.rules.some((r) => r.check.kind === 'system')) {
    throw refused('The rule-pack does not follow the rule-pack format.', FIX_FILE);
  }
  const pack = parsed.data;
  if (BUILTIN_PACK_IDS.has(pack.id)) {
    throw refused(
      `The rule-pack ${pack.id} is built into Tracewell, and no file replaces it.`,
      'Install a rule-pack with another ID.',
    );
  }
  const locked = Object.hasOwn(p.lockedVersions, pack.id) ? p.lockedVersions[pack.id] : undefined;
  if (locked !== undefined && locked !== pack.version) {
    throw refused(
      `The policy locks ${pack.id} at version ${locked}, and this file is version ${pack.version}.`,
      `Install version ${locked}, or ask the administrator to change the policy.`,
    );
  }
  const name = (publisher['name'] as string).trim();
  const keyId = publisher['keyId'] as string;
  const key = p.trustedKeys.find((k) => {
    const raw = base64Bytes(k.publicKey);
    return raw !== null && keyIdOf(raw) === keyId;
  });
  if (key === undefined) {
    throw refused(
      `The rule-pack is signed by ${JSON.stringify(name)} (key ${keyId}), a publisher the policy does not trust.`,
      "Ask the administrator to add the publisher's key to the policy file, or get the pack from a trusted publisher.",
    );
  }
  const signature = base64Bytes(o['signature'] as string);
  const message = new TextEncoder().encode(canonicalJson(pack as unknown as JsonValue));
  let valid = false;
  if (signature !== null && signature.length === 64) {
    try {
      const k = await crypto.subtle.importKey(
        'raw',
        base64Bytes(key.publicKey) as BufferSource,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      valid = await crypto.subtle.verify({ name: 'Ed25519' }, k, signature as BufferSource, message);
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw refused(
      `The signature of the rule-pack ${pack.id} ${pack.version} does not verify: the file was changed after it was signed, or signed with another key.`,
      FIX_FILE,
    );
  }
  const others = [...builtin, ...installed.map((i) => i.pack).filter((x) => x.id !== pack.id)];
  for (const rule of pack.rules) {
    const owner = others.find((x) => x.rules.some((r) => r.id === rule.id));
    if (owner !== undefined) {
      throw refused(
        `The rule ${rule.id} of ${pack.id} has the ID of a rule of ${owner.id}.`,
        'Ask the publisher for a pack whose rule IDs are its own.',
      );
    }
  }
  if (installed.some((i) => i.pack.id === pack.id && i.pack.version === pack.version)) {
    throw refused(
      `The rule-pack ${pack.id} ${pack.version} is installed already.`,
      'Install another version, or close the dialog.',
    );
  }
  const sha256 = packDigest(pack);
  return {
    pack,
    ref: { id: pack.id, version: pack.version, sha256 },
    installed: {
      id: pack.id,
      version: pack.version,
      title: pack.title,
      sha256,
      publisher: name,
      keyId,
      rules: pack.rules.length,
    },
  };
}

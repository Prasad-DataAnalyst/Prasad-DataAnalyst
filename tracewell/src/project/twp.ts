/**
 * The `.twp` project container (SAD section 11). The writer is deterministic: the same input always
 * gives the same bytes. The reader never throws on bad content; it returns whatever it could read
 * plus one IntegrityCheck result per check, so a damaged project still opens read-only for
 * inspection. The audit-chain and replay checks need the engine and are done there.
 */
import {
  checksumsFile,
  comparePaths,
  parseChecksumsFile,
  readZip,
  sha256Hex,
  writeZip,
  type ZipEntryInput,
  type ZipReader,
} from '@tw/io';
import {
  EngineError,
  canonicalJson,
  schemas,
  type FileId,
  type IntegrityCheck,
  type JsonValue,
  type OriginalFileInfo,
  type ProjectManifest,
  type RulePackRef,
} from '@tw/model';
import { safeSegment } from './names';
import { twpReadme } from './readme';

export const TWP_MIMETYPE = 'application/vnd.tracewell.project+zip';
export const TWP_FORMAT_VERSION = '0.1';
/** Versions this reader opens: 0.2 adds Parquet caches (SAD decision D-13), which it verifies but does not need. */
export const TWP_READ_VERSIONS: readonly string[] = ['0.1', '0.2'];

const MIMETYPE = 'mimetype';
const MANIFEST = 'manifest.json';
const CHECKSUMS = 'CHECKSUMS.sha256';
const AUDIT = 'audit.jsonl';
const README = 'README.txt';
/** Entries the manifest cannot list: itself, the checksum file that covers it, and the mimetype marker. */
const UNLISTED = new Set([MIMETYPE, MANIFEST, CHECKSUMS]);

export interface TwpInput {
  manifest: Omit<ProjectManifest, 'entries' | 'format' | 'formatVersion'>;
  originals: { info: OriginalFileInfo; bytes: Uint8Array }[];
  auditJsonl: string;
  rulePacks: { ref: RulePackRef; json: string }[];
  unitRegistry: { version: string; json: string };
}

export interface TwpContents {
  manifest: ProjectManifest | null;
  originals: Map<FileId, { info: OriginalFileInfo; bytes: Uint8Array }>;
  auditJsonl: string | null;
  rulePacks: { ref: RulePackRef; json: string }[];
  unitRegistry: { version: string; json: string } | null;
  checks: IntegrityCheck[];
}

const encoder = new TextEncoder();

/** Where an original is stored: content-addressed by its SHA-256, which is also its file ID. */
export function originalPath(info: Pick<OriginalFileInfo, 'fileId' | 'name'>): string {
  return `originals/${info.fileId}/${safeSegment(info.name, 'file')}`;
}

export function rulePackPath(ref: Pick<RulePackRef, 'id' | 'version'>): string {
  return `rulepacks/${safeSegment(ref.id, 'pack')}-${safeSegment(ref.version, '0')}.json`;
}

export function unitRegistryPath(version: string): string {
  return `units/registry-${safeSegment(version, '0')}.json`;
}

// ---------------------------------------------------------------------------------------------
// Writing

export function writeTwp(input: TwpInput): Uint8Array {
  const originals = input.originals.map(checkedOriginal);
  const packs = input.rulePacks.map(checkedPack);
  const registryBytes = encoder.encode(input.unitRegistry.json);

  const base: Omit<ProjectManifest, 'entries'> = {
    format: 'tracewell-project',
    formatVersion: TWP_FORMAT_VERSION,
    ...input.manifest,
    unitRegistry: { version: input.unitRegistry.version, sha256: sha256Hex(registryBytes) },
    rulePacks: packs.map((p) => p.ref),
    originals: originals.map((o) => ({ ...o.info, path: o.path })),
  };

  const content: ZipEntryInput[] = [
    { path: AUDIT, data: encoder.encode(input.auditJsonl) },
    ...originals.map((o) => ({ path: o.path, data: o.bytes, store: true })),
    ...packs.map((p) => ({ path: p.path, data: p.bytes })),
    { path: unitRegistryPath(input.unitRegistry.version), data: registryBytes },
    { path: README, data: encoder.encode(twpReadme(base)) },
  ];
  requireUniquePaths(content);
  content.sort((a, b) => comparePaths(a.path, b.path));

  const manifest: ProjectManifest = {
    ...base,
    entries: content.map((e) => ({ path: e.path, size: e.data.length, sha256: sha256Hex(e.data) })),
  };
  const checked = schemas.projectManifest.safeParse(manifest);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? 'manifest' : issue.path.join('.');
    throw new EngineError(
      'INVALID_INPUT',
      `The project manifest is not well formed at ${where}: ${issue?.message ?? 'invalid value'}.`,
      'Correct the project details before saving.',
      { path: where },
    );
  }

  const mimetype: ZipEntryInput = { path: MIMETYPE, data: encoder.encode(TWP_MIMETYPE), store: true };
  const manifestEntry: ZipEntryInput = {
    path: MANIFEST,
    data: encoder.encode(`${canonicalJson(manifest as unknown as JsonValue)}\n`),
  };
  const listed = [mimetype, manifestEntry, ...content];
  const checksums: ZipEntryInput = {
    path: CHECKSUMS,
    data: encoder.encode(checksumsFile(listed.map((e) => ({ path: e.path, sha256: sha256Hex(e.data) })))),
  };
  const rest = [manifestEntry, ...content, checksums].sort((a, b) => comparePaths(a.path, b.path));
  // The mimetype entry must come first and stay uncompressed so tools can identify the file.
  return writeZip([mimetype, ...rest]);
}

function checkedOriginal(o: { info: OriginalFileInfo; bytes: Uint8Array }) {
  const digest = sha256Hex(o.bytes);
  if (digest !== o.info.fileId || o.bytes.length !== o.info.size) {
    throw new EngineError(
      'INVALID_INPUT',
      `The original file "${o.info.name}" does not match its recorded file ID or size.`,
      'Save again from the project as loaded; the original bytes must not change after import.',
      { fileId: o.info.fileId, sha256: digest, size: o.bytes.length },
    );
  }
  return { info: o.info, bytes: o.bytes, path: originalPath(o.info) };
}

function checkedPack(p: { ref: RulePackRef; json: string }) {
  const bytes = encoder.encode(p.json);
  const digest = sha256Hex(bytes);
  if (digest !== p.ref.sha256) {
    throw new EngineError(
      'INVALID_INPUT',
      `The rule pack ${p.ref.id} ${p.ref.version} text does not match its recorded SHA-256.`,
      'Record the rule pack with the digest of the exact text being saved.',
      { id: p.ref.id, version: p.ref.version, sha256: digest },
    );
  }
  return { ref: p.ref, bytes, path: rulePackPath(p.ref) };
}

function requireUniquePaths(entries: ZipEntryInput[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.path)) {
      throw new EngineError(
        'INVALID_INPUT',
        `Two project entries would be stored at "${e.path}".`,
        'Remove the duplicate original file or rule pack before saving.',
        { path: e.path },
      );
    }
    seen.add(e.path);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading

export function readTwp(bytes: Uint8Array): TwpContents {
  const out: TwpContents = {
    manifest: null,
    originals: new Map(),
    auditJsonl: null,
    rulePacks: [],
    unitRegistry: null,
    checks: [],
  };

  let zip: ZipReader;
  try {
    zip = readZip(bytes);
  } catch (e) {
    out.checks.push(fail('zip', `The file is not a readable ZIP archive: ${messageOf(e)}`, 'TW-PRJ-004'));
    return out;
  }
  const paths = zip.paths();
  out.checks.push(pass('zip', `The archive is readable and holds ${paths.length} entries.`));

  out.checks.push(mimetypeCheck(zip, paths));
  const raw = readJson(zip, MANIFEST);
  const version = formatVersionCheck(raw);
  out.checks.push(version);
  const manifest = validManifest(raw, out.checks);
  // A manifest of an unsupported version is still used for the checks below, but not handed on.
  if (manifest !== null && version.ok) out.manifest = manifest;

  out.checks.push(...entryChecks(zip, paths, manifest));
  out.checks.push(...originalChecks(zip, paths, manifest, out.originals));

  out.auditJsonl = readTextOrNull(zip, AUDIT);
  if (manifest !== null) {
    for (const ref of manifest.rulePacks) {
      const json = readTextOrNull(zip, rulePackPath(ref));
      if (json !== null) out.rulePacks.push({ ref, json });
    }
    const registry = readTextOrNull(zip, unitRegistryPath(manifest.unitRegistry.version));
    if (registry !== null) out.unitRegistry = { version: manifest.unitRegistry.version, json: registry };
  }
  return out;
}

function mimetypeCheck(zip: ZipReader, paths: string[]): IntegrityCheck {
  if (paths[0] !== MIMETYPE) {
    return fail(
      'mimetype',
      'The first entry is not "mimetype", so this is not a Tracewell project file.',
      'TW-PRJ-004',
    );
  }
  const text = readTextOrNull(zip, MIMETYPE);
  if (text !== TWP_MIMETYPE) {
    return fail(
      'mimetype',
      `The mimetype entry reads "${text ?? '(unreadable)'}", not "${TWP_MIMETYPE}".`,
      'TW-PRJ-004',
    );
  }
  return pass('mimetype', `The file identifies itself as ${TWP_MIMETYPE}.`);
}

type RawJson = { ok: true; value: unknown } | { ok: false; reason: string };

function readJson(zip: ZipReader, path: string): RawJson {
  if (!zip.has(path)) return { ok: false, reason: `${path} is missing` };
  try {
    return { ok: true, value: JSON.parse(zip.readText(path)) as unknown };
  } catch (e) {
    return { ok: false, reason: `${path} could not be read: ${messageOf(e)}` };
  }
}

function formatVersionCheck(raw: RawJson): IntegrityCheck {
  if (!raw.ok) return fail('format-version', `The format version is unknown because ${raw.reason}.`, 'TW-PRJ-004');
  const value = raw.value as { format?: unknown; formatVersion?: unknown } | null;
  const format = typeof value === 'object' && value !== null ? value.format : undefined;
  const version = typeof value === 'object' && value !== null ? value.formatVersion : undefined;
  if (format !== 'tracewell-project') {
    return fail(
      'format-version',
      `The manifest format is ${JSON.stringify(format)}, not "tracewell-project".`,
      'TW-PRJ-004',
    );
  }
  if (typeof version !== 'string' || !TWP_READ_VERSIONS.includes(version)) {
    return fail(
      'format-version',
      `The project uses format version ${JSON.stringify(version)}; this version of Tracewell reads ${TWP_READ_VERSIONS.join(' and ')}.`,
      'TW-PRJ-004',
    );
  }
  return pass('format-version', `Format tracewell-project ${version} is supported.`);
}

/** The manifest's own version when this reader opens it, else the one it writes. */
function readableVersion(value: unknown): string {
  const v = (value as { formatVersion?: unknown }).formatVersion;
  return typeof v === 'string' && TWP_READ_VERSIONS.includes(v) ? v : TWP_FORMAT_VERSION;
}

/**
 * Validates the manifest's structure independently of its version number, so an unsupported
 * version and a malformed manifest are reported as two separate findings.
 */
function validManifest(raw: RawJson, checks: IntegrityCheck[]): ProjectManifest | null {
  if (!raw.ok) {
    checks.push(fail('manifest-schema', `The manifest cannot be checked because ${raw.reason}.`));
    return null;
  }
  const candidate =
    typeof raw.value === 'object' && raw.value !== null && !Array.isArray(raw.value)
      ? { ...(raw.value as Record<string, unknown>), formatVersion: readableVersion(raw.value) }
      : raw.value;
  const checked = schemas.projectManifest.safeParse(candidate);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? 'the top level' : issue.path.join('.');
    checks.push(
      fail('manifest-schema', `The manifest is not well formed at ${where}: ${issue?.message ?? 'invalid'}.`),
    );
    return null;
  }
  checks.push(pass('manifest-schema', 'The manifest is well formed.'));
  return checked.data;
}

/**
 * Every entry the manifest lists must be present with the recorded size and SHA-256, no other
 * entries may be present, and CHECKSUMS.sha256 must agree with the archive for the entries the
 * manifest cannot cover (the manifest itself and the mimetype marker).
 */
function entryChecks(zip: ZipReader, paths: string[], manifest: ProjectManifest | null): IntegrityCheck[] {
  const failures: IntegrityCheck[] = [];
  const digest = (path: string): string | null => {
    try {
      return sha256Hex(zip.read(path));
    } catch {
      return null;
    }
  };

  if (manifest !== null) {
    const listed = new Set(manifest.entries.map((e) => e.path));
    for (const e of manifest.entries) {
      if (!zip.has(e.path)) {
        failures.push(
          fail('entry-checksum', `The entry ${e.path} listed in the manifest is missing.`, 'TW-PRJ-004', e.path),
        );
      } else if (zip.size(e.path) !== e.size || digest(e.path) !== e.sha256) {
        failures.push(
          fail(
            'entry-checksum',
            `The entry ${e.path} does not match its recorded SHA-256 checksum.`,
            'TW-PRJ-004',
            e.path,
          ),
        );
      }
    }
    for (const path of paths) {
      if (!UNLISTED.has(path) && !listed.has(path)) {
        failures.push(fail('entry-checksum', `The entry ${path} is not listed in the manifest.`, 'TW-PRJ-004', path));
      }
    }
  }

  const sums = checksumList(zip);
  if (sums === null) {
    failures.push(fail('entry-checksum', `${CHECKSUMS} is missing or unreadable.`, 'TW-PRJ-004', CHECKSUMS));
  } else {
    const covered = new Set(sums.map((s) => s.path));
    for (const s of sums) {
      if (!zip.has(s.path) || digest(s.path) !== s.sha256) {
        failures.push(fail('entry-checksum', `The entry ${s.path} does not match ${CHECKSUMS}.`, 'TW-PRJ-004', s.path));
      }
    }
    for (const path of paths) {
      if (path !== CHECKSUMS && !covered.has(path)) {
        failures.push(fail('entry-checksum', `The entry ${path} is not listed in ${CHECKSUMS}.`, 'TW-PRJ-004', path));
      }
    }
  }

  const unique = dedupeByTarget(failures);
  if (unique.length > 0) return unique;
  return [pass('entry-checksum', `All ${paths.length} entries match their recorded SHA-256 checksums.`)];
}

function checksumList(zip: ZipReader): { path: string; sha256: string }[] | null {
  const text = readTextOrNull(zip, CHECKSUMS);
  if (text === null) return null;
  try {
    return parseChecksumsFile(text);
  } catch {
    return null;
  }
}

/** Each original's SHA-256 must equal its file ID, which is also the folder it is stored under. */
function originalChecks(
  zip: ZipReader,
  paths: string[],
  manifest: ProjectManifest | null,
  into: TwpContents['originals'],
): IntegrityCheck[] {
  const failures: IntegrityCheck[] = [];
  if (manifest === null) {
    // Without a manifest the content addresses can still be checked, though the files cannot be named.
    for (const path of paths.filter((p) => p.startsWith('originals/'))) {
      const folder = path.split('/')[1];
      const bytes = readOrNull(zip, path);
      if (bytes === null || sha256Hex(bytes) !== folder) {
        failures.push(
          fail('original-checksum', `The original ${path} does not match its content address.`, 'TW-PRJ-001', path),
        );
      }
    }
    if (failures.length > 0) return failures;
    return [
      pass(
        'original-checksum',
        'The originals match their content addresses; the manifest is unavailable to name them.',
      ),
    ];
  }

  for (const o of manifest.originals) {
    const { path, ...info } = o;
    const bytes = readOrNull(zip, path);
    if (bytes === null) {
      failures.push(fail('original-checksum', `The original "${o.name}" is missing from ${path}.`, 'TW-PRJ-001', path));
      continue;
    }
    into.set(o.fileId, { info, bytes });
    const digest = sha256Hex(bytes);
    if (digest !== o.fileId || path.split('/')[1] !== o.fileId) {
      failures.push(
        fail(
          'original-checksum',
          `The original "${o.name}" has changed: its SHA-256 is ${digest}, but it was imported as ${o.fileId}.`,
          'TW-PRJ-001',
          path,
        ),
      );
    }
  }
  if (failures.length > 0) return failures;
  const n = manifest.originals.length;
  return [
    pass(
      'original-checksum',
      n === 0
        ? 'The project has no original files.'
        : `All ${n} original files are byte-identical to the files imported.`,
    ),
  ];
}

function dedupeByTarget(checks: IntegrityCheck[]): IntegrityCheck[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    const key = c.target ?? c.detail;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readOrNull(zip: ZipReader, path: string): Uint8Array | null {
  if (!zip.has(path)) return null;
  try {
    return zip.read(path);
  } catch {
    return null;
  }
}

function readTextOrNull(zip: ZipReader, path: string): string | null {
  if (!zip.has(path)) return null;
  try {
    return zip.readText(path);
  } catch {
    return null;
  }
}

function pass(id: IntegrityCheck['id'], detail: string): IntegrityCheck {
  return { id, ok: true, detail };
}

function fail(
  id: IntegrityCheck['id'],
  detail: string,
  ruleId?: IntegrityCheck['ruleId'],
  target?: string,
): IntegrityCheck {
  return {
    id,
    ok: false,
    ...(target === undefined ? {} : { target }),
    detail,
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

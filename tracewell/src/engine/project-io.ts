/**
 * Saving and opening projects (SAD sections 8.1 and 11). A save records the digests of every
 * dataset's working and output views in the audit log and the manifest. Opening never trusts the
 * file: it checks every checksum, verifies the audit chain, rebuilds every dataset by replaying the
 * log over the originals, and compares the result with the saved digests. Any failure opens the
 * project read-only with the matching TW-PRJ issue; nothing is repaired silently. A recovery
 * journal (FR-PRJ-03) is opened the same way, without saved digests to compare with.
 */
import { AuditLog } from '@tw/audit';
import { sha256Hex } from '@tw/io';
import {
  EngineError,
  type AuditEntry,
  type IntegrityCheck,
  type IssueDraft,
  type JsonValue,
  type OriginalFileInfo,
  type ProjectId,
  type ProjectManifest,
  type RulePackRef,
} from '@tw/model';
import { readTwp, writeTwp } from '@tw/project';
import { BUILTIN_PACK_JSON, systemIssue } from '@tw/rules';
import { viewDigest } from '@tw/table';
import { REGISTRY_JSON, REGISTRY_VERSION } from '@tw/units';
import { cancelledError } from './jobs';
import { applyEntry } from './reducer';
import { emptyProject, type ProjectState } from './state';
import { outputView, workingView } from './views';

export type DatasetDigest = ProjectManifest['datasets'][number];

/** The digests a save records and an open compares, in dataset order. */
export function datasetDigests(state: ProjectState): DatasetDigest[] {
  return [...state.datasets.values()].map((ds) => ({
    id: ds.id,
    name: ds.dataset.schema.name,
    rowCount: ds.dataset.rowCount,
    workingDigest: viewDigest(workingView(ds)).sha256,
    outputDigest: viewDigest(outputView(ds)).sha256,
  }));
}

function packJson(ref: RulePackRef): string {
  const json = (BUILTIN_PACK_JSON as Record<string, string | undefined>)[ref.id];
  if (json === undefined) {
    throw new EngineError(
      'INTERNAL',
      `The rule pack ${ref.id} ${ref.version} is not available to save.`,
      'Run the checks again with the built-in rule packs, then save.',
    );
  }
  return json;
}

/** The `.twp` bytes of a project whose last audit entry is its `project.save`. */
export function projectBytes(state: ProjectState, appVersion: string, digests: DatasetDigest[]): Uint8Array {
  const savedAt = state.lastSavedAt ?? state.createdAt;
  return writeTwp({
    manifest: {
      appVersion,
      projectId: state.id,
      name: state.name,
      createdAt: state.createdAt,
      savedAt,
      savedBy: state.profile.name,
      unitSystem: state.unitSystem,
      projectArea: state.projectArea,
      // writeTwp computes these three from the files it stores.
      unitRegistry: { version: REGISTRY_VERSION, sha256: '0'.repeat(64) },
      rulePacks: state.rulePacks,
      originals: [],
      datasets: digests,
      auditHead: state.log.head,
    },
    originals: [...state.originals.values()],
    auditJsonl: state.log.toJsonl(),
    rulePacks: state.rulePacks.map((ref) => ({ ref, json: packJson(ref) })),
    unitRegistry: { version: REGISTRY_VERSION, json: REGISTRY_JSON },
  });
}

function pass(id: IntegrityCheck['id'], detail: string): IntegrityCheck {
  return { id, ok: true, detail };
}

function fail(
  id: IntegrityCheck['id'],
  detail: string,
  ruleId: NonNullable<IntegrityCheck['ruleId']>,
  target?: string,
): IntegrityCheck {
  return { id, ok: false, ...(target === undefined ? {} : { target }), detail, ruleId };
}

export interface OpenContext {
  memoryBudgetBytes: number;
  signal: AbortSignal;
  onProgress(done: number, total: number): void;
}

export interface Opened {
  state: ProjectState;
  checks: IntegrityCheck[];
  readOnly: boolean;
}

/** A project rebuilt from `.twp` bytes, with one check result per integrity check (SAD section 11.3). */
export async function openProjectBytes(bytes: Uint8Array, fileName: string, ctx: OpenContext): Promise<Opened> {
  const contents = readTwp(bytes);
  const checks = [...contents.checks];
  const manifest = contents.manifest;
  const placeholder = 'p_0000000000000000';

  if (manifest === null || contents.auditJsonl === null) {
    const state = emptyProject(manifest?.projectId ?? placeholder);
    state.name = manifest?.name ?? fileName.replace(/\.twp$/i, '');
    state.createdAt = manifest?.createdAt ?? '';
    const why = manifest === null ? 'the manifest could not be read' : 'audit.jsonl is missing or unreadable';
    checks.push(fail('audit-chain', `The audit chain cannot be verified because ${why}.`, 'TW-PRJ-002'));
    checks.push(fail('replay-digest', `The datasets cannot be rebuilt because ${why}.`, 'TW-PRJ-003'));
    return finish(state, checks);
  }

  const { log, report } = AuditLog.fromJsonl(manifest.projectId, contents.auditJsonl);
  const head = log.head;
  if (!report.ok) {
    const at = report.brokenAt === undefined ? '' : ` at entry ${report.brokenAt}`;
    checks.push(
      fail(
        'audit-chain',
        `The audit chain is broken${at}: ${report.reason ?? 'an entry does not verify'}.`,
        'TW-PRJ-002',
      ),
    );
  } else if (head.seq !== manifest.auditHead.seq || head.hash !== manifest.auditHead.hash) {
    checks.push(
      fail(
        'audit-chain',
        `The audit log ends at entry ${head.seq}, but the manifest says it ends at entry ${manifest.auditHead.seq} with another hash.`,
        'TW-PRJ-002',
      ),
    );
  } else {
    checks.push(pass('audit-chain', `All ${report.entries} audit entries verify, each linked to the one before.`));
  }

  const state = emptyProject(manifest.projectId, log);
  for (const [fileId, o] of contents.originals) state.originals.set(fileId, { info: { ...o.info }, bytes: o.bytes });
  const stopped = await replay(state, log.entries(), ctx);
  if (state.name === '') state.name = manifest.name;
  if (state.createdAt === '') state.createdAt = manifest.createdAt;
  checks.push(...replayChecks(state, manifest, stopped));
  return finish(state, checks);
}

/** Applies the entries in order; the first that cannot be applied stops the replay. */
async function replay(
  state: ProjectState,
  entries: readonly AuditEntry[],
  ctx: OpenContext,
): Promise<{ seq: number; message: string } | null> {
  for (let i = 0; i < entries.length; i++) {
    if (ctx.signal.aborted) throw cancelledError('project opening');
    const e = entries[i] as AuditEntry;
    try {
      await applyEntry(state, e, { memoryBudgetBytes: ctx.memoryBudgetBytes, signal: ctx.signal });
    } catch (err) {
      if (ctx.signal.aborted) throw cancelledError('project opening');
      return { seq: e.seq, message: EngineError.from(err).message };
    }
    ctx.onProgress(i + 1, entries.length);
  }
  return null;
}

/** What a session's recovery journal holds: its audit log and the original files it imported. */
export interface JournalContents {
  projectId: ProjectId;
  name: string;
  auditJsonl: string;
  originals: { info: OriginalFileInfo; bytes: Uint8Array }[];
}

/**
 * A project rebuilt from a recovery journal (FR-PRJ-03): each original must match its SHA-256,
 * the audit chain must verify and every entry must replay; otherwise it opens read-only.
 */
export async function openJournal(j: JournalContents, ctx: OpenContext): Promise<Opened> {
  const checks: IntegrityCheck[] = [];
  for (const o of j.originals) {
    if (sha256Hex(o.bytes) !== o.info.fileId) {
      checks.push(
        fail(
          'original-checksum',
          `The recovered copy of ${o.info.name} does not match its SHA-256.`,
          'TW-PRJ-001',
          o.info.fileId,
        ),
      );
    }
  }
  if (checks.length === 0) {
    checks.push(pass('original-checksum', `All ${j.originals.length} original files match their SHA-256.`));
  }
  const { log, report } = AuditLog.fromJsonl(j.projectId, j.auditJsonl);
  checks.push(
    report.ok
      ? pass('audit-chain', `All ${report.entries} recovered audit entries verify, each linked to the one before.`)
      : fail(
          'audit-chain',
          `The recovered audit chain is broken${report.brokenAt === undefined ? '' : ` at entry ${report.brokenAt}`}: ${report.reason ?? 'an entry does not verify'}.`,
          'TW-PRJ-002',
        ),
  );
  const state = emptyProject(j.projectId, log);
  for (const o of j.originals) state.originals.set(o.info.fileId, { info: { ...o.info }, bytes: o.bytes });
  const stopped = await replay(state, log.entries(), ctx);
  checks.push(
    stopped === null
      ? pass(
          'replay-digest',
          `All ${state.datasets.size} datasets were rebuilt from the original files and the recovered audit log.`,
        )
      : fail(
          'replay-digest',
          `Rebuilding the project stopped at audit entry ${stopped.seq}: ${stopped.message}`,
          'TW-PRJ-003',
        ),
  );
  if (state.name === '') state.name = j.name;
  return finish(state, checks);
}

function replayChecks(
  state: ProjectState,
  manifest: ProjectManifest,
  stopped: { seq: number; message: string } | null,
): IntegrityCheck[] {
  if (stopped !== null) {
    return [
      fail(
        'replay-digest',
        `Rebuilding the project stopped at audit entry ${stopped.seq}: ${stopped.message}`,
        'TW-PRJ-003',
      ),
    ];
  }
  const rebuilt = new Map(datasetDigests(state).map((d) => [d.id, d]));
  const failures: IntegrityCheck[] = [];
  for (const saved of manifest.datasets) {
    const now = rebuilt.get(saved.id);
    rebuilt.delete(saved.id);
    if (now === undefined) {
      failures.push(
        fail(
          'replay-digest',
          `Dataset ${saved.id} (${saved.name}) is not rebuilt by the audit log.`,
          'TW-PRJ-003',
          saved.id,
        ),
      );
    } else if (
      now.rowCount !== saved.rowCount ||
      now.workingDigest !== saved.workingDigest ||
      now.outputDigest !== saved.outputDigest
    ) {
      const what =
        now.rowCount !== saved.rowCount
          ? `${now.rowCount} rows instead of the ${saved.rowCount} saved`
          : now.workingDigest !== saved.workingDigest
            ? 'working data that differs from the saved digest'
            : 'output data that differs from the saved digest';
      failures.push(
        fail('replay-digest', `Rebuilding dataset ${saved.id} (${saved.name}) gives ${what}.`, 'TW-PRJ-003', saved.id),
      );
    }
  }
  for (const extra of rebuilt.values()) {
    failures.push(
      fail(
        'replay-digest',
        `The audit log builds dataset ${extra.id}, which the manifest does not list.`,
        'TW-PRJ-003',
        extra.id,
      ),
    );
  }
  if (failures.length > 0) return failures;
  const n = manifest.datasets.length;
  return [
    pass(
      'replay-digest',
      n === 0
        ? 'The project has no datasets to rebuild.'
        : `All ${n} datasets were rebuilt from the originals and the audit log and match their saved digests.`,
    ),
  ];
}

/** One system issue per failed rule, naming the first failure and how many more there are. */
function finish(state: ProjectState, checks: IntegrityCheck[]): Opened {
  const failed = checks.filter((c) => !c.ok);
  const readOnly = failed.length > 0;
  state.readOnly = readOnly;
  const byRule = new Map<string, IntegrityCheck[]>();
  for (const c of failed) {
    if (c.ruleId === undefined) continue;
    byRule.set(c.ruleId, [...(byRule.get(c.ruleId) ?? []), c]);
  }
  const issues: IssueDraft[] = [];
  for (const [ruleId, list] of byRule) {
    const first = list[0] as IntegrityCheck;
    const more = list.length > 1 ? ` (and ${list.length - 1} more)` : '';
    const datasetId =
      list.every((c) => c.target !== undefined && state.datasets.has(c.target)) && list.length === 1
        ? (first.target as string)
        : '';
    const detail: Record<string, JsonValue> = {
      checks: list.map((c) => ({ id: c.id, detail: c.detail, target: c.target ?? null })),
    };
    issues.push(systemIssue(ruleId, datasetId, `${first.detail}${more}`, detail));
  }
  state.systemIssues = issues;
  return { state, checks, readOnly };
}

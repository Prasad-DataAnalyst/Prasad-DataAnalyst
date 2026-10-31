/** The bottom panels: the audit log, read-only with its chain status, and the jobs list. */
import { useState } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type { AuditAction, AuditEntry, JsonValue } from '@tw/model';
import { formatCount, useWorkbench } from '@tw/ui-shell';
import { ErrorNote, Progress } from './common';
import { useEngineQuery, useProject } from './hooks';
import { TID } from './testids';

const PAGE = 100;

const ACTION_TEXT: Record<AuditAction, string> = {
  'project.create': 'Project created',
  'source.add': 'File imported',
  'detection.assume': 'Detections assumed',
  'detection.override': 'Detection overridden',
  'check.run': 'Checks run',
  'cell.edit': 'Cell edited',
  'issue.accept': 'Issue accepted',
  'issue.comment': 'Comment',
  'rows.exclude': 'Rows excluded',
  'step.apply': 'Step applied',
  'step.remove': 'Step removed',
  'entry.revert': 'Change reverted',
  'project.area': 'Project area set',
  'export.create': 'Exported',
  'project.save': 'Project saved',
  'recipe.apply': 'Recipe run',
};

function short(v: JsonValue | undefined): string {
  if (v === undefined) return '';
  if (v === null) return 'empty';
  if (typeof v === 'object' && !Array.isArray(v)) {
    if ('date' in v) return String(v['date']);
    if ('datetime' in v) return String(v['datetime']);
  }
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function target(e: AuditEntry): string {
  const t = e.target;
  const parts = [
    t.datasetId,
    t.locator ?? (t.rowId === undefined ? undefined : `row ${t.rowId + 1}`),
    t.locator === undefined ? t.columnId : undefined,
    t.stepId,
    t.issueId,
    t.seq === undefined ? undefined : `entry #${t.seq}`,
    (e.payload as { property?: string } | undefined)?.property,
  ];
  return parts.filter((x) => x !== undefined && x !== '').join(' · ');
}

function change(e: AuditEntry): string {
  if (e.action === 'rows.exclude')
    return `${formatCount((e.payload as { count?: number } | undefined)?.count ?? 0)} rows`;
  if (e.action === 'issue.accept') {
    const rows = (e.payload as { rows?: number[] | 'all' } | undefined)?.rows;
    return rows === 'all' ? 'whole issue' : `${formatCount(rows?.length ?? 0)} rows`;
  }
  if (e.action === 'step.apply') return (e.payload as { description?: string } | undefined)?.description ?? '';
  if (e.action === 'source.add') return short((e.new as { fileName?: JsonValue } | undefined)?.fileName);
  if (e.action === 'detection.assume')
    return `${(e.payload as { assumptions?: unknown[] } | undefined)?.assumptions?.length ?? 0} assumptions`;
  if (e.old === undefined && e.new === undefined) return '';
  return e.old === undefined ? short(e.new) : `${short(e.old)} → ${short(e.new)}`;
}

export function LogPanel(p: { engine: EngineClient }): React.JSX.Element {
  const { engine } = p;
  const project = useProject();
  const [offset, setOffset] = useState(0);
  const key = project === null ? null : `${project.id}:${offset}`;
  const page = useEngineQuery(engine, key, () => engine.listAudit({ offset, limit: PAGE, order: 'desc' }), ['audit']);
  const chain = useEngineQuery(engine, project === null ? null : `chain:${project.id}`, () => engine.verifyAudit(), [
    'audit',
  ]);
  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;
  return (
    <div className="tw-log" data-testid={TID.log}>
      <div className="tw-view-toolbar">
        <span data-testid={TID.chainStatus} className={chain.data?.ok === false ? 'tw-fail' : 'tw-ok'} role="status">
          {chain.data === null
            ? 'Verifying the audit chain…'
            : chain.data.ok
              ? `✓ Audit chain verified: ${formatCount(chain.data.entries)} entries, each linked to the one before by SHA-256`
              : `✗ Audit chain broken at entry ${chain.data.brokenAt ?? '?'}: ${chain.data.reason ?? ''}`}
        </span>
        <span className="tw-toolbar-spacer" />
        {total > PAGE && (
          <span className="tw-pager">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </button>
            <span>
              {formatCount(offset + 1)}–{formatCount(Math.min(total, offset + PAGE))} of {formatCount(total)}
            </span>
            <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              Older
            </button>
          </span>
        )}
      </div>
      <ErrorNote error={page.error} />
      <div className="tw-table-scroll">
        <table className="tw-table tw-log-table" aria-label="Audit log">
          <thead>
            <tr>
              <th scope="col" className="tw-num">
                #
              </th>
              <th scope="col">Time (UTC)</th>
              <th scope="col">By</th>
              <th scope="col">Action</th>
              <th scope="col">Target</th>
              <th scope="col">Change</th>
              <th scope="col">Reason</th>
              <th scope="col">Method</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.seq} data-testid={TID.logRow(e.seq)} data-action={e.action}>
                <td className="tw-num">{e.seq}</td>
                <td className="tw-mono">{e.at.replace('T', ' ').slice(0, 19)}</td>
                <td>{e.actor.kind === 'user' ? e.actor.name : `system (${e.actor.component})`}</td>
                <td title={e.action}>{ACTION_TEXT[e.action]}</td>
                <td className="tw-mono">{target(e)}</td>
                <td>{change(e)}</td>
                <td>{e.reason ?? ''}</td>
                <td>
                  {e.method === undefined ? (
                    ''
                  ) : (
                    <span title={e.method.source}>
                      {e.method.formula} <span className="tw-muted">({e.method.source})</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function JobsPanel(p: { engine: EngineClient }): React.JSX.Element {
  const jobs = useWorkbench((s) => s.jobs);
  const list = Object.values(jobs).reverse();
  return (
    <div className="tw-jobs" data-testid={TID.jobs}>
      {list.length === 0 ? (
        <p className="tw-empty">No jobs yet. Imports, checks, steps, exports, saves and opens run here.</p>
      ) : (
        <table className="tw-table" aria-label="Jobs">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">State</th>
              <th scope="col">Progress</th>
              <th scope="col">
                <span className="tw-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((j) => (
              <tr key={j.handle.jobId} data-state={j.state}>
                <td>{j.label}</td>
                <td>
                  <span className={`tw-job tw-job-${j.state}`}>{j.state}</span>
                  {j.error !== undefined && <div className="tw-fail">{j.error.message}</div>}
                </td>
                <td>
                  {j.state === 'running' ? (
                    <Progress
                      done={j.progress?.done ?? 0}
                      {...(j.progress?.total === undefined ? {} : { total: j.progress.total })}
                      label={j.progress?.phase ?? 'Waiting'}
                    />
                  ) : (
                    ''
                  )}
                </td>
                <td>
                  {j.state === 'running' && (
                    <button type="button" onClick={() => void p.engine.cancelJob(j.handle.jobId)}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * The export centre (SAD section 10): one card per destination. Every package is written, read
 * back independently and checked before it is offered; the checklist shows each read-back check,
 * and a package that fails any check is never offered for saving.
 */
import { useState } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type { DatasetId, ExportProfileId, ExportProfileStatus, ExportResult } from '@tw/model';
import { formatCount, useJob, useWorkbench, type CentreViewProps } from '@tw/ui-shell';
import { ErrorNote, Progress, downloadBytes, formatBytes } from './common';
import { attempt, datasetFor, useEngineQuery, useProject } from './hooks';
import { exportKey, useViews, views } from './store';
import { TID } from './testids';

const CHECK_LABELS: Record<string, string> = {
  'RB-OPEN': 'The file opens',
  'RB-ROWS': 'Row count matches',
  'RB-HEADER': 'Headers and units match',
  'RB-VALUES': 'Every value matches its column digest',
  'RB-CSV-ENCODING': 'UTF-8 without byte-order mark, same field count on every row',
  'RB-XLSX-TYPES': 'Cell types are right (numbers, dates, text)',
  'RB-XLSX-STRUCTURE': 'Workbook structure (sheets, frozen header, filter)',
  'RB-GEOJSON-STRUCTURE': 'Valid GeoJSON in WGS84',
  'RB-PKG-CHECKSUMS': 'Package checksums verify',
  'RB-PKG-CONTENTS': 'Package contents complete',
};

export function ExportCentreView(p: CentreViewProps): React.JSX.Element {
  const project = useProject();
  const datasetId = datasetFor(p.tab, project);
  if (datasetId === null) return <div className="tw-empty">Import a file before exporting.</div>;
  return <Centre engine={p.engine} datasetId={datasetId} />;
}

function Centre(p: { engine: EngineClient; datasetId: DatasetId }): React.JSX.Element {
  const { engine, datasetId } = p;
  const project = useProject();
  const summary = project?.datasets.find((d) => d.id === datasetId);
  const profiles = useEngineQuery(engine, `profiles:${datasetId}`, () => engine.listExportProfiles(datasetId), [
    'datasets',
    'schema',
    'steps',
  ]);
  const [baseName, setBaseName] = useState('');
  return (
    <div className="tw-view tw-export-centre" data-testid={TID.exportCentre}>
      <div className="tw-view-toolbar">
        <strong className="tw-view-title">Export {summary?.name ?? datasetId}</strong>
        <span className="tw-view-meta">
          {formatCount(summary?.outputRowCount ?? 0)} output rows · {summary?.steps.length ?? 0} steps
        </span>
        <span className="tw-toolbar-spacer" />
        <label className="tw-inline-field">
          File name
          <input
            placeholder={summary?.name ?? 'export'}
            value={baseName}
            aria-label="Export file name"
            onChange={(e) => setBaseName(e.target.value)}
          />
        </label>
      </div>
      <p className="tw-hint tw-pad">
        Each package holds the data file, a README, the manifest, the audit log, the open issues and checksums. It is
        read back and verified before it is offered.
      </p>
      <ErrorNote error={profiles.error} />
      <div className="tw-cards">
        {(profiles.data ?? []).map((s) => (
          <ExportCard key={s.profile.id} engine={engine} datasetId={datasetId} status={s} baseName={baseName} />
        ))}
      </div>
    </div>
  );
}

function ExportCard(p: {
  engine: EngineClient;
  datasetId: DatasetId;
  status: ExportProfileStatus;
  baseName: string;
}): React.JSX.Element {
  const { engine, datasetId, status } = p;
  const profile = status.profile;
  const key = exportKey(datasetId, profile.id);
  const handle = useViews((s) => s.exports[key] ?? null);
  const job = useJob<ExportResult>(handle);
  const readOnly = useWorkbench((s) => s.project?.readOnly === true);
  const result = job.result;

  const start = async () => {
    const h = await attempt(() =>
      engine.exportData({
        datasetId,
        profile: profile.id,
        ...(p.baseName.trim() === '' ? {} : { baseName: p.baseName.trim() }),
      }),
    );
    if (h === null) return;
    useWorkbench.getState().trackJob(h, `Export ${profile.label}`);
    views.set((s) => ({ exports: { ...s.exports, [key]: h } }));
  };

  return (
    <article
      className={`tw-card${status.available ? '' : ' tw-card-disabled'}`}
      data-testid={TID.exportCard(profile.id)}
      aria-labelledby={`card-${profile.id}`}
    >
      <header className="tw-card-head">
        <span className="tw-card-ext" aria-hidden="true">
          {profile.dataExtension}
        </span>
        <div>
          <h3 id={`card-${profile.id}`} className="tw-card-title">
            {profile.label}
          </h3>
          <div className="tw-muted">{profile.destinations.join(' · ')}</div>
        </div>
      </header>
      <p className="tw-card-text">{profile.description}</p>
      {!status.available && (
        <div className="tw-error-note" role="note">
          <strong>{status.reason}</strong>
          {status.fix !== undefined && <div>{status.fix}</div>}
        </div>
      )}
      {status.substitutions.map((s, i) => (
        <div key={i} className="tw-warning-note" role="note">
          <strong>{s.ruleId}:</strong> {s.what} — {s.why} {s.instead}
        </div>
      ))}
      <div className="tw-card-actions">
        <button
          type="button"
          className="tw-primary"
          data-testid={TID.exportButton(profile.id)}
          disabled={!status.available || readOnly || job.state === 'running'}
          onClick={() => void start()}
        >
          {job.state === 'running' ? 'Exporting…' : `Export ${profile.label}`}
        </button>
        {job.state === 'running' && (
          <button type="button" onClick={job.cancel}>
            Cancel
          </button>
        )}
      </div>
      <div
        data-testid={TID.exportStatus}
        data-state={job.state === 'done' ? (result?.ok === true ? 'validated' : 'failed') : job.state}
      >
        {job.state === 'running' && (
          <Progress
            done={job.progress?.done ?? 0}
            {...(job.progress?.total === undefined ? {} : { total: job.progress.total })}
            label={job.progress?.phase ?? 'Starting'}
          />
        )}
        {job.state === 'failed' && <ErrorNote error={job.error} />}
        {job.state === 'cancelled' && <p className="tw-muted">Export cancelled; nothing was written.</p>}
        {result !== null && <ExportOutcome result={result} />}
      </div>
    </article>
  );
}

function ExportOutcome(p: { result: ExportResult }): React.JSX.Element {
  const r = p.result;
  const m = r.manifest;
  return (
    <div className="tw-outcome">
      <div className={`tw-outcome-head ${r.ok ? 'tw-ok' : 'tw-fail'}`} role="status">
        {r.ok ? '✓ Validated' : '✗ Validation failed (TW-EXP-001): no package is offered'}
      </div>
      <ul className="tw-checklist" data-testid={TID.validation} aria-label="Read-back checks">
        {r.validation.checks.map((c, i) => (
          <li
            key={`${c.id}-${c.file ?? ''}-${i}`}
            className={c.ok ? 'tw-check-ok' : 'tw-check-fail'}
            data-testid={TID.validationCheck(c.id)}
            data-ok={c.ok}
          >
            <span className="tw-check-icon" aria-hidden="true">
              {c.ok ? '✓' : '✗'}
            </span>
            <span>
              <strong>{CHECK_LABELS[c.id] ?? c.id}</strong> <span className="tw-mono tw-muted">{c.id}</span>
              {c.file !== undefined && <span className="tw-muted"> · {c.file}</span>}
              <div className="tw-muted">{c.detail}</div>
            </span>
          </li>
        ))}
      </ul>
      {r.ok && (
        <>
          <dl className="tw-kv">
            <dt>Package</dt>
            <dd className="tw-mono">{r.packageName}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(r.size)}</dd>
            <dt>SHA-256</dt>
            <dd className="tw-mono tw-break">{r.packageSha256}</dd>
            <dt>Rows</dt>
            <dd>
              {formatCount(m.dataset.rowCount)} ({formatCount(m.excludedRows)} excluded)
            </dd>
            <dt>Open issues</dt>
            <dd>
              {m.openIssues.error} errors, {m.openIssues.warning} warnings, {m.openIssues.note} notes
            </dd>
            <dt>Assumptions</dt>
            <dd>{m.assumptions.length}</dd>
          </dl>
          <button
            type="button"
            className="tw-primary"
            data-testid={TID.savePackage}
            disabled={r.bytes === undefined}
            onClick={() => r.bytes !== undefined && downloadBytes(r.bytes, r.packageName, 'application/zip')}
          >
            Save package
          </button>
        </>
      )}
    </div>
  );
}

export type { ExportProfileId };

/**
 * Properties of whatever is selected: the project, a dataset, a column (detections with their
 * evidence, and statistics), a cell (its full lineage), an issue, a source file, a step or an export.
 */
import { Fragment } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type { CellLineage, ColumnSchema, DatasetId, IssueId, JsonValue, ProjectSummary } from '@tw/model';
import { formatCell, formatCount, useWorkbench, type Selection } from '@tw/ui-shell';
import { DetectionValue, ErrorNote, SeverityBadge, formatBytes, useReasonPrompt } from './common';
import { attempt, useEngineQuery, useProject } from './hooks';
import { DialogHost } from './dialogs';
import { TID } from './testids';

/** The properties pane; it also hosts the dialogs commands open, as it is always on screen. */
export function PropertiesPane(p: { engine: EngineClient }): React.JSX.Element {
  return (
    <>
      <PropertiesPanel engine={p.engine} />
      <DialogHost engine={p.engine} />
    </>
  );
}

export function PropertiesPanel(p: { engine: EngineClient }): React.JSX.Element {
  const selection = useWorkbench((s) => s.selection);
  const project = useProject();
  return (
    <div className="tw-properties" data-testid={TID.properties}>
      {project === null ? (
        <p className="tw-empty">No project is open.</p>
      ) : (
        <Body engine={p.engine} selection={selection} project={project} />
      )}
    </div>
  );
}

function Body(p: { engine: EngineClient; selection: Selection; project: ProjectSummary }): React.JSX.Element {
  const s = p.selection;
  switch (s.kind) {
    case 'dataset':
      return <DatasetProps engine={p.engine} project={p.project} datasetId={s.datasetId} />;
    case 'column':
      return <ColumnProps engine={p.engine} datasetId={s.datasetId} columnId={s.columnId} />;
    case 'cell':
      return <CellProps engine={p.engine} datasetId={s.datasetId} rowId={s.rowId} columnId={s.columnId} />;
    case 'issue':
      return <IssueProps engine={p.engine} issueId={s.issueId} />;
    case 'source': {
      const o = p.project.originals.find((x) => x.fileId === s.fileId);
      return o === undefined ? (
        <ProjectProps project={p.project} />
      ) : (
        <Section title="Source file">
          <dl className="tw-kv">
            <dt>Name</dt>
            <dd>{o.name}</dd>
            <dt>Size</dt>
            <dd>
              {formatBytes(o.size)} ({formatCount(o.size)} bytes)
            </dd>
            <dt>Type</dt>
            <dd>{o.mediaType}</dd>
            <dt>SHA-256</dt>
            <dd className="tw-mono tw-break">{o.fileId}</dd>
            <dt>Added by</dt>
            <dd>audit entry #{o.addedSeq}</dd>
          </dl>
          <p className="tw-hint">The original is kept byte for byte in the project file, addressed by this SHA-256.</p>
        </Section>
      );
    }
    case 'step':
      return <StepProps engine={p.engine} project={p.project} datasetId={s.datasetId} stepId={s.stepId} />;
    case 'export': {
      const e = p.project.exports.find((x) => x.exportId === s.exportId);
      return e === undefined ? (
        <ProjectProps project={p.project} />
      ) : (
        <Section title="Export">
          <dl className="tw-kv">
            <dt>Package</dt>
            <dd className="tw-mono">{e.packageName}</dd>
            <dt>Profile</dt>
            <dd>{e.profile}</dd>
            <dt>Created</dt>
            <dd>{e.createdAt.replace('T', ' ').slice(0, 19)} UTC</dd>
            <dt>SHA-256</dt>
            <dd className="tw-mono tw-break">{e.packageSha256}</dd>
          </dl>
        </Section>
      );
    }
    case 'none':
      return <ProjectProps project={p.project} />;
  }
}

function Section(p: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="tw-prop-section" aria-label={p.title}>
      <h3 className="tw-prop-title">{p.title}</h3>
      {p.children}
    </section>
  );
}

function ProjectProps(p: { project: ProjectSummary }): React.JSX.Element {
  const pr = p.project;
  return (
    <Section title="Project">
      <dl className="tw-kv">
        <dt>Name</dt>
        <dd>{pr.name}</dd>
        <dt>Analyst</dt>
        <dd>{pr.profile.name}</dd>
        <dt>Created</dt>
        <dd>{pr.createdAt.replace('T', ' ').slice(0, 19)} UTC</dd>
        <dt>Unit system</dt>
        <dd>{pr.unitSystem}</dd>
        <dt>Project area</dt>
        <dd>{pr.projectArea === null ? 'not set' : pr.projectArea.join(', ')}</dd>
        <dt>Audit log</dt>
        <dd>
          {pr.auditHead.seq} entries
          <div className="tw-mono tw-muted tw-break">{pr.auditHead.hash.slice(0, 16)}…</div>
        </dd>
        <dt>State</dt>
        <dd>{pr.readOnly ? 'Read-only' : pr.dirty ? 'Unsaved changes' : 'Saved'}</dd>
      </dl>
      <p className="tw-hint">Select a dataset, column, cell or issue to see its details here.</p>
    </Section>
  );
}

function DatasetProps(p: { engine: EngineClient; project: ProjectSummary; datasetId: DatasetId }): React.JSX.Element {
  const d = p.project.datasets.find((x) => x.id === p.datasetId);
  const schema = useEngineQuery(p.engine, `schema:${p.datasetId}`, () => p.engine.getSchema(p.datasetId), [
    'schema',
    'datasets',
  ]);
  if (d === undefined) return <ProjectProps project={p.project} />;
  return (
    <Section title="Dataset">
      <dl className="tw-kv">
        <dt>Name</dt>
        <dd>{d.name}</dd>
        <dt>Source</dt>
        <dd>
          {d.source.fileName}
          {d.source.sheet === undefined ? '' : ` › ${d.source.sheet}`} ({d.source.format.toUpperCase()})
        </dd>
        <dt>Rows</dt>
        <dd>
          {formatCount(d.rowCount)} imported, {formatCount(d.outputRowCount)} in output
          {d.partial ? ' (partial import)' : ''}
        </dd>
        <dt>Columns</dt>
        <dd>{d.columnCount}</dd>
        <dt>Assumptions</dt>
        <dd>{d.assumptions}</dd>
        {schema.data?.crs !== null && schema.data?.crs !== undefined && (
          <>
            <dt>CRS</dt>
            <dd>
              <DetectionValue d={schema.data.crs} format={(v) => (v as { code: string }).code} />
            </dd>
          </>
        )}
      </dl>
      {d.steps.length > 0 && (
        <>
          <h4 className="tw-prop-subtitle">Steps</h4>
          <ol className="tw-steps">
            {d.steps.map((s) => (
              <li key={s.id}>
                <span className="tw-mono">{s.id}</span> {s.kind.replace('_', ' ')}
              </li>
            ))}
          </ol>
        </>
      )}
      {schema.data !== null && (
        <>
          <h4 className="tw-prop-subtitle">Columns</h4>
          <ul className="tw-col-list">
            {schema.data.columns.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="tw-link"
                  onClick={() => useWorkbench.getState().select({ kind: 'column', datasetId: d.id, columnId: c.id })}
                >
                  {c.name}
                </button>{' '}
                <span className="tw-muted">
                  {c.type.value}
                  {c.unit.value === null ? '' : ` · ${c.unit.value}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function ColumnProps(p: { engine: EngineClient; datasetId: DatasetId; columnId: string }): React.JSX.Element {
  const schema = useEngineQuery(p.engine, `schema:${p.datasetId}`, () => p.engine.getSchema(p.datasetId), [
    'schema',
    'datasets',
  ]);
  const stats = useEngineQuery(
    p.engine,
    `stats:${p.datasetId}:${p.columnId}`,
    () => p.engine.getColumnStats(p.datasetId, p.columnId),
    ['datasets', 'schema', 'issues'],
  );
  const c: ColumnSchema | undefined = schema.data?.columns.find((x) => x.id === p.columnId);
  if (c === undefined) return <ErrorNote error={schema.error} />;
  const st = stats.data;
  const rows: [string, React.ReactNode][] = [
    ['Type', <DetectionValue key="t" d={c.type} />],
    ['Role', <DetectionValue key="r" d={c.role} />],
    ['Unit', <DetectionValue key="u" d={c.unit} format={(v) => (v === null ? 'none' : String(v))} />],
    ['Null markers', <DetectionValue key="n" d={c.nullMarkers} />],
  ];
  if (c.dateFormat !== undefined) rows.push(['Date format', <DetectionValue key="df" d={c.dateFormat} />]);
  if (c.timezone !== undefined) rows.push(['Time zone', <DetectionValue key="tz" d={c.timezone} />]);
  if (c.decimalSeparator !== undefined)
    rows.push(['Decimal separator', <DetectionValue key="ds" d={c.decimalSeparator} />]);
  return (
    <Section title={`Column: ${c.name}`}>
      <dl className="tw-kv">
        <dt>ID</dt>
        <dd className="tw-mono">{c.id}</dd>
        <dt>Source header</dt>
        <dd>{c.sourceHeader.join(' / ') || '—'}</dd>
        {c.quantity !== null && (
          <>
            <dt>Quantity</dt>
            <dd>{c.quantity.replace(/_/g, ' ')}</dd>
          </>
        )}
        {c.derivedFrom !== undefined && (
          <>
            <dt>Derived</dt>
            <dd>
              from {c.derivedFrom.column} by step {c.derivedFrom.step}
            </dd>
          </>
        )}
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      {st !== null && (
        <>
          <h4 className="tw-prop-subtitle">Statistics (working data)</h4>
          <dl className="tw-kv" data-testid={TID.columnStats}>
            <dt>Values</dt>
            <dd>{formatCount(st.count - st.nulls)}</dd>
            <dt>Empty</dt>
            <dd>{formatCount(st.nulls)}</dd>
            <dt>Did not parse</dt>
            <dd>{formatCount(st.rawRejected)}</dd>
            <dt>Distinct</dt>
            <dd>
              {formatCount(st.distinct)}
              {st.distinctCapped ? '+' : ''}
            </dd>
            <dt>Minimum</dt>
            <dd>{formatCell(st.min, c.type.value)}</dd>
            <dt>Maximum</dt>
            <dd>{formatCell(st.max, c.type.value)}</dd>
            {st.mean !== null && (
              <>
                <dt>Mean</dt>
                <dd>{formatCell(st.mean, 'number')}</dd>
              </>
            )}
          </dl>
          {st.topValues.length > 0 && (
            <>
              <h4 className="tw-prop-subtitle">Most common</h4>
              <ul className="tw-top-values">
                {st.topValues.map((t, i) => (
                  <li key={i}>
                    <span>{formatCell(t.value, c.type.value)}</span>{' '}
                    <span className="tw-muted">×{formatCount(t.count)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Section>
  );
}

function json(v: JsonValue | undefined): string {
  if (v === undefined) return '';
  if (v === null) return 'empty';
  if (typeof v === 'object' && !Array.isArray(v)) {
    if ('date' in v) return String(v['date']);
    if ('datetime' in v) return String(v['datetime']);
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function CellProps(p: {
  engine: EngineClient;
  datasetId: DatasetId;
  rowId: number;
  columnId: string;
}): React.JSX.Element {
  const lineage = useEngineQuery<CellLineage>(
    p.engine,
    `lineage:${p.datasetId}:${p.rowId}:${p.columnId}`,
    () => p.engine.explainCell(p.datasetId, p.rowId, p.columnId),
    ['datasets', 'schema', 'audit', 'steps'],
  );
  const l = lineage.data;
  if (l === null)
    return lineage.error === null ? (
      <p className="tw-muted">Tracing the value…</p>
    ) : (
      <ErrorNote error={lineage.error} />
    );
  return (
    <Section title="Cell lineage">
      <div data-testid={TID.lineage}>
        <dl className="tw-kv">
          <dt>Current value</dt>
          <dd className="tw-strong">
            {l.current === null ? 'empty' : formatCell(l.current, typeof l.current === 'number' ? 'number' : 'string')}
          </dd>
          <dt>Source</dt>
          <dd>
            {l.source.fileName}
            <div className="tw-mono">{l.source.locator}</div>
          </dd>
          <dt>Original text</dt>
          <dd className="tw-mono">
            {l.source.rawText === null ? '(none)' : l.source.rawText === '' ? '(empty)' : l.source.rawText}
          </dd>
          <dt>Read as</dt>
          <dd>
            {l.parse.method}
            {l.parse.nullMarker !== null && <div>matched null marker “{l.parse.nullMarker}”</div>}
            {!l.parse.ok && <div className="tw-fail">the text did not parse as {l.parse.type}</div>}
          </dd>
        </dl>
        <h4 className="tw-prop-subtitle">History</h4>
        {l.history.length === 0 ? (
          <p className="tw-muted">Unchanged since import.</p>
        ) : (
          <ol className="tw-history">
            {l.history.map((h) => (
              <li key={h.seq}>
                <div>
                  <span className="tw-mono">#{h.seq}</span> <strong>{h.action}</strong>{' '}
                  <span className="tw-muted">
                    {h.actor}, {h.at.replace('T', ' ').slice(0, 19)} UTC
                  </span>
                </div>
                {(h.old !== undefined || h.new !== undefined) && h.action === 'cell.edit' && (
                  <div>
                    {json(h.old)} → {json(h.new)}
                  </div>
                )}
                {h.method !== undefined && (
                  <div className="tw-method">
                    {h.method.formula}
                    <div className="tw-muted">{h.method.source}</div>
                  </div>
                )}
                {h.reason !== undefined && <div className="tw-reason">“{h.reason}”</div>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Section>
  );
}

function IssueProps(p: { engine: EngineClient; issueId: IssueId }): React.JSX.Element {
  const issues = useEngineQuery(p.engine, `issue:${p.issueId}`, () => p.engine.listIssues({ limit: 1000 }), ['issues']);
  const issue = issues.data?.items.find((i) => i.id === p.issueId);
  if (issue === undefined) return <p className="tw-muted">This issue is no longer in the register.</p>;
  return (
    <Section title="Issue">
      <p>
        <SeverityBadge severity={issue.severity} /> <strong>{issue.title}</strong>
      </p>
      <dl className="tw-kv">
        <dt>Rule</dt>
        <dd className="tw-mono">
          {issue.ruleId} {issue.ruleVersion}
        </dd>
        <dt>Pack</dt>
        <dd>{issue.packId}</dd>
        <dt>Message</dt>
        <dd>{issue.message}</dd>
        <dt>Counts</dt>
        <dd>
          {formatCount(issue.counts.open)} open · {formatCount(issue.counts.accepted)} accepted ·{' '}
          {formatCount(issue.counts.excluded)} excluded · {formatCount(issue.counts.fixed)} fixed
        </dd>
      </dl>
      <h4 className="tw-prop-subtitle">Why it matters</h4>
      <p>{issue.explanation}</p>
      <h4 className="tw-prop-subtitle">Source</h4>
      <p className="tw-muted">{issue.source}</p>
      {issue.comments.length > 0 && (
        <>
          <h4 className="tw-prop-subtitle">Comments</h4>
          <ul className="tw-comments">
            {issue.comments.map((c) => (
              <li key={c.seq}>
                <span className="tw-muted">{c.by}:</span> {c.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function StepProps(p: {
  engine: EngineClient;
  project: ProjectSummary;
  datasetId: DatasetId;
  stepId: string;
}): React.JSX.Element {
  const d = p.project.datasets.find((x) => x.id === p.datasetId);
  const step = d?.steps.find((s) => s.id === p.stepId);
  const entry = useEngineQuery(
    p.engine,
    step === undefined ? null : `step:${p.datasetId}:${step.seq}`,
    () => p.engine.listAudit({ fromSeq: step?.seq ?? 0, limit: 1 }),
    ['audit'],
  );
  const reason = useReasonPrompt();
  if (d === undefined || step === undefined) return <ProjectProps project={p.project} />;
  const e = entry.data?.items[0];
  const description = (e?.payload as { description?: string } | undefined)?.description ?? step.kind;
  return (
    <Section title={`Step ${step.id}`}>
      <p>{description}</p>
      <dl className="tw-kv">
        <dt>Kind</dt>
        <dd>{step.kind.replace('_', ' ')}</dd>
        <dt>Applied</dt>
        <dd>
          audit entry #{step.seq}
          {e === undefined ? '' : `, ${e.at.replace('T', ' ').slice(0, 19)} UTC`}
        </dd>
        {e?.reason !== undefined && (
          <>
            <dt>Reason</dt>
            <dd>{e.reason}</dd>
          </>
        )}
        {e?.method !== undefined && (
          <>
            <dt>Method</dt>
            <dd>
              {e.method.formula}
              <div className="tw-muted">{e.method.source}</div>
            </dd>
          </>
        )}
      </dl>
      <button
        type="button"
        disabled={p.project.readOnly}
        onClick={() =>
          void (async () => {
            const why = await reason.ask(`Remove step ${step.id}`);
            if (why === null) return;
            const done = await attempt(() => p.engine.removeStep(d.id, step.id, why));
            if (done !== null) useWorkbench.getState().select({ kind: 'dataset', datasetId: d.id });
          })()
        }
      >
        Remove step…
      </button>
      {reason.element}
      {step.kind === 'filter' && (
        <p className="tw-hint">Rows outside the filter stay in the project; only the output leaves them out.</p>
      )}
    </Section>
  );
}

/**
 * The issues register (SAD section 7.7): issues grouped per rule, dataset and columns, with counts
 * that show what is open, accepted, excluded and fixed. Each issue drills down to its occurrences
 * with source locators; accepting and excluding always ask for a reason.
 */
import { useMemo, useState } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type { DatasetId, Issue, IssueOccurrence, IssueQuery, RowId, Severity } from '@tw/model';
import { formatCell, formatCount, useWorkbench, type CentreViewProps } from '@tw/ui-shell';
import { ErrorNote, ReadOnlyBanner, SeverityBadge, display, useReasonPrompt } from './common';
import { attempt, datasetFor, useEngineQuery, useProject } from './hooks';
import { gotoRow, openDialog } from './store';
import { TID } from './testids';

const SEVERITIES: Severity[] = ['error', 'warning', 'note'];
const STATUS_TEXT: Record<Issue['status'], string> = {
  open: 'Open',
  partly_resolved: 'Partly resolved',
  resolved: 'Resolved',
};
const OCCURRENCE_PAGE = 200;

export function IssuesView(p: CentreViewProps): React.JSX.Element {
  const project = useProject();
  return <IssuesRegister engine={p.engine} datasetId={datasetFor(p.tab, project)} variant="view" />;
}

export function IssuesPanel(p: { engine: EngineClient }): React.JSX.Element {
  return <IssuesRegister engine={p.engine} datasetId={null} variant="panel" />;
}

interface Filters {
  severity: Severity[];
  status: Issue['status'] | 'all' | 'unresolved';
  ruleId: string;
  text: string;
  sort: NonNullable<IssueQuery['sort']>;
}

function IssuesRegister(p: {
  engine: EngineClient;
  datasetId: DatasetId | null;
  variant: 'view' | 'panel';
}): React.JSX.Element {
  const { engine } = p;
  const project = useProject();
  const select = useWorkbench((s) => s.select);
  const [filters, setFilters] = useState<Filters>({
    severity: [],
    status: 'all',
    ruleId: '',
    text: '',
    sort: 'severity',
  });
  const [selected, setSelected] = useState<string | null>(null);
  const query: IssueQuery = {
    ...(p.datasetId === null ? {} : { datasetId: p.datasetId }),
    ...(filters.severity.length === 0 ? {} : { severity: filters.severity }),
    ...(filters.status === 'all'
      ? {}
      : filters.status === 'unresolved'
        ? { status: ['open', 'partly_resolved'] as Issue['status'][] }
        : { status: [filters.status] }),
    ...(filters.ruleId === '' ? {} : { ruleId: filters.ruleId }),
    ...(filters.text.trim() === '' ? {} : { text: filters.text }),
    sort: filters.sort,
    limit: 1000,
  };
  const key = project === null ? null : JSON.stringify({ q: query, p: project.id });
  const issues = useEngineQuery(engine, key, () => engine.listIssues(query), ['issues', 'datasets', 'project']);
  const all = useEngineQuery(
    engine,
    project === null ? null : `rules:${project.id}:${p.datasetId ?? ''}`,
    () => engine.listIssues({ ...(p.datasetId === null ? {} : { datasetId: p.datasetId }), limit: 1000 }),
    ['issues'],
  );
  const rules = useMemo(() => [...new Set((all.data?.items ?? []).map((i) => i.ruleId))].sort(), [all.data]);
  const items = issues.data?.items ?? [];
  const current = items.find((i) => i.id === selected) ?? null;
  const datasetName = (id: string) => project?.datasets.find((d) => d.id === id)?.name ?? (id === '' ? 'Project' : id);
  const totals = (all.data?.items ?? []).reduce(
    (t, i) => ({ ...t, [i.severity]: t[i.severity] + (i.counts.open > 0 ? 1 : 0) }),
    { error: 0, warning: 0, note: 0 } as Record<Severity, number>,
  );

  const checked = project?.rulePacks.length !== 0;
  return (
    <div
      className={`tw-view tw-issues tw-issues-${p.variant}`}
      data-testid={p.variant === 'view' ? TID.issuesView : TID.issuesPanel}
    >
      {p.variant === 'view' && <ReadOnlyBanner />}
      <div className="tw-view-toolbar tw-filterbar" role="toolbar" aria-label="Issue filters">
        <div role="group" aria-label="Severity" className="tw-chips">
          {SEVERITIES.map((s) => {
            const on = filters.severity.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                className={`tw-chip tw-chip-${s}${on ? ' tw-chip-on' : ''}`}
                data-testid={TID.issueFilter(s)}
                onClick={() =>
                  setFilters({
                    ...filters,
                    severity: on ? filters.severity.filter((x) => x !== s) : [...filters.severity, s],
                  })
                }
              >
                <span className={`tw-sev-dot tw-sev-dot-${s}`} aria-hidden="true" />
                {s === 'error' ? 'Errors' : s === 'warning' ? 'Warnings' : 'Notes'} {totals[s]}
              </button>
            );
          })}
        </div>
        <label className="tw-inline-field">
          Status
          <select
            value={filters.status}
            data-testid={TID.issueFilter('status')}
            onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters['status'] })}
          >
            <option value="all">All</option>
            <option value="unresolved">Not resolved</option>
            <option value="open">Open</option>
            <option value="partly_resolved">Partly resolved</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label className="tw-inline-field">
          Rule
          <select
            value={filters.ruleId}
            data-testid={TID.issueFilter('rule')}
            onChange={(e) => setFilters({ ...filters, ruleId: e.target.value })}
          >
            <option value="">All rules</option>
            {rules.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="tw-inline-field">
          Sort
          <select
            value={filters.sort}
            data-testid={TID.issueFilter('sort')}
            onChange={(e) => setFilters({ ...filters, sort: e.target.value as Filters['sort'] })}
          >
            <option value="severity">Severity</option>
            <option value="count">Open count</option>
            <option value="rule">Rule</option>
            <option value="column">Column</option>
          </select>
        </label>
        <input
          type="search"
          placeholder="Search issues"
          aria-label="Search issues"
          data-testid={TID.issueFilter('text')}
          value={filters.text}
          onChange={(e) => setFilters({ ...filters, text: e.target.value })}
        />
        <span className="tw-toolbar-spacer" />
        <span className="tw-view-meta">{formatCount(issues.data?.total ?? 0)} issues</span>
      </div>
      <ErrorNote error={issues.error} />
      {!checked && items.length === 0 ? (
        <div className="tw-empty">
          No checks have run yet. Choose Data › Run checks (or the Check stage) to find issues.
        </div>
      ) : (
        <div className={`tw-split${current === null ? '' : ' tw-split-open'}`}>
          <div className="tw-table-scroll">
            <table className="tw-table tw-issues-table" aria-label="Issues">
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Rule</th>
                  <th scope="col">Issue</th>
                  {p.datasetId === null && <th scope="col">Dataset</th>}
                  <th scope="col" className="tw-num">
                    Open
                  </th>
                  <th scope="col" className="tw-num">
                    Accepted
                  </th>
                  <th scope="col" className="tw-num">
                    Excluded
                  </th>
                  <th scope="col" className="tw-num">
                    Fixed
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.id}
                    tabIndex={0}
                    aria-selected={i.id === selected}
                    className={i.id === selected ? 'tw-row-selected' : ''}
                    data-testid={TID.issueRow(i.id)}
                    data-rule={i.ruleId}
                    onClick={() => {
                      setSelected(i.id);
                      select({ kind: 'issue', issueId: i.id });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(i.id);
                        select({ kind: 'issue', issueId: i.id });
                      }
                    }}
                  >
                    <td>
                      <SeverityBadge severity={i.severity} />
                    </td>
                    <td className="tw-mono">{i.ruleId}</td>
                    <td>
                      <div className="tw-issue-title">{i.title}</div>
                      <div className="tw-muted tw-issue-message">{i.message}</div>
                    </td>
                    {p.datasetId === null && <td>{datasetName(i.datasetId)}</td>}
                    <td className="tw-num">{formatCount(i.counts.open)}</td>
                    <td className="tw-num">{formatCount(i.counts.accepted)}</td>
                    <td className="tw-num">{formatCount(i.counts.excluded)}</td>
                    <td className="tw-num">{formatCount(i.counts.fixed)}</td>
                    <td>
                      <span className={`tw-status tw-status-${i.status}`}>{STATUS_TEXT[i.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current !== null && (
            <IssueDetail key={current.id} engine={engine} issue={current} onClose={() => setSelected(null)} />
          )}
        </div>
      )}
    </div>
  );
}

function IssueDetail(p: { engine: EngineClient; issue: Issue; onClose(): void }): React.JSX.Element {
  const { engine, issue } = p;
  const project = useProject();
  const readOnly = project?.readOnly === true;
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState<Set<RowId>>(new Set());
  const reason = useReasonPrompt();
  const occurrences = useEngineQuery(
    engine,
    `${issue.id}:${offset}`,
    () => engine.listOccurrences(issue.id, { offset, limit: OCCURRENCE_PAGE }),
    ['issues', 'datasets'],
  );
  const rows = occurrences.data?.items ?? [];
  const total = occurrences.data?.total ?? 0;
  const openPicked = [...picked].filter((r) => rows.some((o) => o.rowId === r && o.state === 'open'));
  const rowScope = issue.scope === 'rows';
  const isSystem = issue.packId === 'tracewell.system' && issue.ruleId.startsWith('TW-PRJ');

  const accept = async (rowsToAccept: RowId[] | 'all') => {
    const why = await reason.ask(
      rowsToAccept === 'all'
        ? `Accept every open occurrence of ${issue.ruleId}`
        : `Accept ${rowsToAccept.length} occurrences of ${issue.ruleId}`,
    );
    if (why === null) return;
    const done = await attempt(() =>
      engine.decide({ kind: 'accept_issue', issueId: issue.id, rows: rowsToAccept, reason: why }),
    );
    if (done !== null) setPicked(new Set());
  };
  const exclude = async (which: RowId[] | 'open') => {
    const why = await reason.ask(
      which === 'open' ? `Exclude every open row of ${issue.ruleId}` : `Exclude ${which.length} rows`,
    );
    if (why === null) return;
    const done = await attempt(() =>
      engine.decide({
        kind: 'exclude_rows',
        datasetId: issue.datasetId,
        rows: which === 'open' ? { issueId: issue.id } : which,
        reason: why,
      }),
    );
    if (done !== null) setPicked(new Set());
  };
  const goto = (o: IssueOccurrence) => {
    const s = useWorkbench.getState();
    const ds = project?.datasets.find((d) => d.id === issue.datasetId);
    s.openTab({
      id: `data-${issue.datasetId}`,
      kind: 'data',
      title: ds?.name ?? issue.datasetId,
      datasetId: issue.datasetId,
    });
    gotoRow(issue.datasetId, o.rowId, o.columnId ?? undefined);
    s.select({
      kind: 'cell',
      datasetId: issue.datasetId,
      rowId: o.rowId,
      columnId: o.columnId ?? issue.columns[0] ?? '',
    });
  };

  return (
    <section className="tw-issue-detail" aria-label={`Issue ${issue.ruleId} details`}>
      <header className="tw-detail-head">
        <SeverityBadge severity={issue.severity} />
        <strong>{issue.title}</strong>
        <span className="tw-mono tw-muted">{issue.ruleId}</span>
        <span className="tw-toolbar-spacer" />
        <button type="button" aria-label="Close issue details" onClick={p.onClose}>
          ×
        </button>
      </header>
      <p className="tw-detail-text">{issue.message}</p>
      <p className="tw-muted tw-detail-text">{issue.explanation}</p>
      {!isSystem && (
        <div className="tw-actions" role="toolbar" aria-label="Issue actions">
          <button
            type="button"
            data-testid={TID.issueAction('accept-all')}
            disabled={readOnly || issue.counts.open === 0}
            onClick={() => void accept('all')}
          >
            Accept all open
          </button>
          {rowScope && (
            <>
              <button
                type="button"
                data-testid={TID.issueAction('accept')}
                disabled={readOnly || openPicked.length === 0}
                onClick={() => void accept(openPicked)}
              >
                Accept selected ({openPicked.length})
              </button>
              <button
                type="button"
                data-testid={TID.issueAction('exclude-all')}
                disabled={readOnly || issue.counts.open === 0}
                onClick={() => void exclude('open')}
              >
                Exclude open rows
              </button>
              <button
                type="button"
                data-testid={TID.issueAction('exclude')}
                disabled={readOnly || picked.size === 0}
                onClick={() => void exclude([...picked])}
              >
                Exclude selected ({picked.size})
              </button>
            </>
          )}
          <button
            type="button"
            data-testid={TID.issueAction('comment')}
            disabled={readOnly}
            onClick={() => openDialog({ kind: 'comment', issueId: issue.id })}
          >
            Comment…
          </button>
        </div>
      )}
      {issue.comments.length > 0 && (
        <ul className="tw-comments" aria-label="Comments">
          {issue.comments.map((c) => (
            <li key={c.seq}>
              <span className="tw-muted">
                {c.by}, {c.at.slice(0, 16).replace('T', ' ')} UTC:
              </span>{' '}
              {c.text}
            </li>
          ))}
        </ul>
      )}
      {rowScope && (
        <>
          <div className="tw-table-scroll">
            <table className="tw-table tw-occurrences" data-testid={TID.occurrences} aria-label="Occurrences">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="tw-visually-hidden">Select</span>
                  </th>
                  <th scope="col">Row</th>
                  <th scope="col">Source</th>
                  <th scope="col">Value</th>
                  <th scope="col">Raw text</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="tw-visually-hidden">Go to</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.rowId} data-testid={TID.occurrence(o.rowId)} data-state={o.state}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select row ${o.rowId + 1}`}
                        checked={picked.has(o.rowId)}
                        disabled={o.state === 'excluded' || readOnly}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(o.rowId);
                          else next.delete(o.rowId);
                          setPicked(next);
                        }}
                      />
                    </td>
                    <td className="tw-num">{o.rowId + 1}</td>
                    <td className="tw-mono">{o.locator}</td>
                    <td>
                      {o.value === null ? (
                        <span className="tw-muted">empty</span>
                      ) : (
                        formatCell(o.value, typeof o.value === 'number' ? 'number' : 'string')
                      )}
                    </td>
                    <td className="tw-mono">{o.raw === null ? '' : display(o.raw)}</td>
                    <td>
                      <span className={`tw-occ tw-occ-${o.state}`}>
                        {o.state}
                        {o.decidedBy === null ? '' : ` (#${o.decidedBy})`}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="tw-link" onClick={() => goto(o)}>
                        Go to row
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > OCCURRENCE_PAGE && (
            <div className="tw-pager">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - OCCURRENCE_PAGE))}
              >
                Previous
              </button>
              <span>
                {formatCount(offset + 1)}–{formatCount(Math.min(total, offset + OCCURRENCE_PAGE))} of{' '}
                {formatCount(total)}
              </span>
              <button
                type="button"
                disabled={offset + OCCURRENCE_PAGE >= total}
                onClick={() => setOffset(offset + OCCURRENCE_PAGE)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      {reason.element}
    </section>
  );
}

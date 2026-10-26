/**
 * The data grid (SAD section 15): an ARIA grid over the engine's row windows, virtualised so a
 * million rows scroll as smoothly as a hundred. Rows arrive in 200-row pages through RowPageCache.
 * Cells show edit and issue markers, headers show units and "assumed" badges, and every edit asks
 * for a reason before it is sent to the engine.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type { CellValue, ColumnId, DatasetId, RowWindow, RowWindowColumn, Severity } from '@tw/model';
import { cellTooltip, formatCell, formatCount, useWorkbench, type CentreViewProps } from '@tw/ui-shell';
import { ReadOnlyBanner, useReasonPrompt } from './common';
import { attempt, datasetFor, useChangeVersion, useProject } from './hooks';
import { RowPageCache } from './row-cache';
import { openDialog, useViews, views } from './store';
import { TID } from './testids';

const PAGE = 200;
type Row = RowWindow['rows'][number];
type Stage = 'working' | 'output';

interface Loaded {
  key: string;
  columns: RowWindowColumn[] | null;
  total: number | null;
  pages: Map<number, Row[]>;
}

const SEVERITY_TEXT: Record<Severity, string> = { error: 'error', warning: 'warning', note: 'note' };

function isNumeric(c: RowWindowColumn): boolean {
  return c.type === 'number' || c.type === 'integer';
}

/** The text an editor starts with: the value as stored, not as rounded for display. */
function editText(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return String(v);
  if ('date' in v) return v.date;
  if ('datetime' in v) return v.datetime;
  return JSON.stringify(v.geometry);
}

/** The visible position of a row: rows are in ascending row ID order, so a binary search finds it. */
async function indexOfRow(cache: RowPageCache, total: number, rowId: number): Promise<number> {
  let lo = 0;
  let hi = total - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = (await cache.get(mid, 1)).rows[0]?.rowId;
    if (at === undefined) return -1;
    if (at === rowId) return mid;
    if (at < rowId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function DataGridView(p: CentreViewProps): React.JSX.Element {
  const project = useProject();
  const datasetId = datasetFor(p.tab, project);
  if (datasetId === null) return <div className="tw-empty">Import a file to see its data here.</div>;
  return <Grid key={datasetId} engine={p.engine} datasetId={datasetId} />;
}

function Grid(p: { engine: EngineClient; datasetId: DatasetId }): React.JSX.Element {
  const { engine, datasetId } = p;
  const project = useProject();
  const summary = project?.datasets.find((d) => d.id === datasetId);
  const readOnly = project?.readOnly === true;
  const density = useWorkbench((s) => s.density);
  const select = useWorkbench((s) => s.select);
  const rowHeight = density === 'compact' ? 24 : 32;
  const [stage, setStage] = useState<Stage>('working');
  const version = useChangeVersion(engine, ['datasets', 'schema', 'issues', 'steps'], datasetId);
  const key = `${datasetId}|${stage}|${version}`;
  const cache = useMemo(
    () => new RowPageCache((offset, limit) => engine.getRows({ datasetId, stage, offset, limit }), { pageSize: PAGE }),
    // A new cache for every change, so no page from before the change is ever shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, datasetId, stage, version],
  );
  const [loaded, setLoaded] = useState<Loaded>({ key, columns: null, total: null, pages: new Map() });
  const current: Loaded =
    loaded.key === key ? loaded : { key, columns: loaded.columns, total: loaded.total, pages: new Map() };
  const columns = current.columns ?? [];
  const total = current.total ?? 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualiser is read during render by design
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const firstIndex = items[0]?.index ?? 0;
  const lastIndex = items.at(-1)?.index ?? 0;

  const [active, setActive] = useState({ row: 0, col: 0 });
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const [menu, setMenu] = useState<ColumnId | null>(null);
  const reason = useReasonPrompt();
  const pendingFocus = useRef(false);

  // Fetch the pages the viewport needs; the first page also tells the columns and the row count.
  useEffect(() => {
    let live = true;
    const firstPage = Math.floor(firstIndex / PAGE);
    const lastPage = Math.max(firstPage, Math.floor(lastIndex / PAGE));
    for (let page = firstPage; page <= lastPage; page++) {
      if (current.pages.has(page) && current.columns !== null) continue;
      cache.get(page * PAGE, PAGE).then(
        (w) => {
          if (!live) return;
          setLoaded((prev) => {
            const base = prev.key === key ? prev : { key, columns: null, total: null, pages: new Map<number, Row[]>() };
            const pages = new Map(base.pages);
            pages.set(page, w.rows);
            return { key, columns: w.columns, total: w.totalRows, pages };
          });
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
    // current.pages is derived from `loaded`; listing the page range and key is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key, firstIndex, lastIndex]);

  // "Go to row" from the issues register.
  const goto = useViews((s) => s.goto);
  useEffect(() => {
    if (goto === null || goto.datasetId !== datasetId || current.total === null) return;
    let live = true;
    const target = goto;
    views.set({ goto: null });
    const working = new RowPageCache((offset, limit) => engine.getRows({ datasetId, stage: 'working', offset, limit }));
    void working.get(0, 1).then(async (w) => {
      const index = await indexOfRow(working, w.totalRows, target.rowId);
      if (!live || index < 0) return;
      setStage('working');
      const col = Math.max(
        0,
        w.columns.findIndex((c) => c.id === target.columnId),
      );
      setActive({ row: index, col });
      virtualizer.scrollToIndex(index, { align: 'center' });
      pendingFocus.current = true;
    });
    return () => {
      live = false;
    };
  }, [goto, datasetId, engine, current.total, virtualizer]);

  const rowAt = (index: number): Row | undefined => current.pages.get(Math.floor(index / PAGE))?.[index % PAGE];

  // Edit › Edit cell starts editing the active cell.
  const editNonce = useViews((s) => s.editNonce);
  const seenEdit = useRef(editNonce);
  useEffect(() => {
    if (editNonce === seenEdit.current) return;
    seenEdit.current = editNonce;
    const timer = setTimeout(() => startEditRef.current(active.row, active.col), 0);
    return () => clearTimeout(timer);
  }, [editNonce, active]);

  // Keep keyboard focus on the active cell after it moves.
  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-testid="${TID.cell(active.row, columns[active.col]?.id ?? '')}"]`,
    );
    if (el !== null && el !== undefined) {
      el.focus();
      pendingFocus.current = false;
    }
  });

  const move = (row: number, col: number) => {
    const r = Math.max(0, Math.min(total - 1, row));
    const c = Math.max(0, Math.min(columns.length - 1, col));
    setActive({ row: r, col: c });
    virtualizer.scrollToIndex(r);
    pendingFocus.current = true;
    const target = rowAt(r);
    const column = columns[c];
    if (target !== undefined && column !== undefined)
      select({ kind: 'cell', datasetId, rowId: target.rowId, columnId: column.id });
  };

  const canEdit = (col: number): boolean => {
    const c = columns[col];
    return stage === 'working' && !readOnly && c !== undefined && !c.derived && c.type !== 'geometry';
  };

  const startEdit = (row: number, col: number, initial?: string) => {
    if (!canEdit(col)) return;
    const r = rowAt(row);
    if (r === undefined) return;
    setEditing({ row, col, text: initial ?? editText(r.cells[col] ?? null) });
  };

  const startEditRef = useRef(startEdit);
  useEffect(() => {
    startEditRef.current = startEdit;
  });

  const commitEdit = async () => {
    if (editing === null) return;
    const r = rowAt(editing.row);
    const c = columns[editing.col];
    const text = editing.text;
    setEditing(null);
    pendingFocus.current = true;
    if (r === undefined || c === undefined || text === editText(r.cells[editing.col] ?? null)) return;
    const why = await reason.ask(`Edit ${c.name}, ${r.locator}`);
    if (why === null) return;
    await attempt(() =>
      engine.decide({ kind: 'edit_cell', datasetId, rowId: r.rowId, columnId: c.id, value: { text }, reason: why }),
    );
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing !== null || total === 0) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight) - 1);
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(active.row + 1, active.col),
      ArrowUp: () => move(active.row - 1, active.col),
      ArrowRight: () => move(active.row, active.col + 1),
      ArrowLeft: () => move(active.row, active.col - 1),
      PageDown: () => move(active.row + page, active.col),
      PageUp: () => move(active.row - page, active.col),
      Home: () => (e.ctrlKey ? move(0, 0) : move(active.row, 0)),
      End: () => (e.ctrlKey ? move(total - 1, columns.length - 1) : move(active.row, columns.length - 1)),
      Enter: () => startEdit(active.row, active.col),
      F2: () => startEdit(active.row, active.col),
    };
    const action = keys[e.key];
    if (action !== undefined) {
      e.preventDefault();
      action();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && canEdit(active.col)) {
      e.preventDefault();
      startEdit(active.row, active.col, e.key);
    }
  };

  const template = `56px ${columns.map((c) => (isNumeric(c) ? 'minmax(128px, 160px)' : 'minmax(128px, 200px)')).join(' ')}`;
  const outputRows = summary?.outputRowCount;

  return (
    <div className="tw-view tw-grid-view">
      <ReadOnlyBanner />
      <div className="tw-view-toolbar" role="toolbar" aria-label="Data view">
        <div className="tw-segmented" role="radiogroup" aria-label="Stage" data-testid={TID.gridStage}>
          {(['working', 'output'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={stage === s}
              className={stage === s ? 'tw-seg-on' : ''}
              onClick={() => setStage(s)}
            >
              {s === 'working' ? 'Working data' : 'Output'}
            </button>
          ))}
        </div>
        <span className="tw-view-meta">
          {summary?.name ?? datasetId} · {formatCount(total)} rows
          {stage === 'working' && outputRows !== undefined && outputRows !== total
            ? ` · output ${formatCount(outputRows)}`
            : ''}
          {summary?.partial === true ? ' · partial import' : ''}
        </span>
        <span className="tw-toolbar-spacer" />
        <span className="tw-legend" aria-hidden="true">
          <span className="tw-legend-edited" /> edited
          <span className="tw-sev-dot tw-sev-dot-error" /> error
          <span className="tw-sev-dot tw-sev-dot-warning" /> warning
          <span className="tw-sev-dot tw-sev-dot-note" /> note
        </span>
      </div>
      <div ref={scrollRef} className="tw-grid-scroll">
        <div
          ref={gridRef}
          role="grid"
          aria-label={`${summary?.name ?? 'Dataset'} ${stage === 'working' ? 'working data' : 'output'}`}
          aria-rowcount={total + 1}
          aria-colcount={columns.length + 1}
          aria-readonly={stage === 'output' || readOnly}
          data-testid={TID.grid}
          className="tw-grid"
          onKeyDown={onGridKey}
          style={{ minWidth: 'max-content' }}
        >
          <div role="row" aria-rowindex={1} className="tw-grid-header" style={{ gridTemplateColumns: template }}>
            <div role="columnheader" aria-colindex={1} className="tw-grid-corner">
              #
            </div>
            {columns.map((c, j) => (
              <div
                key={c.id}
                role="columnheader"
                aria-colindex={j + 2}
                className={`tw-grid-colhead${isNumeric(c) ? ' tw-num' : ''}`}
                data-testid={TID.header(c.id)}
              >
                <button
                  type="button"
                  className="tw-colhead-name"
                  tabIndex={-1}
                  title={`${c.name}${c.unit === null ? '' : ` [${c.unit}]`} · ${c.type}${c.derived ? ' · converted' : ''}`}
                  onClick={() => select({ kind: 'column', datasetId, columnId: c.id })}
                >
                  <span className="tw-colhead-text">{c.name}</span>
                  <span className="tw-colhead-meta">
                    <span className="tw-colhead-unit">{c.unit === null ? c.type : `[${c.unit}]`}</span>
                    {c.derived && <span className="tw-badge tw-badge-derived">converted</span>}
                    {c.assumed && (
                      <span
                        className="tw-badge tw-badge-assumed"
                        data-testid={TID.assumed}
                        title="Some detections for this column are assumed"
                      >
                        assumed
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="tw-colhead-menu"
                  aria-label={`Column ${c.name} actions`}
                  aria-haspopup="menu"
                  aria-expanded={menu === c.id}
                  data-testid={TID.headerMenu(c.id)}
                  onClick={() => setMenu(menu === c.id ? null : c.id)}
                >
                  ⋮
                </button>
                {menu === c.id && (
                  <ColumnMenu
                    column={c}
                    datasetId={datasetId}
                    readOnly={readOnly}
                    onClose={() => setMenu(null)}
                    onProperties={() => select({ kind: 'column', datasetId, columnId: c.id })}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="tw-grid-body" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rowAt(item.index);
              return (
                <div
                  key={item.key}
                  role="row"
                  aria-rowindex={item.index + 2}
                  className="tw-grid-row"
                  style={{ gridTemplateColumns: template, transform: `translateY(${item.start}px)`, height: rowHeight }}
                >
                  <div role="rowheader" aria-colindex={1} className="tw-grid-rowhead" title={row?.locator}>
                    {row === undefined ? '' : row.rowId + 1}
                  </div>
                  {columns.map((c, j) => {
                    const isActive = active.row === item.index && active.col === j;
                    const value = row?.cells[j] ?? null;
                    const severity = row?.issue[j] ?? null;
                    const edited = row?.edited[j] === true;
                    const isEditing = editing !== null && editing.row === item.index && editing.col === j;
                    const classes = [
                      'tw-grid-cell',
                      isNumeric(c) ? 'tw-num' : '',
                      isActive ? 'tw-cell-active' : '',
                      edited ? 'tw-cell-edited' : '',
                      severity === null ? '' : `tw-cell-sev-${severity}`,
                      value === null ? 'tw-cell-null' : '',
                    ].join(' ');
                    const notes = [edited ? 'edited' : '', severity === null ? '' : `open ${SEVERITY_TEXT[severity]}`]
                      .filter((s) => s !== '')
                      .join(', ');
                    return (
                      <div
                        key={c.id}
                        role="gridcell"
                        aria-colindex={j + 2}
                        aria-selected={isActive}
                        aria-description={notes === '' ? undefined : notes}
                        tabIndex={isActive ? 0 : -1}
                        className={classes}
                        data-testid={TID.cell(item.index, c.id)}
                        title={
                          row === undefined ? undefined : `${cellTooltip(value)}${notes === '' ? '' : ` (${notes})`}`
                        }
                        onClick={() => {
                          setActive({ row: item.index, col: j });
                          if (row !== undefined) select({ kind: 'cell', datasetId, rowId: row.rowId, columnId: c.id });
                        }}
                        onDoubleClick={() => startEdit(item.index, j)}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="tw-cell-editor"
                            data-testid={TID.cellEditor}
                            aria-label={`New value for ${c.name}`}
                            value={editing.text}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void commitEdit();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditing(null);
                                pendingFocus.current = true;
                              }
                            }}
                            onBlur={() => void commitEdit()}
                          />
                        ) : row === undefined ? (
                          <span className="tw-cell-loading" aria-hidden="true" />
                        ) : (
                          formatCell(value, c.type)
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        {current.total === 0 && (
          <div className="tw-empty">No rows at this stage. Check the filter steps of this dataset.</div>
        )}
      </div>
      {reason.element}
    </div>
  );
}

function ColumnMenu(p: {
  column: RowWindowColumn;
  datasetId: DatasetId;
  readOnly: boolean;
  onClose(): void;
  onProperties(): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) p.onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [p]);
  const numeric = isNumeric(p.column);
  const actions: { id: string; label: string; enabled: boolean; run(): void }[] = [
    {
      id: 'convert',
      label: 'Convert units…',
      enabled: numeric && !p.readOnly,
      run: () => openDialog({ kind: 'convert', datasetId: p.datasetId, columnId: p.column.id }),
    },
    {
      id: 'filter',
      label: 'Filter…',
      enabled: !p.readOnly,
      run: () => openDialog({ kind: 'filter', datasetId: p.datasetId }),
    },
    {
      id: 'override',
      label: 'Override detection…',
      enabled: !p.readOnly && !p.column.derived,
      run: () => openDialog({ kind: 'override', datasetId: p.datasetId, columnId: p.column.id }),
    },
    {
      id: 'columns',
      label: 'Columns…',
      enabled: !p.readOnly,
      run: () => openDialog({ kind: 'columns', datasetId: p.datasetId }),
    },
    { id: 'properties', label: 'Properties', enabled: true, run: p.onProperties },
  ];
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${p.column.name} actions`}
      className="tw-menu-popup tw-colmenu"
      onKeyDown={(e) => {
        e.stopPropagation();
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape') p.onClose();
        if (e.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus();
        if (e.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
      }}
    >
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          className="tw-menu-item"
          disabled={!a.enabled}
          data-testid={TID.headerAction(a.id)}
          onClick={() => {
            p.onClose();
            a.run();
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

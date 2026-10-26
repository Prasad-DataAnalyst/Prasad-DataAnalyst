/**
 * The dialogs commands and column menus open: unit conversion, filter, columns, detection
 * overrides, project area, the Open report, licences, comments and the first-start profile.
 * Each one previews its effect where the engine can, and every change asks for a reason.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type {
  ColumnId,
  ColumnSchema,
  DatasetId,
  EngineErrorData,
  IssueId,
  JsonValue,
  OverridableProperty,
  ProjectOpenReport,
  StepInput,
  StepPreview,
  StepResult,
  TableSchema,
  UnitInfo,
  UserProfile,
} from '@tw/model';
import { formatCell, formatCount, toErrorData, useWorkbench } from '@tw/ui-shell';
import { DetectionValue, ErrorNote, Modal, display, useReasonPrompt } from './common';
import { OP_LABELS, buildPredicate, opsFor, type FilterCondition, type FilterFormState } from './filter-form';
import { attempt, useEngineQuery } from './hooks';
import { closeDialog, useViews } from './store';
import { TID } from './testids';

/** Renders whichever dialog a command asked for. */
export function DialogHost(p: { engine: EngineClient }): React.JSX.Element | null {
  const d = useViews((s) => s.dialog);
  if (d === null) return null;
  switch (d.kind) {
    case 'convert':
      return (
        <ConvertUnitsDialog
          engine={p.engine}
          datasetId={d.datasetId}
          columnId={d.columnId ?? null}
          onClose={closeDialog}
        />
      );
    case 'filter':
      return <FilterDialog engine={p.engine} datasetId={d.datasetId} onClose={closeDialog} />;
    case 'columns':
      return <ColumnsDialog engine={p.engine} datasetId={d.datasetId} onClose={closeDialog} />;
    case 'override':
      return (
        <OverrideDialog engine={p.engine} datasetId={d.datasetId} columnId={d.columnId ?? null} onClose={closeDialog} />
      );
    case 'area':
      return <ProjectAreaDialog engine={p.engine} onClose={closeDialog} />;
    case 'openReport':
      return <OpenReportDialog report={d.report} onClose={closeDialog} />;
    case 'licences':
      return <LicencesDialog onClose={closeDialog} />;
    case 'comment':
      return <CommentDialog engine={p.engine} issueId={d.issueId} onClose={closeDialog} />;
    case 'newProject':
      return <NewProjectDialog engine={p.engine} onClose={closeDialog} />;
  }
}

/** Applies a step as a job, waits for it and reports a failure in the shell's error banner. */
async function applyStep(
  engine: EngineClient,
  datasetId: DatasetId,
  s: StepInput,
  reason: string,
  label: string,
): Promise<boolean> {
  const store = useWorkbench.getState();
  try {
    store.showError(null);
    const handle = await engine.applyStep(datasetId, s, reason);
    store.trackJob(handle, label);
    await engine.awaitJob<StepResult>(handle);
    return true;
  } catch (e) {
    useWorkbench.getState().showError(toErrorData(e));
    return false;
  }
}

function useSchema(engine: EngineClient, datasetId: DatasetId, stage: 'working' | 'output') {
  return useEngineQuery(engine, `${stage}:${datasetId}`, () => engine.getSchema(datasetId, stage), [
    'schema',
    'steps',
    'datasets',
  ]);
}

/** Debounced engine preview of a step, so typing does not flood the engine. */
function useStepPreview(engine: EngineClient, datasetId: DatasetId, step: StepInput | null): StepPreview | null {
  const [preview, setPreview] = useState<{ key: string; value: StepPreview } | null>(null);
  const key = step === null ? null : JSON.stringify(step);
  useEffect(() => {
    if (key === null || step === null) return;
    let live = true;
    const timer = setTimeout(() => {
      engine.previewStep(datasetId, step).then(
        (value) => live && setPreview({ key, value }),
        (e: unknown) =>
          live && setPreview({ key, value: { ok: false, error: toErrorData(e), description: '', sample: [] } }),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` stands for `step`, whose identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, datasetId, key]);
  return preview !== null && preview.key === key ? preview.value : null;
}

// ---------------------------------------------------------------------------------------------
// Convert units

export function ConvertUnitsDialog(p: {
  engine: EngineClient;
  datasetId: DatasetId;
  columnId: ColumnId | null;
  onClose(): void;
}): React.JSX.Element {
  const { engine, datasetId } = p;
  const schema = useSchema(engine, datasetId, 'working');
  const numeric = (schema.data?.columns ?? []).filter(
    (c) => (c.type.value === 'number' || c.type.value === 'integer') && c.unit.value !== null,
  );
  const [columnId, setColumnId] = useState<ColumnId | null>(p.columnId);
  const column = numeric.find((c) => c.id === (columnId ?? numeric[0]?.id));
  const [toUnit, setToUnit] = useState('');
  const [mode, setMode] = useState<'replace' | 'add_column'>('replace');
  const reason = useReasonPrompt();
  const units = useEngineQuery<UnitInfo[]>(
    engine,
    column?.unit.value == null ? null : `units:${column.unit.value}`,
    () => engine.listUnits({ compatibleWith: column?.unit.value ?? '' }),
    [],
  );
  const step: StepInput | null =
    column === undefined || toUnit.trim() === ''
      ? null
      : { kind: 'convert_unit', columnId: column.id, toUnit: toUnit.trim(), mode };
  const preview = useStepPreview(engine, datasetId, step);

  const apply = async () => {
    if (step === null || preview?.ok !== true) return;
    const why = await reason.ask(
      `Convert ${column?.name ?? ''} to ${toUnit}`,
      `Report ${column?.name ?? ''} in ${toUnit}`,
    );
    if (why === null) return;
    if (await applyStep(engine, datasetId, step, why, `Convert ${column?.name ?? ''} to ${toUnit}`)) p.onClose();
  };

  return (
    <Modal
      title="Convert units"
      testId={TID.convertDialog}
      wide
      onClose={p.onClose}
      actions={
        <>
          <button type="button" data-testid={TID.dialogCancel} onClick={p.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tw-primary"
            data-testid={TID.dialogApply}
            disabled={preview?.ok !== true}
            onClick={() => void apply()}
          >
            Convert…
          </button>
        </>
      }
    >
      {numeric.length === 0 ? (
        <p>This dataset has no number columns with a unit. Set a column's unit first (Override detection).</p>
      ) : (
        <div className="tw-form-grid">
          <label className="tw-field">
            <span>Column</span>
            <select value={column?.id ?? ''} onChange={(e) => setColumnId(e.target.value)}>
              {numeric.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} [{c.unit.value}]
                </option>
              ))}
            </select>
          </label>
          <label className="tw-field">
            <span>Convert to</span>
            <input
              list="tw-convert-units"
              data-testid={TID.convertUnit}
              placeholder="for example kPa"
              value={toUnit}
              onChange={(e) => setToUnit(e.target.value)}
            />
            <datalist id="tw-convert-units">
              {(units.data ?? [])
                .filter((u) => u.code !== column?.unit.value)
                .map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.label}
                  </option>
                ))}
            </datalist>
          </label>
          <fieldset className="tw-field" data-testid={TID.convertMode}>
            <legend>Result</legend>
            <label>
              <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />{' '}
              Replace the column
            </label>
            <label>
              <input type="radio" name="mode" checked={mode === 'add_column'} onChange={() => setMode('add_column')} />{' '}
              Add a converted column
            </label>
          </fieldset>
        </div>
      )}
      {column !== undefined && (units.data?.length ?? 0) > 0 && (
        <p className="tw-hint">
          Units {column.unit.value} converts to without changing convention:{' '}
          {(units.data ?? [])
            .filter((u) => u.code !== column.unit.value)
            .map((u) => u.code)
            .join(', ')}
        </p>
      )}
      <div data-testid={TID.convertPreview} aria-live="polite">
        {preview !== null && !preview.ok && <ErrorNote error={preview.error} />}
        {preview !== null && preview.ok && (
          <div className="tw-preview-box">
            <p>
              <strong>{preview.description}</strong>
            </p>
            {preview.method !== undefined && (
              <dl className="tw-kv">
                <dt>Formula</dt>
                <dd className="tw-mono">{preview.method.formula}</dd>
                <dt>Factor</dt>
                <dd className="tw-mono">
                  × {preview.method.fromFactor} / {preview.method.toFactor}
                </dd>
                <dt>Source</dt>
                <dd>{preview.method.source}</dd>
                <dt>Registry</dt>
                <dd>{preview.method.registryVersion}</dd>
              </dl>
            )}
            <table className="tw-table tw-sample">
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col" className="tw-num">
                    Before [{column?.unit.value}]
                  </th>
                  <th scope="col" className="tw-num">
                    After [{toUnit}]
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.slice(0, 8).map((s) => (
                  <tr key={s.rowId}>
                    <td className="tw-num">{s.rowId + 1}</td>
                    <td className="tw-num">{formatCell(s.before, 'number')}</td>
                    <td className="tw-num">{formatCell(s.after, 'number')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {reason.element}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Filter

function emptyCondition(schema: TableSchema | null): FilterCondition {
  const c = schema?.columns[0];
  return {
    columnId: c?.id ?? '',
    op: c === undefined ? 'eq' : (opsFor(c)[0] ?? 'eq'),
    value: '',
    value2: '',
    values: '',
  };
}

export function FilterDialog(p: { engine: EngineClient; datasetId: DatasetId; onClose(): void }): React.JSX.Element {
  const { engine, datasetId } = p;
  const schema = useSchema(engine, datasetId, 'output');
  const s = schema.data;
  const [form, setForm] = useState<FilterFormState | null>(null);
  const current: FilterFormState = form ?? { combinator: 'all', conditions: [emptyCondition(s)] };
  const [useBox, setUseBox] = useState(false);
  const [label, setLabel] = useState('');
  const reason = useReasonPrompt();
  const effective: FilterFormState = useBox
    ? { ...current, bbox: current.bbox ?? { minLon: '', minLat: '', maxLon: '', maxLat: '' } }
    : { combinator: current.combinator, conditions: current.conditions };
  const built = s === null ? null : buildPredicate(effective, s);
  const step: StepInput | null =
    built?.ok === true
      ? { kind: 'filter', predicate: built.predicate, ...(label.trim() === '' ? {} : { label: label.trim() }) }
      : null;
  const preview = useStepPreview(engine, datasetId, step);
  const update = (next: FilterFormState) => setForm(next);
  const setCondition = (i: number, patch: Partial<FilterCondition>) =>
    update({ ...current, conditions: current.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const boxCapable = s !== null && (s.geometryColumn !== null || s.columns.some((c) => c.role.value === 'latitude'));

  const apply = async () => {
    if (step === null || preview?.ok !== true) return;
    const why = await reason.ask('Add a filter step', preview.description);
    if (why === null) return;
    if (await applyStep(engine, datasetId, step, why, 'Filter')) p.onClose();
  };

  return (
    <Modal
      title="Filter rows"
      testId={TID.filterDialog}
      wide
      onClose={p.onClose}
      actions={
        <>
          <button type="button" data-testid={TID.dialogCancel} onClick={p.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tw-primary"
            data-testid={TID.dialogApply}
            disabled={preview?.ok !== true}
            onClick={() => void apply()}
          >
            Add filter…
          </button>
        </>
      }
    >
      <p className="tw-hint">Filtered-out rows stay in the project; only the output and exports leave them out.</p>
      <label className="tw-inline-field">
        Keep rows matching
        <select
          data-testid={TID.filterCombinator}
          value={current.combinator}
          onChange={(e) => update({ ...current, combinator: e.target.value as 'all' | 'any' })}
        >
          <option value="all">all of these conditions (AND)</option>
          <option value="any">any of these conditions (OR)</option>
        </select>
      </label>
      <div className="tw-conditions">
        {current.conditions.map((x, i) => {
          const col: ColumnSchema | undefined = s?.columns.find((c) => c.id === x.columnId);
          const ops = col === undefined ? [] : opsFor(col);
          const needs = x.op === 'is_null' || x.op === 'not_null' ? 0 : x.op === 'between' ? 2 : 1;
          return (
            <div key={i} className="tw-condition" role="group" aria-label={`Condition ${i + 1}`}>
              <select
                aria-label="Column"
                data-testid={TID.filterCondition(i, 'column')}
                value={x.columnId}
                onChange={(e) => {
                  const c = s?.columns.find((y) => y.id === e.target.value);
                  setCondition(i, { columnId: e.target.value, op: c === undefined ? 'eq' : (opsFor(c)[0] ?? 'eq') });
                }}
              >
                {(s?.columns ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.unit.value === null ? '' : ` [${c.unit.value}]`}
                  </option>
                ))}
              </select>
              <select
                aria-label="Comparison"
                data-testid={TID.filterCondition(i, 'op')}
                value={x.op}
                onChange={(e) => setCondition(i, { op: e.target.value })}
              >
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABELS[o]}
                  </option>
                ))}
              </select>
              {needs >= 1 && x.op === 'in' && (
                <input
                  aria-label="Values, separated by commas"
                  data-testid={TID.filterCondition(i, 'values')}
                  placeholder="a, b, c"
                  value={x.values ?? ''}
                  onChange={(e) => setCondition(i, { values: e.target.value })}
                />
              )}
              {needs >= 1 && x.op !== 'in' && (
                <input
                  aria-label={needs === 2 ? 'From' : 'Value'}
                  data-testid={TID.filterCondition(i, 'value')}
                  placeholder={placeholder(col)}
                  value={x.value ?? ''}
                  onChange={(e) => setCondition(i, { value: e.target.value })}
                />
              )}
              {needs === 2 && (
                <>
                  <span>and</span>
                  <input
                    aria-label="To"
                    data-testid={TID.filterCondition(i, 'value2')}
                    placeholder={placeholder(col)}
                    value={x.value2 ?? ''}
                    onChange={(e) => setCondition(i, { value2: e.target.value })}
                  />
                </>
              )}
              <button
                type="button"
                aria-label={`Remove condition ${i + 1}`}
                onClick={() => update({ ...current, conditions: current.conditions.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          data-testid={TID.filterAdd}
          onClick={() => update({ ...current, conditions: [...current.conditions, emptyCondition(s)] })}
        >
          + Add condition
        </button>
      </div>
      {boxCapable && (
        <fieldset className="tw-bbox">
          <legend>
            <label>
              <input type="checkbox" checked={useBox} onChange={(e) => setUseBox(e.target.checked)} /> Inside a bounding
              box (WGS84 degrees)
            </label>
          </legend>
          {useBox &&
            (['minLon', 'minLat', 'maxLon', 'maxLat'] as const).map((k) => (
              <label key={k} className="tw-field">
                <span>
                  {
                    {
                      minLon: 'West (min lon)',
                      minLat: 'South (min lat)',
                      maxLon: 'East (max lon)',
                      maxLat: 'North (max lat)',
                    }[k]
                  }
                </span>
                <input
                  inputMode="decimal"
                  value={effective.bbox?.[k] ?? ''}
                  onChange={(e) =>
                    update({
                      ...current,
                      bbox: {
                        ...(current.bbox ?? { minLon: '', minLat: '', maxLon: '', maxLat: '' }),
                        [k]: e.target.value,
                      },
                    })
                  }
                />
              </label>
            ))}
        </fieldset>
      )}
      <label className="tw-field">
        <span>Label (optional)</span>
        <input value={label} placeholder="for example January 2026 only" onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div data-testid={TID.filterPreview} aria-live="polite" className="tw-preview-box">
        {built !== null && !built.ok && <p className="tw-fail">{built.message}</p>}
        {preview !== null && !preview.ok && <ErrorNote error={preview.error} />}
        {preview?.ok === true && (
          <p>
            <strong>{preview.description}</strong> — keeps {formatCount(preview.resultingRows ?? 0)} rows.
          </p>
        )}
      </div>
      {reason.element}
    </Modal>
  );
}

function placeholder(c: ColumnSchema | undefined): string {
  switch (c?.type.value) {
    case 'date':
      return 'YYYY-MM-DD';
    case 'datetime':
      return 'YYYY-MM-DD or YYYY-MM-DDTHH:MM';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'true or false';
    default:
      return 'text';
  }
}

// ---------------------------------------------------------------------------------------------
// Columns

export function ColumnsDialog(p: { engine: EngineClient; datasetId: DatasetId; onClose(): void }): React.JSX.Element {
  const { engine, datasetId } = p;
  const schema = useSchema(engine, datasetId, 'output');
  const [order, setOrder] = useState<{ id: ColumnId; keep: boolean }[] | null>(null);
  const columns = schema.data?.columns ?? [];
  const list = order ?? columns.map((c) => ({ id: c.id, keep: true }));
  const name = (id: ColumnId) => columns.find((c) => c.id === id)?.name ?? id;
  const reason = useReasonPrompt();
  const kept = list.filter((x) => x.keep).map((x) => x.id);
  const unchanged = order === null || JSON.stringify(kept) === JSON.stringify(columns.map((c) => c.id));
  const move = (i: number, by: number) => {
    const next = [...list];
    const [item] = next.splice(i, 1);
    if (item === undefined) return;
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, item);
    setOrder(next);
  };
  const apply = async () => {
    const why = await reason.ask('Choose output columns', `Keep ${kept.length} columns`);
    if (why === null) return;
    if (await applyStep(engine, datasetId, { kind: 'select_columns', columnIds: kept }, why, 'Columns')) p.onClose();
  };
  return (
    <Modal
      title="Output columns"
      testId={TID.columnsDialog}
      onClose={p.onClose}
      actions={
        <>
          <button type="button" data-testid={TID.dialogCancel} onClick={p.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tw-primary"
            data-testid={TID.dialogApply}
            disabled={unchanged || kept.length === 0}
            onClick={() => void apply()}
          >
            Apply…
          </button>
        </>
      }
    >
      <p className="tw-hint">Untick columns to leave them out of the output; use the arrows to change their order.</p>
      <ul className="tw-orderable" aria-label="Columns">
        {list.map((x, i) => (
          <li key={x.id}>
            <label>
              <input
                type="checkbox"
                checked={x.keep}
                onChange={(e) => setOrder(list.map((y) => (y.id === x.id ? { ...y, keep: e.target.checked } : y)))}
              />{' '}
              {name(x.id)}
            </label>
            <span className="tw-toolbar-spacer" />
            <button type="button" aria-label={`Move ${name(x.id)} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${name(x.id)} down`}
              disabled={i === list.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ul>
      {reason.element}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Override detection

const COLUMN_PROPS: { id: OverridableProperty; label: string }[] = [
  { id: 'unit', label: 'Unit' },
  { id: 'type', label: 'Type' },
  { id: 'role', label: 'Role' },
  { id: 'name', label: 'Name' },
  { id: 'nullMarkers', label: 'Null markers' },
  { id: 'dateFormat', label: 'Date format' },
  { id: 'timezone', label: 'Time zone' },
];
const CHOICES: Partial<Record<OverridableProperty, string[]>> = {
  type: ['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'geometry'],
  role: ['measure', 'id', 'time', 'latitude', 'longitude', 'easting', 'northing', 'geometry', 'unit', 'text'],
  dateFormat: ['iso', 'dmy', 'mdy', 'ymd-slash', 'excel-serial'],
  timezone: ['utc', 'offset', 'naive-assumed-utc'],
};

function OverrideDialog(p: {
  engine: EngineClient;
  datasetId: DatasetId;
  columnId: ColumnId | null;
  onClose(): void;
}): React.JSX.Element {
  const { engine, datasetId } = p;
  const schema = useSchema(engine, datasetId, 'working');
  const columns = (schema.data?.columns ?? []).filter((c) => c.derivedFrom === undefined);
  const [columnId, setColumnId] = useState<ColumnId | null>(p.columnId);
  const column = columns.find((c) => c.id === (columnId ?? columns[0]?.id));
  const [property, setProperty] = useState<OverridableProperty>('unit');
  const [value, setValue] = useState<string | null>(null);
  const reason = useReasonPrompt();
  const units = useEngineQuery(engine, 'units:all', () => engine.listUnits(), []);
  const currentDetection =
    column === undefined
      ? undefined
      : property === 'name'
        ? undefined
        : (column as unknown as Record<string, unknown>)[property];
  const currentText =
    column === undefined
      ? ''
      : property === 'name'
        ? column.name
        : display((currentDetection as { value?: unknown } | undefined)?.value ?? '');
  const text = value ?? (currentText === '—' ? '' : currentText);
  const parsed: JsonValue =
    property === 'nullMarkers'
      ? text
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== '' && x !== 'none')
      : property === 'unit' && text.trim() === ''
        ? null
        : text.trim();
  const apply = async () => {
    if (column === undefined) return;
    const why = await reason.ask(`Set the ${property} of ${column.name}`);
    if (why === null) return;
    const done = await attempt(() =>
      engine.decide({
        kind: 'override_detection',
        datasetId,
        columnId: column.id,
        property,
        value: parsed,
        reason: why,
      }),
    );
    if (done !== null) p.onClose();
  };
  const choices = CHOICES[property];
  return (
    <Modal
      title="Override detection"
      testId={TID.overrideDialog}
      onClose={p.onClose}
      actions={
        <>
          <button type="button" data-testid={TID.dialogCancel} onClick={p.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tw-primary"
            data-testid={TID.dialogApply}
            disabled={column === undefined}
            onClick={() => void apply()}
          >
            Override…
          </button>
        </>
      }
    >
      <div className="tw-form-grid">
        <label className="tw-field">
          <span>Column</span>
          <select value={column?.id ?? ''} onChange={(e) => setColumnId(e.target.value)}>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="tw-field">
          <span>Property</span>
          <select
            value={property}
            onChange={(e) => {
              setProperty(e.target.value as OverridableProperty);
              setValue(null);
            }}
          >
            {COLUMN_PROPS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tw-field">
          <span>New value</span>
          {choices !== undefined ? (
            <select value={text} onChange={(e) => setValue(e.target.value)}>
              {choices.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          ) : (
            <input
              list={property === 'unit' ? 'tw-override-units' : undefined}
              value={text}
              placeholder={property === 'nullMarkers' ? '-999.25, N/A' : property === 'unit' ? 'none' : ''}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <datalist id="tw-override-units">
            {(units.data ?? []).map((u) => (
              <option key={u.code} value={u.code}>
                {u.label}
              </option>
            ))}
          </datalist>
        </label>
      </div>
      {currentDetection !== undefined &&
        typeof currentDetection === 'object' &&
        currentDetection !== null &&
        'confidence' in currentDetection && (
          <p className="tw-hint">
            Detected: <DetectionValue d={currentDetection as Parameters<typeof DetectionValue>[0]['d']} />
          </p>
        )}
      <p className="tw-hint">
        The column is read again with the new setting, and checks run again if they have run before.
      </p>
      {reason.element}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Project area

function ProjectAreaDialog(p: { engine: EngineClient; onClose(): void }): React.JSX.Element {
  const area = useWorkbench((s) => s.project?.projectArea ?? null);
  const [box, setBox] = useState<string[]>(area === null ? ['', '', '', ''] : area.map(String));
  const [error, setError] = useState<EngineErrorData | null>(null);
  const reason = useReasonPrompt();
  const labels = ['West (min longitude)', 'South (min latitude)', 'East (max longitude)', 'North (max latitude)'];
  const submit = async (bbox: [number, number, number, number] | null) => {
    const why = await reason.ask(bbox === null ? 'Clear the project area' : 'Set the project area');
    if (why === null) return;
    try {
      await p.engine.decide({ kind: 'set_project_area', bbox, reason: why });
      p.onClose();
    } catch (e) {
      setError(toErrorData(e));
    }
  };
  const numbers = box.map((x) => Number(x));
  const valid = box.every((x) => x.trim() !== '') && numbers.every(Number.isFinite);
  return (
    <Modal
      title="Project area"
      testId={TID.areaDialog}
      onClose={p.onClose}
      actions={
        <>
          <button type="button" onClick={() => void submit(null)} disabled={area === null}>
            Clear area…
          </button>
          <button type="button" data-testid={TID.dialogCancel} onClick={p.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tw-primary"
            data-testid={TID.dialogApply}
            disabled={!valid}
            onClick={() => void submit(numbers as [number, number, number, number])}
          >
            Set area…
          </button>
        </>
      }
    >
      <p className="tw-hint">Locations outside this WGS84 box are flagged by the spatial checks (TW-GEO-003).</p>
      <div className="tw-form-grid">
        {labels.map((l, i) => (
          <label key={l} className="tw-field">
            <span>{l}</span>
            <input
              inputMode="decimal"
              value={box[i] ?? ''}
              onChange={(e) => setBox(box.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
      </div>
      <ErrorNote error={error} />
      {reason.element}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Open report, licences, comment, profile

const CHECK_TEXT: Record<string, string> = {
  zip: 'The file is a readable archive',
  mimetype: 'It identifies itself as a Tracewell project',
  'format-version': 'Its format version is supported',
  'manifest-schema': 'Its manifest is well formed',
  'entry-checksum': 'Every entry matches its checksum',
  'original-checksum': 'The original files are unchanged',
  'audit-chain': 'The audit chain verifies',
  'replay-digest': 'Rebuilding the data reproduces the saved digests',
};

export function OpenReportDialog(p: { report: ProjectOpenReport; onClose(): void }): React.JSX.Element {
  const r = p.report;
  return (
    <Modal
      title={r.readOnly ? 'Project opened read-only' : 'Project opened and verified'}
      testId={TID.openReport}
      wide
      onClose={p.onClose}
      actions={
        <button type="button" className="tw-primary" autoFocus onClick={p.onClose}>
          Close
        </button>
      }
    >
      <p>
        <strong>{r.project.name}</strong> · {r.project.datasets.length} datasets · {r.project.auditHead.seq} audit
        entries
      </p>
      {r.readOnly && (
        <div className="tw-readonly-banner" role="alert">
          One or more integrity checks failed, so the project is open for inspection only. Nothing was repaired.
        </div>
      )}
      <ul className="tw-checklist">
        {r.checks.map((c, i) => (
          <li key={`${c.id}-${i}`} className={c.ok ? 'tw-check-ok' : 'tw-check-fail'} data-ok={c.ok}>
            <span className="tw-check-icon" aria-hidden="true">
              {c.ok ? '✓' : '✗'}
            </span>
            <span>
              <strong>{CHECK_TEXT[c.id] ?? c.id}</strong>
              {c.ruleId !== undefined && <span className="tw-mono tw-muted"> {c.ruleId}</span>}
              <div className="tw-muted">{c.detail}</div>
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

const LICENCES: readonly { name: string; licence: string; use: string }[] = [
  { name: 'React and React DOM', licence: 'MIT', use: 'user interface' },
  { name: 'zustand', licence: 'MIT', use: 'window state' },
  { name: 'TanStack Virtual', licence: 'MIT', use: 'virtualised data grid' },
  { name: 'react-resizable-panels', licence: 'MIT', use: 'resizable panes' },
  { name: 'Lucide icons', licence: 'ISC', use: 'icons' },
  { name: 'fflate', licence: 'MIT', use: 'ZIP compression' },
  { name: 'saxes', licence: 'ISC', use: 'Excel XML reading' },
  { name: '@noble/hashes', licence: 'MIT', use: 'SHA-256' },
  { name: '@streamparser/json', licence: 'MIT', use: 'streaming GeoJSON' },
  { name: 'zod', licence: 'MIT', use: 'schema validation' },
];

function LicencesDialog(p: { onClose(): void }): React.JSX.Element {
  return (
    <Modal
      title="Open-source licences"
      onClose={p.onClose}
      actions={
        <button type="button" className="tw-primary" autoFocus onClick={p.onClose}>
          Close
        </button>
      }
    >
      <p>Tracewell is built on these open-source libraries. Their licence texts are in the NOTICE file.</p>
      <table className="tw-table">
        <thead>
          <tr>
            <th scope="col">Library</th>
            <th scope="col">Licence</th>
            <th scope="col">Used for</th>
          </tr>
        </thead>
        <tbody>
          {LICENCES.map((l) => (
            <tr key={l.name}>
              <td>{l.name}</td>
              <td>{l.licence}</td>
              <td>{l.use}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function CommentDialog(p: { engine: EngineClient; issueId: IssueId; onClose(): void }): React.JSX.Element {
  const [text, setText] = useState('');
  const submit = async () => {
    const done = await attempt(() => p.engine.decide({ kind: 'comment_issue', issueId: p.issueId, text }));
    if (done !== null) p.onClose();
  };
  return (
    <Modal
      title="Comment on the issue"
      onClose={p.onClose}
      actions={
        <>
          <button type="button" onClick={p.onClose}>
            Cancel
          </button>
          <button type="button" className="tw-primary" disabled={text.trim() === ''} onClick={() => void submit()}>
            Add comment
          </button>
        </>
      }
    >
      <label className="tw-field">
        <span>Comment (recorded in the audit log)</span>
        <textarea autoFocus rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    </Modal>
  );
}

function NewProjectDialog(p: { engine: EngineClient; onClose(): void }): React.JSX.Element {
  const current = useWorkbench((s) => s.project);
  const [name, setName] = useState('');
  const [unitSystem, setUnitSystem] = useState<'SI' | 'Oilfield'>(current?.unitSystem ?? 'SI');
  const valid = name.trim() !== '';
  const submit = async () => {
    if (current === null || !valid) return;
    const created = await attempt(() =>
      p.engine.newProject({ name: name.trim(), profile: current.profile, unitSystem }),
    );
    if (created === null) return;
    const s = useWorkbench.getState();
    for (const t of [...s.tabs]) s.closeTab(t.id);
    s.select({ kind: 'none' });
    p.onClose();
  };
  return (
    <Modal
      title="New project"
      onClose={p.onClose}
      actions={
        <>
          <button type="button" onClick={p.onClose}>
            Cancel
          </button>
          <button type="button" className="tw-primary" disabled={!valid} onClick={() => void submit()}>
            Create
          </button>
        </>
      }
    >
      {current?.dirty === true && (
        <div className="tw-warning-note" role="note">
          The open project has unsaved changes. Save it first (File › Save project) if you want to keep them.
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="tw-field">
          <span>Project name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="for example North Sea well tests Q1"
          />
        </label>
        <label className="tw-field">
          <span>Unit system</span>
          <select value={unitSystem} onChange={(e) => setUnitSystem(e.target.value as 'SI' | 'Oilfield')}>
            <option value="SI">SI</option>
            <option value="Oilfield">Oilfield</option>
          </select>
        </label>
      </form>
    </Modal>
  );
}

/** First start: who is doing the work. The name appears in the audit log and in every export. */
export function ProfileSetupDialog(p: { onDone(profile: UserProfile): void }): React.JSX.Element {
  const [name, setName] = useState('');
  const id = useMemo(
    () => `u_${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`,
    [],
  );
  const valid = name.trim().length >= 2;
  return (
    <Modal title="Welcome to Tracewell" testId={TID.profileDialog} onClose={() => undefined}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) p.onDone({ id, name: name.trim(), role: 'Analyst' });
        }}
      >
        <p>
          Tracewell works entirely on this computer. Your name is recorded with every change you make, so reviewers know
          who decided what.
        </p>
        <label className="tw-field">
          <span>Your name</span>
          <input
            autoFocus
            data-testid={TID.profileName}
            value={name}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="tw-hint">Role: Analyst</p>
        <div className="tw-dialog-actions">
          <button type="submit" className="tw-primary" disabled={!valid}>
            Start
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The import preview: what Tracewell detected in the file, how sure it is, and what it assumed,
 * before anything is imported. Reading settings and column interpretations can be changed here;
 * each change is recorded with a reason as a `detection.override` entry when the file is imported.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type {
  ColumnOverride,
  ColumnPlan,
  ColumnRole,
  CsvOptions,
  DatasetSummary,
  FormatOptions,
  ImportPreview,
  LogicalType,
  TemplateApplied,
  TemplateId,
  UnitInfo,
} from '@tw/model';
import { formatCell, formatCount, toErrorData, useWorkbench, type CentreViewProps } from '@tw/ui-shell';
import { AssumedBadge, DetectionValue, display, formatBytes, useReasonPrompt } from './common';
import { attempt } from './hooks';
import { pendingImports } from './store';
import { TID } from './testids';

const TYPES: LogicalType[] = ['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'geometry'];
const ROLES: ColumnRole[] = [
  'measure',
  'id',
  'time',
  'latitude',
  'longitude',
  'easting',
  'northing',
  'geometry',
  'unit',
  'text',
];
const ENCODINGS: CsvOptions['encoding'][] = ['utf-8', 'windows-1252', 'utf-16le', 'utf-16be'];
const DELIMITERS: { value: CsvOptions['delimiter']; label: string }[] = [
  { value: ',', label: 'Comma ,' },
  { value: ';', label: 'Semicolon ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe |' },
];

type ColumnEdits = Record<string, Partial<Omit<ColumnOverride, 'columnId'>>>;

export function ImportPreviewView(p: CentreViewProps): React.JSX.Element {
  const pending = p.tab.previewId === undefined ? undefined : pendingImports.get(p.tab.previewId);
  if (pending === undefined) {
    return (
      <div className="tw-empty">This import preview is no longer available. Choose File › Import file… again.</div>
    );
  }
  return (
    <Preview
      engine={p.engine}
      tabId={p.tab.id}
      previewId={p.tab.previewId as string}
      file={pending.file}
      initial={pending.preview}
    />
  );
}

function Preview(p: {
  engine: EngineClient;
  tabId: string;
  previewId: string;
  file: File;
  initial: ImportPreview;
}): React.JSX.Element {
  const { engine, file } = p;
  const [preview, setPreview] = useState(p.initial);
  const [options, setOptions] = useState<FormatOptions>(p.initial.sniff.options);
  const [edits, setEdits] = useState<ColumnEdits>({});
  const [name, setName] = useState(p.initial.fileName.replace(/\.[^.]+$/, ''));
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  // The mapping template: undefined lets the engine apply the one that fits; null applies none.
  const [templateChoice, setTemplateChoice] = useState<TemplateId | null | undefined>(undefined);
  // A fitting template the user chose not to apply, so it can be applied again.
  const [declined, setDeclined] = useState<TemplateApplied | null>(null);
  const [units, setUnits] = useState<UnitInfo[]>([]);
  const reason = useReasonPrompt();
  const readOnly = useWorkbench((s) => s.project?.readOnly === true);

  useEffect(() => {
    let live = true;
    engine.listUnits().then(
      (u) => live && setUnits(u),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [engine]);

  const detected = p.initial.sniff.options;
  const optionsChanged = JSON.stringify(options) !== JSON.stringify(detected);

  const resniff = async (next: FormatOptions, template: TemplateId | null | undefined): Promise<ImportPreview | null> => {
    setBusy('preview');
    const fresh = await attempt(() =>
      engine.sniff(
        { kind: 'blob', blob: file, name: file.name },
        { options: next, ...(template === undefined ? {} : { template }) },
      ),
    );
    setBusy(null);
    if (fresh !== null) {
      setPreview(fresh);
      setEdits({});
    }
    return fresh;
  };

  const changeOptions = async (next: FormatOptions) => {
    setOptions(next);
    await resniff(next, templateChoice);
  };

  const chooseTemplate = async (choice: TemplateId | null) => {
    const before = preview.template ?? null;
    if ((await resniff(options, choice)) === null) return;
    setTemplateChoice(choice);
    setDeclined(choice === null ? before : null);
  };

  const overrides: ColumnOverride[] = useMemo(
    () =>
      Object.entries(edits)
        .map(([columnId, e]) => ({ columnId, ...e }))
        .filter((o) => Object.keys(o).length > 1),
    [edits],
  );

  const runImport = async () => {
    const changed = optionsChanged || overrides.length > 0;
    let why: string | null = null;
    if (changed) {
      why = await reason.ask('Import with changed settings', 'Settings checked against the file');
      if (why === null) return;
    }
    setBusy('import');
    const store = useWorkbench.getState();
    try {
      store.showError(null);
      const handle = await engine.importFile(
        { kind: 'blob', blob: file, name: file.name },
        {
          name: name.trim() || p.initial.fileName,
          ...(optionsChanged ? { options } : {}),
          ...(overrides.length > 0 ? { columnOverrides: overrides } : {}),
          ...(why === null ? {} : { overrideReason: why }),
          // The template the preview shows, or none: the import applies exactly what was reviewed.
          template: preview.template?.id ?? null,
          // The plan the user reviewed: engines that execute plans import exactly this.
          preview,
        },
      );
      store.trackJob(handle, `Import ${file.name}`);
      const ds = await engine.awaitJob<DatasetSummary>(handle);
      pendingImports.delete(p.previewId);
      const s = useWorkbench.getState();
      s.closeTab(p.tabId);
      s.openTab({ id: `data-${ds.id}`, kind: 'data', title: ds.name, datasetId: ds.id });
      s.select({ kind: 'dataset', datasetId: ds.id });
    } catch (e) {
      useWorkbench.getState().showError(toErrorData(e));
    } finally {
      setBusy(null);
    }
  };

  const columnValue = <K extends keyof Omit<ColumnOverride, 'columnId'>>(c: ColumnPlan, key: K): ColumnOverride[K] => {
    const edited = edits[c.id]?.[key];
    if (edited !== undefined) return edited as ColumnOverride[K];
    if (key === 'name') return c.name as ColumnOverride[K];
    const d = (c as unknown as Record<string, { value: unknown } | undefined>)[key];
    return d?.value as ColumnOverride[K];
  };
  const setColumn = (c: ColumnPlan, key: keyof Omit<ColumnOverride, 'columnId'>, value: unknown) =>
    setEdits((prev) => ({ ...prev, [c.id]: { ...prev[c.id], [key]: value } }));

  const sniff = preview.sniff;
  return (
    <div className="tw-view tw-import-view" data-testid={TID.importView}>
      <div className="tw-view-toolbar">
        <strong className="tw-view-title">{preview.fileName}</strong>
        <span className="tw-view-meta">
          {sniff.format.toUpperCase()} · {formatBytes(preview.size)}
          {preview.estimatedRows === null ? '' : ` · about ${formatCount(preview.estimatedRows)} rows`}
        </span>
        <span className="tw-toolbar-spacer" />
        <label className="tw-inline-field">
          Dataset name
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Dataset name" />
        </label>
        <button
          type="button"
          className="tw-primary"
          data-testid={TID.importButton}
          disabled={busy !== null || readOnly}
          onClick={() => void runImport()}
        >
          {busy === 'import' ? 'Importing…' : 'Import'}
        </button>
      </div>
      {preview.template !== undefined && preview.template !== null && (
        <div className="tw-template-note" role="status" data-testid={TID.importTemplate}>
          <span>
            Mapping template <strong>{preview.template.name}</strong> applied:{' '}
            {preview.template.overrides.length === 0
              ? 'detection already reads every column as it says.'
              : `it sets ${preview.template.overrides.length} ${preview.template.overrides.length === 1 ? 'column' : 'columns'} differently from detection. Each change is recorded in the audit log in the template's name.`}
          </span>
          <button
            type="button"
            className="tw-link"
            data-testid={TID.importTemplateToggle}
            disabled={busy !== null}
            onClick={() => void chooseTemplate(null)}
          >
            Don't apply
          </button>
        </div>
      )}
      {(preview.template === undefined || preview.template === null) && declined !== null && (
        <div className="tw-template-note" role="status" data-testid={TID.importTemplate}>
          <span>
            Mapping template <strong>{declined.name}</strong> fits this file but is not applied.
          </span>
          <button
            type="button"
            className="tw-link"
            data-testid={TID.importTemplateToggle}
            disabled={busy !== null}
            onClick={() => void chooseTemplate(declined.id)}
          >
            Apply it
          </button>
        </div>
      )}
      {preview.exceedsBudget && (
        <div className="tw-warning-note" role="status">
          This file is larger than this edition's memory budget; only the first part will be imported (TW-IMP-006). The
          desktop edition imports all of it.
        </div>
      )}
      <div className="tw-import-body">
        <section className="tw-section" aria-labelledby="imp-detect">
          <h3 id="imp-detect" className="tw-section-title">
            How the file is read
          </h3>
          <table className="tw-table tw-kv-table">
            <tbody>
              {Object.entries(sniff.detections).map(([property, d]) => (
                <tr key={property} data-testid={TID.detection(property)}>
                  <th scope="row">{label(property)}</th>
                  <td>
                    <DetectionValue d={d} />
                  </td>
                  <td className="tw-muted">{d.evidence}</td>
                </tr>
              ))}
              {preview.crs !== null && (
                <tr data-testid={TID.detection('crs')}>
                  <th scope="row">Coordinate reference system</th>
                  <td>
                    <DetectionValue d={preview.crs} format={(v) => (v as { code: string }).code} />
                  </td>
                  <td className="tw-muted">{preview.crs.evidence}</td>
                </tr>
              )}
            </tbody>
          </table>
          <SettingsEditor
            options={options}
            sniff={sniff}
            disabled={busy !== null}
            onChange={(o) => void changeOptions(o)}
          />
          {optionsChanged && (
            <p className="tw-hint">
              Changed settings are recorded in the audit log, with your reason, when you import.{' '}
              <button type="button" className="tw-link" onClick={() => void changeOptions(detected)}>
                Use the detected settings
              </button>
            </p>
          )}
        </section>

        {(preview.assumptions.length > 0 || sniff.notes.length > 0) && (
          <section className="tw-section" aria-labelledby="imp-assume">
            <h3 id="imp-assume" className="tw-section-title">
              Assumptions and notes
            </h3>
            <ul className="tw-list">
              {preview.assumptions.map((a, i) => (
                <li key={`a${i}`}>
                  <AssumedBadge />{' '}
                  <strong>
                    {a.columnId === null
                      ? label(a.property)
                      : `${columnName(preview, a.columnId)}: ${label(a.property)}`}
                  </strong>{' '}
                  = {display(a.value)}{' '}
                  <span className="tw-muted">
                    ({a.confidence}) {a.evidence}
                  </span>
                </li>
              ))}
              {sniff.notes.map((n, i) => (
                <li key={`n${i}`}>
                  <span className="tw-badge">{n.code}</span> {n.message}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="tw-section" aria-labelledby="imp-cols">
          <h3 id="imp-cols" className="tw-section-title">
            Columns ({preview.columns.length})
          </h3>
          <datalist id="tw-unit-list">
            {units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.label}
              </option>
            ))}
          </datalist>
          <div className="tw-table-scroll">
            <table className="tw-table tw-columns-table">
              <thead>
                <tr>
                  <th scope="col">Source header</th>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Role</th>
                  <th scope="col">Null markers</th>
                </tr>
              </thead>
              <tbody>
                {preview.columns.map((c) => (
                  <tr key={c.id}>
                    <td className="tw-muted" title={c.sourceHeader.join(' / ')}>
                      {c.sourceHeader.join(' / ') || `(column ${c.sourceIndex + 1})`}
                    </td>
                    <td>
                      <input
                        aria-label={`Name of ${c.name}`}
                        data-testid={TID.importColumn(c.id, 'name')}
                        value={String(columnValue(c, 'name') ?? '')}
                        onChange={(e) => setColumn(c, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`Type of ${c.name}`}
                        data-testid={TID.importColumn(c.id, 'type')}
                        value={String(columnValue(c, 'type'))}
                        onChange={(e) => setColumn(c, 'type', e.target.value)}
                      >
                        {TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                      <Flags d={c.type} edited={edits[c.id]?.type !== undefined} />
                    </td>
                    <td>
                      <input
                        aria-label={`Unit of ${c.name}`}
                        data-testid={TID.importColumn(c.id, 'unit')}
                        list="tw-unit-list"
                        placeholder="none"
                        value={String(columnValue(c, 'unit') ?? '')}
                        onChange={(e) =>
                          setColumn(c, 'unit', e.target.value.trim() === '' ? null : e.target.value.trim())
                        }
                      />
                      <Flags d={c.unit} edited={edits[c.id]?.unit !== undefined} />
                    </td>
                    <td>
                      <select
                        aria-label={`Role of ${c.name}`}
                        data-testid={TID.importColumn(c.id, 'role')}
                        value={String(columnValue(c, 'role'))}
                        onChange={(e) => setColumn(c, 'role', e.target.value)}
                      >
                        {ROLES.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                      <Flags d={c.role} edited={edits[c.id]?.role !== undefined} />
                    </td>
                    <td>
                      <input
                        aria-label={`Null markers of ${c.name}`}
                        data-testid={TID.importColumn(c.id, 'nullMarkers')}
                        value={(columnValue(c, 'nullMarkers') ?? []).join(', ')}
                        onChange={(e) =>
                          setColumn(
                            c,
                            'nullMarkers',
                            e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter((s) => s !== ''),
                          )
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="tw-section" aria-labelledby="imp-rows">
          <h3 id="imp-rows" className="tw-section-title">
            First {preview.rows.length} rows, as they will be read
          </h3>
          <div className="tw-table-scroll tw-preview-scroll">
            <table className="tw-table tw-preview-table" data-testid={TID.previewGrid}>
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c.id} scope="col">
                      {c.name}
                      {c.unit.value === null ? '' : ` [${c.unit.value}]`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    {preview.columns.map((c, j) => (
                      <td
                        key={c.id}
                        className={c.type.value === 'number' || c.type.value === 'integer' ? 'tw-num' : ''}
                      >
                        {formatCell(r[j] ?? null, c.type.value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      {reason.element}
    </div>
  );
}

function Flags(p: {
  d: { assumed: boolean; confidence: string; evidence: string; method?: string };
  edited: boolean;
}): React.JSX.Element | null {
  if (p.edited) return <span className="tw-badge tw-badge-user">changed</span>;
  if (p.d.method === 'mapping-template') {
    return (
      <span className="tw-badge tw-badge-template" title={p.d.evidence}>
        template
      </span>
    );
  }
  if (!p.d.assumed) return null;
  return <AssumedBadge title={`${p.d.confidence} confidence: ${p.d.evidence}`} />;
}

function SettingsEditor(p: {
  options: FormatOptions;
  sniff: ImportPreview['sniff'];
  disabled: boolean;
  onChange(o: FormatOptions): void;
}): React.JSX.Element | null {
  const o = p.options;
  if (o.format === 'csv' || o.format === 'tsv') {
    const set = (patch: Partial<CsvOptions>) => p.onChange({ ...o, csv: { ...o.csv, ...patch } });
    const count = (v: string) => Math.max(0, Math.min(50, Math.trunc(Number(v) || 0)));
    return (
      <div className="tw-settings" role="group" aria-label="Reading settings">
        <label className="tw-field">
          <span>Encoding</span>
          <select
            data-testid={TID.importOption('encoding')}
            disabled={p.disabled}
            value={o.csv.encoding}
            onChange={(e) => set({ encoding: e.target.value as CsvOptions['encoding'], bomLength: 0 })}
          >
            {ENCODINGS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="tw-field">
          <span>Delimiter</span>
          <select
            data-testid={TID.importOption('delimiter')}
            disabled={p.disabled}
            value={o.csv.delimiter}
            onChange={(e) => set({ delimiter: e.target.value as CsvOptions['delimiter'] })}
          >
            {DELIMITERS.map((x) => (
              <option key={x.label} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tw-field">
          <span>Decimal separator</span>
          <select
            data-testid={TID.importOption('decimalSeparator')}
            disabled={p.disabled}
            value={o.csv.decimalSeparator}
            onChange={(e) => set({ decimalSeparator: e.target.value as CsvOptions['decimalSeparator'] })}
          >
            <option value=".">Point .</option>
            <option value=",">Comma ,</option>
          </select>
        </label>
        <label className="tw-field">
          <span>Header rows</span>
          <input
            type="number"
            min={0}
            max={10}
            data-testid={TID.importOption('headerRows')}
            disabled={p.disabled}
            value={o.csv.headerRows}
            onChange={(e) => set({ headerRows: count(e.target.value) })}
          />
        </label>
        <label className="tw-field">
          <span>Lines to skip</span>
          <input
            type="number"
            min={0}
            max={50}
            data-testid={TID.importOption('skipLines')}
            disabled={p.disabled}
            value={o.csv.skipLines}
            onChange={(e) => set({ skipLines: count(e.target.value) })}
          />
        </label>
      </div>
    );
  }
  if (o.format === 'xlsx') {
    const sheets = p.sniff.sheets ?? [];
    const sheet = sheets.find((s) => s.name === o.xlsx.sheet);
    return (
      <div className="tw-settings" role="group" aria-label="Reading settings">
        <label className="tw-field">
          <span>Sheet</span>
          <select
            data-testid={TID.importOption('sheet')}
            disabled={p.disabled}
            value={o.xlsx.sheet}
            onChange={(e) => p.onChange({ ...o, xlsx: { ...o.xlsx, sheet: e.target.value, tableIndex: 0 } })}
          >
            {sheets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
                {s.state === 'visible' ? '' : ` (${s.state})`} — {s.dimension}
              </option>
            ))}
          </select>
        </label>
        {sheet !== undefined && sheet.tables.length > 1 && (
          <label className="tw-field">
            <span>Table on the sheet</span>
            <select
              data-testid={TID.importOption('tableIndex')}
              disabled={p.disabled}
              value={o.xlsx.tableIndex}
              onChange={(e) => p.onChange({ ...o, xlsx: { ...o.xlsx, tableIndex: Number(e.target.value) } })}
            >
              {sheet.tables.map((t, i) => (
                <option key={t.range} value={i}>
                  {t.range}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    );
  }
  return null;
}

const LABELS: Record<string, string> = {
  encoding: 'Text encoding',
  delimiter: 'Delimiter',
  decimalSeparator: 'Decimal separator',
  thousandsSeparator: 'Thousands separator',
  headerRows: 'Header rows',
  skipLines: 'Lines skipped before the header',
  quote: 'Quote character',
  sheet: 'Sheet',
  tableIndex: 'Table',
  crs: 'Coordinate reference system',
  type: 'type',
  unit: 'unit',
  role: 'role',
  timezone: 'time zone',
  dateFormat: 'date format',
  nullMarkers: 'null markers',
};

function label(property: string): string {
  return LABELS[property] ?? property;
}

function columnName(preview: ImportPreview, columnId: string): string {
  return preview.columns.find((c) => c.id === columnId)?.name ?? columnId;
}

/**
 * Mapping templates (FR-IMP-06): the user's saved ways of reading recurring files. A template is
 * saved from a dataset as the user left its columns (names, types, units, roles, null markers,
 * date formats and time zones); the import preview applies it to every later file with the same
 * columns. Templates hold no data and belong to the user, not to the project.
 */
import { useEffect, useState } from 'react';
import type { DatasetId, MappingTemplate } from '@tw/model';
import { useWorkbench, type CentreViewProps } from '@tw/ui-shell';
import { attempt, datasetFor, useProject } from './hooks';
import { TID } from './testids';

export function TemplatesView(p: CentreViewProps): React.JSX.Element {
  const { engine } = p;
  const project = useProject();
  const readOnly = useWorkbench((s) => s.project?.readOnly === true);
  const [templates, setTemplates] = useState<MappingTemplate[] | null>(null);
  const [version, setVersion] = useState(0);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<DatasetId | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    engine.listMappingTemplates().then(
      (t) => live && setTemplates(t),
      () => live && setTemplates([]),
    );
    return () => {
      live = false;
    };
  }, [engine, version]);

  const datasets = project?.datasets ?? [];
  const datasetId = picked ?? datasetFor(p.tab, project) ?? datasets[0]?.id ?? null;

  const save = async () => {
    if (datasetId === null) return;
    setBusy(true);
    const saved = await attempt(() => engine.saveMappingTemplate({ datasetId, name }));
    setBusy(false);
    if (saved !== null) {
      setName('');
      setVersion((v) => v + 1);
    }
  };

  const remove = async (t: MappingTemplate) => {
    setBusy(true);
    const done = await attempt(() => engine.deleteMappingTemplate(t.id).then(() => true));
    setBusy(false);
    if (done !== null) setVersion((v) => v + 1);
  };

  return (
    <div className="tw-view tw-templates-view" data-testid={TID.templatesView}>
      <div className="tw-view-toolbar">
        <strong className="tw-view-title">Mapping templates</strong>
        <span className="tw-view-meta">
          {templates === null ? '' : `${templates.length} saved`} · applied in the import preview to files with the same
          columns
        </span>
      </div>
      <div className="tw-import-body">
        <section className="tw-section" aria-labelledby="tpl-save">
          <h3 id="tpl-save" className="tw-section-title">
            Save a dataset's columns as a template
          </h3>
          {datasets.length === 0 ? (
            <p className="tw-hint">Import a file and set its columns as they should be read, then save them here.</p>
          ) : (
            <form
              className="tw-template-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="tw-inline-field">
                Dataset
                <select
                  data-testid={TID.templateDataset}
                  value={datasetId ?? ''}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tw-inline-field">
                Template name
                <input
                  data-testid={TID.templateName}
                  value={name}
                  maxLength={200}
                  placeholder="e.g. Daily well report, operator A"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button
                type="submit"
                className="tw-primary"
                data-testid={TID.templateSave}
                disabled={busy || readOnly || name.trim() === ''}
              >
                Save template
              </button>
            </form>
          )}
          <p className="tw-hint">
            A template of the same name is replaced. It holds header text and column settings, never values.
          </p>
        </section>
        <section className="tw-section" aria-labelledby="tpl-list">
          <h3 id="tpl-list" className="tw-section-title">
            Saved templates
          </h3>
          {templates !== null && templates.length === 0 && <p className="tw-hint">No templates saved yet.</p>}
          {templates !== null && templates.length > 0 && (
            <table className="tw-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Columns</th>
                  <th scope="col">Saved from</th>
                  <th scope="col">Saved</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} data-testid={TID.templateRow(t.id)}>
                    <td>{t.name}</td>
                    <td title={t.columns.map((c) => c.sourceHeader.join(' / ')).join(', ')}>{t.columns.length}</td>
                    <td>
                      {t.savedFrom.fileName} <span className="tw-muted">({t.savedFrom.format.toUpperCase()})</span>
                    </td>
                    <td>
                      {t.savedAt.slice(0, 16).replace('T', ' ')} UTC <span className="tw-muted">by {t.savedBy}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="tw-link"
                        data-testid={TID.templateDelete(t.id)}
                        disabled={busy}
                        onClick={() => void remove(t)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

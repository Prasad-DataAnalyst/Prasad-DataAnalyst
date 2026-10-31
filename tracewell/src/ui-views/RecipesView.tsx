/**
 * Recipes (FR-RCP-01..03): save a dataset's checks, steps and export as a `.twr` file, and run one
 * on another dataset, such as next month's file. Running shows the plan first: which column each
 * recipe column maps to, the steps as they will be applied, and anything that stops it. After a
 * run the issues register shows only issues that are new or changed since the recipe was saved.
 */
import { useState } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type { DatasetId, ExportProfileId, FileInput, RecipePlan, RecipeRun } from '@tw/model';
import { formatCount, toErrorData, useWorkbench, type CentreViewProps } from '@tw/ui-shell';
import { downloadBytes, useReasonPrompt } from './common';
import { attempt, datasetFor, useProject } from './hooks';
import { TID } from './testids';

const PROFILES: { id: ExportProfileId; label: string }[] = [
  { id: 'excel', label: 'Excel' },
  { id: 'csv', label: 'CSV' },
  { id: 'parquet', label: 'Parquet' },
  { id: 'geojson', label: 'GeoJSON' },
];

export function RecipesView(p: CentreViewProps): React.JSX.Element {
  const project = useProject();
  const datasetId = datasetFor(p.tab, project);
  if (datasetId === null) return <div className="tw-empty">Import a file before saving or running a recipe.</div>;
  return <Recipes engine={p.engine} datasetId={datasetId} />;
}

function Recipes(p: { engine: EngineClient; datasetId: DatasetId }): React.JSX.Element {
  const { engine, datasetId } = p;
  const project = useProject();
  const readOnly = useWorkbench((s) => s.project?.readOnly === true);
  const summary = project?.datasets.find((d) => d.id === datasetId);
  const reason = useReasonPrompt();
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<RecipePlan | null>(null);
  const [run, setRun] = useState<RecipeRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<ExportProfileId | ''>('');
  const [neutralize, setNeutralize] = useState(false);

  const input = (f: File): FileInput => ({ kind: 'blob', blob: f, name: f.name });

  const choose = async (f: File | null) => {
    setFile(f);
    setPlan(null);
    setRun(null);
    if (f === null) return;
    setBusy(true);
    setPlan(await attempt(() => engine.planRecipe(datasetId, input(f))));
    setBusy(false);
  };

  const runRecipe = async () => {
    if (file === null || plan === null) return;
    const why = await reason.ask(
      `Run the recipe "${plan.recipe.name}" v${plan.recipe.version}`,
      'Next period, same processing',
    );
    if (why === null) return;
    setBusy(true);
    const store = useWorkbench.getState();
    try {
      store.showError(null);
      const handle = await engine.applyRecipe(datasetId, input(file), why);
      store.trackJob(handle, `Recipe ${plan.recipe.name}`);
      setRun(await engine.awaitJob<RecipeRun>(handle));
      setPlan(null);
    } catch (e) {
      store.showError(toErrorData(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    const saved = await attempt(() =>
      engine.saveRecipe({
        datasetId,
        name,
        export: profile === '' ? null : { profile, neutralizeFormulas: profile === 'csv' && neutralize },
      }),
    );
    setBusy(false);
    if (saved !== null) downloadBytes(saved.bytes, saved.fileName, 'application/json');
  };

  const openIssues = () =>
    useWorkbench.getState().openTab({
      id: `issues-${datasetId}`,
      kind: 'issues',
      title: `Issues ${summary?.name ?? datasetId}`,
      datasetId,
    });

  return (
    <div className="tw-view tw-recipes-view" data-testid={TID.recipesView}>
      <div className="tw-view-toolbar">
        <strong className="tw-view-title">Recipes · {summary?.name ?? datasetId}</strong>
        <span className="tw-view-meta">steps from Check to Export, saved as a .twr file without data</span>
      </div>
      <div className="tw-import-body">
        <section className="tw-section" aria-labelledby="rcp-run">
          <h3 id="rcp-run" className="tw-section-title">
            Run a recipe on this dataset
          </h3>
          <label className="tw-inline-field">
            Recipe file
            <input
              type="file"
              accept=".twr,application/json"
              data-testid={TID.recipeFile}
              disabled={busy || readOnly}
              onChange={(e) => void choose(e.currentTarget.files?.[0] ?? null)}
            />
          </label>
          {plan !== null && <Plan plan={plan} />}
          {plan !== null && (
            <button
              type="button"
              className="tw-primary"
              data-testid={TID.recipeRun}
              disabled={busy || readOnly || !plan.fits}
              onClick={() => void runRecipe()}
            >
              Run recipe
            </button>
          )}
          {run !== null && <RunResult run={run} onIssues={openIssues} />}
        </section>
        <section className="tw-section" aria-labelledby="rcp-save">
          <h3 id="rcp-save" className="tw-section-title">
            Save this dataset as a recipe
          </h3>
          <p className="tw-hint">
            {summary?.steps.length ?? 0} steps,{' '}
            {project?.rulePacks.length === 0 ? 'not checked yet' : 'the rule packs it was checked with'}, and the issues
            found, as rule IDs, column names and counts. No values are saved. Saving again under the name of the recipe
            last run here gives its next version.
          </p>
          <form
            className="tw-template-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="tw-inline-field">
              Recipe name
              <input
                data-testid={TID.recipeName}
                value={name}
                maxLength={200}
                placeholder="e.g. Monthly well report"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="tw-inline-field">
              Export
              <select
                data-testid={TID.recipeExport}
                value={profile}
                onChange={(e) => setProfile(e.target.value as ExportProfileId | '')}
              >
                <option value="">None</option>
                {PROFILES.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            {profile === 'csv' && (
              <label className="tw-card-option">
                <input type="checkbox" checked={neutralize} onChange={(e) => setNeutralize(e.target.checked)} />
                Neutralise formulas
              </label>
            )}
            <button
              type="submit"
              className="tw-primary"
              data-testid={TID.recipeSave}
              disabled={busy || name.trim() === ''}
            >
              Save recipe…
            </button>
          </form>
        </section>
      </div>
      {reason.element}
    </div>
  );
}

function Plan(p: { plan: RecipePlan }): React.JSX.Element {
  const { plan } = p;
  const r = plan.recipe;
  return (
    <div className="tw-recipe-plan" data-testid={TID.recipePlan}>
      <p>
        <strong>{r.name}</strong> version {r.version}, saved {r.savedAt.slice(0, 10)} by {r.savedBy}.{' '}
        {r.check === null
          ? 'Runs no checks.'
          : `Checks with ${r.check.packs.map((x) => `${x.id} ${x.version}`).join(' and ')}.`}{' '}
        {r.export === null ? '' : `Exports with the ${r.export.profile.toUpperCase()} profile.`}
      </p>
      {plan.columns.length > 0 && (
        <table className="tw-table">
          <thead>
            <tr>
              <th scope="col">Recipe column</th>
              <th scope="col">In this dataset</th>
            </tr>
          </thead>
          <tbody>
            {plan.columns.map((c) => (
              <tr key={c.key}>
                <td>{c.name}</td>
                <td className={c.problem === null ? '' : 'tw-recipe-problem'}>
                  {c.problem ?? `${c.columnId ?? ''} ✓`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.steps.length > 0 && (
        <ol className="tw-list tw-recipe-steps">
          {plan.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {plan.problems.length > 0 && (
        <div className="tw-error-note" role="alert">
          The recipe cannot run on this dataset:
          <ul>
            {plan.problems.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RunResult(p: { run: RecipeRun; onIssues(): void }): React.JSX.Element {
  const { run } = p;
  const d = run.delta;
  return (
    <div className="tw-template-note" role="status" data-testid={TID.recipeResult}>
      <span>
        Ran <strong>{run.name}</strong> v{run.version}: {run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'}
        {run.checked ? ', checks run' : ''}.{' '}
        {d === null
          ? ''
          : `${formatCount(d.new)} new, ${formatCount(d.changed)} changed and ${formatCount(d.unchanged)} unchanged issues since the recipe was saved; ${formatCount(d.resolved.length)} no longer found.`}
        {run.export === null ? '' : ` Export with the ${run.export.profile.toUpperCase()} profile next.`}
      </span>
      {run.checked && (
        <button type="button" className="tw-link" data-testid={TID.recipeIssues} onClick={p.onIssues}>
          Review new and changed issues
        </button>
      )}
    </div>
  );
}

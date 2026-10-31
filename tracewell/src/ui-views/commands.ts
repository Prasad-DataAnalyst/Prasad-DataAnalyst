/**
 * The workbench's commands (SAD section 15): one list for the menus, the process toolbar and the
 * keyboard shortcuts. Theme, density, keyboard shortcuts and About come from the shell itself.
 */
import type { AuditEntry, DatasetId, DatasetSummary, ProjectOpenReport, SaveResult } from '@tw/model';
import type { Command, CommandContext, WorkbenchState } from '@tw/ui-shell';
import { addPendingImport, openDialog, views } from './store';

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.geojson,.json';
const TWP_TYPE = 'application/vnd.tracewell.project+zip';
const REVERTIBLE = new Set([
  'cell.edit',
  'issue.accept',
  'rows.exclude',
  'step.apply',
  'detection.override',
  'project.area',
]);

/** The dataset a command acts on: the active tab's, else the selected one's, else the first. */
export function activeDataset(s: WorkbenchState): DatasetId | null {
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (tab?.datasetId !== undefined) return tab.datasetId;
  if ('datasetId' in s.selection && s.selection.datasetId !== undefined) return s.selection.datasetId;
  return s.project?.datasets[0]?.id ?? null;
}

const hasProject = (s: WorkbenchState) => s.project !== null;
const writable = (s: WorkbenchState) => s.project !== null && !s.project.readOnly;
const hasData = (s: WorkbenchState) => writable(s) && (s.project?.datasets.length ?? 0) > 0;
const anyData = (s: WorkbenchState) => (s.project?.datasets.length ?? 0) > 0;

function datasetName(s: WorkbenchState, id: DatasetId): string {
  return s.project?.datasets.find((d) => d.id === id)?.name ?? id;
}

function openDataTab(s: WorkbenchState, ds: Pick<DatasetSummary, 'id' | 'name'>): void {
  s.openTab({ id: `data-${ds.id}`, kind: 'data', title: ds.name, datasetId: ds.id });
}

function closeAllTabs(s: WorkbenchState): void {
  for (const t of [...s.tabs]) s.closeTab(t.id);
  s.select({ kind: 'none' });
}

async function runJob<T>(
  ctx: CommandContext,
  start: () => Promise<{ jobId: string; kind: string }>,
  label: string,
): Promise<T> {
  const handle = await start();
  ctx.store.trackJob(handle as Parameters<WorkbenchState['trackJob']>[0], label);
  return ctx.engine.awaitJob<T>(handle as Parameters<WorkbenchState['trackJob']>[0]);
}

/** The latest change that can still be undone: revertible, and not reverted already. */
export function lastRevertible(entries: readonly AuditEntry[]): AuditEntry | null {
  const reverted = new Set(entries.filter((e) => e.action === 'entry.revert').map((e) => e.target.seq));
  const newestFirst = [...entries].sort((a, b) => b.seq - a.seq);
  return newestFirst.find((e) => REVERTIBLE.has(e.action) && !reverted.has(e.seq)) ?? null;
}

export function defaultCommands(): Command[] {
  return [
    // File
    {
      id: 'file.new',
      label: 'New project…',
      menu: 'file',
      enabled: () => true,
      run: () => openDialog({ kind: 'newProject' }),
    },
    {
      id: 'file.open',
      label: 'Open project…',
      menu: 'file',
      shortcut: 'Ctrl+O',
      enabled: () => true,
      run: async (ctx) => {
        const file = await ctx.pickFile('.twp');
        if (file === null) return;
        const report = await runJob<ProjectOpenReport>(
          ctx,
          () => ctx.engine.openProject({ kind: 'blob', blob: file, name: file.name }),
          `Open ${file.name}`,
        );
        closeAllTabs(ctx.store);
        const first = report.project.datasets[0];
        if (first !== undefined) openDataTab(ctx.store, first);
        openDialog({ kind: 'openReport', report });
      },
    },
    {
      id: 'file.save',
      label: 'Save project',
      menu: 'file',
      shortcut: 'Ctrl+S',
      enabled: writable,
      run: async (ctx) => {
        const saved = await runJob<SaveResult>(ctx, () => ctx.engine.saveProject(), 'Save project');
        if (saved.bytes !== undefined) ctx.download(saved.bytes, saved.fileName, TWP_TYPE);
      },
    },
    {
      id: 'file.import',
      label: 'Import file…',
      menu: 'file',
      stage: 'import',
      shortcut: 'Ctrl+I',
      enabled: writable,
      run: async (ctx) => {
        const file = await ctx.pickFile(ACCEPT);
        if (file === null) return;
        const preview = await ctx.engine.sniff({ kind: 'blob', blob: file, name: file.name });
        const id = addPendingImport(file, preview);
        ctx.store.openTab({ id, kind: 'import', title: `Import ${file.name}`, previewId: id });
      },
    },
    {
      id: 'file.export',
      label: 'Export…',
      menu: 'file',
      stage: 'export',
      shortcut: 'Ctrl+E',
      enabled: anyData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        if (id === null) return;
        ctx.store.openTab({
          id: `export-${id}`,
          kind: 'export',
          title: `Export ${datasetName(ctx.store, id)}`,
          datasetId: id,
        });
      },
    },
    {
      id: 'file.area',
      label: 'Project area…',
      menu: 'file',
      enabled: writable,
      run: () => openDialog({ kind: 'area' }),
    },

    // Edit
    {
      id: 'edit.cell',
      label: 'Edit cell',
      menu: 'edit',
      enabled: hasData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        if (id === null) return;
        openDataTab(ctx.store, { id, name: datasetName(ctx.store, id) });
        views.set((s) => ({ editNonce: s.editNonce + 1 }));
      },
    },
    {
      id: 'edit.undo',
      label: 'Undo last change…',
      menu: 'edit',
      shortcut: 'Ctrl+Z',
      enabled: writable,
      run: async (ctx) => {
        const page = await ctx.engine.listAudit({ limit: 1000, order: 'desc' });
        const target = lastRevertible(page.items);
        if (target === null) {
          ctx.store.showError({
            code: 'NOT_FOUND',
            message: 'There is no change to undo.',
            fix: 'Edits, acceptances, exclusions, steps, overrides and project-area changes can be undone.',
          });
          return;
        }
        const reason = await ctx.requestReason(`Undo entry #${target.seq} (${target.action})`);
        if (reason === null) return;
        await ctx.engine.decide({ kind: 'revert', seq: target.seq, reason });
      },
    },

    // View
    {
      id: 'view.issues',
      label: 'Issues panel',
      menu: 'view',
      enabled: () => true,
      run: (ctx) => ctx.store.setBottomTab('issues'),
    },
    {
      id: 'view.log',
      label: 'Log panel',
      menu: 'view',
      enabled: () => true,
      run: (ctx) => ctx.store.setBottomTab('log'),
    },
    {
      id: 'view.jobs',
      label: 'Jobs panel',
      menu: 'view',
      enabled: () => true,
      run: (ctx) => ctx.store.setBottomTab('jobs'),
    },
    {
      id: 'view.register',
      label: 'Issues register',
      menu: 'view',
      stage: 'review',
      enabled: anyData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        if (id === null) return;
        ctx.store.openTab({
          id: `issues-${id}`,
          kind: 'issues',
          title: `Issues ${datasetName(ctx.store, id)}`,
          datasetId: id,
        });
      },
    },

    // Data
    {
      id: 'data.check',
      label: 'Run checks',
      menu: 'data',
      stage: 'check',
      shortcut: 'Ctrl+K',
      enabled: hasData,
      run: async (ctx) => {
        const id = activeDataset(ctx.store);
        if (id === null) return;
        await runJob(ctx, () => ctx.engine.runChecks(id), `Check ${datasetName(ctx.store, id)}`);
        ctx.store.setBottomTab('issues');
      },
    },
    {
      id: 'data.templates',
      label: 'Mapping templates…',
      menu: 'data',
      stage: 'import',
      enabled: () => true,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        ctx.store.openTab({
          id: 'templates',
          kind: 'templates',
          title: 'Mapping templates',
          ...(id === null ? {} : { datasetId: id }),
        });
      },
    },
    {
      id: 'data.recipes',
      label: 'Recipes…',
      menu: 'data',
      stage: 'export',
      enabled: anyData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        if (id === null) return;
        ctx.store.openTab({
          id: `recipes-${id}`,
          kind: 'recipes',
          title: `Recipes ${datasetName(ctx.store, id)}`,
          datasetId: id,
        });
      },
    },
    {
      id: 'data.convert',
      label: 'Convert units…',
      menu: 'data',
      stage: 'process',
      enabled: hasData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        if (id === null) return;
        const s = ctx.store.selection;
        const columnId = (s.kind === 'column' || s.kind === 'cell') && s.datasetId === id ? s.columnId : undefined;
        openDialog({ kind: 'convert', datasetId: id, ...(columnId === undefined ? {} : { columnId }) });
      },
    },
    {
      id: 'data.filter',
      label: 'Filter…',
      menu: 'data',
      stage: 'extract',
      enabled: hasData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        if (id !== null) openDialog({ kind: 'filter', datasetId: id });
      },
    },
    {
      id: 'data.columns',
      label: 'Columns…',
      menu: 'data',
      enabled: hasData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        if (id !== null) openDialog({ kind: 'columns', datasetId: id });
      },
    },
    {
      id: 'data.exclude',
      label: 'Exclude rows…',
      menu: 'data',
      enabled: hasData,
      run: async (ctx) => {
        const s = ctx.store.selection;
        if (s.kind === 'cell') {
          const reason = await ctx.requestReason(`Exclude row ${s.rowId + 1}`);
          if (reason !== null)
            await ctx.engine.decide({ kind: 'exclude_rows', datasetId: s.datasetId, rows: [s.rowId], reason });
          return;
        }
        if (s.kind === 'issue') {
          const issues = await ctx.engine.listIssues({ limit: 1000 });
          const issue = issues.items.find((i) => i.id === s.issueId);
          if (issue === undefined) return;
          const reason = await ctx.requestReason(`Exclude every open row of ${issue.ruleId}`);
          if (reason !== null)
            await ctx.engine.decide({
              kind: 'exclude_rows',
              datasetId: issue.datasetId,
              rows: { issueId: issue.id },
              reason,
            });
          return;
        }
        ctx.store.showError({
          code: 'INVALID_INPUT',
          message: 'Choose what to exclude first.',
          fix: 'Select a cell in the data grid to exclude its row, or an issue to exclude its open rows.',
        });
      },
    },
    {
      id: 'data.override',
      label: 'Override detection…',
      menu: 'data',
      enabled: hasData,
      run: (ctx) => {
        const id = activeDataset(ctx.store);
        const s = ctx.store.selection;
        const columnId = (s.kind === 'column' || s.kind === 'cell') && s.datasetId === id ? s.columnId : undefined;
        if (id !== null)
          openDialog({ kind: 'override', datasetId: id, ...(columnId === undefined ? {} : { columnId }) });
      },
    },

    // Help
    {
      id: 'help.licences',
      label: 'Open-source licences',
      menu: 'help',
      enabled: hasProject,
      run: () => openDialog({ kind: 'licences' }),
    },
  ];
}

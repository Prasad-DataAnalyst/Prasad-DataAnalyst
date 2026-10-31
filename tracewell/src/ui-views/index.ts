// Public entry point of the ui-views module, imported elsewhere as '@tw/ui-views': the content of
// the workbench (data grid, import preview, issues register, export centre, mapping templates,
// properties and the bottom panels), the dialogs, the concrete command list and the stable test hooks.
import type { ShellViews } from '@tw/ui-shell';
import { DataGridView } from './DataGridView';
import { ExportCentreView } from './ExportCentreView';
import { ImportPreviewView } from './ImportPreviewView';
import { IssuesPanel, IssuesView } from './IssuesView';
import { JobsPanel, LogPanel } from './panels';
import { PropertiesPane } from './PropertiesPanel';
import { TemplatesView } from './TemplatesView';
import './views.css';

export { DataGridView } from './DataGridView';
export { ImportPreviewView } from './ImportPreviewView';
export { IssuesPanel, IssuesView } from './IssuesView';
export { ExportCentreView } from './ExportCentreView';
export { TemplatesView } from './TemplatesView';
export { PropertiesPane, PropertiesPanel } from './PropertiesPanel';
export { JobsPanel, LogPanel } from './panels';
export {
  ColumnsDialog,
  ConvertUnitsDialog,
  DialogHost,
  FilterDialog,
  OpenReportDialog,
  ProfileSetupDialog,
} from './dialogs';
export { activeDataset, defaultCommands, lastRevertible } from './commands';
export { RowPageCache } from './row-cache';
export type { FilterCondition, FilterFormState, FilterResult } from './filter-form';
export { buildPredicate, predicateFromForm } from './filter-form';
export { TID } from './testids';
export { openDialog } from './store';

export const SHELL_VIEWS: ShellViews = {
  centre: {
    data: DataGridView,
    import: ImportPreviewView,
    issues: IssuesView,
    export: ExportCentreView,
    templates: TemplatesView,
  },
  properties: PropertiesPane,
  issuesPanel: IssuesPanel,
  logPanel: LogPanel,
  jobsPanel: JobsPanel,
};

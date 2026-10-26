// Public entry point of the ui-shell module, imported elsewhere as '@tw/ui-shell': the enterprise
// window frame, the command registry, the workbench store, engine hooks, shared dialogs and
// display formatting. Views are injected by the app, so this module never imports ui-views.

export type { CentreTab, CentreTabKind, Selection, Stage, StageState } from './types';
export { STAGES, STAGE_LABELS } from './types';
export { stageStates } from './stages';
export type { TrackedJob, WorkbenchState } from './store';
export { createWorkbenchStore, loadPrefs, PREFS_KEY, useWorkbench } from './store';
export type { Command, CommandContext } from './commands';
export { clearCommands, getCommands, matchShortcut, registerCommands } from './commands';
export { formatCell, formatCount, cellTooltip } from './format';
export { EngineProvider, toErrorData, useEngine, useEngineEvents, useJob } from './engine-context';
export { AboutDialog, ErrorBanner, ReasonDialog, reasonLength } from './dialogs';
export type { AppShellProps, CentreViewProps, ShellViews } from './AppShell';
export { AppShell } from './AppShell';

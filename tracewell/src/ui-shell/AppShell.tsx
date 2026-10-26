/**
 * The enterprise window frame (SAD section 15): menu bar, process toolbar, project tree, centre
 * tabs, properties, the Issues/Log/Jobs panel and the status bar. Views and commands are injected,
 * so the frame knows nothing about what they show.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { EngineClient } from '@tw/engine-api';
import { getCommands, matchShortcut, registerCommands, type Command, type CommandContext } from './commands';
import { AboutDialog, ErrorBanner, ReasonDialog } from './dialogs';
import { EngineProvider, toErrorData } from './engine-context';
import { MenuBar, focusMenuBar } from './MenuBar';
import { ProcessToolbar } from './ProcessToolbar';
import { ProjectTree } from './ProjectTree';
import { StatusBar } from './StatusBar';
import { stageStates } from './stages';
import { useWorkbench } from './store';
import type { CentreTab, CentreTabKind } from './types';
import './tokens.css';
import './shell.css';

export interface CentreViewProps {
  tab: CentreTab;
  engine: EngineClient;
}

export interface ShellViews {
  centre: Record<CentreTabKind, React.ComponentType<CentreViewProps>>;
  properties: React.ComponentType<{ engine: EngineClient }>;
  issuesPanel: React.ComponentType<{ engine: EngineClient }>;
  logPanel: React.ComponentType<{ engine: EngineClient }>;
  jobsPanel: React.ComponentType<{ engine: EngineClient }>;
}

export interface AppShellProps {
  engine: EngineClient;
  edition: 'lite' | 'desktop';
  owner: string;
  appVersion: string;
  views: ShellViews;
  commands: Command[];
  /** Open-issue count for the toolbar; null until checks have run. */
  openIssues?: number | null;
}

const REGIONS = ['menubar', 'toolbar', 'tree', 'centre', 'properties', 'bottom', 'status'] as const;
const FOCUSABLE = 'button:not([disabled]), [tabindex="0"], input, select, textarea, [href]';

function builtInCommands(openAbout: () => void, openShortcuts: () => void): Command[] {
  return [
    {
      id: 'view.theme',
      label: 'Light/Dark theme',
      menu: 'view',
      enabled: () => true,
      run: ({ store }) => store.setTheme(store.theme === 'light' ? 'dark' : 'light'),
    },
    {
      id: 'view.density',
      label: 'Compact/Comfortable density',
      menu: 'view',
      enabled: () => true,
      run: ({ store }) => store.setDensity(store.density === 'compact' ? 'comfortable' : 'compact'),
    },
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', menu: 'help', enabled: () => true, run: openShortcuts },
    { id: 'help.about', label: 'About Tracewell', menu: 'help', enabled: () => true, run: openAbout },
  ];
}

export function AppShell(p: AppShellProps): React.JSX.Element {
  const state = useWorkbench();
  const [about, setAbout] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [reason, setReason] = useState<{ title: string; suggestion?: string; resolve(r: string | null): void } | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const filePick = useRef<((f: File | null) => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(() => {
    registerCommands([
      ...builtInCommands(
        () => setAbout(true),
        () => setShortcuts(true),
      ),
      ...p.commands,
    ]);
    return getCommands();
  }, [p.commands]);

  const ctx = useCallback(
    (): CommandContext => ({
      engine: p.engine,
      store: useWorkbench.getState(),
      requestReason: (title, suggestion) =>
        new Promise((resolve) =>
          setReason(suggestion === undefined ? { title, resolve } : { title, suggestion, resolve }),
        ),
      pickFile: (accept) =>
        new Promise((resolve) => {
          const input = fileInput.current;
          if (input === null) {
            resolve(null);
            return;
          }
          filePick.current = resolve;
          input.accept = accept;
          input.value = '';
          input.click();
        }),
      download: (bytes, fileName, mime) => {
        const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.rel = 'noopener';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      },
    }),
    [p.engine],
  );

  const run = useCallback(
    (c: Command) => {
      if (!c.enabled(useWorkbench.getState())) return;
      Promise.resolve()
        .then(() => c.run(ctx()))
        .catch((e: unknown) => useWorkbench.getState().showError(toErrorData(e)));
    },
    [ctx],
  );

  // Engine handshake and event wiring.
  useEffect(() => {
    let live = true;
    const store = useWorkbench.getState();
    p.engine.hello().then(
      (info) => live && store.setEngineInfo(info),
      (e: unknown) => live && store.showError(toErrorData(e)),
    );
    p.engine.getProject().then(
      (project) => live && store.setProject(project),
      () => undefined,
    );
    const off = p.engine.onEvent((e) => {
      const s = useWorkbench.getState();
      if (e.type.startsWith('job.')) s.updateJob(e);
      if (e.type === 'project.changed') {
        p.engine.getProject().then(
          (project) => live && useWorkbench.getState().setProject(project),
          (err: unknown) => live && useWorkbench.getState().showError(toErrorData(err)),
        );
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [p.engine]);

  // Global keyboard: F10 or a lone Alt for the menu bar, F6 region cycling, command shortcuts.
  useEffect(() => {
    let altAlone = false;
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altAlone) {
        e.preventDefault();
        focusMenuBar(rootRef.current ?? document);
      }
      altAlone = false;
    };
    const onKey = (e: KeyboardEvent) => {
      altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      if (e.key === 'F10') {
        e.preventDefault();
        focusMenuBar(rootRef.current ?? document);
        return;
      }
      if (e.key === 'F6') {
        e.preventDefault();
        cycleRegion(rootRef.current, e.shiftKey ? -1 : 1);
        return;
      }
      const c = matchShortcut(e);
      if (c !== undefined) {
        e.preventDefault();
        run(c);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [run]);

  const states = stageStates(
    state.project,
    p.openIssues === undefined || p.openIssues === null ? null : { open: p.openIssues },
  );
  const rulePackLabel =
    state.project?.rulePacks.map((r) => `${r.id.replace(/^tracewell\./, '')} ${r.version}`).join(', ') || 'generic-dq';
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const Centre = activeTab === null ? null : p.views.centre[activeTab.kind];
  const Properties = p.views.properties;
  const Bottom = { issues: p.views.issuesPanel, log: p.views.logPanel, jobs: p.views.jobsPanel }[state.bottomTab];

  return (
    <EngineProvider engine={p.engine}>
      <div ref={rootRef} className="tw-app" data-theme={state.theme} data-density={state.density}>
        <div data-region="menubar">
          <MenuBar commands={commands} state={state} run={run} />
        </div>
        <div data-region="toolbar">
          <ProcessToolbar states={states} commands={commands} state={state} run={run} rulePackLabel={rulePackLabel} />
        </div>
        <ErrorBanner error={state.lastError} onDismiss={() => state.showError(null)} />
        {state.project?.readOnly === true && (
          <div className="tw-readonly-banner" role="alert" data-testid="tw-read-only">
            <strong>Read-only project.</strong> Its integrity checks failed when it was opened, so nothing can be
            changed and nothing was repaired. The Issues panel lists what failed. To keep working, import the original
            files into a new project.
          </div>
        )}
        <main className="tw-main">
          <Group orientation="vertical" className="tw-group">
            <Panel defaultSize="72" minSize="30">
              <Group orientation="horizontal" className="tw-group">
                <Panel defaultSize="18" minSize="10" className="tw-pane" data-region="tree">
                  <h2 className="tw-pane-title">Project</h2>
                  <ProjectTree project={state.project} selection={state.selection} onSelect={state.select} />
                </Panel>
                <Separator className="tw-separator" aria-label="Resize project tree" />
                <Panel defaultSize="60" minSize="30" className="tw-pane tw-centre" data-region="centre">
                  <div role="tablist" aria-label="Open views" className="tw-tabs">
                    {state.tabs.map((t) => (
                      <button
                        key={t.id}
                        role="tab"
                        id={`tab-${t.id}`}
                        aria-selected={t.id === state.activeTabId}
                        aria-controls={`panel-${t.id}`}
                        aria-keyshortcuts="Delete"
                        title={`${t.title} (Delete closes the tab)`}
                        tabIndex={t.id === state.activeTabId ? 0 : -1}
                        className="tw-tab"
                        onClick={() => state.activateTab(t.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Delete') {
                            e.preventDefault();
                            state.closeTab(t.id);
                          }
                        }}
                      >
                        {t.title}
                        <span
                          className="tw-tab-close"
                          aria-hidden="true"
                          onClick={(e) => {
                            e.stopPropagation();
                            state.closeTab(t.id);
                          }}
                        >
                          ×
                        </span>
                      </button>
                    ))}
                  </div>
                  {activeTab !== null && Centre !== null ? (
                    <div
                      role="tabpanel"
                      id={`panel-${activeTab.id}`}
                      aria-labelledby={`tab-${activeTab.id}`}
                      className="tw-tabpanel"
                    >
                      <Centre tab={activeTab} engine={p.engine} />
                    </div>
                  ) : (
                    <div className="tw-empty">
                      Import a CSV, Excel or GeoJSON file to begin (File › Import file…, Ctrl+I).
                    </div>
                  )}
                </Panel>
                <Separator className="tw-separator" aria-label="Resize properties" />
                <Panel defaultSize="22" minSize="12" className="tw-pane" data-region="properties">
                  <h2 className="tw-pane-title">Properties</h2>
                  <Properties engine={p.engine} />
                </Panel>
              </Group>
            </Panel>
            <Separator className="tw-separator tw-separator-h" aria-label="Resize bottom panel" />
            <Panel defaultSize="28" minSize="10" className="tw-pane" data-region="bottom">
              <div role="tablist" aria-label="Bottom panel" className="tw-tabs">
                {(['issues', 'log', 'jobs'] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={state.bottomTab === t}
                    tabIndex={state.bottomTab === t ? 0 : -1}
                    className="tw-tab"
                    onClick={() => state.setBottomTab(t)}
                  >
                    {t === 'issues' ? 'Issues' : t === 'log' ? 'Log' : 'Jobs'}
                  </button>
                ))}
              </div>
              <div role="tabpanel" aria-label={state.bottomTab} className="tw-tabpanel">
                <Bottom engine={p.engine} />
              </div>
            </Panel>
          </Group>
        </main>
        <div data-region="status">
          <StatusBar project={state.project} edition={p.edition} />
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          data-testid="tw-file-input"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0] ?? null;
            filePick.current?.(f);
            filePick.current = null;
          }}
        />
        <ReasonDialog
          open={reason !== null}
          title={reason?.title ?? ''}
          {...(reason?.suggestion === undefined ? {} : { suggestion: reason.suggestion })}
          onSubmit={(r) => {
            reason?.resolve(r);
            setReason(null);
          }}
          onCancel={() => {
            reason?.resolve(null);
            setReason(null);
          }}
        />
        <AboutDialog
          open={about}
          owner={p.owner}
          appVersion={p.appVersion}
          edition={p.edition}
          onClose={() => setAbout(false)}
        />
        <ShortcutsDialog open={shortcuts} commands={commands} onClose={() => setShortcuts(false)} />
      </div>
    </EngineProvider>
  );
}

function cycleRegion(root: HTMLElement | null, dir: 1 | -1): void {
  if (root === null) return;
  const active = document.activeElement;
  const regions = REGIONS.map((r) => root.querySelector<HTMLElement>(`[data-region="${r}"]`)).filter(
    (el): el is HTMLElement => el !== null,
  );
  const current = regions.findIndex((r) => active !== null && r.contains(active));
  for (let step = 1; step <= regions.length; step++) {
    const region = regions[(current + dir * step + regions.length * 2) % regions.length];
    const target = region?.querySelector<HTMLElement>(FOCUSABLE);
    if (target !== null && target !== undefined) {
      target.focus();
      return;
    }
  }
}

function ShortcutsDialog(p: {
  open: boolean;
  commands: readonly Command[];
  onClose(): void;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (p.open && !d.open) d.showModal();
    if (!p.open && d.open) d.close();
  }, [p.open]);
  if (!p.open) return null;
  const rows = [
    ['F10', 'Focus the menu bar'],
    ['F6 / Shift+F6', 'Move to the next / previous region'],
    ['Enter or F2', 'Edit the selected cell'],
    ['Esc', 'Cancel'],
    ...p.commands.filter((c) => c.shortcut !== undefined).map((c) => [c.shortcut as string, c.label]),
  ];
  return (
    <dialog ref={ref} className="tw-dialog" aria-label="Keyboard shortcuts" onClose={p.onClose}>
      <h2 className="tw-dialog-title">Keyboard shortcuts</h2>
      <table className="tw-shortcuts">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={`${k}-${v}`}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tw-dialog-actions">
        <button type="button" className="tw-primary" autoFocus onClick={p.onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

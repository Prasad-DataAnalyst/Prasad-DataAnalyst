/**
 * Starts Tracewell: the engine in a module worker behind the engine protocol, a protocol check,
 * the analyst's profile on first start, a new project, then the workbench shell with its views
 * and commands. Nothing here talks to the network; the build's CSP forbids it as well.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EngineClient, workerTransport, type EngineInfo } from '@tw/engine-api';
import type { EngineErrorData, UserProfile } from '@tw/model';
import { AppShell, toErrorData, useWorkbench } from '@tw/ui-shell';
import { ProfileSetupDialog, SHELL_VIEWS, defaultCommands } from '@tw/ui-views';
import { checkProtocol } from './protocol';
import { loadProfile, saveProfile } from './profile';

declare global {
  interface Window {
    __tracewellReady?: boolean;
  }
}

const OWNER = import.meta.env.VITE_OWNER;
const VERSION = import.meta.env.VITE_APP_VERSION;
const COMMANDS = defaultCommands();

/**
 * The engine worker. `?budget=<bytes>` lowers the memory budget, so the partial-import path can be
 * tried without a huge file; the worker reads it from its name.
 */
function startWorker(): EngineClient {
  const budget = new URLSearchParams(window.location.search).get('budget');
  const name = budget !== null && /^\d+$/.test(budget) ? `budget=${budget}` : 'tracewell-engine';
  const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module', name });
  return new EngineClient(workerTransport(worker));
}

/** The open-issue count the toolbar shows; null until checks have run. */
function useOpenIssues(engine: EngineClient): number | null {
  const project = useWorkbench((s) => s.project);
  const [count, setCount] = useState<{ key: string; value: number } | null>(null);
  const key = project === null ? '' : `${project.id}:${project.auditHead.seq}`;
  const checked = project !== null && project.rulePacks.length > 0;
  useEffect(() => {
    if (!checked) return;
    let live = true;
    engine.listIssues({ status: ['open', 'partly_resolved'], limit: 1000 }).then(
      (page) => live && setCount({ key, value: page.total }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [engine, key, checked]);
  if (!checked) return null;
  return count?.key === key ? count.value : (count?.value ?? null);
}

function Workbench(p: { engine: EngineClient }): React.JSX.Element {
  const openIssues = useOpenIssues(p.engine);
  const theme = useWorkbench((s) => s.theme);
  const density = useWorkbench((s) => s.density);
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    document.documentElement.dataset['density'] = density;
  }, [theme, density]);
  useEffect(() => {
    window.__tracewellReady = true;
  }, []);
  return (
    <AppShell
      engine={p.engine}
      edition="lite"
      owner={OWNER}
      appVersion={VERSION}
      views={SHELL_VIEWS}
      commands={COMMANDS}
      openIssues={openIssues}
    />
  );
}

function App(p: { engine: EngineClient; info: EngineInfo }): React.JSX.Element {
  const [profile, setProfile] = useState<UserProfile | null>(() => loadProfile());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<EngineErrorData | null>(null);
  const theme = useWorkbench((s) => s.theme);
  const density = useWorkbench((s) => s.density);

  useEffect(() => {
    if (profile === null) return;
    let live = true;
    p.engine.newProject({ name: 'Untitled project', profile }).then(
      (summary) => {
        if (!live) return;
        useWorkbench.getState().setProject(summary);
        setReady(true);
      },
      (e: unknown) => live && setError(toErrorData(e)),
    );
    return () => {
      live = false;
    };
  }, [p.engine, profile]);

  if (error !== null) return <StartError error={error} />;
  if (profile === null) {
    return (
      <div className="tw-app tw-start" data-theme={theme} data-density={density}>
        <ProfileSetupDialog
          onDone={(prof) => {
            saveProfile(prof);
            setProfile(prof);
          }}
        />
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="tw-app tw-start" data-theme={theme} data-density={density} role="status">
        <p className="tw-empty">
          Starting the Tracewell engine ({p.info.name} {p.info.version})…
        </p>
      </div>
    );
  }
  return <Workbench engine={p.engine} />;
}

function StartError(p: { error: EngineErrorData }): React.JSX.Element {
  return (
    <div className="tw-app tw-start" role="alert">
      <div className="tw-error-banner">
        <div>
          <strong>Tracewell could not start: {p.error.message}</strong>
          <div>{p.error.fix}</div>
        </div>
      </div>
    </div>
  );
}

/** Mounts Tracewell into `root`. Tests may pass their own engine client. */
export async function bootstrap(root: HTMLElement, o: { engine?: EngineClient } = {}): Promise<void> {
  const reactRoot = createRoot(root);
  const engine = o.engine ?? startWorker();
  try {
    const info = await engine.hello();
    checkProtocol(info.protocol);
    reactRoot.render(
      <StrictMode>
        <App engine={engine} info={info} />
      </StrictMode>,
    );
  } catch (e) {
    reactRoot.render(<StartError error={toErrorData(e)} />);
  }
}

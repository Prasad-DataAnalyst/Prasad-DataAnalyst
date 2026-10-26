/**
 * The workbench store: what the window shows right now. The engine owns project state; this store
 * only mirrors the latest summary, plus purely visual state (selection, tabs, layout, theme).
 * Theme and density persist in localStorage, which may be unavailable or throw (private windows,
 * blocked storage), so every access is guarded and the app works the same without it.
 */
import { create } from 'zustand';
import type { EngineErrorData, JobHandle, JobId, JobProgress, ProjectSummary } from '@tw/model';
import type { EngineEvent, EngineInfo } from '@tw/engine-api';
import type { CentreTab, Selection } from './types';

export interface TrackedJob {
  handle: JobHandle;
  label: string;
  progress: JobProgress | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  error?: EngineErrorData;
}

export interface WorkbenchState {
  project: ProjectSummary | null;
  engineInfo: EngineInfo | null;
  selection: Selection;
  tabs: CentreTab[];
  activeTabId: string | null;
  bottomTab: 'issues' | 'log' | 'jobs';
  jobs: Record<JobId, TrackedJob>;
  theme: 'light' | 'dark';
  density: 'compact' | 'comfortable';
  lastError: EngineErrorData | null;
  setProject(p: ProjectSummary | null): void;
  setEngineInfo(i: EngineInfo | null): void;
  select(s: Selection): void;
  openTab(t: CentreTab): void;
  closeTab(id: string): void;
  activateTab(id: string): void;
  setBottomTab(t: WorkbenchState['bottomTab']): void;
  trackJob(h: JobHandle, label: string): void;
  updateJob(e: EngineEvent): void;
  setTheme(t: 'light' | 'dark'): void;
  setDensity(d: 'compact' | 'comfortable'): void;
  showError(e: EngineErrorData | null): void;
}

export const PREFS_KEY = 'tracewell.prefs.v1';

interface Prefs {
  theme: 'light' | 'dark';
  density: 'compact' | 'comfortable';
}

const DEFAULT_PREFS: Prefs = { theme: 'light', density: 'compact' };

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = storage()?.getItem(PREFS_KEY);
    if (raw === null || raw === undefined) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
      density: parsed.density === 'comfortable' ? 'comfortable' : 'compact',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(p: Prefs): void {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Preferences are a convenience; failing to store them must never interrupt work.
  }
}

/** Tabs of the same kind for the same dataset are one tab: opening again focuses it. */
function sameTab(a: CentreTab, b: CentreTab): boolean {
  return a.id === b.id || (a.kind === b.kind && a.datasetId === b.datasetId && a.previewId === b.previewId);
}

export function createWorkbenchStore() {
  const prefs = loadPrefs();
  return create<WorkbenchState>()((set, get) => ({
    project: null,
    engineInfo: null,
    selection: { kind: 'none' },
    tabs: [],
    activeTabId: null,
    bottomTab: 'issues',
    jobs: {},
    theme: prefs.theme,
    density: prefs.density,
    lastError: null,

    setProject: (project) => set({ project }),
    setEngineInfo: (engineInfo) => set({ engineInfo }),
    select: (selection) => set({ selection }),

    openTab: (tab) => {
      const existing = get().tabs.find((t) => sameTab(t, tab));
      if (existing !== undefined) {
        set({ activeTabId: existing.id });
        return;
      }
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    },

    closeTab: (id) =>
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id);
        if (index < 0) return {};
        const tabs = s.tabs.filter((t) => t.id !== id);
        const neighbour = tabs[Math.min(index, tabs.length - 1)];
        return { tabs, activeTabId: s.activeTabId === id ? (neighbour?.id ?? null) : s.activeTabId };
      }),

    activateTab: (id) => {
      if (get().tabs.some((t) => t.id === id)) set({ activeTabId: id });
    },

    setBottomTab: (bottomTab) => set({ bottomTab }),

    trackJob: (handle, label) =>
      set((s) => ({ jobs: { ...s.jobs, [handle.jobId]: { handle, label, progress: null, state: 'running' } } })),

    updateJob: (e) => {
      if (!e.type.startsWith('job.') || !('jobId' in e)) return;
      const job = get().jobs[e.jobId];
      if (job === undefined || job.state !== 'running') return;
      let next: TrackedJob;
      switch (e.type) {
        case 'job.progress':
          next = { ...job, progress: e.progress };
          break;
        case 'job.done':
          next = { ...job, state: 'done' };
          break;
        case 'job.failed':
          next = { ...job, state: 'failed', error: e.error };
          break;
        case 'job.cancelled':
          next = { ...job, state: 'cancelled' };
          break;
        default:
          return;
      }
      set((s) => ({ jobs: { ...s.jobs, [e.jobId]: next } }));
    },

    setTheme: (theme) => {
      set({ theme });
      savePrefs({ theme, density: get().density });
    },
    setDensity: (density) => {
      set({ density });
      savePrefs({ theme: get().theme, density });
    },
    showError: (lastError) => set({ lastError }),
  }));
}

export const useWorkbench = createWorkbenchStore();

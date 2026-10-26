/**
 * State the views share that is not project state: the dialog a command asked for, a pending
 * "go to row", files waiting in the import preview, and the latest export job per destination.
 * A small external store read with useSyncExternalStore, so this module depends on React alone.
 */
import { useSyncExternalStore } from 'react';
import type {
  ColumnId,
  DatasetId,
  ExportProfileId,
  ImportPreview,
  IssueId,
  JobHandle,
  ProjectOpenReport,
  RowId,
} from '@tw/model';

export type DialogRequest =
  | { kind: 'convert'; datasetId: DatasetId; columnId?: ColumnId }
  | { kind: 'filter'; datasetId: DatasetId }
  | { kind: 'columns'; datasetId: DatasetId }
  | { kind: 'override'; datasetId: DatasetId; columnId?: ColumnId }
  | { kind: 'area' }
  | { kind: 'openReport'; report: ProjectOpenReport }
  | { kind: 'licences' }
  | { kind: 'comment'; issueId: IssueId }
  | { kind: 'newProject' };

export interface ViewsState {
  dialog: DialogRequest | null;
  goto: { datasetId: DatasetId; rowId: RowId; columnId?: ColumnId; nonce: number } | null;
  exports: Record<string, JobHandle>;
  /** Moves on when Edit › Edit cell asks the grid to edit its active cell. */
  editNonce: number;
}

type Listener = () => void;

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(l: Listener): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const l of [...listeners]) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export const views = createStore<ViewsState>({ dialog: null, goto: null, exports: {}, editNonce: 0 });

/** Reads one slice of the views store; the selector must return a stored value, not a new object. */
export function useViews<S>(select: (s: ViewsState) => S): S {
  return useSyncExternalStore(views.subscribe, () => select(views.get()));
}

export function openDialog(d: DialogRequest): void {
  views.set({ dialog: d });
}

export function closeDialog(): void {
  views.set({ dialog: null });
}

let gotoNonce = 0;

export function gotoRow(datasetId: DatasetId, rowId: RowId, columnId?: ColumnId): void {
  views.set({ goto: { datasetId, rowId, ...(columnId === undefined ? {} : { columnId }), nonce: ++gotoNonce } });
}

export function exportKey(datasetId: DatasetId, profile: ExportProfileId): string {
  return `${datasetId}:${profile}`;
}

/** Files picked for import, waiting in their preview tab. Files cannot live in a serialisable store. */
export const pendingImports = new Map<string, { file: File; preview: ImportPreview }>();
let importCounter = 0;

export function addPendingImport(file: File, preview: ImportPreview): string {
  const id = `import-${++importCounter}`;
  pendingImports.set(id, { file, preview });
  return id;
}

/** Shared vocabulary of the window frame: stages, centre tabs and the current selection. */
import type { ColumnId, DatasetId, FileId, IssueId, RowId, StepId } from '@tw/model';

export type Stage = 'import' | 'check' | 'review' | 'process' | 'extract' | 'export';
export type StageState = 'idle' | 'active' | 'done' | 'attention';
export type CentreTabKind = 'data' | 'import' | 'issues' | 'export' | 'templates' | 'recipes';

export interface CentreTab {
  id: string;
  kind: CentreTabKind;
  title: string;
  datasetId?: DatasetId;
  previewId?: string;
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'dataset'; datasetId: DatasetId }
  | { kind: 'column'; datasetId: DatasetId; columnId: ColumnId }
  | { kind: 'cell'; datasetId: DatasetId; rowId: RowId; columnId: ColumnId }
  | { kind: 'issue'; issueId: IssueId }
  | { kind: 'source'; fileId: FileId }
  | { kind: 'step'; datasetId: DatasetId; stepId: StepId }
  | { kind: 'export'; exportId: string };

export const STAGES: readonly Stage[] = ['import', 'check', 'review', 'process', 'extract', 'export'];

export const STAGE_LABELS: Record<Stage, string> = {
  import: 'Import',
  check: 'Check',
  review: 'Review',
  process: 'Process',
  extract: 'Extract',
  export: 'Export',
};

/** Project state: everything rebuilt by replaying the audit log over the originals (SAD section 8.1). */
import { AuditLog } from '@tw/audit';
import type { ImportSpec, IngestNote } from '@tw/ingest';
import type {
  Assumption,
  AuditSeq,
  BBox,
  DatasetId,
  ExportRecord,
  FileId,
  IsoUtc,
  IssueComment,
  IssueDraft,
  IssueId,
  OriginalFileInfo,
  ProjectId,
  Recipe,
  RulePackRef,
  Step,
  UserProfile,
} from '@tw/model';
import { Overlay, RowSet, type Dataset } from '@tw/table';

export interface IssueState {
  draft: IssueDraft;
  /** Every row ever flagged during the session's check runs. */
  flagged: RowSet;
  /** Rows the latest check run flagged. */
  current: RowSet;
  accepted: RowSet;
  /** For column- and dataset-scope issues: whether the latest run raised it. */
  present: boolean;
  acceptedWhole: boolean;
  comments: IssueComment[];
  firstSeenSeq: AuditSeq;
  lastCheckedSeq: AuditSeq;
  /** The audit entry that decided each accepted row, for drill-down. */
  decidedBy: Map<number, AuditSeq>;
}

export interface DatasetState {
  id: DatasetId;
  fileId: FileId;
  spec: ImportSpec;
  dataset: Dataset;
  notes: IngestNote[];
  assumptions: Assumption[];
  overlay: Overlay;
  excluded: RowSet;
  /** The `rows.exclude` entry that excluded each row; each row is excluded by exactly one entry. */
  excludedBy: Map<number, AuditSeq>;
  steps: Step[];
  checked: boolean;
  checkPacks: RulePackRef[];
  issues: Map<IssueId, IssueState>;
  /** The recipe last run on the dataset (FR-RCP-02): issues are compared with its baseline. */
  recipe: Pick<Recipe, 'id' | 'name' | 'version' | 'baseline' | 'export'> | null;
}

export interface ProjectState {
  id: ProjectId;
  name: string;
  createdAt: IsoUtc;
  profile: UserProfile;
  unitSystem: 'SI' | 'Oilfield';
  projectArea: BBox | null;
  readOnly: boolean;
  lastSavedAt: IsoUtc | null;
  lastSavedSeq: AuditSeq | null;
  originals: Map<FileId, { info: OriginalFileInfo; bytes: Uint8Array }>;
  datasets: Map<DatasetId, DatasetState>;
  nextDataset: number;
  /** Step IDs are numbered per project: 's1', 's2', ... */
  nextStep: number;
  exports: ExportRecord[];
  rulePacks: RulePackRef[];
  reverted: Set<AuditSeq>;
  /** Findings about the project file itself (TW-PRJ rules), raised when it is opened. */
  systemIssues: IssueDraft[];
  log: AuditLog;
}

export function emptyProject(id: ProjectId, log: AuditLog = new AuditLog(id)): ProjectState {
  return {
    id,
    name: '',
    createdAt: '',
    profile: { id: '', name: '', role: 'Analyst' },
    unitSystem: 'SI',
    projectArea: null,
    readOnly: false,
    lastSavedAt: null,
    lastSavedSeq: null,
    originals: new Map(),
    datasets: new Map(),
    nextDataset: 1,
    nextStep: 1,
    exports: [],
    rulePacks: [],
    reverted: new Set(),
    systemIssues: [],
    log,
  };
}

export function newDatasetState(
  id: DatasetId,
  spec: ImportSpec,
  dataset: Dataset,
  notes: IngestNote[],
  assumptions: Assumption[],
): DatasetState {
  return {
    id,
    fileId: spec.fileId,
    spec,
    dataset,
    notes,
    assumptions,
    overlay: new Overlay(),
    excluded: new RowSet(dataset.rowCount),
    excludedBy: new Map(),
    steps: [],
    checked: false,
    checkPacks: [],
    issues: new Map(),
    recipe: null,
  };
}

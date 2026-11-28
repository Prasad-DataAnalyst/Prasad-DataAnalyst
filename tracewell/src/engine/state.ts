/** Project state: everything rebuilt by replaying the audit log over the originals (SAD section 8.1). */
import { AuditLog } from '@tw/audit';
import type { ImportSpec, IngestNote } from '@tw/ingest';
import {
  NO_CONVENTIONS,
  type Assumption,
  type AuditSeq,
  type BBox,
  type Conventions,
  type DatasetId,
  type ExportRecord,
  type FileId,
  type IsoUtc,
  type IssueComment,
  type IssueDraft,
  type InstalledRulePack,
  type IssueId,
  type OriginalFileInfo,
  type ProjectId,
  type Recipe,
  type RulePack,
  type RulePackRef,
  type Step,
  type UserProfile,
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
  /** Who the issue is assigned to (issue.assign), by name, or null. */
  assignee: string | null;
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
  conventions: Conventions;
  /** Rule-packs installed from signed files, in install order (a newer version replaces its pack). */
  installedPacks: { info: InstalledRulePack; pack: RulePack }[];
  /** Every pack version installed in the project, by SHA-256, so a project file can store what check runs used. */
  packsBySha: Map<string, RulePack>;
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
    conventions: { ...NO_CONVENTIONS },
    installedPacks: [],
    packsBySha: new Map(),
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

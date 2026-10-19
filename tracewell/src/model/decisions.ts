/**
 * Decisions: the user's review actions. Each is validated, appended to the audit log and then
 * applied by the same reducer that replays the log (SAD section 8.1).
 */
import type { AuditSeq, BBox, ColumnId, DatasetId, IssueId, JsonValue, RowId } from './ids';
import type { CellValue } from './values';

/** Text is parsed with the column's parser; a value is taken as already typed. */
export type CellInput = { text: string } | { value: CellValue };

export type OverridableProperty =
  | 'name'
  | 'type'
  | 'unit'
  | 'role'
  | 'nullMarkers'
  | 'dateFormat'
  | 'timezone'
  | 'crs'
  | 'encoding'
  | 'delimiter'
  | 'decimalSeparator'
  | 'headerRows'
  | 'skipLines'
  | 'sheet'
  | 'tableIndex';

/** Every decision except a comment needs a reason of at least MIN_REASON_LENGTH non-space characters. */
export type Decision =
  | { kind: 'edit_cell'; datasetId: DatasetId; rowId: RowId; columnId: ColumnId; value: CellInput; reason: string; issueId?: IssueId }
  | { kind: 'accept_issue'; issueId: IssueId; rows: 'all' | RowId[]; reason: string }
  | { kind: 'exclude_rows'; datasetId: DatasetId; rows: RowId[] | { issueId: IssueId }; reason: string }
  | { kind: 'comment_issue'; issueId: IssueId; text: string }
  | {
      kind: 'override_detection';
      datasetId: DatasetId;
      columnId?: ColumnId;
      property: OverridableProperty;
      value: JsonValue;
      reason: string;
    }
  | { kind: 'set_project_area'; bbox: BBox | null; reason: string }
  /** Allowed targets: cell.edit, issue.accept, rows.exclude, step.apply, detection.override, project.area. */
  | { kind: 'revert'; seq: AuditSeq; reason: string };

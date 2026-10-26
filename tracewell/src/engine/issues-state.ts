/**
 * The issues register (SAD section 7.7): issues grouped per (rule, dataset, columns), with flagged,
 * current, accepted and excluded rows, from which the counts and the status follow.
 */
import { findRule, GENERIC_DQ, issueId, SYSTEM_RULES } from '@tw/rules';
import type { AuditSeq, Issue, IssueDraft, IssueId, IssueOccurrence, RowId, Severity } from '@tw/model';
import { RowSet } from '@tw/table';
import type { DatasetState, IssueState } from './state';

const PACKS = [GENERIC_DQ, SYSTEM_RULES];

/** Merges a check run's drafts: issues it raised are updated, issues it did not raise are no longer flagged. */
export function mergeCheckRun(ds: DatasetState, drafts: IssueDraft[], seq: AuditSeq): void {
  const n = ds.dataset.rowCount;
  const seen = new Set<IssueId>();
  for (const d of drafts) {
    const id = issueId(d);
    seen.add(id);
    const rows = RowSet.of(n, d.rows);
    const existing = ds.issues.get(id);
    if (existing === undefined) {
      ds.issues.set(id, {
        draft: d,
        flagged: rows.clone(),
        current: rows,
        accepted: new RowSet(n),
        present: true,
        acceptedWhole: false,
        comments: [],
        firstSeenSeq: seq,
        lastCheckedSeq: seq,
        decidedBy: new Map(),
      });
    } else {
      existing.draft = d;
      existing.flagged = existing.flagged.union(rows);
      existing.current = rows;
      existing.present = true;
      existing.lastCheckedSeq = seq;
    }
  }
  for (const [id, st] of ds.issues) {
    if (seen.has(id)) continue;
    st.current = new RowSet(n);
    st.present = false;
    st.lastCheckedSeq = seq;
  }
}

export function issueCounts(st: IssueState, excluded: RowSet): Issue['counts'] {
  if (st.draft.scope !== 'rows') {
    const open = st.present && !st.acceptedWhole ? 1 : 0;
    return {
      flagged: 1,
      open,
      accepted: st.present && st.acceptedWhole ? 1 : 0,
      excluded: 0,
      fixed: st.present ? 0 : 1,
    };
  }
  const current = st.current.minus(excluded);
  const accepted = current.intersect(st.accepted);
  return {
    flagged: st.flagged.size,
    open: current.minus(st.accepted).size,
    accepted: accepted.size,
    excluded: st.flagged.intersect(excluded).size,
    fixed: st.flagged.minus(st.current).minus(excluded).size,
  };
}

export function issueStatus(c: Issue['counts']): Issue['status'] {
  if (c.open === 0) return 'resolved';
  if (c.accepted === 0 && c.excluded === 0 && c.fixed === 0) return 'open';
  return 'partly_resolved';
}

export function toIssue(id: IssueId, st: IssueState, ds: DatasetState): Issue {
  const rule = findRule(PACKS, st.draft.ruleId)?.rule;
  const counts = issueCounts(st, ds.excluded);
  const open =
    st.draft.scope === 'rows' ? st.current.minus(ds.excluded).minus(st.accepted) : new RowSet(ds.dataset.rowCount);
  return {
    id,
    ruleId: st.draft.ruleId,
    ruleVersion: st.draft.ruleVersion,
    packId: st.draft.packId,
    severity: st.draft.severity,
    category: st.draft.category,
    datasetId: st.draft.datasetId,
    columns: st.draft.columns,
    scope: st.draft.scope,
    title: rule?.title ?? st.draft.ruleId,
    message: st.draft.message,
    explanation: rule?.explanation ?? '',
    source: rule?.source ?? '',
    status: issueStatus(counts),
    counts,
    openRows: open.toRanges(),
    comments: [...st.comments],
    firstSeenSeq: st.firstSeenSeq,
    lastCheckedSeq: st.lastCheckedSeq,
  };
}

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, note: 1 };

export function worse(a: Severity | null, b: Severity): Severity {
  return a === null || SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export function occurrenceState(st: IssueState, excluded: RowSet, r: RowId): IssueOccurrence['state'] {
  if (excluded.has(r)) return 'excluded';
  if (!st.current.has(r)) return 'fixed';
  return st.accepted.has(r) ? 'accepted' : 'open';
}

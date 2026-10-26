/** Stable issue identity: the same rule, dataset and columns always give the same issue ID. */
import { sha256Hex } from '@tw/io';
import type { IssueDraft, IssueId } from '@tw/model';

export function issueId(d: Pick<IssueDraft, 'ruleId' | 'datasetId' | 'columns'>): IssueId {
  const cols = [...d.columns].sort();
  return `I-${sha256Hex(`${d.ruleId}|${d.datasetId}|${cols.join(',')}`).slice(0, 12)}`;
}

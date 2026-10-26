/** README.txt and issues.csv inside an export package (SAD section 10.4). */
import { writeCsv } from '@tw/formats-csv';
import type { ExportManifest, Issue } from '@tw/model';

export function renderReadme(m: ExportManifest, stepDescriptions: string[]): string {
  const data = m.files.filter((f) => f.role === 'data');
  const passed = m.validation.checks.filter((c) => c.ok).length;
  const lines = [
    `Tracewell export: ${m.dataset.name}`,
    `Project: ${m.project.name} (${m.project.id})`,
    `Export ID: ${m.exportId}`,
    `Created: ${m.createdAt} by Tracewell ${m.appVersion} (owner: ${m.owner})`,
    `Profile: ${m.profile}`,
    `Rows: ${m.dataset.rowCount}${m.dataset.partial ? ' (PARTIAL: the import stopped at the memory budget)' : ''}`,
    `Excluded rows: ${m.excludedRows}`,
    '',
    'DATA FILES',
    ...data.map((f) => `  ${f.path}  ${f.size} bytes  SHA-256 ${f.sha256}`),
    '',
    'COLUMNS',
    ...m.dataset.columns.map((c) => `  ${c.header}  (${c.type})  SHA-256 of values ${c.sha256}`),
    '',
    `SOURCES (${m.sources.length})`,
    ...(m.sources.length === 0
      ? ['  none']
      : m.sources.map((s) => `  ${s.name}  ${s.size} bytes  SHA-256 ${s.fileId}`)),
    '',
    `RULE PACKS (${m.rulePacks.length})`,
    ...(m.rulePacks.length === 0 ? ['  none'] : m.rulePacks.map((r) => `  ${r.id} ${r.version}  SHA-256 ${r.sha256}`)),
    `UNIT REGISTRY: ${m.unitRegistry.version}  SHA-256 ${m.unitRegistry.sha256}`,
    '',
    `STEPS (${stepDescriptions.length})`,
    ...(stepDescriptions.length === 0 ? ['  none'] : stepDescriptions.map((d, i) => `  ${i + 1}. ${d}`)),
    '',
    `ASSUMPTIONS (${m.assumptions.length})`,
    ...(m.assumptions.length === 0
      ? ['  none']
      : m.assumptions.map(
          (a) =>
            `  ${a.columnId ?? 'dataset'} ${a.property} = ${JSON.stringify(a.value)} (${a.confidence}): ${a.evidence}`,
        )),
    '',
    'OPEN WARNINGS',
    `  errors ${m.openIssues.error}, warnings ${m.openIssues.warning}, notes ${m.openIssues.note} (details in issues.csv)`,
    '',
    `SUBSTITUTIONS (${m.substitutions.length})`,
    ...(m.substitutions.length === 0
      ? ['  none']
      : m.substitutions.map((s) => `  ${s.ruleId}: ${s.what}. ${s.why} ${s.instead}`)),
    '',
    'VALIDATION',
    `  ${m.validation.ok ? 'Passed' : 'FAILED'}: ${passed} of ${m.validation.checks.length} read-back checks passed before the package was assembled.`,
    ...m.validation.checks.map(
      (c) => `  [${c.ok ? 'ok' : 'FAILED'}] ${c.id}${c.file === undefined ? '' : ` ${c.file}`}: ${c.detail}`,
    ),
    '',
    'HOW TO VERIFY',
    '  1. Extract the package into an empty folder.',
    '  2. Run:  sha256sum -c CHECKSUMS.sha256   (every line must end in OK)',
    '  3. manifest.json holds the SHA-256 of every column; audit.jsonl holds the full history,',
    '     each entry linked to the one before it by its SHA-256 hash.',
    '',
  ];
  return lines.join('\n');
}

export function issuesCsv(issues: Issue[]): Uint8Array {
  const header = [
    'issue_id',
    'rule_id',
    'severity',
    'status',
    'dataset',
    'columns',
    'title',
    'message',
    'flagged',
    'open',
    'accepted',
    'excluded',
    'fixed',
  ];
  const rows = issues.map((i) => [
    i.id,
    i.ruleId,
    i.severity,
    i.status,
    i.datasetId,
    i.columns.join(' '),
    i.title,
    i.message,
    String(i.counts.flagged),
    String(i.counts.open),
    String(i.counts.accepted),
    String(i.counts.excluded),
    String(i.counts.fixed),
  ]);
  return writeCsv(header, rows);
}

/** Always-visible facts: offline state, save state, rules, units, conventions, rows and assumptions. */
import type { ProjectSummary } from '@tw/model';
import { formatCount } from './format';

export function savedText(p: ProjectSummary | null): string {
  if (p === null) return 'No project';
  if (p.readOnly) return 'Read-only';
  if (p.dirty || p.lastSavedAt === null) return 'Unsaved';
  return `Saved ${p.lastSavedAt.slice(11, 16)} UTC`;
}

export function StatusBar(p: { project: ProjectSummary | null; edition: 'lite' | 'desktop' }): React.JSX.Element {
  const project = p.project;
  const rows = project?.datasets.reduce((n, d) => n + d.outputRowCount, 0) ?? 0;
  const assumed = project?.datasets.reduce((n, d) => n + d.assumptions, 0) ?? 0;
  const rules = project?.rulePacks.map((r) => `${r.id.replace(/^tracewell\./, '')} ${r.version}`).join(', ');
  return (
    <footer role="status" aria-label="Status" className="tw-statusbar">
      <span className="tw-offline">
        <span className="tw-dot-ok" aria-hidden="true" /> Offline
      </span>
      <span>{savedText(project)}</span>
      <span>Rules {rules === undefined || rules === '' ? 'built-in' : rules}</span>
      <span>Units {project?.unitSystem ?? 'SI'}</span>
      <span>Conventions: not set</span>
      <span>{formatCount(rows)} rows</span>
      <span>{formatCount(assumed)} assumed</span>
      <span className="tw-status-edition">{p.edition === 'lite' ? 'Lite edition' : 'Desktop edition'}</span>
    </footer>
  );
}

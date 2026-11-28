/** Always-visible facts: offline state, save state, rules, units, conventions, rows and assumptions. */
import { conventionsText, type Conventions, type ProjectSummary, type UserProfile } from '@tw/model';
import { formatCount } from './format';

export function savedText(p: ProjectSummary | null): string {
  if (p === null) return 'No project';
  if (p.readOnly) return 'Read-only';
  if (p.dirty || p.lastSavedAt === null) return 'Unsaved';
  return `Saved ${p.lastSavedAt.slice(11, 16)} UTC`;
}

const CONDITIONS_SHORT: Readonly<Record<string, string>> = {
  'std-60F-14.696psia': '60 °F / 14.696 psia',
  'std-15C-101.325kPa': '15 °C / 101.325 kPa',
  'std-0C-101.325kPa': '0 °C / 101.325 kPa',
};

/** The conventions in a few words for the status bar; the full text is its tooltip. */
export function conventionsShort(c: Conventions | undefined): string {
  if (c === undefined) return 'not set';
  const parts = [
    c.standardConditions === null ? null : (CONDITIONS_SHORT[c.standardConditions] ?? c.standardConditions),
    c.energyUnit,
    c.combustionTemperature === null ? null : `combustion ${c.combustionTemperature} °C`,
    c.meteringTemperature === null ? null : `metering ${c.meteringTemperature} °C`,
    c.tonneToEnergy === null ? null : `${c.tonneToEnergy.factor} ${c.tonneToEnergy.unit}`,
  ].filter((x) => x !== null);
  return parts.length === 0 ? 'not set' : parts.join(' · ');
}

/**
 * The rule-packs for the status bar: those the check runs used (the built-in ones before any run),
 * then installed ones no run has used yet.
 */
export function rulesShort(p: ProjectSummary | null): string {
  const used = (p?.rulePacks ?? []).map((r) => `${r.id.replace(/^tracewell\./, '')} ${r.version}`);
  const names = used.length === 0 ? ['built-in'] : used;
  for (const i of p?.installedPacks ?? []) {
    const name = `${i.id} ${i.version}`;
    if (!names.includes(name)) names.push(name);
  }
  return names.join(', ');
}

/** Who signed each installed rule-pack, for the status bar's tooltip. */
export function installedPacksText(p: ProjectSummary | null): string | undefined {
  const lines = (p?.installedPacks ?? []).map(
    (i) =>
      `${i.id} ${i.version}: ${i.title}, ${i.rules} ${i.rules === 1 ? 'rule' : 'rules'}, signed by ${i.publisher} (key ${i.keyId})`,
  );
  return lines.length === 0 ? undefined : lines.join('\n');
}

export function StatusBar(p: {
  project: ProjectSummary | null;
  user: UserProfile | null;
  edition: 'lite' | 'desktop';
}): React.JSX.Element {
  const project = p.project;
  const rows = project?.datasets.reduce((n, d) => n + d.outputRowCount, 0) ?? 0;
  const assumed = project?.datasets.reduce((n, d) => n + d.assumptions, 0) ?? 0;
  return (
    <footer role="status" aria-label="Status" className="tw-statusbar">
      <span className="tw-offline">
        <span className="tw-dot-ok" aria-hidden="true" /> Offline
      </span>
      <span>{savedText(project)}</span>
      {(project?.user ?? p.user) !== null && (
        <span data-testid="tw-status-user">
          {(project?.user ?? p.user)?.name} · {(project?.user ?? p.user)?.role}
        </span>
      )}
      <span data-testid="tw-status-rules" title={installedPacksText(project)}>
        Rules {rulesShort(project)}
      </span>
      <span>Units {project?.unitSystem ?? 'SI'}</span>
      <span
        data-testid="tw-status-conventions"
        title={project === null ? undefined : (conventionsText(project.conventions) ?? undefined)}
      >
        Conventions: {conventionsShort(project?.conventions)}
      </span>
      <span>{formatCount(rows)} rows</span>
      <span>{formatCount(assumed)} assumed</span>
      <span className="tw-status-edition">{p.edition === 'lite' ? 'Lite edition' : 'Desktop edition'}</span>
    </footer>
  );
}

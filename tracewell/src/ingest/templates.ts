/**
 * Mapping templates (FR-IMP-06) against import plans. A template is saved from a dataset's
 * columns as the user left them; a later file uses it when every one of its columns is found in
 * the file by header text. Applying it overrides only what detection got differently, so a
 * template column that agrees with detection changes nothing and records nothing.
 */
import type {
  ColumnOverride,
  ColumnPlan,
  Detection,
  MappingTemplate,
  TableSchema,
  TemplateApplied,
  TemplateColumn,
} from '@tw/model';

function sameHeader(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((cell, i) => cell === b[i]);
}

/** The settings of each column read from the source; derived and geometry columns are left out. */
export function templateColumns(schema: TableSchema): TemplateColumn[] {
  return schema.columns
    .filter((c) => c.derivedFrom === undefined && c.type.value !== 'geometry')
    .map((c) => ({
      sourceHeader: [...c.sourceHeader],
      name: c.name,
      type: c.type.value,
      unit: c.unit.value,
      role: c.role.value,
      nullMarkers: [...c.nullMarkers.value],
      ...(c.dateFormat === undefined ? {} : { dateFormat: c.dateFormat.value }),
      ...(c.timezone === undefined ? {} : { timezone: c.timezone.value }),
    }));
}

/**
 * The plan column each template column applies to, in template order, or null when one is
 * missing. Repeated header text is matched in source order, so each plan column is used once.
 */
function pairs(template: MappingTemplate, plans: readonly ColumnPlan[]): [TemplateColumn, ColumnPlan][] | null {
  const used = new Set<string>();
  const out: [TemplateColumn, ColumnPlan][] = [];
  for (const t of template.columns) {
    const plan = plans.find((p) => !used.has(p.id) && sameHeader(p.sourceHeader, t.sourceHeader));
    if (plan === undefined) return null;
    used.add(plan.id);
    out.push([t, plan]);
  }
  return out;
}

/**
 * The template that fits a file's columns: every one of its columns is in the file. With several,
 * the one covering the most columns, then the most recently saved, then the first by name.
 */
export function matchTemplate(
  templates: readonly MappingTemplate[],
  plans: readonly ColumnPlan[],
): MappingTemplate | null {
  const fitting = templates.filter((t) => pairs(t, plans) !== null);
  fitting.sort(
    (a, b) =>
      b.columns.length - a.columns.length ||
      (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return fitting[0] ?? null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The overrides that make the plan read each column as the template says. */
export function applyTemplate(template: MappingTemplate, plans: readonly ColumnPlan[]): TemplateApplied | null {
  const matched = pairs(template, plans);
  if (matched === null) return null;
  const overrides: ColumnOverride[] = [];
  for (const [t, plan] of matched) {
    const o: ColumnOverride = { columnId: plan.id };
    if (t.name !== plan.name) o.name = t.name;
    if (t.type !== plan.type.value) o.type = t.type;
    if (t.unit !== plan.unit.value) o.unit = t.unit;
    if (t.role !== plan.role.value) o.role = t.role;
    if (!sameList(t.nullMarkers, plan.nullMarkers.value)) o.nullMarkers = [...t.nullMarkers];
    if (t.dateFormat !== undefined && t.dateFormat !== plan.dateFormat?.value) o.dateFormat = t.dateFormat;
    if (t.timezone !== undefined && t.timezone !== plan.timezone?.value) o.timezone = t.timezone;
    if (Object.keys(o).length > 1) overrides.push(o);
  }
  return { id: template.id, name: template.name, overrides };
}

const OVERRIDDEN: readonly (keyof Omit<ColumnOverride, 'columnId' | 'name'>)[] = [
  'type',
  'unit',
  'role',
  'nullMarkers',
  'dateFormat',
  'timezone',
];

/** Says in each overridden detection that the template set it, not the user at the keyboard. */
export function creditTemplate(plans: ColumnPlan[], applied: TemplateApplied): ColumnPlan[] {
  const evidence = `From the mapping template "${applied.name}".`;
  return plans.map((plan) => {
    const o = applied.overrides.find((x) => x.columnId === plan.id);
    if (o === undefined) return plan;
    const next: Record<string, unknown> = { ...plan };
    for (const key of OVERRIDDEN) {
      const d = next[key] as Detection<unknown> | undefined;
      if (o[key] !== undefined && d !== undefined) next[key] = { ...d, method: 'mapping-template', evidence };
    }
    return next as unknown as ColumnPlan;
  });
}

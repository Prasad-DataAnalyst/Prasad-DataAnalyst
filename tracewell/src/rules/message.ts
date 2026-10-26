/** Message templates: {column} {count} {unit} {min} {max} {detail}. Unknown placeholders stay visible. */
export function renderMessage(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

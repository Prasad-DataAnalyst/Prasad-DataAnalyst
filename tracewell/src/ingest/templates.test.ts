import { describe, expect, it } from 'vitest';
import { bytesSource } from '@tw/io';
import type { ColumnPlan, MappingTemplate, TemplateColumn } from '@tw/model';
import { applyTemplate, matchTemplate, previewSource } from './index';

async function plansOf(csv: string): Promise<ColumnPlan[]> {
  return (await previewSource(bytesSource(new TextEncoder().encode(csv), 'f.csv'))).columns;
}

function column(header: string, o: Partial<TemplateColumn> = {}): TemplateColumn {
  return { sourceHeader: [header], name: header, type: 'number', unit: null, role: 'measure', nullMarkers: [], ...o };
}

function template(name: string, columns: TemplateColumn[], savedAt = '2026-10-01T00:00:00.000Z'): MappingTemplate {
  return {
    id: `mt_${name.padEnd(12, '0').slice(0, 12)}`,
    name,
    savedFrom: { fileName: 'f.csv', format: 'csv' },
    columns,
    savedAt,
    savedBy: 'Prasad',
  };
}

const CSV = 'well,THP,THP,rate\nA,1.5,2.5,10\nB,1.25,2.75,11\n';

describe('matchTemplate', () => {
  it('needs every template column in the file, and prefers the one covering most columns, then the newest', async () => {
    const plans = await plansOf(CSV);
    const two = template('aaaa', [column('THP'), column('rate')]);
    const three = template('bbbb', [column('well', { type: 'string', role: 'id' }), column('THP'), column('rate')]);
    const newer = template('cccc', [column('THP'), column('rate')], '2026-10-02T00:00:00.000Z');
    const missing = template('dddd', [column('well'), column('THP'), column('rate'), column('choke')]);
    expect(matchTemplate([two, three, newer, missing], plans)?.name).toBe('bbbb');
    expect(matchTemplate([two, newer], plans)?.name).toBe('cccc');
    expect(matchTemplate([missing], plans)).toBeNull();
  });
});

describe('applyTemplate', () => {
  it('matches repeated header text in source order and overrides only what detection got differently', async () => {
    const plans = await plansOf(CSV);
    const t = template('thp', [
      column('THP', { name: 'THP A', unit: 'psig' }),
      column('THP', { name: 'THP B', unit: 'psig' }),
      // As detected, so it adds no override.
      column('rate', { type: 'integer' }),
    ]);
    const applied = applyTemplate(t, plans);
    expect(applied?.overrides).toEqual([
      { columnId: 'c1', name: 'THP A', unit: 'psig' },
      { columnId: 'c2', name: 'THP B', unit: 'psig' },
    ]);
    // A third THP column is not in the file.
    expect(applyTemplate(template('x', [column('THP'), column('THP'), column('THP')]), plans)).toBeNull();
  });
});

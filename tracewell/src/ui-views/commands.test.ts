import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@tw/model';
import { STAGES } from '@tw/ui-shell';
import { defaultCommands, lastRevertible } from './commands';

/** The menu items of SAD section 15 this module provides; the shell adds theme, density, shortcuts and About. */
const SAD_MENUS: Record<string, string[]> = {
  file: ['New project…', 'Open project…', 'Save project', 'Import file…', 'Export…', 'Project area…'],
  edit: ['Edit cell', 'Undo last change…'],
  view: ['Issues panel', 'Log panel', 'Jobs panel'],
  data: ['Run checks', 'Convert units…', 'Filter…', 'Columns…', 'Exclude rows…'],
  help: ['Open-source licences'],
};

describe('defaultCommands', () => {
  const commands = defaultCommands();

  it.each(Object.entries(SAD_MENUS))('covers every %s menu item of SAD section 15', (menu, labels) => {
    const present = commands.filter((c) => c.menu === menu).map((c) => c.label);
    for (const label of labels) expect(present, `${menu} › ${label}`).toContain(label);
  });

  it('gives every process stage a command', () => {
    for (const stage of STAGES)
      expect(
        commands.some((c) => c.stage === stage),
        stage,
      ).toBe(true);
  });

  it('has unique ids and the shortcuts of SAD section 15', () => {
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    const shortcuts = commands.flatMap((c) => (c.shortcut === undefined ? [] : [c.shortcut]));
    expect(shortcuts).toEqual(expect.arrayContaining(['Ctrl+O', 'Ctrl+S', 'Ctrl+I', 'Ctrl+E']));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('disables changes when no project is open or it is read-only', () => {
    const save = commands.find((c) => c.id === 'file.save');
    const base = { project: null } as unknown as Parameters<NonNullable<typeof save>['enabled']>[0];
    expect(save?.enabled(base)).toBe(false);
    const readOnly = { ...base, project: { readOnly: true, datasets: [] } } as unknown as typeof base;
    expect(save?.enabled(readOnly)).toBe(false);
  });
});

describe('lastRevertible', () => {
  const entry = (seq: number, action: AuditEntry['action'], target: AuditEntry['target'] = {}): AuditEntry =>
    ({ seq, action, target, at: '', actor: { kind: 'system', component: 'engine' }, prev: '', hash: '' }) as AuditEntry;

  it('finds the newest revertible entry that is not reverted yet', () => {
    const log = [
      entry(1, 'project.create'),
      entry(2, 'cell.edit'),
      entry(3, 'cell.edit'),
      entry(4, 'entry.revert', { seq: 3 }),
      entry(5, 'project.save'),
    ];
    expect(lastRevertible(log)?.seq).toBe(2);
    expect(lastRevertible([entry(1, 'project.create')])).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { clearCommands, getCommands, matchShortcut, registerCommands, type Command } from './commands';
import { createWorkbenchStore } from './store';

const needsProject = (s: { project: unknown }) => s.project !== null;

function cmd(id: string, shortcut?: string): Command {
  return {
    id,
    label: id,
    menu: 'file',
    ...(shortcut === undefined ? {} : { shortcut }),
    enabled: needsProject,
    run: () => undefined,
  };
}

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('command registry', () => {
  beforeEach(() => {
    clearCommands();
    registerCommands([
      cmd('file.save', 'Ctrl+S'),
      cmd('file.open', 'Ctrl+O'),
      cmd('file.import', 'Ctrl+I'),
      cmd('file.export', 'Ctrl+E'),
    ]);
  });

  it.each([
    ['s', 'file.save'],
    ['o', 'file.open'],
    ['i', 'file.import'],
    ['e', 'file.export'],
  ])('Ctrl+%s runs %s', (k, id) => {
    expect(matchShortcut(key(k, { ctrlKey: true }))?.id).toBe(id);
  });

  it('accepts Cmd in place of Ctrl on macOS', () => {
    expect(matchShortcut(key('s', { metaKey: true }))?.id).toBe('file.save');
  });

  it('matches upper-case keys from Caps Lock', () => {
    expect(matchShortcut(key('S', { ctrlKey: true }))?.id).toBe('file.save');
  });

  it('does not match without the modifier or with extra modifiers', () => {
    expect(matchShortcut(key('s'))).toBeUndefined();
    expect(matchShortcut(key('s', { ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(matchShortcut(key('s', { ctrlKey: true, altKey: true }))).toBeUndefined();
  });

  it('is disabled without a project', () => {
    const state = createWorkbenchStore().getState();
    expect(getCommands().every((c) => !c.enabled(state))).toBe(true);
  });

  it('replaces a command registered again under the same id', () => {
    registerCommands([{ ...cmd('file.save', 'Ctrl+Shift+S'), label: 'Save as' }]);
    expect(getCommands().filter((c) => c.id === 'file.save')).toHaveLength(1);
    expect(matchShortcut(key('s', { ctrlKey: true }))).toBeUndefined();
    expect(matchShortcut(key('s', { ctrlKey: true, shiftKey: true }))?.label).toBe('Save as');
  });
});

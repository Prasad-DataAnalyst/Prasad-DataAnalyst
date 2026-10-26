/**
 * One command registry shared by the menus, the process toolbar and keyboard shortcuts, so every
 * way of doing something runs the same code and is enabled under the same conditions.
 */
import type { EngineClient } from '@tw/engine-api';
import type { WorkbenchState } from './store';
import type { Stage } from './types';

export interface CommandContext {
  engine: EngineClient;
  store: WorkbenchState;
  requestReason(title: string, suggestion?: string): Promise<string | null>;
  pickFile(accept: string): Promise<File | null>;
  download(bytes: Uint8Array, fileName: string, mime: string): void;
}

export interface Command {
  id: string;
  label: string;
  menu?: 'file' | 'edit' | 'view' | 'data' | 'help';
  stage?: Stage;
  /** Written as 'Ctrl+S'; Ctrl also matches Cmd on macOS. */
  shortcut?: string;
  enabled(s: WorkbenchState): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

const registry = new Map<string, Command>();

/** Adds or replaces commands by id; the latest registration of an id wins. */
export function registerCommands(cmds: Command[]): void {
  for (const c of cmds) registry.set(c.id, c);
}

export function getCommands(): readonly Command[] {
  return [...registry.values()];
}

export function clearCommands(): void {
  registry.clear();
}

interface Chord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function parseShortcut(s: string): Chord {
  const parts = s.split('+').map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1] ?? '';
  return { key, ctrl: parts.includes('ctrl'), shift: parts.includes('shift'), alt: parts.includes('alt') };
}

export function matchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): Command | undefined {
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  for (const c of registry.values()) {
    if (c.shortcut === undefined) continue;
    const chord = parseShortcut(c.shortcut);
    if (chord.key === key && chord.ctrl === ctrl && chord.shift === e.shiftKey && chord.alt === e.altKey) return c;
  }
  return undefined;
}

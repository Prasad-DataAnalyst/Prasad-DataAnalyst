/**
 * WAI-ARIA menubar: Left/Right move between menus, Down or Enter opens one, Up/Down move through
 * its items, Enter runs an item, Escape closes. F10 focuses the bar from anywhere (AppShell).
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import type { Command } from './commands';
import type { WorkbenchState } from './store';

export const MENUS: readonly { id: NonNullable<Command['menu']>; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'data', label: 'Data' },
  { id: 'help', label: 'Help' },
];

export function MenuBar(p: {
  commands: readonly Command[];
  state: WorkbenchState;
  run(c: Command): void;
}): React.JSX.Element {
  const [open, setOpen] = useState<number | null>(null);
  const [item, setItem] = useState(0);
  const barRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const itemsOf = (i: number) => p.commands.filter((c) => c.menu === MENUS[i]?.id);
  const focusBar = (i: number) => barRefs.current[(i + MENUS.length) % MENUS.length]?.focus();
  const openMenu = (i: number, first = true) => {
    const idx = (i + MENUS.length) % MENUS.length;
    setOpen(idx);
    setItem(first ? 0 : Math.max(0, itemsOf(idx).length - 1));
    requestAnimationFrame(() => itemRefs.current[first ? 0 : itemsOf(idx).length - 1]?.focus());
  };
  const close = (refocus: number | null) => {
    setOpen(null);
    if (refocus !== null) focusBar(refocus);
  };

  const onBarKey = (i: number) => (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (open === null) focusBar(i + 1);
      else openMenu(i + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (open === null) focusBar(i - 1);
      else openMenu(i - 1);
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu(i);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(i, false);
    } else if (e.key === 'Escape') {
      close(i);
    }
  };

  const onItemKey = (i: number, items: Command[]) => (e: KeyboardEvent) => {
    const move = (to: number) => {
      const next = (to + items.length) % items.length;
      setItem(next);
      itemRefs.current[next]?.focus();
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(item + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(item - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      openMenu(i + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      openMenu(i - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(i);
    } else if (e.key === 'Tab') {
      close(null);
    }
  };

  return (
    <nav className="tw-menubar-wrap" aria-label="Main menu">
      <div role="menubar" className="tw-menubar" aria-orientation="horizontal">
        {MENUS.map((m, i) => {
          const items = itemsOf(i);
          return (
            <div key={m.id} className="tw-menu">
              <button
                ref={(el) => {
                  barRefs.current[i] = el;
                }}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open === i}
                tabIndex={i === 0 ? 0 : -1}
                className="tw-menubar-item"
                onClick={() => (open === i ? close(null) : openMenu(i))}
                onKeyDown={onBarKey(i)}
              >
                {m.label}
              </button>
              {open === i && (
                <div role="menu" aria-label={m.label} className="tw-menu-popup">
                  {items.map((c, j) => {
                    const enabled = c.enabled(p.state);
                    return (
                      <button
                        key={c.id}
                        ref={(el) => {
                          itemRefs.current[j] = el;
                        }}
                        role="menuitem"
                        tabIndex={j === item ? 0 : -1}
                        aria-disabled={!enabled}
                        className="tw-menu-item"
                        onKeyDown={onItemKey(i, items)}
                        onClick={() => {
                          if (!enabled) return;
                          close(null);
                          p.run(c);
                        }}
                      >
                        <span>{c.label}</span>
                        {c.shortcut !== undefined && <kbd>{c.shortcut}</kbd>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** Focuses the first menubar item; used for F10. */
export function focusMenuBar(root: ParentNode = document): void {
  root.querySelector<HTMLButtonElement>('[role="menubar"] [role="menuitem"]')?.focus();
}

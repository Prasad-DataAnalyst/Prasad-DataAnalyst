/**
 * ARIA tree of the project: Sources, Datasets (each with its Steps) and Exports. Up/Down move,
 * Right expands or enters a group, Left collapses or returns to the parent, Enter selects.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectSummary } from '@tw/model';
import { formatCount } from './format';
import type { Selection } from './types';

interface Node {
  id: string;
  label: string;
  level: number;
  parent: string | null;
  group: boolean;
  selection?: Selection;
  detail?: string;
}

function buildNodes(p: ProjectSummary): Node[] {
  const nodes: Node[] = [];
  nodes.push({ id: 'g:sources', label: `Sources (${p.originals.length})`, level: 1, parent: null, group: true });
  for (const o of p.originals) {
    nodes.push({
      id: `src:${o.fileId}`,
      label: o.name,
      detail: `SHA-256 ${o.fileId.slice(0, 12)}…`,
      level: 2,
      parent: 'g:sources',
      group: false,
      selection: { kind: 'source', fileId: o.fileId },
    });
  }
  nodes.push({ id: 'g:datasets', label: `Datasets (${p.datasets.length})`, level: 1, parent: null, group: true });
  for (const d of p.datasets) {
    const id = `ds:${d.id}`;
    nodes.push({
      id,
      label: d.name,
      detail: `${formatCount(d.outputRowCount)} rows`,
      level: 2,
      parent: 'g:datasets',
      group: d.steps.length > 0,
      selection: { kind: 'dataset', datasetId: d.id },
    });
    for (const s of d.steps) {
      nodes.push({
        id: `step:${d.id}:${s.id}`,
        label: stepLabel(s),
        level: 3,
        parent: id,
        group: false,
        selection: { kind: 'step', datasetId: d.id, stepId: s.id },
      });
    }
  }
  nodes.push({ id: 'g:exports', label: `Exports (${p.exports.length})`, level: 1, parent: null, group: true });
  for (const e of p.exports) {
    nodes.push({
      id: `exp:${e.exportId}`,
      label: e.packageName,
      detail: e.ok ? 'validated' : 'failed validation',
      level: 2,
      parent: 'g:exports',
      group: false,
      selection: { kind: 'export', exportId: e.exportId },
    });
  }
  return nodes;
}

function stepLabel(s: ProjectSummary['datasets'][number]['steps'][number]): string {
  switch (s.kind) {
    case 'convert_unit':
      return `Convert ${s.columnId} to ${s.toUnit}`;
    case 'filter':
      return s.label ?? 'Filter rows';
    case 'select_columns':
      return `Keep ${s.columnIds.length} columns`;
  }
}

function sameSelection(a: Selection | undefined, b: Selection): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export function ProjectTree(p: {
  project: ProjectSummary | null;
  selection: Selection;
  onSelect(s: Selection): void;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const nodes = useMemo(() => (p.project === null ? [] : buildNodes(p.project)), [p.project]);

  const visible = nodes.filter((n) => {
    for (let parent = n.parent; parent !== null; parent = nodes.find((x) => x.id === parent)?.parent ?? null) {
      if (collapsed.has(parent)) return false;
    }
    return true;
  });

  if (p.project === null) {
    return (
      <div className="tw-empty" role="note">
        No project open. Use File › New project or File › Import file to start.
      </div>
    );
  }

  const current = visible.find((n) => n.id === focusId) ?? visible[0];
  const focus = (n: Node | undefined) => {
    if (n === undefined) return;
    setFocusId(n.id);
    refs.current.get(n.id)?.focus();
  };
  const toggle = (id: string, open: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });

  const onKey = (n: Node) => (e: KeyboardEvent) => {
    const i = visible.indexOf(n);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focus(visible[i + 1]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focus(visible[i - 1]);
    } else if (e.key === 'ArrowRight' && n.group) {
      e.preventDefault();
      if (collapsed.has(n.id)) toggle(n.id, true);
      else focus(visible[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (n.group && !collapsed.has(n.id)) toggle(n.id, false);
      else focus(visible.find((x) => x.id === n.parent));
    } else if ((e.key === 'Enter' || e.key === ' ') && n.selection !== undefined) {
      e.preventDefault();
      p.onSelect(n.selection);
    }
  };

  return (
    <ul role="tree" aria-label="Project" className="tw-tree">
      {visible.map((n) => (
        <li
          key={n.id}
          ref={(el) => {
            if (el === null) refs.current.delete(n.id);
            else refs.current.set(n.id, el);
          }}
          role="treeitem"
          aria-level={n.level}
          aria-expanded={n.group ? !collapsed.has(n.id) : undefined}
          aria-selected={sameSelection(n.selection, p.selection)}
          tabIndex={n === current ? 0 : -1}
          className={`tw-tree-item tw-level-${n.level}`}
          onKeyDown={onKey(n)}
          onClick={() => {
            setFocusId(n.id);
            if (n.selection !== undefined) p.onSelect(n.selection);
            else if (n.group) toggle(n.id, collapsed.has(n.id));
          }}
        >
          <span className="tw-tree-label">{n.label}</span>
          {n.detail !== undefined && <span className="tw-tree-detail">{n.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

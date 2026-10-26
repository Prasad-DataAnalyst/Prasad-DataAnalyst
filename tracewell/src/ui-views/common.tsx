/** Small building blocks shared by the views: modal frame, badges, reason prompt, downloads. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Confidence, Detection, EngineErrorData, Severity } from '@tw/model';
import { ReasonDialog, useWorkbench } from '@tw/ui-shell';
import { TID } from './testids';

/** A native modal dialog: focus is trapped, Escape closes it, and it sits above everything else. */
export function Modal(p: {
  title: string;
  testId?: string;
  wide?: boolean;
  onClose(): void;
  children: ReactNode;
  actions?: ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d !== null && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`tw-dialog${p.wide === true ? ' tw-dialog-wide' : ''}`}
      aria-labelledby={titleId}
      data-testid={p.testId}
      onCancel={(e) => {
        e.preventDefault();
        p.onClose();
      }}
    >
      <h2 id={titleId} className="tw-dialog-title">
        {p.title}
      </h2>
      <div className="tw-dialog-body">{p.children}</div>
      {p.actions !== undefined && <div className="tw-dialog-actions">{p.actions}</div>}
    </dialog>
  );
}

export function AssumedBadge(p: { title?: string }): React.JSX.Element {
  return (
    <span
      className="tw-badge tw-badge-assumed"
      data-testid={TID.assumed}
      title={p.title ?? 'Assumed: check this value'}
    >
      assumed
    </span>
  );
}

export function ConfidenceBadge(p: { confidence: Confidence }): React.JSX.Element {
  return <span className={`tw-badge tw-conf-${p.confidence}`}>{p.confidence}</span>;
}

export function SeverityBadge(p: { severity: Severity }): React.JSX.Element {
  const label = { error: 'Error', warning: 'Warning', note: 'Note' }[p.severity];
  return (
    <span className={`tw-sev tw-sev-${p.severity}`}>
      <span className="tw-sev-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** A detection's value with its confidence, how it was found, and the assumed badge when it applies. */
export function DetectionValue(p: { d: Detection<unknown>; format?: (v: unknown) => string }): React.JSX.Element {
  const text = (p.format ?? display)(p.d.value);
  return (
    <span className="tw-detection" title={p.d.evidence}>
      <span className="tw-detection-value">{text}</span>
      {p.d.source === 'user' ? (
        <span className="tw-badge tw-badge-user">set by user</span>
      ) : (
        <ConfidenceBadge confidence={p.d.confidence} />
      )}
      {p.d.assumed && <AssumedBadge title={p.d.evidence} />}
    </span>
  );
}

export function display(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (v === '\t') return 'Tab';
  if (Array.isArray(v)) return v.length === 0 ? 'none' : v.map((x) => (x === '' ? '(empty)' : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ErrorNote(p: { error: EngineErrorData | null | undefined }): React.JSX.Element | null {
  if (p.error === null || p.error === undefined) return null;
  return (
    <div className="tw-error-note" role="alert">
      <strong>{p.error.message}</strong>
      <div>{p.error.fix}</div>
    </div>
  );
}

export function ReadOnlyBanner(): React.JSX.Element | null {
  const readOnly = useWorkbench((s) => s.project?.readOnly === true);
  if (!readOnly) return null;
  return (
    <div className="tw-readonly-banner" role="alert" data-testid={TID.readOnlyBanner}>
      <strong>Read-only project.</strong> Its integrity checks failed when it was opened, so nothing can be changed. See
      the Issues panel for what failed. To keep working, import the original files into a new project.
    </div>
  );
}

/** A reason prompt for this view: render `element`, then `await ask(title)` gives the reason or null. */
export function useReasonPrompt(): {
  element: React.JSX.Element;
  ask(title: string, suggestion?: string): Promise<string | null>;
} {
  const [req, setReq] = useState<{ title: string; suggestion?: string; resolve(r: string | null): void } | null>(null);
  const ask = useCallback(
    (title: string, suggestion?: string) =>
      new Promise<string | null>((resolve) =>
        setReq(suggestion === undefined ? { title, resolve } : { title, suggestion, resolve }),
      ),
    [],
  );
  const element = (
    <ReasonDialog
      open={req !== null}
      title={req?.title ?? ''}
      {...(req?.suggestion === undefined ? {} : { suggestion: req.suggestion })}
      onSubmit={(r) => {
        req?.resolve(r);
        setReq(null);
      }}
      onCancel={() => {
        req?.resolve(null);
        setReq(null);
      }}
    />
  );
  return { element, ask };
}

/** Offers bytes as a file download, entirely in the browser. */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function Progress(p: { done: number; total?: number; label: string }): React.JSX.Element {
  const pct = p.total === undefined || p.total === 0 ? undefined : Math.min(100, Math.round((p.done / p.total) * 100));
  return (
    <div className="tw-progress-wrap">
      <progress className="tw-progress" max={100} value={pct} aria-label={p.label} />
      <span className="tw-progress-text">{pct === undefined ? p.label : `${p.label} ${pct}%`}</span>
    </div>
  );
}

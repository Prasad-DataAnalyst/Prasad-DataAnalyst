/** Dialogs and banners shared by every view. */
import { useEffect, useId, useRef, useState } from 'react';
import { MIN_REASON_LENGTH, type EngineErrorData } from '@tw/model';

/** Counts non-space characters, the same measure the engine uses to enforce reasons. */
export function reasonLength(text: string): number {
  return text.replace(/\s/g, '').length;
}

export function ReasonDialog(p: {
  open: boolean;
  title: string;
  suggestion?: string;
  onSubmit(reason: string): void;
  onCancel(): void;
}): React.JSX.Element | null {
  const [text, setText] = useState(p.suggestion ?? '');
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const hintId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (p.open && !dialog.open) {
      setText(p.suggestion ?? '');
      dialog.showModal();
    } else if (!p.open && dialog.open) {
      dialog.close();
    }
  }, [p.open, p.suggestion]);

  if (!p.open) return null;
  const valid = reasonLength(text) >= MIN_REASON_LENGTH;
  return (
    <dialog
      ref={ref}
      className="tw-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        p.onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) p.onSubmit(text.trim());
        }}
      >
        <h2 id={titleId} className="tw-dialog-title">
          {p.title}
        </h2>
        <label className="tw-field">
          <span>Reason (recorded in the audit log)</span>
          <textarea
            autoFocus
            rows={3}
            value={text}
            aria-describedby={hintId}
            aria-invalid={!valid}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <p id={hintId} className="tw-hint">
          At least {MIN_REASON_LENGTH} characters. Everyone who reviews this project will see it.
        </p>
        <div className="tw-dialog-actions">
          <button type="button" onClick={p.onCancel}>
            Cancel
          </button>
          <button type="submit" className="tw-primary" disabled={!valid}>
            Record
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** What went wrong and how to fix it (UI-07), straight from the engine error. */
export function ErrorBanner(p: { error: EngineErrorData | null; onDismiss(): void }): React.JSX.Element | null {
  if (p.error === null) return null;
  return (
    <div className="tw-error-banner" role="alert">
      <div>
        <strong>{p.error.message}</strong>
        <div>{p.error.fix}</div>
      </div>
      <button type="button" aria-label="Dismiss message" onClick={p.onDismiss}>
        ×
      </button>
    </div>
  );
}

export const LICENCES: readonly { name: string; licence: string }[] = [
  { name: 'React', licence: 'MIT' },
  { name: 'zustand', licence: 'MIT' },
  { name: 'TanStack Virtual', licence: 'MIT' },
  { name: 'react-resizable-panels', licence: 'MIT' },
  { name: 'Lucide icons', licence: 'ISC' },
  { name: 'fflate', licence: 'MIT' },
  { name: 'saxes', licence: 'ISC' },
  { name: '@noble/hashes', licence: 'MIT' },
  { name: '@streamparser/json', licence: 'MIT' },
  { name: 'zod', licence: 'MIT' },
];

export function AboutDialog(p: {
  open: boolean;
  owner: string;
  appVersion: string;
  edition: 'lite' | 'desktop';
  onClose(): void;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (p.open && !dialog.open) dialog.showModal();
    if (!p.open && dialog.open) dialog.close();
  }, [p.open]);
  if (!p.open) return null;
  return (
    <dialog ref={ref} className="tw-dialog" aria-labelledby={titleId} onClose={p.onClose}>
      <h2 id={titleId} className="tw-dialog-title">
        About Tracewell
      </h2>
      <p>
        Tracewell Data Workbench {p.appVersion} ({p.edition === 'lite' ? 'Lite edition' : 'Desktop edition'})
      </p>
      <p>Author and owner: {p.owner}</p>
      <p>Works offline. Your data never leaves this computer.</p>
      <h3>Open-source licences</h3>
      <ul className="tw-licences">
        {LICENCES.map((l) => (
          <li key={l.name}>
            {l.name} — {l.licence}
          </li>
        ))}
      </ul>
      <div className="tw-dialog-actions">
        <button type="button" className="tw-primary" autoFocus onClick={p.onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

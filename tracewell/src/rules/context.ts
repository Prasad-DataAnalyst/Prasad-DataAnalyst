/** What a check sees: the working view plus the import's notes and assumptions. */
import type { Assumption, BBox, ImportNote, ImportNoteCode } from '@tw/model';
import type { View } from '@tw/table';

/** A reader note, or a note ingest raises itself (TW-IMP-006). */
export type RuleNote = Omit<ImportNote, 'code'> & { code: ImportNoteCode | 'TW-IMP-005' | 'TW-IMP-006' };

export interface RuleContext {
  view: View;
  importNotes: RuleNote[];
  assumptions: Assumption[];
  projectArea: BBox | null;
  signal: AbortSignal;
  onProgress(done: number, total: number): void;
}

/**
 * Recovery journals (FR-PRJ-03). Each engine session keeps one journal: its project's audit log and
 * the original files the log imports, rewritten after every change (each original only once). The
 * project can be rebuilt from them exactly as it was, because the engine's state is a replay of
 * the log over the originals. A session that ends without saving leaves its journal behind; the
 * next session finds it and offers to recover it. In the browser each session holds a lock for as
 * long as it runs, so a journal is only offered once the session that wrote it is gone: a second
 * tab never takes over the first one's work.
 */
import type { IsoUtc, OriginalFileInfo } from '@tw/model';
import type { JournalContents } from './project-io';

export interface JournalRecord extends JournalContents {
  updatedAt: IsoUtc;
}

export interface JournalStore {
  /** Writes this session's journal; `originals` are all of the project's, written once each. */
  write(record: JournalRecord): Promise<void>;
  /** The most recent journal left by a session that has ended, or null. */
  findOrphan(): Promise<JournalRecord | null>;
  /** Deletes the journal findOrphan returned last, once it is recovered or discarded. */
  dropOrphan(): Promise<void>;
}

/** Journals kept in memory, for tests: sessions share a disk and end when told to. */
export class MemoryJournalDisk {
  readonly journals = new Map<string, JournalRecord>();
  private readonly live = new Set<string>();

  store(session: string): JournalStore {
    this.live.add(session);
    let orphan: string | null = null;
    return {
      write: (record) => {
        this.journals.set(session, structuredClone(record));
        return Promise.resolve();
      },
      findOrphan: () => {
        const ended = [...this.journals].filter(([s]) => s !== session && !this.live.has(s));
        ended.sort(([, a], [, b]) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        orphan = ended[0]?.[0] ?? null;
        return Promise.resolve(orphan === null ? null : structuredClone(this.journals.get(orphan) ?? null));
      },
      dropOrphan: () => {
        if (orphan !== null) this.journals.delete(orphan);
        orphan = null;
        return Promise.resolve();
      },
    };
  }

  /** The session ends as a closed tab does: its journal stays. */
  end(session: string): void {
    this.live.delete(session);
  }
}

const ROOT = 'tracewell-recovery';
const JOURNAL = 'journal.json';
const AUDIT = 'audit.jsonl';
const ORIGINALS = 'originals';

function lockName(session: string): string {
  return `tracewell-session-${session}`;
}

interface DirectoryEntries {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
  keys(): AsyncIterable<string>;
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string | Uint8Array): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(typeof data === 'string' ? data : new Uint8Array(data));
  await w.close();
}

function isInfo(v: unknown): v is OriginalFileInfo {
  const o = v as Partial<OriginalFileInfo> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.fileId === 'string' &&
    /^[0-9a-f]{64}$/.test(o.fileId) &&
    typeof o.name === 'string' &&
    typeof o.size === 'number' &&
    typeof o.mediaType === 'string' &&
    typeof o.addedSeq === 'number'
  );
}

/** The journal in a session folder, or null when it is not a readable journal. */
async function readJournal(dir: FileSystemDirectoryHandle): Promise<JournalRecord | null> {
  try {
    const head = JSON.parse(await (await (await dir.getFileHandle(JOURNAL)).getFile()).text()) as Record<
      string,
      unknown
    >;
    const { projectId, name, updatedAt, originals } = head;
    if (
      head['format'] !== 'tracewell-journal' ||
      typeof projectId !== 'string' ||
      !/^p_[0-9a-f]{16}$/.test(projectId) ||
      typeof name !== 'string' ||
      typeof updatedAt !== 'string' ||
      !Array.isArray(originals) ||
      !originals.every(isInfo)
    ) {
      return null;
    }
    const auditJsonl = await (await (await dir.getFileHandle(AUDIT)).getFile()).text();
    const files = await dir.getDirectoryHandle(ORIGINALS);
    const read: JournalRecord['originals'] = [];
    for (const info of originals) {
      const bytes = new Uint8Array(await (await (await files.getFileHandle(info.fileId)).getFile()).arrayBuffer());
      read.push({ info, bytes });
    }
    return { projectId, name, updatedAt, auditJsonl, originals: read };
  } catch {
    return null;
  }
}

/** Whether no running session holds the lock: only then is its journal an orphan. */
async function ended(session: string): Promise<boolean> {
  return navigator.locks.request(lockName(session), { ifAvailable: true }, (lock) => lock !== null);
}

/**
 * This session's journal in the browser's origin-private file system. Without file system access
 * or the Web Locks API nothing is journalled or recovered: a journal another tab still writes
 * must never be offered.
 */
export function opfsJournalStore(session: string): JournalStore {
  const supported =
    typeof navigator !== 'undefined' && navigator.storage?.getDirectory !== undefined && navigator.locks !== undefined;
  if (supported) {
    // Held until the session ends, which is what tells the next session this journal is free.
    void navigator.locks.request(lockName(session), () => new Promise<never>(() => undefined));
  }
  const root = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
  let project: string | null = null;
  let written = new Set<string>();
  let orphan: string | null = null;
  return {
    async write(r) {
      if (!supported) return;
      const dir = await (await root()).getDirectoryHandle(session, { create: true });
      if (project !== r.projectId) {
        // Another project in this session: its journal starts afresh.
        for await (const name of (dir as unknown as DirectoryEntries).keys())
          await dir.removeEntry(name, { recursive: true });
        project = r.projectId;
        written = new Set();
      }
      const files = await dir.getDirectoryHandle(ORIGINALS, { create: true });
      for (const o of r.originals) {
        if (written.has(o.info.fileId)) continue;
        await writeFile(files, o.info.fileId, o.bytes);
        written.add(o.info.fileId);
      }
      await writeFile(dir, AUDIT, r.auditJsonl);
      // Written last: a journal is only read once its head names everything it needs.
      const head = {
        format: 'tracewell-journal',
        version: 1,
        projectId: r.projectId,
        name: r.name,
        updatedAt: r.updatedAt,
      };
      await writeFile(dir, JOURNAL, JSON.stringify({ ...head, originals: r.originals.map((o) => o.info) }));
    },
    async findOrphan() {
      orphan = null;
      if (!supported) return null;
      const dir = await root();
      let best: { name: string; record: JournalRecord } | null = null;
      for await (const [name, handle] of (dir as unknown as DirectoryEntries).entries()) {
        if (name === session || handle.kind !== 'directory' || !(await ended(name))) continue;
        const record = await readJournal(handle as FileSystemDirectoryHandle);
        if (record === null) {
          await dir.removeEntry(name, { recursive: true });
          continue;
        }
        if (best === null || record.updatedAt > best.record.updatedAt) best = { name, record };
      }
      orphan = best?.name ?? null;
      return best?.record ?? null;
    },
    async dropOrphan() {
      if (!supported || orphan === null) return;
      await (await root()).removeEntry(orphan, { recursive: true });
      orphan = null;
    },
  };
}

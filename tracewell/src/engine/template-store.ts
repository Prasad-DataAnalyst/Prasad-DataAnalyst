/**
 * Where the user's mapping templates are kept (FR-IMP-06). Templates belong to the user, not to a
 * project, so they live beside the engine rather than in a .twp: in the browser, one file in the
 * origin-private file system, which survives reloads; in tests and tools, memory. A stored entry
 * that fails validation is left out rather than trusted.
 */
import { schemas, type MappingTemplate } from '@tw/model';

export interface TemplateStore {
  load(): Promise<MappingTemplate[]>;
  save(templates: MappingTemplate[]): Promise<void>;
}

const FILE_NAME = 'tracewell-mapping-templates.json';
const FORMAT = 'tracewell-mapping-templates';

export function memoryTemplateStore(initial: readonly MappingTemplate[] = []): TemplateStore {
  let held = structuredClone([...initial]);
  return {
    load: () => Promise.resolve(structuredClone(held)),
    save: (templates) => {
      held = structuredClone(templates);
      return Promise.resolve();
    },
  };
}

/** The stored document for a list of templates. */
export function templateFile(templates: readonly MappingTemplate[]): string {
  return `${JSON.stringify({ format: FORMAT, version: 1, templates }, null, 2)}\n`;
}

/** The valid templates in a stored document; an unreadable document holds none. */
export function parseTemplateFile(text: string): MappingTemplate[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null || (doc as { format?: unknown }).format !== FORMAT) return [];
  const list = (doc as { templates?: unknown }).templates;
  if (!Array.isArray(list)) return [];
  return list.flatMap((t) => {
    const parsed = schemas.mappingTemplate.safeParse(t);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Templates in the browser's origin-private file system, or in memory where it is unavailable. */
export function opfsTemplateStore(): TemplateStore {
  const fallback = memoryTemplateStore();
  const handle = async (): Promise<FileSystemFileHandle | null> => {
    try {
      const root = await navigator.storage.getDirectory();
      return await root.getFileHandle(FILE_NAME, { create: true });
    } catch {
      return null;
    }
  };
  return {
    async load() {
      const h = await handle();
      return h === null ? fallback.load() : parseTemplateFile(await (await h.getFile()).text());
    },
    async save(templates) {
      const h = await handle();
      if (h === null) return fallback.save(templates);
      const w = await h.createWritable();
      await w.write(templateFile(templates));
      await w.close();
    },
  };
}

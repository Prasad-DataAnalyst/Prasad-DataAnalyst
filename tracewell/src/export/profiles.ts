/** Export profiles are named by destination, not format (SAD section 10.1). */
import { EngineError, type ColumnSchema, type ExportProfile, type ExportProfileId } from '@tw/model';
import profilesText from './profiles.json?raw';

const PROFILE_IDS: readonly ExportProfileId[] = ['excel', 'csv', 'parquet', 'geojson'];
const EXTENSIONS: readonly ExportProfile['dataExtension'][] = ['.xlsx', '.csv', '.parquet', '.geojson'];

function broken(message: string): EngineError {
  return new EngineError(
    'INTERNAL',
    `The export profile list is invalid: ${message}`,
    'The profile list shipped with Tracewell is damaged; reinstall Tracewell or restore the file.',
  );
}

/** The profiles, in the order the export centre shows them. The native engine reads the same file. */
export const EXPORT_PROFILES: readonly ExportProfile[] = loadProfiles(profilesText);

/** Parses the profile list, checking each profile has a known ID and every field the UI shows. */
export function loadProfiles(text: string): readonly ExportProfile[] {
  const list = (JSON.parse(text) as { profiles?: unknown }).profiles;
  if (!Array.isArray(list)) throw broken('it has no list of profiles.');
  return Object.freeze(
    list.map((p: Record<string, unknown>) => {
      const ok =
        typeof p['id'] === 'string' &&
        (PROFILE_IDS as readonly string[]).includes(p['id']) &&
        typeof p['label'] === 'string' &&
        Array.isArray(p['destinations']) &&
        p['destinations'].every((d) => typeof d === 'string') &&
        typeof p['dataExtension'] === 'string' &&
        (EXTENSIONS as readonly string[]).includes(p['dataExtension']) &&
        typeof p['description'] === 'string';
      if (!ok) throw broken(`the profile ${JSON.stringify(p['id'])} is incomplete or unknown.`);
      return Object.freeze({ ...(p as unknown as ExportProfile) });
    }),
  );
}

/** 'Pressure [kPa]', or just the name when the column has no unit. */
export function headerFor(col: Pick<ColumnSchema, 'name' | 'unit'>): string {
  const unit = col.unit.value;
  return unit === null ? col.name : `${col.name} [${unit}]`;
}

/** The inverse of headerFor: only a trailing ' [unit]' is read as the unit. */
export function parseHeader(h: string): { name: string; unit: string | null } {
  const m = /^(.*) \[([^[\]]+)\]$/s.exec(h);
  return m === null ? { name: h, unit: null } : { name: m[1] as string, unit: m[2] as string };
}

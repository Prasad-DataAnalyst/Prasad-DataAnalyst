/**
 * The local profiles of this browser or machine (FR-AUD-03): who has worked here, each with a role,
 * and who worked last. They are kept in localStorage when the browser allows it and in memory
 * otherwise (private windows, blocked storage), so Tracewell works the same either way and simply
 * asks again next time.
 */
import { ROLES, type Role, type UserProfile } from '@tw/model';

export const PROFILES_KEY = 'tracewell.profiles.v1';
/** Where Tracewell kept the one Analyst profile before roles; read once and carried over. */
export const LEGACY_PROFILE_KEY = 'tracewell.profile.v1';

interface Stored {
  profiles: UserProfile[];
  last: string | null;
}

let memory: Stored = { profiles: [], last: null };

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function valid(v: unknown): v is UserProfile {
  const p = v as Partial<UserProfile> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.id === 'string' &&
    p.id !== '' &&
    typeof p.name === 'string' &&
    p.name.trim() !== '' &&
    (ROLES as readonly unknown[]).includes(p.role)
  );
}

function read(): Stored {
  try {
    const raw = storage()?.getItem(PROFILES_KEY);
    if (raw !== null && raw !== undefined) {
      const parsed = JSON.parse(raw) as Partial<Stored>;
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.filter(valid) : [];
      return { profiles, last: typeof parsed.last === 'string' ? parsed.last : null };
    }
    const legacy = storage()?.getItem(LEGACY_PROFILE_KEY);
    if (legacy !== null && legacy !== undefined) {
      const p: unknown = JSON.parse(legacy);
      if (valid(p)) return { profiles: [p], last: p.id };
    }
  } catch {
    // Unreadable stored profiles are treated as none: the user is asked again.
  }
  return memory;
}

/** Every local profile, in the order they were first used. */
export function loadProfiles(): UserProfile[] {
  return read().profiles.map((p) => ({ ...p }));
}

/** The profile that worked last, or null on first start. */
export function lastProfile(): UserProfile | null {
  const s = read();
  return s.profiles.find((p) => p.id === s.last) ?? null;
}

/** Keeps a profile (adding it, or updating the one with its id) as the one that worked last. */
export function rememberProfile(p: UserProfile): void {
  const s = read();
  const profiles = s.profiles.some((x) => x.id === p.id)
    ? s.profiles.map((x) => (x.id === p.id ? { ...p } : x))
    : [...s.profiles, { ...p }];
  memory = { profiles, last: p.id };
  try {
    storage()?.setItem(PROFILES_KEY, JSON.stringify(memory));
  } catch {
    // Kept in memory for this session only.
  }
}

/** What each role may do, in a few words, for the profile dialogs and the mode banner. */
export const ROLE_TEXT: Readonly<Record<Role, string>> = {
  Analyst: 'imports, checks, corrects and exports data',
  Reviewer: 'reads a project, comments on issues, assigns them and signs datasets off',
  Viewer: 'reads a project',
};

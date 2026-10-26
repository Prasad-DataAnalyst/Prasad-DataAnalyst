/**
 * The analyst's profile, asked for once on first start. It is kept in localStorage when the
 * browser allows it and in memory otherwise (private windows, blocked storage), so Tracewell
 * works the same either way and simply asks again next time.
 */
import type { UserProfile } from '@tw/model';

export const PROFILE_KEY = 'tracewell.profile.v1';

let memory: UserProfile | null = null;

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
    p.role === 'Analyst'
  );
}

export function loadProfile(): UserProfile | null {
  try {
    const raw = storage()?.getItem(PROFILE_KEY);
    if (raw !== null && raw !== undefined) {
      const parsed: unknown = JSON.parse(raw);
      if (valid(parsed)) return parsed;
    }
  } catch {
    // An unreadable stored profile is treated as none: the user is asked again.
  }
  return memory;
}

export function saveProfile(p: UserProfile): void {
  memory = p;
  try {
    storage()?.setItem(PROFILE_KEY, JSON.stringify(p));
  } catch {
    // Kept in memory for this session only.
  }
}

import { describe, expect, it } from 'vitest';
import { lastProfile, loadProfiles, rememberProfile } from './profiles';

describe('local profiles', () => {
  it('keeps every profile and the last one in memory when there is no localStorage', () => {
    expect(lastProfile()).toBeNull();
    rememberProfile({ id: 'u_1', name: 'Prasad', role: 'Analyst' });
    rememberProfile({ id: 'u_2', name: 'Jane', role: 'Reviewer' });
    expect(lastProfile()).toEqual({ id: 'u_2', name: 'Jane', role: 'Reviewer' });
    rememberProfile({ id: 'u_1', name: 'Prasad K', role: 'Analyst' });
    expect(loadProfiles()).toEqual([
      { id: 'u_1', name: 'Prasad K', role: 'Analyst' },
      { id: 'u_2', name: 'Jane', role: 'Reviewer' },
    ]);
    expect(lastProfile()?.id).toBe('u_1');
  });
});

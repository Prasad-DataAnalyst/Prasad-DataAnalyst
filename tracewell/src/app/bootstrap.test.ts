import { describe, expect, it } from 'vitest';
import { checkProtocol } from './protocol';
import { loadProfile, saveProfile } from './profile';

describe('checkProtocol', () => {
  it('rejects a different major version with PROTOCOL_MISMATCH and a fix', () => {
    expect(() => checkProtocol('1.0.0', '0.1.0')).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_MISMATCH', fix: expect.any(String) }),
    );
  });

  it('accepts a minor or patch difference', () => {
    expect(() => checkProtocol('0.2.0', '0.1.0')).not.toThrow();
    expect(() => checkProtocol('0.1.7', '0.1.0')).not.toThrow();
  });

  it('rejects a version that is not semantic', () => {
    expect(() => checkProtocol('latest', '0.1.0')).toThrow(expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }));
  });
});

describe('profile storage', () => {
  it('keeps the profile in memory when there is no localStorage', () => {
    expect(loadProfile()).toBeNull();
    saveProfile({ id: 'u_1', name: 'Prasad', role: 'Analyst' });
    expect(loadProfile()).toEqual({ id: 'u_1', name: 'Prasad', role: 'Analyst' });
  });
});

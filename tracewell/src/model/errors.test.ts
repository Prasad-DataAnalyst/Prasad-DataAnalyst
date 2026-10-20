import { describe, expect, it } from 'vitest';
import { EngineError, type EngineErrorData } from './errors';

const DEFAULT_INTERNAL_FIX_START = 'Try the operation again.';

describe('EngineError', () => {
  it('carries code, message, fix and detail', () => {
    const e = new EngineError('UNIT_DIMENSION', 'kPa and m measure different things.', 'Pick a pressure unit.', {
      from: 'kPa',
      to: 'm',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('EngineError');
    expect(e.code).toBe('UNIT_DIMENSION');
    expect(e.message).toBe('kPa and m measure different things.');
    expect(e.fix).toBe('Pick a pressure unit.');
    expect(e.detail).toEqual({ from: 'kPa', to: 'm' });
  });

  it('has no detail key when none is given', () => {
    const e = new EngineError('NOT_FOUND', 'No dataset d9.', 'Choose an existing dataset.');
    expect('detail' in e).toBe(false);
    expect(Object.keys(e.toData())).toEqual(['code', 'message', 'fix']);
  });

  it('round-trips toData through structuredClone', () => {
    const e = new EngineError('REASON_REQUIRED', 'A reason is required.', 'Type at least 3 characters.', {
      field: 'reason',
      min: 3,
      nested: [null, true, 'x'],
    });
    const cloned = structuredClone(e.toData());
    expect(cloned).toEqual(e.toData());
    const revived = EngineError.from(cloned);
    expect(revived).toBeInstanceOf(EngineError);
    expect(revived.toData()).toEqual(e.toData());
  });

  it('round-trips toData through JSON', () => {
    const data = new EngineError('PARSE_FAILED', 'Line 4 is not valid CSV.', 'Check the delimiter.').toData();
    expect(EngineError.from(JSON.parse(JSON.stringify(data)) as unknown).toData()).toEqual(data);
  });
});

describe('EngineError.from', () => {
  it('returns an EngineError unchanged', () => {
    const e = new EngineError('MEMORY_BUDGET', 'Too large.', 'Close other datasets.');
    expect(EngineError.from(e)).toBe(e);
  });

  it('wraps an unknown Error as INTERNAL and keeps its fix text', () => {
    const thrown = Object.assign(new Error('disk full'), { fix: 'Free some disk space and save again.' });
    const e = EngineError.from(thrown);
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toContain('disk full');
    expect(e.fix).toBe('Free some disk space and save again.');
    expect(e.cause).toBe(thrown);
  });

  it('gives a wrapped error a generic fix when it carries none', () => {
    const thrown = new TypeError('x is undefined');
    const e = EngineError.from(thrown);
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toBe('An internal error occurred: x is undefined');
    expect(e.fix.startsWith(DEFAULT_INTERNAL_FIX_START)).toBe(true);
    expect(e.detail).toEqual({ name: 'TypeError' });
  });

  it('ignores a blank fix text', () => {
    expect(EngineError.from({ message: 'odd', fix: '  ' }).fix.startsWith(DEFAULT_INTERNAL_FIX_START)).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ['a string', 'boom', 'An internal error occurred: boom'],
    ['an empty string', '', 'An internal error occurred.'],
    ['undefined', undefined, 'An internal error occurred.'],
    ['null', null, 'An internal error occurred.'],
    ['a number', 42, 'An internal error occurred.'],
    ['an object without a message', { status: 500 }, 'An internal error occurred.'],
  ])('wraps %s as INTERNAL', (_name, thrown, message) => {
    const e = EngineError.from(thrown);
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toBe(message);
    expect(e.cause).toBe(thrown);
  });

  it('turns an AbortError into CANCELLED', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const e = EngineError.from(abort);
    expect(e.code).toBe('CANCELLED');
    expect(e.fix).not.toBe('');
    expect(e.cause).toBe(abort);
  });

  it('turns an aborted signal reason into CANCELLED', () => {
    const controller = new AbortController();
    controller.abort();
    expect(EngineError.from(controller.signal.reason).code).toBe('CANCELLED');
  });

  it('revives error data received over the protocol', () => {
    const data: EngineErrorData = { code: 'READ_ONLY_PROJECT', message: 'Read-only.', fix: 'Save a copy.' };
    const e = EngineError.from(data);
    expect(e).toBeInstanceOf(EngineError);
    expect(e.toData()).toEqual(data);
  });

  it('does not trust data with an unknown code', () => {
    const e = EngineError.from({ code: 'EVERYTHING_FINE', message: 'ok', fix: 'none' });
    expect(e.code).toBe('INTERNAL');
    expect(e.fix).toBe('none');
  });
});

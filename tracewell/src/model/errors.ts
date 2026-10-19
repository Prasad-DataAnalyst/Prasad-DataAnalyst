/**
 * Engine errors (UI-07): every failure the engine reports says what happened and how to fix it.
 * EngineError is the only error type that crosses the engine protocol; anything else is wrapped.
 */
import type { JsonValue } from './ids';
import { members } from './literals';

export type ErrorCode =
  | 'REASON_REQUIRED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'PARSE_FAILED'
  | 'FORMAT_UNSUPPORTED'
  | 'UNIT_UNKNOWN'
  | 'UNIT_DIMENSION'
  | 'UNIT_CONVENTION'
  | 'UNIT_GAUGE_ABSOLUTE'
  | 'READ_ONLY_PROJECT'
  | 'MEMORY_BUDGET'
  | 'EXPORT_REFUSED'
  | 'EXPORT_VALIDATION_FAILED'
  | 'PROJECT_INVALID'
  | 'CANCELLED'
  | 'PROTOCOL_MISMATCH'
  | 'INTERNAL';

/** The structured-clone-safe form of an EngineError, as sent over the engine protocol. */
export interface EngineErrorData {
  code: ErrorCode;
  message: string;
  fix: string;
  detail?: JsonValue;
}

const ERROR_CODES: ReadonlySet<string> = new Set(
  members<ErrorCode>()([
    'REASON_REQUIRED',
    'NOT_FOUND',
    'INVALID_INPUT',
    'PARSE_FAILED',
    'FORMAT_UNSUPPORTED',
    'UNIT_UNKNOWN',
    'UNIT_DIMENSION',
    'UNIT_CONVENTION',
    'UNIT_GAUGE_ABSOLUTE',
    'READ_ONLY_PROJECT',
    'MEMORY_BUDGET',
    'EXPORT_REFUSED',
    'EXPORT_VALIDATION_FAILED',
    'PROJECT_INVALID',
    'CANCELLED',
    'PROTOCOL_MISMATCH',
    'INTERNAL',
  ]),
);

const INTERNAL_FIX =
  'Try the operation again. If it fails again, save the project and report the steps that led to this error, ' +
  'together with the project file.';

const CANCELLED_MESSAGE = 'The operation was cancelled.';
const CANCELLED_FIX = 'Start the operation again when you are ready.';

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && ERROR_CODES.has(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Recognises EngineErrorData, including an EngineError that lost its class in a structured clone. */
function asErrorData(v: unknown): EngineErrorData | null {
  if (!isRecord(v)) return null;
  const { code, message, fix, detail } = v;
  if (!isErrorCode(code) || typeof message !== 'string' || typeof fix !== 'string') return null;
  return detail === undefined ? { code, message, fix } : { code, message, fix, detail: detail as JsonValue };
}

function isAbort(e: unknown): boolean {
  return isRecord(e) && e['name'] === 'AbortError';
}

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly fix: string;
  // Declared, not defined, so an error without detail has no `detail` key at all.
  declare readonly detail?: JsonValue;

  constructor(code: ErrorCode, message: string, fix: string, detail?: JsonValue) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.fix = fix;
    if (detail !== undefined) this.detail = detail;
  }

  toData(): EngineErrorData {
    const data: EngineErrorData = { code: this.code, message: this.message, fix: this.fix };
    if (this.detail !== undefined) data.detail = this.detail;
    return data;
  }

  /**
   * Turns anything thrown into an EngineError. EngineErrors and their data form keep their code,
   * message, fix and detail; an AbortError becomes CANCELLED; anything else becomes INTERNAL,
   * keeping a `fix` text if the thrown value carries one, and the original as `cause`.
   */
  static from(e: unknown): EngineError {
    if (e instanceof EngineError) return e;
    const data = asErrorData(e);
    if (data !== null) return new EngineError(data.code, data.message, data.fix, data.detail);
    if (isAbort(e)) return withCause(new EngineError('CANCELLED', CANCELLED_MESSAGE, CANCELLED_FIX), e);
    return withCause(internalError(e), e);
  }
}

function internalError(e: unknown): EngineError {
  if (!isRecord(e)) {
    return new EngineError('INTERNAL', internalMessage(typeof e === 'string' ? e : ''), INTERNAL_FIX);
  }
  const { message, fix, name } = e;
  const text = internalMessage(typeof message === 'string' ? message : '');
  const kept = typeof fix === 'string' && fix.trim() !== '' ? fix : INTERNAL_FIX;
  return typeof name === 'string'
    ? new EngineError('INTERNAL', text, kept, { name })
    : new EngineError('INTERNAL', text, kept);
}

function internalMessage(text: string): string {
  return text === '' ? 'An internal error occurred.' : `An internal error occurred: ${text}`;
}

function withCause(error: EngineError, cause: unknown): EngineError {
  error.cause = cause;
  return error;
}

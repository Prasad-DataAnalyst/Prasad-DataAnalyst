/**
 * Local profiles, roles and review (FR-AUD-03, FR-AUD-04, SAD decision D-18): what each role may
 * do, the refusal both engines give when it may not, and the sign-off stamps the log holds. The
 * native engine (roles.rs) has the same table, messages and rules.
 */
import type { AuditEntry } from './audit';
import { EngineError } from './errors';
import type { AuditSeq, DatasetId, IsoUtc, Role, UserProfile } from './ids';
import { members } from './literals';

export const ROLES = members<Role>()(['Analyst', 'Reviewer', 'Viewer']);

/** What a Reviewer's sign-off says: the dataset is approved, or changes are requested. */
export type SignOffStatus = 'approved' | 'changes_requested';

export const SIGN_OFF_STATUSES = members<SignOffStatus>()(['approved', 'changes_requested']);

/** The longest assignee name, in UTF-16 code units. */
export const ASSIGNEE_MAX_LENGTH = 100;

/**
 * A sign-off stamp: who signed which dataset off, when, with what statement, and the first later
 * entry that changed the dataset's data or issues (null while none has).
 */
export interface SignOff {
  seq: AuditSeq;
  at: IsoUtc;
  by: { profileId: string; name: string; role: Role };
  status: SignOffStatus;
  statement: string;
  changedSeq: AuditSeq | null;
}

/** Everything a profile can be refused, each with what it is and the roles that may do it. */
export type Operation =
  | 'create_project'
  | 'import'
  | 'check'
  | 'apply_step'
  | 'remove_step'
  | 'run_recipe'
  | 'save_recipe'
  | 'export'
  | 'install_rulepack'
  | 'save_template'
  | 'delete_template'
  | 'save'
  | 'edit_cell'
  | 'accept_issue'
  | 'exclude_rows'
  | 'comment_issue'
  | 'assign_issue'
  | 'sign_off'
  | 'override_detection'
  | 'set_project_area'
  | 'set_conventions'
  | 'revert';

export const OPERATIONS: Readonly<Record<Operation, { what: string; roles: readonly Role[] }>> = {
  create_project: { what: 'create projects', roles: ['Analyst'] },
  import: { what: 'import files', roles: ['Analyst'] },
  check: { what: 'run checks', roles: ['Analyst'] },
  apply_step: { what: 'apply steps', roles: ['Analyst'] },
  remove_step: { what: 'remove steps', roles: ['Analyst'] },
  run_recipe: { what: 'run recipes', roles: ['Analyst'] },
  save_recipe: { what: 'save recipes', roles: ['Analyst'] },
  export: { what: 'export data', roles: ['Analyst'] },
  install_rulepack: { what: 'install rule-packs', roles: ['Analyst'] },
  save_template: { what: 'save mapping templates', roles: ['Analyst'] },
  delete_template: { what: 'delete mapping templates', roles: ['Analyst'] },
  save: { what: 'save the project', roles: ['Analyst', 'Reviewer'] },
  edit_cell: { what: 'edit cells', roles: ['Analyst'] },
  accept_issue: { what: 'accept issues', roles: ['Analyst'] },
  exclude_rows: { what: 'exclude rows', roles: ['Analyst'] },
  comment_issue: { what: 'comment on issues', roles: ['Analyst', 'Reviewer'] },
  assign_issue: { what: 'assign issues', roles: ['Analyst', 'Reviewer'] },
  sign_off: { what: 'sign off datasets', roles: ['Reviewer'] },
  override_detection: { what: 'override detections', roles: ['Analyst'] },
  set_project_area: { what: 'set the project area', roles: ['Analyst'] },
  set_conventions: { what: 'set the conventions', roles: ['Analyst'] },
  revert: { what: 'revert changes', roles: ['Analyst'] },
};

function article(role: Role): string {
  return role === 'Analyst' ? 'an' : 'a';
}

/** The refusal of an operation the profile's role may not do, or null when it may. */
export function roleRefusal(profile: UserProfile, op: Operation): EngineError | null {
  const { what, roles } = OPERATIONS[op];
  if (roles.includes(profile.role)) return null;
  const first = roles[0] as Role;
  return new EngineError(
    'ROLE_NOT_ALLOWED',
    `${profile.name} is working as ${article(profile.role)} ${profile.role}, who cannot ${what}.`,
    `Switch to ${article(first)} ${roles.join(' or ')} profile to ${what}.`,
  );
}

/** A profile as the engines take it: an id, a name and a role, the name trimmed. */
export function checkedProfile(p: unknown): UserProfile {
  const o = p as Partial<UserProfile> | null | undefined;
  if (
    typeof o?.id !== 'string' ||
    o.id === '' ||
    typeof o.name !== 'string' ||
    o.name.trim() === '' ||
    !(ROLES as readonly unknown[]).includes(o.role)
  ) {
    throw new EngineError(
      'INVALID_INPUT',
      'The user profile is incomplete.',
      'Pass a profile with an id, a name and a role: Analyst, Reviewer or Viewer.',
    );
  }
  return { id: o.id, name: o.name.trim(), role: o.role as Role };
}

/** Entries that change a dataset's data or issues, and with them what a sign-off covered. */
const CHANGES = new Set<string>([
  'source.add',
  'detection.assume',
  'detection.override',
  'check.run',
  'cell.edit',
  'rows.exclude',
  'issue.accept',
  'step.apply',
  'step.remove',
  'recipe.apply',
]);

/**
 * Every dataset's sign-offs, from the log alone: a dataset.signoff entry stamps its dataset, and
 * the first later entry that changes the dataset's data or issues (a project-area change changes
 * every dataset's; a revert, its target's dataset) is recorded on each stamp it supersedes.
 */
export function signOffsOf(entries: readonly AuditEntry[]): Map<DatasetId, SignOff[]> {
  const out = new Map<DatasetId, SignOff[]>();
  const bySeq = new Map<AuditSeq, AuditEntry>();
  const touched = (e: AuditEntry): DatasetId[] | 'all' => {
    if (e.action === 'project.area') return 'all';
    if (e.action === 'entry.revert') {
      const target = e.target.seq === undefined ? undefined : bySeq.get(e.target.seq);
      return target === undefined ? [] : touched(target);
    }
    return CHANGES.has(e.action) && e.target.datasetId !== undefined ? [e.target.datasetId] : [];
  };
  for (const e of entries) {
    if (e.action === 'dataset.signoff' && e.target.datasetId !== undefined && e.actor.kind === 'user') {
      const list = out.get(e.target.datasetId) ?? [];
      list.push({
        seq: e.seq,
        at: e.at,
        by: { profileId: e.actor.profileId, name: e.actor.name, role: e.actor.role },
        status: (e.new as { status: SignOffStatus }).status,
        statement: e.reason ?? '',
        changedSeq: null,
      });
      out.set(e.target.datasetId, list);
    } else {
      const t = touched(e);
      for (const [id, list] of out) {
        if (t !== 'all' && !t.includes(id)) continue;
        for (const s of list) if (s.changedSeq === null) s.changedSeq = e.seq;
      }
    }
    bySeq.set(e.seq, e);
  }
  return out;
}

/** A sign-off in one line, as an export's README states it. */
export function signOffText(s: SignOff): string {
  const verdict = s.status === 'approved' ? 'approved' : 'changes requested';
  const since =
    s.changedSeq === null
      ? 'the dataset has not changed since'
      : `the dataset changed after it, at entry ${s.changedSeq}`;
  return `${verdict} by ${s.by.name} (${s.by.role}) at ${s.at}, entry ${s.seq}; ${since}`;
}

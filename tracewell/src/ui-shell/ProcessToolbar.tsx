/** The six process stages with their state; each button runs the stage's main command. */
import type { Command } from './commands';
import type { WorkbenchState } from './store';
import { STAGES, STAGE_LABELS, type Stage, type StageState } from './types';

const STATE_TEXT: Record<StageState, string> = {
  idle: 'not started',
  active: 'next',
  done: 'done',
  attention: 'needs attention',
};

export function ProcessToolbar(p: {
  states: Record<Stage, StageState>;
  commands: readonly Command[];
  state: WorkbenchState;
  run(c: Command): void;
  rulePackLabel: string;
}): React.JSX.Element {
  return (
    <div role="toolbar" aria-label="Process stages" className="tw-toolbar">
      {STAGES.map((stage) => {
        const command = p.commands.find((c) => c.stage === stage);
        const enabled = command !== undefined && command.enabled(p.state);
        const s = p.states[stage];
        return (
          <button
            key={stage}
            type="button"
            className={`tw-stage tw-stage-${s}`}
            data-stage={stage}
            data-state={s}
            disabled={!enabled}
            title={command?.label ?? STAGE_LABELS[stage]}
            aria-label={`${STAGE_LABELS[stage]}: ${STATE_TEXT[s]}`}
            onClick={() => command !== undefined && p.run(command)}
          >
            <span className="tw-stage-dot" aria-hidden="true" />
            {STAGE_LABELS[stage]}
          </button>
        );
      })}
      <span className="tw-toolbar-spacer" />
      <span className="tw-toolbar-note">Rules: {p.rulePackLabel}</span>
    </div>
  );
}

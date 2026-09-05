import { IllegalTransitionError } from '../errors';

/**
 * A state machine is a plain transition table: state -> allowed next states.
 * Everything that mutates a financial record's status goes through `assertTransition`
 * so an illegal move is impossible to express, not merely discouraged.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export class StateMachine<S extends string> {
  constructor(
    readonly entity: string,
    readonly table: TransitionTable<S>,
    readonly terminal: readonly S[],
  ) {}

  can(from: S, to: S): boolean {
    return (this.table[from] ?? []).includes(to);
  }

  assertTransition(from: S, to: S): void {
    if (!this.can(from, to)) {
      throw new IllegalTransitionError(this.entity, from, to);
    }
  }

  isTerminal(state: S): boolean {
    return this.terminal.includes(state);
  }

  /** Every state reachable from `from` in one step. Used by the admin UI. */
  next(from: S): readonly S[] {
    return this.table[from] ?? [];
  }
}

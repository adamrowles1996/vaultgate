/**
 * What the `sql` connector's contract tests run against (ACT-75, ACT-78): a
 * scripted `SqlSession` that records every request, answers from a script
 * and can fail, hang or echo the credential back the way a hostile database
 * would (ACT-53); plus fake `pg` and `mssql` drivers, so the real session
 * modules are covered without a database.
 */
import { ActionError } from '../actions/errors.ts';

import type {
  SqlColumn,
  SqlConnection,
  SqlRequest,
  SqlRows,
  SqlSession,
  SqlSessionFactory,
  SqlSessions,
} from '../actions/connectors/sql/session.ts';
import type { SqlRow } from '../actions/connectors/sql/values.ts';

export type Answer = SqlRows | Error | 'hang';

export interface FakeSessions {
  readonly sessions: SqlSessions;
  readonly opened: SqlConnection[];
  readonly requests: SqlRequest[];
  readonly closed: number[];
}

export function columns(...names: readonly string[]): readonly SqlColumn[] {
  return names.map((name) => ({ name, type: 'text' }));
}

export function rowsOf(names: readonly string[], rows: readonly SqlRow[]): SqlRows {
  return { columns: columns(...names), rows, rowsAffected: rows.length };
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const stop = (): void => {
      reject(new ActionError('timeout'));
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
  });
}

export interface FakeOptions {
  /**
  What each request is answered with, in order; the last answer repeats.
  */
  readonly answers?: readonly Answer[];
  /**
  Thrown instead of opening the session, so the connect-failure paths can be driven.
  */
  readonly openError?: Error;
  readonly closeError?: Error;
}

/**
One `SqlSessions` pair whose two engines share one script and one record of what happened.
*/
export function fakeSqlSessions(options: FakeOptions = {}): FakeSessions {
  const opened: SqlConnection[] = [];
  const requests: SqlRequest[] = [];
  const closed: number[] = [];
  const answers: readonly Answer[] =
    options.answers === undefined || options.answers.length === 0
      ? [rowsOf(['one'], [[1]])]
      : options.answers;
  const factory: SqlSessionFactory = (connection) => {
    if (options.openError !== undefined) {
      return Promise.reject(options.openError);
    }
    opened.push(connection);
    const session: SqlSession = {
      query(request) {
        requests.push(request);
        const answer = answers.at(Math.min(requests.length - 1, answers.length - 1)) ?? 'hang';
        if (answer === 'hang') {
          return untilAborted(connection.signal);
        }
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      close() {
        closed.push(opened.length);
        return options.closeError === undefined
          ? Promise.resolve()
          : Promise.reject(options.closeError);
      },
    };
    return Promise.resolve(session);
  };
  return { sessions: { mssql: factory, postgres: factory }, opened, requests, closed };
}

/**
The `ActionError` a session rejected with, failing the test loudly if it did anything else.
*/
export async function rejection(work: Promise<unknown>): Promise<ActionError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ActionError) {
      return error;
    }
    throw error instanceof Error ? error : new Error('expected an action error');
  }
  throw new Error('expected the session to reject');
}

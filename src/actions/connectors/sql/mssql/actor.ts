/**
 * ACT-132 on SQL Server: a write's caller tag as the session context key
 * `actor_id`, set on the transaction's connection before the statement and
 * cleared after it. Session context does not roll back, so the clear runs
 * whether the statement succeeded or not; the connection is closed with the
 * call (ACT-86) besides. Best effort: the tag is metadata, and a server that
 * refuses it never fails the write. A read is not tagged: it runs outside a
 * transaction, where the pool gives no promise that two requests share a
 * connection, so a set and a clear could land on different sessions.
 */
/**
What this needs of the driver's transaction (`session.ts` holds the whole shape).
*/
interface MssqlTransaction {
  request(): {
    input(name: string, value: unknown): void;
    query(command: string): Promise<unknown>;
  };
}

export const SET_ACTOR = "EXEC sp_set_session_context @key = N'actor_id', @value = @actor_id";
export const CLEAR_ACTOR = "EXEC sp_set_session_context @key = N'actor_id', @value = NULL";

async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    // Metadata only: a refused tag never changes the call's outcome.
  }
}

/**
Sets `actor_id` on the transaction's connection; nothing when the call has no tag.
*/
export async function setActor(
  transaction: MssqlTransaction,
  tag: string | undefined,
): Promise<void> {
  if (tag === undefined) {
    return;
  }
  await quietly(() => {
    const command = transaction.request();
    command.input('actor_id', tag);
    return command.query(SET_ACTOR);
  });
}

/**
Clears `actor_id` again, on success and on failure alike; nothing when the call had no tag.
*/
export async function clearActor(
  transaction: MssqlTransaction,
  tag: string | undefined,
): Promise<void> {
  if (tag === undefined) {
    return;
  }
  await quietly(() => transaction.request().query(CLEAR_ACTOR));
}

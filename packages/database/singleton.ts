import { db, getDb } from './index';
import { sql } from 'drizzle-orm';

/**
 * Attempt to acquire a PostgreSQL advisory lock for a named service.
 * Uses pg_try_advisory_lock (non-blocking) — returns immediately.
 *
 * Call this at the very start of a service's main() before any HTTP
 * or polling logic. If another instance of the same service is already
 * running, this returns false and the new process should exit cleanly.
 *
 * The lock is automatically released when the PostgreSQL session ends
 * (process exit or connection close).
 *
 * @param serviceName Unique name for the service (e.g. 'guernsey_live', 'fr24_live')
 * @returns true if this process acquired the lock, false if another instance holds it
 */
export async function tryAcquireServiceLock(serviceName: string): Promise<boolean> {
  try {
    // pg_try_advisory_lock(key) — non-blocking, returns boolean.
    // hashtext converts the service name to a stable integer.
    const result = await db.execute(
      sql`SELECT pg_try_advisory_lock(hashtext(${serviceName})) as locked`,
    );
    const locked = (result.rows[0] as { locked: boolean } | undefined)?.locked ?? false;
    return locked;
  } catch (err) {
    // If the query itself fails (DB unreachable), log and fail open.
    // This avoids a bootstrap deadlock: if the DB is down, the service
    // should start anyway so it can log the error and retry.
    console.error(`[singleton] Failed to acquire lock for '${serviceName}':`, err);
    return true; // fail open — let the service start
  }
}

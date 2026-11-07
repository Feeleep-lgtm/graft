import type { Pool } from "pg";
import type { ActingUser } from "../types";

/** Who a user id is, read from the users table on every call so newly seeded users are seen without a restart. */
export async function findUser(db: Pool, userId: string): Promise<ActingUser | null> {
  const { rows } = await db.query<{ id: string; role: ActingUser["role"] }>(
    "SELECT id, role FROM users WHERE id = $1",
    [userId],
  );
  return rows[0] ? { userId: rows[0].id, role: rows[0].role } : null;
}

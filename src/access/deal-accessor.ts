// The ONLY thing allowed to read deal tables.
// Scope is held by the object, not passed per call, so a caller cannot forget it.
import type { Pool, PoolClient } from "pg";
import type { ActingUser } from "../types";

export interface DealRow {
  id: number;
  title: string;
  amountCents: number | null;
  currency: string | null;
  stage: string;
  ownerUserId: string;
  threadId: number;
  sourceMessageId: number;
  createdAt: Date;
}

export interface DealWithThread extends DealRow {
  thread: { id: number; subject: string; messages: unknown[] };
}

export class DealAccessor {
  constructor(
    private db: Pool | PoolClient,
    private acting: ActingUser,
  ) {}

  // Returns the SQL fragment that scopes a deal query to this user.
  private scope(alias = "d"): { sql: string; params: unknown[] } {
    if (this.acting.role === "manager") return { sql: "TRUE", params: [] };
    return { sql: `${alias}.owner_user_id = $1`, params: [this.acting.userId] };
  }

  async list(): Promise<DealRow[]> {
    const s = this.scope();
    const { rows } = await this.db.query(
      `SELECT id, title, amount_cents, currency, stage, owner_user_id,
              thread_id, source_message_id, created_at
         FROM deals d
        WHERE ${s.sql}
        ORDER BY created_at DESC`,
      s.params,
    );
    return rows.map(toDeal);
  }

  // A rep's inbox is theirs: message bodies are returned only to the deal's owner.
  // Anyone else in scope (a manager) gets the message metadata with body = null.
  // The body is dropped in SQL, so it never leaves the database for a non-owner.
  async getById(id: number): Promise<DealWithThread | null> {
    const s = this.scope();
    const n = s.params.length;
    const { rows } = await this.db.query(
      `SELECT d.id, d.title, d.amount_cents, d.currency, d.stage, d.owner_user_id,
              d.thread_id, d.source_message_id, d.created_at,
              t.subject,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', m.id,
                    'external_id', m.external_id,
                    'sender', m.sender,
                    'to_emails', m.to_emails,
                    'cc_emails', m.cc_emails,
                    'sent_at', m.sent_at,
                    'body', CASE WHEN d.owner_user_id = $${n + 2} THEN m.body END
                  ) ORDER BY m.sent_at
                ) FILTER (WHERE m.id IS NOT NULL),
                '[]'
              ) AS messages
         FROM deals d
         JOIN threads t ON t.id = d.thread_id
         LEFT JOIN messages m ON m.thread_id = t.id
        WHERE d.id = $${n + 1} AND ${s.sql}
        GROUP BY d.id, t.id`,
      [...s.params, id, this.acting.userId],
    );
    if (!rows[0]) return null;
    return {
      ...toDeal(rows[0]),
      thread: { id: Number(rows[0].thread_id), subject: rows[0].subject, messages: rows[0].messages },
    };
  }

  /** The deal created from a thread, if this user can see it. Used by ingest, acting as the inbox owner. */
  async findIdByThreadExternalId(externalId: string): Promise<number | null> {
    const s = this.scope();
    const { rows } = await this.db.query(
      `SELECT d.id
         FROM deals d
         JOIN threads t ON t.id = d.thread_id
        WHERE t.external_id = $${s.params.length + 1} AND ${s.sql}`,
      [...s.params, externalId],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }
}

function toDeal(r: any): DealRow {
  return {
    id: Number(r.id),
    title: r.title,
    amountCents: r.amount_cents != null ? Number(r.amount_cents) : null,
    currency: r.currency,
    stage: r.stage,
    ownerUserId: r.owner_user_id,
    threadId: Number(r.thread_id),
    sourceMessageId: Number(r.source_message_id),
    createdAt: r.created_at,
  };
}

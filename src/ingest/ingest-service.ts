// Classifies, extracts, then writes the deal and its contacts.
// Model calls happen before the transaction opens, so a slow model never holds a database connection.
import type { Pool, PoolClient } from "pg";
import { DealAccessor } from "../access/deal-accessor";
import { findUser } from "../access/users";
import type { Classification, Extraction, TriageProvider } from "../triage/provider";
import type { RawThread } from "../types";

export class IngestService {
  constructor(
    private db: Pool,
    private triage: TriageProvider,
  ) {}

  async ingest(thread: RawThread) {
    // The deal belongs to the rep whose inbox the thread came from.
    const owner = await findUser(this.db, thread.inbox_owner);
    if (!owner) throw Object.assign(new Error(`Unknown inbox_owner ${thread.inbox_owner}`), { status: 422 });

    // 1. Idempotency: if every message is already known (an identical or older copy), do nothing.
    //    Ingest acts as the inbox owner, so even its own deal lookup goes through the accessor.
    const known = await this.db.query<{ message_ids: string[] }>(
      "SELECT message_ids FROM threads WHERE external_id = $1",
      [thread.id],
    );
    if (known.rows[0]) {
      const seen = new Set(known.rows[0].message_ids);
      if (thread.messages.every((m) => seen.has(m.id))) {
        const dealId = await new DealAccessor(this.db, owner).findIdByThreadExternalId(thread.id);
        return { duplicate: true, dealId };
      }
    }

    // 2. Cheap call: runs on everything.
    const classification = await this.triage.classify(thread);
    if (!classification.relevant) {
      await this.recordIrrelevant(thread, classification);
      return { relevant: false, reason: classification.reason, dealId: null };
    }

    // 3. Expensive call: only on survivors.
    const extraction = await this.triage.extract(thread, classification);

    // 4. Traceability guard: the cited message must be in this thread. Checked before anything is written.
    if (!thread.messages.some((m) => m.id === extraction.sourceMessageExternalId)) {
      throw new Error(`extraction cited unknown message ${extraction.sourceMessageExternalId}`);
    }

    // 5. Write everything in one transaction.
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const dealId = await this.writeDeal(client, thread, owner.userId, classification, extraction);
      await client.query("COMMIT");
      return { relevant: true, dealId, classification };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // Irrelevant threads keep a record (so a re-send is a no-op) but no raw mail and no messages.
  private async recordIrrelevant(thread: RawThread, classification: Classification) {
    await this.db.query(
      `INSERT INTO threads (external_id, subject, raw, is_relevant, relevance_reason, message_ids)
            VALUES ($1, $2, NULL, FALSE, $3, $4)
       ON CONFLICT (external_id) DO UPDATE
          SET subject = EXCLUDED.subject,
              relevance_reason = EXCLUDED.relevance_reason,
              message_ids = ARRAY(SELECT DISTINCT unnest(threads.message_ids || EXCLUDED.message_ids))`,
      [thread.id, thread.subject, classification.reason, thread.messages.map((m) => m.id)],
    );
  }

  private async writeDeal(
    client: PoolClient,
    thread: RawThread,
    ownerUserId: string,
    classification: Classification,
    extraction: Extraction,
  ): Promise<number> {
    // Thread: insert, or bring an existing one up to date with the newer copy.
    const threadRow = await client.query<{ id: string }>(
      `INSERT INTO threads (external_id, subject, raw, is_relevant, relevance_reason, message_ids)
            VALUES ($1, $2, $3, TRUE, $4, $5)
       ON CONFLICT (external_id) DO UPDATE
          SET subject = EXCLUDED.subject,
              raw = EXCLUDED.raw,
              is_relevant = TRUE,
              relevance_reason = EXCLUDED.relevance_reason,
              message_ids = ARRAY(SELECT DISTINCT unnest(threads.message_ids || EXCLUDED.message_ids))
         RETURNING id`,
      [thread.id, thread.subject, thread, classification.reason, thread.messages.map((m) => m.id)],
    );
    const threadRowId = Number(threadRow.rows[0]!.id);

    // Messages: only new ones are added; existing ones never change.
    for (const m of thread.messages) {
      await client.query(
        `INSERT INTO messages (thread_id, external_id, sender, to_emails, cc_emails, sent_at, body)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (thread_id, external_id) DO NOTHING`,
        [threadRowId, m.id, m.from.toLowerCase(), m.to, m.cc ?? [], m.sent_at, m.body],
      );
    }
    const source = await client.query<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1 AND external_id = $2",
      [threadRowId, extraction.sourceMessageExternalId],
    );
    const sourceMessageId = Number(source.rows[0]!.id);

    // Contacts.
    const contactRows: Array<{ id: number; role?: string }> = [];
    for (const c of extraction.contacts) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO contacts (email, name, company)
              VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE
            SET name = COALESCE(EXCLUDED.name, contacts.name),
                company = COALESCE(EXCLUDED.company, contacts.company)
           RETURNING id`,
        [c.email.toLowerCase(), c.name ?? null, c.company ?? null],
      );
      contactRows.push({ id: Number(r.rows[0]!.id), role: c.role });
    }

    // Deal: one per thread. A newer copy updates it; the owner and source message stay as first written.
    const deal = await client.query<{ id: string }>(
      `INSERT INTO deals
              (thread_id, owner_user_id, title, amount_cents, currency, stage, source_message_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (thread_id) DO UPDATE
          SET title = EXCLUDED.title,
              amount_cents = EXCLUDED.amount_cents,
              currency = EXCLUDED.currency,
              stage = EXCLUDED.stage
         RETURNING id`,
      [
        threadRowId,
        ownerUserId,
        extraction.title,
        extraction.amountCents,
        extraction.currency,
        extraction.stage,
        sourceMessageId,
      ],
    );
    const dealId = Number(deal.rows[0]!.id);

    for (const c of contactRows) {
      await client.query(
        `INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (deal_id, contact_id) DO NOTHING`,
        [dealId, c.id, c.role ?? null],
      );
    }
    return dealId;
  }
}

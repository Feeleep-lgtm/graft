CREATE TABLE users (
  id    TEXT PRIMARY KEY,
  role  TEXT NOT NULL CHECK (role IN ('rep', 'manager'))
);

CREATE TABLE threads (
  id               BIGSERIAL PRIMARY KEY,
  external_id      TEXT NOT NULL UNIQUE,              -- idempotency key
  subject          TEXT NOT NULL,
  raw              JSONB,                             -- only kept for sales-relevant threads
  is_relevant      BOOLEAN NOT NULL,
  relevance_reason TEXT NOT NULL,
  message_ids      TEXT[] NOT NULL,                   -- every message id seen; a re-send with nothing new is a no-op
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id           BIGSERIAL PRIMARY KEY,
  thread_id    BIGINT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,                         -- the message id from threads.json
  sender       TEXT NOT NULL,
  to_emails    TEXT[] NOT NULL DEFAULT '{}',
  cc_emails    TEXT[] NOT NULL DEFAULT '{}',
  sent_at      TIMESTAMPTZ NOT NULL,
  body         TEXT NOT NULL,
  UNIQUE (thread_id, external_id)
);

CREATE TABLE contacts (
  id       BIGSERIAL PRIMARY KEY,
  email    TEXT NOT NULL UNIQUE,
  name     TEXT,
  company  TEXT
);

CREATE TABLE deals (
  id                 BIGSERIAL PRIMARY KEY,
  thread_id          BIGINT NOT NULL UNIQUE REFERENCES threads(id),
  owner_user_id      TEXT NOT NULL REFERENCES users(id),
  title              TEXT NOT NULL,
  amount_cents       BIGINT,
  currency           TEXT,
  stage              TEXT NOT NULL DEFAULT 'discovery'
                     CHECK (stage IN ('discovery', 'demo', 'proposal', 'negotiation', 'closed_won', 'closed_lost')),
  source_message_id  BIGINT NOT NULL REFERENCES messages(id),  -- traceability
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deal_contacts (
  deal_id     BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id  BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role        TEXT,
  PRIMARY KEY (deal_id, contact_id)
);

CREATE INDEX deals_owner_idx ON deals(owner_user_id);

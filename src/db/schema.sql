-- Brain's persisted state. Postgres, addressed on Zerops's private network as `db:5432`.

-- The event log. Every MCP tool call appends here, and the Observatory is a read over it.
CREATE TABLE IF NOT EXISTS brain_events (
  id        BIGSERIAL   PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope     TEXT        NOT NULL DEFAULT 'default',
  kind      TEXT        NOT NULL,
  agent_id  TEXT,
  payload   JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS brain_events_scope_id_idx ON brain_events (scope, id DESC);
CREATE INDEX IF NOT EXISTS brain_events_kind_idx     ON brain_events (kind, id DESC);

-- Memories, folded from the memory_* events. Denormalised for exact/tag lookup; the
-- semantic channel lives in Qdrant and is keyed by (scope, memory_id).
CREATE TABLE IF NOT EXISTS memories (
  scope       TEXT        NOT NULL,
  memory_id   TEXT        NOT NULL,
  fact        TEXT        NOT NULL,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  agent_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  forgotten   BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (scope, memory_id)
);
CREATE INDEX IF NOT EXISTS memories_tags_idx ON memories USING GIN (tags);

--
-- Locks. One row per contended resource, and the PRIMARY KEY is what makes the
-- compare-and-swap in src/core/lock.ts possible: ON CONFLICT needs a unique constraint to
-- conflict against, and that is the entire mechanism by which Postgres -- not our code --
-- decides who wins a race between two containers.
--
CREATE TABLE IF NOT EXISTS locks (
  resource_id TEXT        NOT NULL,
  scope       TEXT        NOT NULL DEFAULT 'default',
  holder      TEXT        NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Not optional. A container that dies leaves a lock no human can reach; without an expiry
  -- the resource is wedged until someone opens a SQL shell.
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (resource_id, scope)
);
CREATE INDEX IF NOT EXISTS locks_expiry_idx ON locks (expires_at);

--
-- The credential broker's audit log.
--
-- Exactly one real secret exists in this system: the Zerops account Personal Access Token,
-- held only by the backend as an envSecret. Agents never receive it. They receive a signed,
-- scoped, short-lived ticket, and every issuance lands here.
--
-- This table is a feature, not bookkeeping: it is the difference between claiming
-- least-privilege access and being able to show it.
--
CREATE TABLE IF NOT EXISTS tickets (
  ticket_id   TEXT        PRIMARY KEY,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  agent_id    TEXT        NOT NULL,
  project_id  TEXT        NOT NULL,
  -- What this ticket was allowed to do. Scope is recorded as granted, so an audit can show
  -- what was permitted rather than only what was used.
  actions     TEXT[]      NOT NULL,
  -- Set when the broker actually performs a call on the ticket's behalf.
  used_at     TIMESTAMPTZ,
  outcome     TEXT
);
CREATE INDEX IF NOT EXISTS tickets_issued_idx ON tickets (issued_at DESC);

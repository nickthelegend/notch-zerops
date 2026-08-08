-- Brain's persisted state. Postgres, addressed on Zerops's private network as `db:5432`.
--
-- Two tables, and both are load-bearing. Earlier drafts also carried `memories` and
-- `tickets` from a memory-layer/credential-broker design that was cut once it became clear
-- ZCP already covers that ground. Dead schema is worse than no schema: it implies features
-- that do not exist and it makes a reviewer hunt for the code that writes it. Those tables
-- are gone rather than left as archaeology.

--
-- Every action Brain takes, append-only. This is the history that makes the app more than a
-- live view: without it, closing the tab loses the fact that qdrant was flagged missing
-- three days running, or that someone already provisioned Postgres into this project once.
--
-- `id` is BIGSERIAL and `ts` defaults to now() from POSTGRES, never from the Node process --
-- with several containers behind a load balancer, a caller's clock would put events in an
-- order that never happened.
--
CREATE TABLE IF NOT EXISTS brain_events (
  id        BIGSERIAL   PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  /** The Zerops project this concerns. `null` for account-level events like a session. */
  scope     TEXT,
  kind      TEXT        NOT NULL,
  /** Who or what caused it. `ui` for a human clicking; a name for anything automated. */
  actor     TEXT,
  payload   JSONB       NOT NULL DEFAULT '{}'::JSONB
);
CREATE INDEX IF NOT EXISTS brain_events_scope_id_idx ON brain_events (scope, id DESC);
CREATE INDEX IF NOT EXISTS brain_events_kind_idx     ON brain_events (kind, id DESC);

--
-- Locks. One row per contended resource.
--
-- The PRIMARY KEY is the entire mechanism: `ON CONFLICT` needs a unique constraint to
-- conflict against, and that is how Postgres -- not our code -- decides who wins a race
-- between two containers. See src/core/lock.ts.
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

# Brain

**Shared memory, multi-agent coordination, and infra judgement — native to Zerops.**

Any MCP-compatible coding agent (Claude Code, Cursor, Codex) gets three things no single
agent session has on its own:

1. **Persistent shared memory** — facts and decisions survive a session and are visible to
   every agent, not only the one that learned them.
2. **Multi-agent coordination** — a single-writer lock so two agents acting on the same
   Zerops project don't collide.
3. **Infra judgement, not just infra config** — given a plain-English requirement, Brain
   reasons about which Zerops managed services actually fit, and can provision, deploy and
   scale them for real through the Zerops REST API using one securely-held account token.

Plus **Doctor**, which audits a Zerops project and explains its own findings, and the
**Observatory**, a live dashboard so coordination can be watched rather than taken on trust.

Zerops's own agent integration, ZCP, is scoped to one project per session with no persistent
memory and no multi-agent coordination. Those two gaps are what this builds.

---

## Built for The Zerops Challenge, Aug 8–9 2026

### Prior work vs. work built during the event

The rules permit reusing code the builder already owns, provided it's clear which is which.
So it is stated plainly, and checkably:

**Prior work** — four files from a previous personal project (Notch), kept verbatim in
[`prior-art/notch/`](prior-art/) and **excluded from the build** so they can be diffed
against what replaced them:

| file | lines | what it contributed |
|---|---|---|
| `baton.ts` | 99 | the single-writer coordination protocol |
| `eventlog.ts` | 275 | the append-only event-store pattern |
| `brain.ts` | 518 | memory as folded add/update/forget events |
| `brain-index.ts` | 365 | hybrid recall (entities ∪ BM25) |

**1,257 lines of prior art. Nothing else was carried across.** Notch is a ~20,000-line
multi-agent orchestrator with six ADE adapters, a mobile app and a desktop shell; none of
that is here, because none of it is Brain.

**Built during the event** — everything under `src/`, starting with the one change that
matters most:

`prior-art/notch/baton.ts` arbitrates its lock by reading a JSON file, checking the holder,
and writing it back. On one laptop that's fine — single writer, microsecond window. On Zerops
it's a real bug: the MCP service can run several containers behind a load balancer against one
Postgres, so two agents served by two containers can both read `holder = NULL` and both write
themselves in, and *both get a success*. [`src/core/lock.ts`](src/core/lock.ts) replaces it
with a single `INSERT … ON CONFLICT DO UPDATE … WHERE`, so Postgres decides under the row lock
it already takes. It also adds a TTL, because a dead container leaves a lock no human can
delete.

---

## Status

This README will not claim a service is wired up before it is. Current state:

- [x] Repo, types, Postgres schema
- [x] `src/core/lock.ts` — atomic single-writer lock, ported and re-platformed
- [ ] Memory tools (`brain.remember` / `brain.recall`) — Postgres + Qdrant
- [ ] MCP server exposing the tool surface
- [ ] Credential broker + Zerops REST client
- [ ] Doctor
- [ ] Observatory dashboard
- [ ] **Deployed live on Zerops** — blocked, see below

### Blocked on one credential

Nothing that touches the real Zerops API can be built or verified without a **Zerops
account-level Personal Access Token** (Zerops GUI → Access Token management). That gates
provisioning, deploying, scaling, `doctor.audit`, and the live URL the rules require.

It will be held only as a Zerops `envSecret` on the backend service, never committed, never
logged in full, and never handed to an agent — agents get short-lived scoped tickets and the
broker makes the call itself.

Until that token exists, this repo will not pretend otherwise: no mocked Zerops responses, no
fake project ids, no simulated deploys.

# Brain

**Shared memory, multi-agent coordination, and infra judgement — native to Zerops.**

Any MCP-compatible coding agent (Claude Code, Cursor, Codex) gets three things no single
agent session has on its own:

1. **Persistent shared memory** — facts and decisions survive a session and are visible to
   every agent, not only the one that learned them.
2. **Multi-agent coordination** — a single-writer lock so two agents acting on the same
   Zerops project don't collide.
Plus the **Observatory**, a live dashboard so coordination can be watched rather than taken
on trust.

## Why this and not ZCP

ZCP already does the end-to-end infra work, and does it well — its own docs describe the loop
as *"the agent reads live state, chooses the app runtime and dependencies, changes the app,
deploys through Zerops, verifies real behavior, and returns proof or a blocker."* The ZCP
container ships `zcli` and a Zerops MCP server, so anything inside it can already deploy,
scale and inspect the project. **Brain does not reimplement any of that.** An earlier draft of
this README promised an `infra.provision` / `infra.deploy` / `infra.scale` tool surface; that
was a duplicate of the toggle, and it was cut.

What ZCP does not have is the layer this builds, and Zerops' own product makes the gap
concrete rather than theoretical:

**No memory.** The documented recovery from an interrupted session is *"Chat history is not
the source of truth… Read current project status and tell me where this project stands before
changing anything."* Live state tells an agent that Redis exists. It cannot tell it why Redis
and not Valkey, or that Valkey was tried and rejected — the decisions and dead ends that are
most expensive to re-derive.

**No coordination between agents.** The project-creation screen offers to install **Claude
Code, Codex, Antigravity, Grok Build and Cursor CLI** into the same ZCP container, and gives
them nothing to share memory with or to keep them off each other's work. Two agents in that
one container are strangers. Across projects it is stronger still: ZCP access is *"sealed
inside the project's own VXLAN"*, so an agent in `my-project-johnd` and one in
`my-project-janed` are on different private networks and can only meet through a GitHub pull
request — which carries a diff, not the reasoning behind it.

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

## What it does

Paste a Zerops Personal Access Token. Brain reads your account through the Zerops REST API
and draws your architecture as a live React Flow diagram — container counts, HA mode, public
ports, all from the platform. Point it at a local repo and it scans the manifests, works out
which managed services the code actually needs, and shows the gap as **ghost nodes** on the
same canvas. One button provisions them for real.

Everything it claims is checkable:

- **Container count is what Zerops reports.** A service that has never deployed renders "not
  deployed", never as one container.
- **HA is read from `mode`, never inferred.** A single-mode service running three containers
  during a deploy is not HA.
- **Edges only come from `connectedStacks`.** An `app` and a `db` in one project are not
  assumed to talk to each other.
- **Every drift finding cites its evidence** — the file and the dependency that produced it.
  A requirement inferred from an env-var name is marked low-confidence, because
  `DATABASE_URL` may point at something outside the project.

## Run it

```bash
docker run -d --name brain-pg -e POSTGRES_PASSWORD=brain -e POSTGRES_DB=brain -p 55432:5432 postgres:16
cp .env.example .env
npm install && (cd ui && npm install && npm run build)
npm run dev            # http://127.0.0.1:7799
```

Paste your token, pick a project, type a repo path, hit **Scan repo for drift**.
**Disconnect** hands the token back — it is held in memory only, and never written to disk.

## Status

| | |
|---|---|
| Zerops REST client | done — verified against a live account, 23 tests |
| Architecture graph | done — pure, 26 tests |
| Repo scan + drift | done — pure, 24 tests |
| HTTP API | done — 32 integration tests against a real server + database |
| Provisioning | done — creates real services, verified and cleaned up |
| Export `zerops.yaml` | done |
| Persisted history | done — Postgres, survives restart |
| Single-writer lock | done — guards provisioning, 20-way concurrency proven |
| Deployed on Zerops | **not done** — needs a `zcli` login, see below |

Every flow above was exercised in a browser against the real API, including the ones that
fail: a rejected token, a project that no longer exists, a path that is not on this machine,
a directory with no manifests, and a provision confirmed after the HA toggle was changed
behind its back. Notes on what that found are in [AUDIT.md](AUDIT.md).

```bash
npm test          # 156 tests; the 64 integration ones skip if Postgres is not running
npm run typecheck # src + test, and the UI has its own
```

Integration tests use their own `brain_test` database, created on demand — they never write to
the log the app reads.

### The one thing genuinely blocked

**Deploying Brain itself onto Zerops** needs a `zcli` login, which is a credential this repo
does not have. Everything else runs and is verified locally against the real Zerops API.
Nothing is mocked to paper over it.

# Prior art — code from a previous personal project, kept here for provenance

The Zerops Challenge permits reusing code the builder already owns, provided it is clear
which parts are prior work and which were built during the event. These four files are the
prior work, copied **verbatim and unmodified** from a personal project (Notch) so a judge can
diff them against what replaced them:

| file | lines | what it is | what happened to it |
|---|---|---|---|
| `baton.ts` | 99 | single-writer coordination protocol | rewritten as `src/core/lock.ts` — see below |
| `eventlog.ts` | 275 | append-only event store (node:sqlite + JSONL) | being re-platformed onto Postgres |
| `brain.ts` | 518 | memory as folded add/update/forget events | folded into Brain's memory module |
| `brain-index.ts` | 365 | hybrid recall: entities ∪ BM25 | gains a Qdrant vector channel |

**Nothing in this folder is compiled or shipped.** `tsconfig.json` excludes it. It exists so
the provenance claim is checkable rather than asserted.

## The one change worth reading

`baton.ts` arbitrates its lock with a read-modify-write over a local JSON file:

```ts
const state = readProjectState(dir);                              // read
if (state.holder && state.holder !== agentId) throw new NotHolderError(...);
state.holder = agentId;                                            // modify
writeProjectState(dir, state);                                     // write
```

One process on one laptop, that is fine — single writer, microsecond window. On Zerops it is
a genuine bug: the MCP service can run several containers behind a load balancer against one
Postgres, so two agents served by two containers can both read `holder = NULL` and both write
themselves in. Both then believe they hold the write lock, and both get a success.

`src/core/lock.ts` replaces it with a single `INSERT … ON CONFLICT DO UPDATE … WHERE`
statement, so Postgres decides under the row lock it already holds. It also adds a TTL,
because a dead container leaves a lock no human can delete.

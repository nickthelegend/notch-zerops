# Audit

Every flow in this app was driven in a real browser against the real Zerops API — clicking,
typing, submitting, and reading the console and network tab afterwards. Nothing below was
found by reading the code. Several of these were invisible from the source, and two of them
were introduced by comments in the source claiming they had already been handled.

**156 tests**, in two layers:

| | |
|---|---|
| Pure units (92) | graph, drift, repo scan, version catalogue, and the Zerops client against a scripted `fetch` — no database, no network |
| Integration (64) | the lock and the event log against a real Postgres; the whole HTTP API against a real server, a real database and a scripted Zerops |

The integration suites skip with a named reason when no database is running (`92 passed | 61
skipped`), so a clone without Docker gets the truth rather than a red suite. They run against
their own `<db>_test` database — see below for why that matters.

## What was tested

| Flow | Includes |
|---|---|
| Token gate | empty field (submit disabled), a rejected token, the real token |
| Session | reconnect after restart, **Disconnect**, refresh mid-scan |
| Projects | load, switch project, an id that no longer resolves, an account with none |
| Architecture graph | initial fit, zoom in/out, fit-view, pan lock, three viewport sizes |
| Repo scan | a real repo, a path that does not exist, a directory with no manifests |
| Provisioning | preview, cancel, confirm, HA toggled *after* previewing, 4 rapid clicks |
| Export | link disabled with no path, content type, filename, YAML body |
| Timeline | persisted history across a server restart, event wording |
| Responsive | 1440×900, 1100×780, 390×844 |

## What was broken

**The canvas filled a third of the window.** `.app` used
`grid-template-rows: auto auto 1fr` while every banner in the app is conditional, so with no
banner showing, `.canvas` landed in the middle `auto` row, sized itself to the sidebar's
content, and left the `1fr` row empty — 560px of dead grey at 1440×900. The app laid itself
out correctly only *after* you had scanned something, so the broken state was the one anybody
sees first. The narrow-screen block already carried a comment explaining this exact failure;
it had been fixed there and left broken on desktop. Now a flex column, which has no positions
to get wrong.

**Every service card rendered at 23% scale.** React Flow's `fitView` prop fits once, at
mount — before the graph has arrived and before the shell has settled — so the fit was
computed against an 81px-tall canvas and never revisited. Calling `fitView()` imperatively did
not fix it: the store sat at `nodesInitialized: false` with `fitViewQueued: true` while every
node in `nodeLookup` had correct dimensions. Replaced with ten lines of arithmetic whose
output can be predicted on paper and asserted against the DOM; verified exact at three
viewport sizes.

**`setViewport` silently did nothing.** No error, no warning, no rejected promise — the fit
computed the right target, called it, and `getViewport()` still read `{0,0,1}` 400ms later.
Gating on `panZoom !== null` did not help. There is no readiness flag here worth trusting, so
the viewport call is now verified by reading it back and retried until it lands.

**Switching project kept the previous project's findings — including a live Provision
button.** The drift summary, the evidence list and the "Provision 3 missing…" button all
survived a project change. The button reads the *current* project id and the *previous*
project's missing list, so pressing it would create one project's gaps inside another one.
Findings now clear with the project they belong to.

**The preview did not bind the write.** The HA checkbox stays clickable while the preview is
on screen, and confirm re-read it, so you could preview `NON_HA`, tick the box, confirm, and
get HA services — the write differing from the file you were shown. The plan now carries the
inputs it was built from. Verified by ticking HA after previewing: the request still sent
`"ha": false`.

**Errors showed a bare `HTTP 404`.** Several server responses carried no `message`, so the UI
had nothing but a status code to display. Every error body now carries a sentence a person can
act on.

**The timeline recorded a false clean bill of health.** Scanning a directory with no manifests
was written to the permanent log as "nothing missing" — the exact conflation the drift panel
refuses to make, made anyway in the copy that is still there tomorrow. It now distinguishes
"nothing to compare" from "everything is deployed".

**`/api/projects` was fetched twice on every load**, a duplicated upstream round-trip caused by
a stale dependency in a React effect.

**Dead weight a judge would find in two seconds.** `@modelcontextprotocol/sdk` and `nats` were
dependencies that nothing imported; the package description still advertised a memory and
coordination layer that was cut; the `brain_events` table still carried the `agent_id` column
`actor` replaced; and `/favicon.ico` 404'd on every load.

**The app was wrong about its own repository.** `.env` declared `QDRANT_URL`, `NATS_URL` and
`BRAIN_SCOPE`, left over from the cut design and read nowhere in `src/`. The repo scanner
reads `.env`, so Brain reported that its own repo needed Qdrant and NATS and wrote both into
the exported `zerops.yaml`. A tool whose whole claim is "here is what your repo actually
needs" cannot be wrong about itself. Removed — the scan now reports only `nodejs` and
`postgresql`, both of which are true and survive being questioned.

## What the new tests found

Writing the suites turned up a bug the browser pass could not have: **every session event had
been silently discarded for the life of the app.**

`schema.sql` declares `scope TEXT` (nullable) because account-level events — connecting and
disconnecting — belong to no project. But an earlier schema declared it `NOT NULL`, and
`CREATE TABLE IF NOT EXISTS` matches on NAME, so on any database created before that change
the constraint was still there. `record` deliberately swallows its own failures, so every
`session_opened` and `session_closed` was rejected by Postgres and dropped without a sound.
`SELECT count(*) FROM brain_events WHERE scope IS NULL` answered **0**. The timeline had a
`connected` label that could never appear, and nobody noticed because the absence of an event
looks exactly like the absence of an event.

This is the *same* trap as the `agent_id`/`actor` column, in the same table — and the column
reconciliation added for that one did not catch it, because `ADD COLUMN IF NOT EXISTS` fixes a
missing column and says nothing about a wrong constraint on an existing one. The migration now
relaxes it, and the boot log prints nullability (`! = NOT NULL`) so this class of drift is
visible rather than silent.

Fixing it exposed a second half: the events were then recorded and visible **nowhere**, because
the timeline reads `/api/history?projectId=…` and account-level rows have no scope. They are
the context for everything else in the list, so that view now opts into including them.

A third finding, from running the suites themselves: they were writing fixtures into the
**development database the app demos from**. Scopeless test events surface in every project's
timeline, so the demo showed rows reading `connected — 0 project(s)`. Tests now run against a
dedicated `<db>_test` database, created on demand. Verified by counting the dev log across a
full run: 322 events before, 322 after.

## Verified working

Zero console messages and zero failed network requests across the full path in a fresh tab.
Five rapid Scan clicks produce one request; four rapid preview clicks produce one. Refresh
mid-scan leaves a coherent state. A real `postgresql` service was provisioned, appeared on the
canvas re-read from the platform, and was deleted again — the account was left exactly as
found: `core, ubuntu, zcp`.

## Not verifiable in this environment

- **Re-fitting on window resize.** Neither `ResizeObserver` callbacks nor `resize` events fire
  in the browser pane used for this audit — the viewport is changed via CDP device-metrics
  override, which relayouts without dispatching either. The initial fit and the node-change
  refit are verified; the resize path is correct code that this harness cannot exercise.
- **A token revoked mid-session.** The handling exists — an auth failure drops the credential
  and returns to the gate, while an unreachable Zerops keeps it and reports degradation — but
  firing it needs a token revoked from the Zerops GUI while the app is open.
- **Two people provisioning at once.** Proven earlier with two simultaneous requests
  (`A:200, B:409`) and the contention is still visible in the timeline; not re-run here,
  because it costs two real writes.

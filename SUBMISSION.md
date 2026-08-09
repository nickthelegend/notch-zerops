# Zerops Challenge — submission

Copy-paste fields for the form. Everything here is checkable; nothing is aspirational.

---

## Project title

**Notch — it tells you what you forgot**

---

## Project description

Zerops deploys exactly what you tell it. The problem is that nobody tells it everything: your
code picks up a search engine on a Tuesday and the project it deploys into never hears about
it. The gap only shows up in production, as a connection refused.

Notch holds your repository against your live Zerops account and shows you the difference —
with the line of code that proves each one. It reads your manifests and env files, compares
them against what the project is actually running, and reports six kinds of drift:

- **Missing services.** Qdrant is required because `src/search.js` imports `@qdrant/js-client-rest`.
  Every finding cites the file and the import behind it; nothing is claimed that cannot point
  at a line.
- **Config drift.** Variables the app reads that the project does not define — the case where
  the database exists and the code still cannot reach it.
- **Committed credentials.** Only files git actually tracks, because a `.env` that git ignores
  is where it belongs. A finding is a file, a line and a kind — never the secret itself.
- **Environment diff.** Two projects held against each other, matched by service type rather
  than hostname.
- **An architecture board.** A real node canvas: drag, pan, zoom, marquee-select, add services
  by hand from the live catalogue. Click a service and everything more than one hop away dims.
- **An action log.** Every REST call Notch made to Zerops this session, with status and timing,
  and the ones that changed something marked as writes. A `POST …/search` is a read, even
  though Zerops does it with a POST.

Then it acts. `notch check` is a CI gate with real exit codes. Provisioning generates the
import file, previews it, and creates the services only after you confirm. Deployment runs the
build your repository already committed and reports the status code the live URL answers with.

**The part that is not a linter:** three agents watch a live service and argue about resizing
it. Notch puts real traffic through the deployed URL, measures p50/p95/error rate/throughput,
reads the running containers and the autoscaling policy from the API, and hands the same
numbers to three agents — one told to argue for capacity, one for cost, one for reliability.
Two of the three must agree before anything moves; a tie holds. Bounds are clamped *after* the
vote, so an agent arguing for twelve containers still gets three. Armed, it issues
`PUT /service-stack/{id}/autoscaling` and then reads the range back — because a 200 from that
endpoint means the request was well formed and nothing more.

Three Zerops behaviours cost an afternoon each and are documented in the code where they bite:
`envVariables` in a service import file is silently ignored; a runtime without its OS prefix is
rejected as "Service base not found"; and an autoscaling body one level too shallow is
accepted, runs a process to FINISHED, and applies nothing. All three return success. You only
catch them by reading the value back, which is now what Notch does everywhere it writes.

287 tests, including integration tests that make real API calls, really resize a service, pin
the silent-refusal behaviour so it cannot quietly change, and restore what they touched.

---

## Repository

https://github.com/nickthelegend/notch-zerops

---

## Live deployment on Zerops

**https://app-2de9-7799.prg1.zerops.app**

Verified: HTTP 200, serves `<title>Notch</title>` and the exact bundle that was built, a real
PAT opens a session against the live API, and a second visitor with no cookie gets
`no_session` rather than inheriting it.

**Architecture (project `notch`):** `app` (Node.js 24 runtime — the daemon, which also serves
the React web UI) → `postgresql@18` (the append-only event log) → `core`. Frontend, backend
and database, plus the Zerops API itself as the system of record.

**How to try it:** open the URL, paste a Zerops Personal Access Token. It is verified by a real
API call, held in memory keyed to your session cookie, never written to disk, never logged, and
only ever shown redacted. Then: the architecture board, drift computed from your account,
environment diff, the action log, and the scaling panel.

**What the hosted build deliberately does not do.** Scanning a repository, sweeping for
committed secrets and `zcli push` all read the filesystem of the machine Notch runs on. That is
exactly right for the desktop app pointed at your own checkout, and it is a directory-traversal
oracle on a public URL — so those endpoints answer 403 with an explanation on the hosted
instance rather than half-working. The desktop build (Electron) does the whole thing.

---

## Social post

> Zerops deploys exactly what you tell it. Nobody tells it everything.
>
> Built **Notch** for the Zerops Challenge: it holds your repo against your live account and
> shows the gap — with the line of code that proves it. Missing services, config drift,
> credentials you already committed.
>
> Then the part I actually enjoyed building: three agents watch a live service under real load
> and argue about resizing it. One argues capacity, one cost, one reliability. Two of three
> have to agree; a tie holds; the bounds clamp after the vote. Armed, it really calls Zerops —
> and then reads the value back, because 200 from that endpoint means "well formed", not
> "done".
>
> Which I learned the hard way. Three separate Zerops calls return success and change nothing:
> `envVariables` in an import file, a runtime missing its OS prefix, and an autoscaling body
> one level too shallow. No error anywhere. Notch now verifies every write.
>
> 287 tests. Live on Zerops. #ZeropsChallenge

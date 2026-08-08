# 100 ideas, ranked

Scored on **impact × feasibility × fit** — would a judge notice, can it be built for real, and
does it strengthen the pitch rather than clutter it. A pile of disconnected features hurts a
demo; the ranking matters more than the count.

The pitch these are ranked against: **Zerops deploys what you tell it. Notch tells you what you
forgot — before the PR merges, with the line of code that proves it.**

`✅` built and verified · `⏳` built this session · `—` not built (reason given at the end)

---

## Tier 1 — the demo lives or dies on these

1. `✅` Deploy the repo to a live URL, not just provision empty services
2. `✅` Runtime detection that survives the `alpine/` prefix (silently killed subdomains, secrets and wiring)
3. `✅` The deployed app can actually reach its services — `run.envVariables` wiring
4. `✅` Stream the build log live instead of freezing the UI for two minutes
5. `✅` Post-deploy health check — Notch hits the URL itself and reports the status code
6. `✅` Edges derived from the code, each labelled with the import that proves it
7. `✅` A real node canvas — React Flow, with a layout that persists per project
8. `✅` `notch check` as a CI gate with real exit codes
9. `✅` Config drift — the variable the app reads that the project does not define
10. `✅` Environment diff — two projects held against each other

## Tier 2 — strong, and cheap given what exists

11. `✅` Add a service to the board by hand, feeding the same preview
12. `✅` Lift-and-shadow while dragging, so a tile feels picked up
13. `✅` Deploy failures surfaced with the log, not a bare error
14. `—` Rollback to a previous deploy from the timeline
15. `—` Scope the CI check to the branch diff, not the whole repo
16. `—` Failed check opens a PR containing the fix
17. `—` Time-travel scrubber over the event log
18. `✅` Blast radius: click a service, highlight what depends on it
19. `✅` Secret hygiene: a real-looking secret committed to a tracked file
20. `—` Cost delta of a plan before provisioning

## Tier 3 — real value, more work

21. `—` Ephemeral preview environment per pull request
22. `—` Promotion: generate the patch that makes staging match production
23. `—` Multi-repo scan for a monorepo with several deployables
24. `—` Account-level board: every project and repo on one screen
25. `—` Persist repo↔project bindings so a scan remembers its target
26. `—` Live polling with change notifications
27. `—` Incident mode: freeze the board at a timestamp, export a report
28. `—` Whole-account export as one yaml for disaster recovery
29. `—` Agent tool loop: scan → propose → verify → refine
30. `—` Baton handoff mid-thread, Claude → Codex

## Tier 4 — polish and motion

31. `✅` Empty state on the board before the first scan that teaches the next action
32. `—` Skeleton while the graph loads rather than a blank canvas
33. `✅` Ghost tiles pulse gently so a gap reads as unfinished, not broken
34. `✅` Edge draw-on animation when a scan completes
35. `—` Count-up on the drift metrics
36. `—` Tile flip from ghost to real when a service is provisioned
37. `—` Snap-to-grid while dragging with a visible guide
38. `✅` Marquee select and move several tiles
39. `—` Minimap for large projects
40. `✅` Pinch/scroll zoom on the canvas
41. `✅` Focus mode: dim everything but one service and its neighbours
42. `—` Colour-blind-safe palette toggle
43. `✅` Reduced-motion respect for every animation
44. `—` Sound design on provision complete (off by default)
45. `—` Confetti-free success state that still feels like an event

## Tier 5 — production readiness

46. `✅` Retry with backoff on a Zerops 5xx
47. `✅` Offline detection with a banner, not a silent failure
48. `—` Request cancellation when the project changes mid-flight
49. `◐` Rate-limit handling — Retry-After is honoured; no countdown
50. `—` A daemon health indicator in the title bar
51. `—` Structured log file for the daemon
52. `—` Crash reporter that writes the last 100 events
53. `—` Migration rollback safety
54. `—` Database connection pool metrics
55. `—` Graceful shutdown that finishes in-flight provisions

## Tier 6 — deeper Zerops integration

56. `—` Read and show build pipeline stages live from the API
57. `—` Service logs tailed into the app
58. `—` Container count autoscaling settings surfaced and editable
59. `—` Custom domain attach flow
60. `—` Zerops backup schedule visibility
61. `—` Cron/scheduled job services
62. `—` Shared storage services
63. `—` Project-level env editing
64. `—` Service restart / stop / start controls
65. `—` VPN / private network visualisation

## Tier 7 — agent depth

66. `—` Three agents answer the same question side by side
67. `—` Agent explains a failed CI check inside the PR
68. `—` Agent-authored PR description
69. `—` Agent proposes the `run.envVariables` block
70. `—` Agent reviews the exported yaml before you commit it
71. `—` Agent watches the timeline and flags anomalies
72. `—` Cost-aware agent: "this proposal adds roughly X"
73. `—` Agent memory across sessions, scoped per project
74. `—` MCP server so external agents can call Notch's tools
75. `—` ZCP integration for inside-the-project reach

## Tier 8 — collaboration

76. `—` Ownership from the actor field on every event
77. `—` Shared team timeline
78. `—` Comment on a drift finding
79. `—` Assign a gap to a person
80. `—` Slack/Discord notification on new drift
81. `—` Weekly digest issue
82. `—` Audit export for compliance
83. `—` Read-only share link for a board
84. `—` Multi-account switching
85. `—` SSO-friendly token handling

## Tier 9 — the long tail

86. `—` Dockerfile detection and import
87. `—` docker-compose translation to zerops.yaml
88. `—` Terraform export
89. `—` Kubernetes manifest comparison
90. `—` Language servers beyond Node (Python/Go/Rust deep scan)
91. `—` Framework detection (Next, Nest, Django) with tailored build config
92. `—` Lockfile-based version pinning for services
93. `—` Dependency vulnerability cross-reference
94. `—` License scan of provisioned services
95. `—` Architecture decision record generation
96. `—` Diagram export to SVG/PNG for docs
97. `✅` Mermaid export of the architecture
98. `—` Public status page generated from the board
99. `—` Onboarding tour on first run
100. `—` Plugin API for custom scanners

---

## Why most of these are not built

**Not time.** Most of tiers 5–9 are deliberately unbuilt because a hackathon demo is judged on
one coherent story told well, and forty half-features tell no story. Numbers 86–100 in
particular would each be a project.

**Actively harmful to the pitch:** 44 (sound), 45 (celebration), 39 (minimap on a six-service
board) — they add motion to a tool whose credibility rests on restraint. 39 was briefly built
and then cut: on this board it was a smudge of three rectangles, and it sat exactly where the
primary action belongs.

**Honest downgrade:** 32 was previously marked built. It is not — the board shows a sentence
while the graph loads, which is a message, not a skeleton.

**Blocked:** 75 (ZCP) needs a project-scoped credential this repo does not have. 59 (custom
domain) needs a domain. 20/72 (cost) need pricing data the API does not expose — a guessed
number is worse than none.

**Redundant:** 69 overlaps 3, which is already built and verified.

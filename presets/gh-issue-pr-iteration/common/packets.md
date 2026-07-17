# Fragment: common/packets

## Purpose

The eight normal phases hand off through durable GitHub packets, never through local worktree state, stdout, or handoff files alone. This fragment pins the packet shapes and the revision-join rule every consumer applies. The ExecutableContract marker itself is specified by `common/executable-contract.md`; the five packets below are the downstream chain — CandidateRef (iteration), VerificationPacket (verification), DiffAuditReport (diff-audit), VerificationAuditReport (verification-audit), ReviewVerdict (review).

Every packet lives on GitHub (PR body/comment or issue comment), references the upstream packet it consumed by URL **and** revision, and binds to an immutable identity (SHA / digest / comment URL). A packet is never edited to change a past conclusion — later phases write new packets and let live structural identity retire stale ones. Display-level minimization of your **own** superseded packet comment (per `common/github-routing.md`, PR-thread comment legibility) is the sanctioned retirement mechanism: the content stays intact and readable; only its display collapses.

## CandidateRef — written by iteration

Iteration must finish by making exactly one candidate durable and describing it in a fenced ` ```json ` block labeled `coder-loop:candidate-ref`, placed in the draft PR body (implementation routes) or an issue comment (no-PR routes). The **current** CandidateRef always lives in the PR body: retries refresh the body block in place to the new head (per-round history stays in the iteration evidence comments):

```json
{
  "kind": "implementation-pr",
  "pr": 123,
  "branch": "fix/issue-45-example",
  "headSha": "<40-hex sha of the pushed head>"
}
```

The `kind` field selects the delivery variant; the other fields are variant-specific:

| kind | fields | durable object |
|---|---|---|
| `implementation-pr` | `pr`, `branch`, `headSha` | pushed branch + draft PR |
| `source-writing` | `ref`, `sourceSha`, `artifactUrl` | pushed spike source + its artifact |
| `comment-delivery` | `commentUrl`, `contentDigest` | posted comment (digest = sha256 of the body) |
| `no-change` | `baseSha`, `proofCommentUrl` | proof comment that base already satisfies the issue |

Verification verifies the immutable revision the packet names — never "whatever the working tree currently contains".

## VerificationPacket — written by verification

Verification posts its result to the CandidateRef's PR thread (or the issue thread on no-PR routes) as a comment containing a fenced ` ```json ` block labeled `coder-loop:verification-packet`:

```json
{
  "candidate": { "kind": "implementation-pr", "pr": 123, "branch": "…", "headSha": "…" },
  "contractMarkerUrl": "<url of the current executable-contract marker comment>",
  "checks": [
    {
      "id": "<stable check id from the marker>",
      "commandOrDriver": "<exact command or runtime driver>",
      "cwd": "<where it ran>",
      "exitCode": 0,
      "observation": "<what was actually observed>",
      "artifactRefs": ["<evidence paths/URLs>"]
    }
  ],
  "runtime": {
    "kind": "durable | recreatable",
    "setup": "<how the runtime was brought up (recreatable)>",
    "readiness": "<how readiness was confirmed>",
    "behavior": "<the observed end-to-end behavior>",
    "cleanup": "<what was torn down / left running and why>"
  },
  "conclusion": "verified | changes-requested | contract-invalid"
}
```

Every `checks[]` row binds to the candidate identity (`candidate.headSha` / digest). `observation` is one to three lines — what was observed, never a transcript; detail lives in `artifactRefs`. The packet is review's **input**, not an engine certificate: review must re-check the bound identity, the check coverage against the marker, and live GitHub checks — it does not re-run the full E2E.

## DiffAuditReport — written by diff-audit

diff-audit runs as a fresh phase after publish; it never shares a session with review. It posts its result to the CandidateRef's PR thread as a comment containing a fenced ` ```json ` block labeled `coder-loop:diff-audit-report` followed by the full audit markdown:

```json
{
  "candidate": { "kind": "implementation-pr", "pr": 123, "branch": "…", "headSha": "…" },
  "contractMarkerUrl": "<url of the current executable-contract marker comment>",
  "publicationRevision": "<PR head SHA at the moment of the audit>",
  "route": "implementation-pr | source-writing | comment-delivery | no-change",
  "verdict": "clean | changes-requested | contract-invalid",
  "reportUrl": "<url of this comment, back-filled after post>"
}
```

The comment body contains the full audit report — scope mapping (every changed file classified `in-scope | support | unmapped`), hygiene findings, test changes in the diff, issue-named pattern coverage, anchored code findings against the issue's stated design, root-cause mechanisms with provenance and class sweep, out-of-scope roots (routing input, not verdict input), change footprint, problems. The report shape is fixed and review is not allowed to demand a different one; review reads this report, it does not re-audit the diff.

no-PR routes (`comment-delivery`, `no-change`, and any `source-writing` where a PR would be a contract violation) short-circuit: diff-audit posts a minimal report to the issue thread stating the route + why a PR audit does not apply + verdict `clean`. A PR that exists on a route where none should → verdict `contract-invalid` with the offending PR URL and route mismatch.

diff-audit failure paths: findings that route to fix → verdict `changes-requested` (the audit report is the retry evidence); contract-scope-conflict / unknown marker Pattern scope / route contradiction → verdict `contract-invalid`. Otherwise `clean`. The report is durable regardless of verdict — review reads it either way.

## VerificationAuditReport — written by verification-audit

verification-audit runs as a fresh phase after diff-audit; it never shares a session with review. It posts its result to the CandidateRef's PR thread as a comment containing a fenced ` ```json ` block labeled `coder-loop:verification-audit-report` followed by the full audit markdown:

```json
{
  "candidate": { "kind": "implementation-pr", "pr": 123, "branch": "…", "headSha": "…" },
  "contractMarkerUrl": "<url of the current executable-contract marker comment>",
  "verificationPacketUrl": "<url of the VerificationPacket comment this audit consumed>",
  "identityBinding": "bound | mismatch",
  "coverageStatus": "complete | gaps",
  "verdict": "clean | verification-drift | changes-requested | contract-invalid",
  "reportUrl": "<url of this comment, back-filled after post>"
}
```

The comment body contains the full audit — identity binding table (CandidateRef ↔ packet.candidate ↔ live head SHAs side by side), marker Check coverage table (every marker stable-ID present in packet.checks with observed command, cwd, exit, observation quality), artifact resolution (each `artifactRefs` entry: resolves? content matches claim?), live checks vs verified head, runtime record consistency, targeted spot re-execution (only when steps 4–6 raised doubt on a cheap row), findings.

verification-audit does not re-run the full canonical suite or the full E2E — the verification phase already executed both independently. It audits packet truth. A doubt not settleable by one cheap spot re-run is reported as an unsettled doubt with evidence, not silently escalated into re-verification.

Route-based verdict:

| finding | verdict | routes back to |
|---|---|---|
| identity mismatch (packet certifies a SHA ≠ live head), coverage gap on a marker Check row, artifact contradiction, internal-contradiction (failing row under `verified`), live CI failing on verified SHA | `verification-drift` | verification (re-execute against the current candidate) |
| the candidate itself is wrong (packet cannot pass because the code doesn't work), or the deliverable route is wrong | `changes-requested` | iteration (new candidate) |
| a marker Check is malformed / unexecutable as written | `contract-invalid` | contract-enrichment |
| all rows covered, identities bound, live CI green, runtime coherent | `clean` | review |

For marker `Deliverable = blocker-removal` the named blocked-path check row's coverage in the packet is mandatory; its absence is `verification-drift`, not `changes-requested`, unless the candidate itself does not attempt the blocked path.

no-PR routes: `comment-delivery` and `no-change` have no VerificationPacket in the usual shape (spike routes may have a minimal packet). Audit rows adapt but the report shape is fixed; verdict `clean` when the route's packet requirements are met, otherwise the matching route-back verdict.

## ReviewVerdict — written by review

Review posts a durable verdict comment on the PR thread (or issue thread) containing a fenced ` ```json ` block labeled `coder-loop:review-verdict`:

```json
{ "kind": "accepted-pr", "candidate": { "…": "…" }, "verificationPacketUrl": "<url>" }
```

| kind | extra fields | scheduler exit review takes |
|---|---|---|
| `accepted-pr` | `candidate`, `verificationPacketUrl` | clean exit → closure |
| `accepted-no-pr` | `candidate`, `verificationPacketUrl` | clean exit → closure |
| `moot` | `reason`, `proofUrl` | clean exit → closure |
| `changes-requested` | `feedbackUrl` | retry status exit → iteration |
| `contract-invalid` | `evidenceUrl` | contract-invalid status exit → contract-enrichment |
| `blocked` | `blockerUrl` | blocked terminal exit |
| `expanded-parent` | `childIssues`, `graphEvidenceUrl` | parent stays continuable (retry status), children first |

Closure never guesses the verdict from local summaries — it reads the durable ReviewVerdict, re-reads every live identity the verdict references, and only then performs the irreversible effect.

## CurrentState index — the O(1) entry point

Thread scanning does not scale: every consumer needs either **the latest of each kind** (verification, diff-audit, publish, closure) or **the full history of each kind** (iteration retry, review's cross-round regression check), and both are impossible to obtain by enumerating a long PR thread without dragging the whole superseded body into context. The PR body therefore carries exactly one fenced ` ```json ` block labeled `coder-loop:current-state`, kept directly under the CandidateRef block. Every per-round packet URL is an **append-only array** — oldest first, newest last — so the index doubles as the cross-round history without a second scan pass:

```json
{
  "round": 13,
  "contractMarkerUrl": "<issue-comment url of the unique current marker>",
  "iterationEvidenceUrls": ["<oldest delta comment url>", "…", "<latest delta comment url>"],
  "verificationPacketUrls": ["<oldest packet comment url>", "…", "<latest packet comment url>"],
  "diffAuditReportUrls": ["<oldest report comment url>", "…", "<latest report comment url>"],
  "verificationAuditReportUrls": ["<oldest report comment url>", "…", "<latest report comment url>"],
  "reviewVerdictUrls": ["<oldest verdict comment url>", "…", "<latest verdict comment url>"],
  "updatedBy": "<phase>@<run id>"
}
```

- **Locator, not a packet.** The index carries no evidence and no conclusions; it points to the durable comment URLs that do. Appending a new URL is required maintenance, not a history rewrite — the immutability rule binds packets themselves (never edited), never the index (append-only pointer list). Empty array = no packet of that kind has been posted yet (fresh PR before verification / audits / review); missing key = legacy PR predating this index shape (see Bootstrap).
- **Writers append, never replace.** The phase that durably posts a packet updates its own array in the same run, after the comment URL resolves, by appending the new URL to the end. Order is round-order (oldest at index 0, newest at index `length-1`); an insert or reorder is a protocol violation. Writers per array:
  - iteration → `round`+1, append to `iterationEvidenceUrls`, refresh `contractMarkerUrl` (from the marker it consumed), refresh the body CandidateRef block.
  - verification → append to `verificationPacketUrls`.
  - diff-audit → append to `diffAuditReportUrls`.
  - verification-audit → append to `verificationAuditReportUrls`.
  - review → append to `reviewVerdictUrls` (both accepted verdicts and retry verdicts append; every verdict is durable feedback the next iteration must consider).
  - publish preserves the CandidateRef and current-state blocks verbatim when reassembling the body — it neither appends nor edits any array.
- **Readers pick history or head.** Consumers resolve the index and fetch only the objects it names — enumerating all PR comments to discover "the latest X" or "all X" is a protocol violation once an index exists.
  - **Head-only readers** (need the round's current object): verification → `verificationPacketUrls[length-1]` on retry only; publish → `verificationPacketUrls[length-1]`; diff-audit → the round's PR + CandidateRef; verification-audit → `verificationPacketUrls[length-1]`; closure → `reviewVerdictUrls[length-1]`.
  - **Full-history readers** (need cross-round accumulation): iteration retry → every URL in `reviewVerdictUrls`, `diffAuditReportUrls`, `verificationAuditReportUrls`; review → every URL in the same three arrays (its cross-round regression judgment reads the full history, not just the latest).
- **Bootstrap and repair.** Index absent (legacy PR), unparsable, missing an array key (older shape), or any revision join failing against what an array element points at → do **one** full-thread scan to locate every historical packet of every kind (all durable packet comments are recognizable by their fenced ` ```json ` labels: `coder-loop:iteration-evidence` — the delta comment marker if present, otherwise fall back to timestamp order over the writer's own comments — `coder-loop:verification-packet`, `coder-loop:diff-audit-report`, `coder-loop:verification-audit-report`, `coder-loop:review-verdict`). Sort each by comment `createdAt` ascending to reconstruct round order, write/repair the index, then proceed. The index is never trusted blindly: revision joins still verify live identities — the index replaces discovery, not verification.

## Revision join — how consumers trust input

A phase does not trust its input because "the previous phase ran". It re-joins identities and routes backwards on mismatch:

| consumer | identities that must match | on mismatch |
|---|---|---|
| iteration | current contract source revision vs latest operator correction | `contract_invalid` exit |
| verification | CandidateRef SHA/digest vs remote object's live revision | retry exit to iteration, or `contract_invalid` |
| publish | VerificationPacket.candidate vs CandidateRef vs live head | retry exit to iteration; never mark an unverified revision ready |
| diff-audit | CandidateRef + contract marker + publication head; ready-state | `changes-requested` (unmapped files, code findings, test-integrity, hygiene) / `contract-invalid` (route mismatch, unknown Pattern scope) |
| verification-audit | CandidateRef ≡ VerificationPacket.candidate ≡ live head; marker Check coverage; artifacts; live CI | `verification-drift` (packet issues) / `changes-requested` (candidate wrong) / `contract-invalid` (marker malformed) |
| review | contract marker + CandidateRef + VerificationPacket + DiffAuditReport + VerificationAuditReport + publication live revision | the exit matching the missing/stale layer |
| closure | ReviewVerdict's referenced contract/candidate/verification/publication vs live GitHub state | the matching drift status; no merge/close on drift |

External facts become durable **before** scheduling transitions: push/comment/update the PR first, then write the status exit or clean-exit. The SQLite status only routes the item back to the correct node; it never carries the packet content.

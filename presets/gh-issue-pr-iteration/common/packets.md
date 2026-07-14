# Fragment: common/packets

## Purpose

The six normal phases hand off through durable GitHub packets, never through local worktree state, stdout, or handoff files alone. This fragment pins the packet shapes and the revision-join rule every consumer applies. The ExecutableContract marker itself is specified by `common/executable-contract.md`; the three packets below are the downstream chain.

Every packet lives on GitHub (PR body/comment or issue comment), references the upstream packet it consumed by URL **and** revision, and binds to an immutable identity (SHA / digest / comment URL). A packet is never edited to change a past conclusion — later phases write new packets and let live structural identity retire stale ones.

## CandidateRef — written by iteration

Iteration must finish by making exactly one candidate durable and describing it in a fenced ` ```json ` block labeled `coder-loop:candidate-ref`, placed in the draft PR body (implementation routes) or an issue comment (no-PR routes):

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

Every `checks[]` row binds to the candidate identity (`candidate.headSha` / digest). The packet is review's **input**, not an engine certificate: review must re-check the bound identity, the check coverage against the marker, and live GitHub checks — it does not re-run the full E2E.

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

## Revision join — how consumers trust input

A phase does not trust its input because "the previous phase ran". It re-joins identities and routes backwards on mismatch:

| consumer | identities that must match | on mismatch |
|---|---|---|
| iteration | current contract source revision vs latest operator correction | `contract_invalid` exit |
| verification | CandidateRef SHA/digest vs remote object's live revision | retry exit to iteration, or `contract_invalid` |
| publish | VerificationPacket.candidate vs CandidateRef vs live head | retry exit to iteration; never mark an unverified revision ready |
| review | contract marker + CandidateRef + VerificationPacket + publication live revision | the exit matching the missing/stale layer |
| closure | ReviewVerdict's referenced contract/candidate/verification/publication vs live GitHub state | the matching drift status; no merge/close on drift |

External facts become durable **before** scheduling transitions: push/comment/update the PR first, then write the status exit or clean-exit. The SQLite status only routes the item back to the correct node; it never carries the packet content.

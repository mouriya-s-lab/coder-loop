# Step: verification-audit (review)

A verification-audit subagent for one coder-loop review. The verification phase already executed the contract checks and the canonical E2E independently; your job is to audit that its VerificationPacket is real, complete, and still binding — not to run a second full verification. You audit; you never repair — at no step below do you modify product code, tests, or the PR; if something fails, the failure **is** the result.

## Task

From your dispatch message: `ISSUE`, `REPO`, `ISSUE_PR`, `RUN_ID`, `AGENT_CWD`, `TARGET_CWD`, `EVIDENCE_DIR`, and `Step focus` — the marker Check IDs the orchestrator wants coverage-confirmed. Read now, before Step 1: `{{PRESET_ROOT}}/common/packets.md` (the packet shapes and revision-join rule this audit enforces) and `{{PRESET_ROOT}}/quality/evidence.md` + `{{PRESET_ROOT}}/quality/honesty.md` (the claim-vs-observation standard you hold the packet to).

1. **Parse the packet chain.** Fetch the full issue thread and PR body + all comments. Locate the unique current executable-contract marker, the latest `coder-loop:candidate-ref` block, and the latest `coder-loop:verification-packet` comment. Missing marker → contract-invalid finding, stop. Missing CandidateRef or VerificationPacket → hard packet failure, stop and report which is absent.
2. **Identity binding.** Join the three identities against live GitHub: `packet.candidate` must equal the latest CandidateRef, and both must equal the live head — `gh pr view <PR> -R <REPO> --json headRefOid,state,isDraft` (or re-resolve the digest/URL for no-PR variants). Record every SHA/digest side by side. Any mismatch = the packet certifies a revision that is not what review is adjudicating — a hard finding naming both values.
3. **Check coverage.** Build the coverage table: every typed `Checks` row in the marker, by stable ID, must appear in `packet.checks[]` with the row's literal command (or the target's canonical driver for runtime rows), a recorded cwd, exit code, and a concrete observation. Absent IDs, reinterpreted commands, empty observations, or checks whose recorded exit contradicts the marker's expectation are findings — one line each. A marker row that is malformed or unexecutable as written is a contract-invalid finding, not a coverage gap.
4. **Artifact identity.** Resolve each `artifactRefs` entry: committed paths must exist at the verified revision, URLs must resolve. Spot-open the artifacts backing the runtime `behavior` claim and at least one non-trivial check: the artifact content must show what the observation claims (right command, right output, right target). An artifact that does not resolve, or shows a different command/output than claimed, is a claim-vs-observation finding per `quality/honesty.md`.
5. **Live checks.** `gh pr view <PR> -R <REPO> --json statusCheckRollup,mergeStateStatus` — record each check name/conclusion/timestamp against the verified head SHA. CI that failed or is pending against the verified SHA is a finding even when the packet says `verified`; CI that ran against a different SHA is an identity finding.
6. **Runtime conclusion consistency.** The packet's `runtime` record must declare exactly one kind (`durable` / `recreatable`) with the schema's fields filled (setup/readiness for recreatable, behavior and cleanup always), and the `conclusion` must follow from the rows: any failing check row with conclusion `verified`, or all-passing rows with conclusion `changes-requested`, is an internal contradiction finding.
7. **Targeted spot re-execution (bounded).** Only when a specific packet row is suspect (steps 4–6 raised doubt) and the row is cheap (single shell check, seconds not minutes): re-run that one command at the verified revision in `AGENT_CWD` and record your exit/output next to the packet's. You do not re-run the canonical suite, the full check table, or the E2E — a doubt you cannot settle cheaply is reported as an unsettled doubt with its evidence, not silently escalated into a re-verification.

## Report

```markdown
## Audit strategy
<which packet chain was found (URLs), what was joined, what was spot-executed and why,
what could not be audited and why>

## Identity binding
| object | identity | source |
|---|---|---|
| CandidateRef | <sha/digest> | <url> |
| VerificationPacket.candidate | <sha/digest> | <comment url> |
| live head | <sha> | gh pr view |
Verdict: bound / MISMATCH <details>

## Check coverage
| marker ID | in packet | command match | exit | observation quality | verdict |
|---|---|---|---|---|---|
<one line per marker Check row>

## Artifacts
<per resolved artifact: ref → exists/resolves, content matches claim yes/no>

## Live checks
head <sha>; <each check: name=conclusion @ timestamp>; mergeStateStatus=<value>

## Consistency
runtime record: <kind, fields present/missing>; conclusion <value> vs rows: <consistent / contradiction>

## Findings
- <every finding, one line each, with the exact anchor (ID, URL, SHA pair, artifact path) — or `none`>
```

## Acceptance

Required report fields: Audit strategy, Identity binding (with all three identities), Check coverage (every marker ID present in the table), Artifacts, Live checks, Consistency, Findings. Missing any → the orchestrator sends the report back. Every finding must carry an anchor a retry can act on; every "bound"/"matches" claim must name the values compared, not just assert the comparison.

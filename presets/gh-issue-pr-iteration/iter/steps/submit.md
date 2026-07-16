# Step: submit

A submission subagent for one coder-loop iteration. The deliverable is the committed, pushed branch plus the **draft** PR (fresh run) or PR-thread comment (retry), carrying the evidence packet the verify and e2e steps produced **and the CandidateRef block** (`{{PRESET_ROOT}}/common/packets.md`) that binds the exact pushed revision — the verification phase executes the contract checks against precisely that identity, and the publish phase later flips the draft to ready. You never mark the PR ready.

## Task

From your dispatch message: `ISSUE`, `REPO`, `RUN_ID`, `AGENT_CWD` (work there), `TARGET_CWD`, `SHARED_CONTEXT_FILE`, `EVIDENCE_DIR` (the verified evidence you assemble from — you add no new claims), `ISSUE_BRANCH`/`ISSUE_PR` when set, `ISSUE_STATUS`, and `Step focus`. Read now, before Step 1: the `Intent (run <RUN_ID>)` block in `SHARED_CONTEXT_FILE`, the target repo's `CLAUDE.md` / `AGENTS.md` in `TARGET_CWD` for project commit / PR conventions, `{{PRESET_ROOT}}/common/github-routing.md` (binds Step 3 routing), and `{{PRESET_ROOT}}/quality/evidence.md` + `{{PRESET_ROOT}}/quality/honesty.md`.

**Claim gate.** Before reporting done, verify the deliverable live — the PR / comment URL must resolve on GitHub, not just exist in local state — and re-check that every claim in the packet traces to an observation the verify or e2e step actually produced. Fresh checks, this run; no completion wording ahead of them.

1. **Write the result delta.** Compare the `Intent (run <RUN_ID>)` block against what this run actually did (your `Step focus` plus the evidence under `EVIDENCE_DIR`). Append to the handoff under `Result (run <RUN_ID>)`: did action match intent; what drifted and why; what was noticed that intent did not anticipate. A plain "intent matched action" line is fine when true; do not pad it.
2. **Push the committed work.** The implement step already committed the implementation locally (fix cycles may have added more commits). Inspect first: `git log --oneline <BASE_BRANCH>..HEAD` (what will be pushed) and `git status --short` (what is still dirty). If deliverable artifacts remain uncommitted — e.g. committed screenshots the packet embeds — stage exactly those files; staging loop-data runtime artifacts, scheduling state, run logs, secrets, unrelated dirty files, or local-only evidence is forbidden; check the staged list (`git diff --cached --name-only`) against that rule before committing. Then audit the already-committed range with `git diff --name-only <BASE_BRANCH>..HEAD` for the same forbidden paths — a runtime artifact committed by an earlier step is a gap to fix before pushing.

   ```bash
   git add <specific evidence files still uncommitted — list them; never -A or .>   # only when needed
   git diff --cached --name-only   # any forbidden path → unstage before committing
   git commit -m "fix(issue-<ISSUE>): <concise description>

   Refs: <REPO>#<ISSUE>"           # only when something was staged
   git push -u origin <branch>
   ```

3. **Route the deliverable.**

   **An open PR already exists for this issue/branch** → retry route. Push went to the same branch; now post a **new PR-thread comment** in the **delta shape**, following the comment-legibility rules of `{{PRESET_ROOT}}/common/github-routing.md` (headline line, blockers above the fold, bulk folded):

   - headline: `**[iteration] retry @ <short-sha>** — <n>/<n> feedback items addressed`;
   - the updated `coder-loop:candidate-ref` block with the new head SHA (above any fold);
   - one entry per item of the review feedback's 缺失汇总: what changed, where (`file:line`), and the observation/evidence pointer proving it — a feedback item deliberately not addressed is stated as such with why;
   - a compact fresh-check table from this run's verify step: command, exit, one-line observation each — full transcripts stay as evidence paths, not inline prose;
   - what evidence was added, replaced, or deliberately unchanged and why, folded in `<details>` when longer than a few lines.

   The full layered evidence packet (Layer 1–4 + `Analysis` + runtime manifest + test-inventory delta) is **not** re-narrated in retry comments — the PR body carries the current full packet (publish reassembles it from the VerificationPacket each round), and the per-round VerificationPacket comments carry the check history. After the delta comment is durably posted: refresh the PR body's `coder-loop:candidate-ref` block to the new head, update (or create) the body's `coder-loop:current-state` index per `{{PRESET_ROOT}}/common/packets.md` (`round`+1, `iterationEvidenceUrl` = this comment, `contractMarkerUrl` = the marker you consumed), and minimize your own previous retry comment per `common/github-routing.md`. Repairing an existing PR body is your job when it has a structural defect (missing/wrong closing keyword, wrong issue number, missing required section); rewriting existing evidence narrative is not — evidence history lives in comments. A body edit must be accompanied by a companion comment stating exactly what changed and why.

   **No PR exists** → create exactly one, as a **draft** (`gh pr create --draft …`):
   - body first line exactly `Closes #<ISSUE>`;
   - title / body / section / language rules per the four required evidence layers below plus any project-specific additions in the target repo's `CLAUDE.md` / `AGENTS.md`;
   - the four-layer evidence packet from this run's verification (Layer 1–4 + `Analysis`), including CI detection + parity status and the test-inventory delta line;
   - the **E2E direct-run evidence** as the formal deliverable layer: the real entry driven (operator-style invocation / agent-browser walk), observed behavior, runtime trace artifacts — unit/integration results are supporting layers only;
   - the **runtime manifest** (binaries, services + start commands, auth by resolution location — **never a secret value in the PR** — ports, standing-environment PIDs/logs/stop commands) so review can re-run everything;
   - screenshots embedded as Markdown images whose paths resolve to committed PR-branch artifacts;
   - every artifact mapped to the behavior it proves;
   - the **CandidateRef block** per `{{PRESET_ROOT}}/common/packets.md`: a fenced json block labeled `coder-loop:candidate-ref` with `kind` `implementation-pr` and the PR number, branch, and the exact pushed head SHA (`git rev-parse HEAD` after the push) — plus, directly under it, the initial **`coder-loop:current-state` index block** (`round` 1, `contractMarkerUrl`, `iterationEvidenceUrl` null on the fresh route). On retries, refresh the body's CandidateRef block to the new head and post the updated block in this run's delta comment too. On no-PR routes, the matching variant (`source-writing` / `comment-delivery` / `no-change`) goes in the issue comment that carries the deliverable.

   The PR body is a diff cover letter with evidence — do not reconstruct the issue's why or move task scope into it. Everything in the packet traces to the verify and e2e steps' output; manufacturing a claim those steps did not produce violates `quality/honesty.md` and will be caught when the verification phase independently executes the contract checks.
4. **Verify liveness, then report.** Confirm your deliverable exists live: `gh pr view <N> -R <REPO> --json url` (fresh) or the comment URL resolving (retry). Nothing here merges PRs, closes issues, edits issue bodies, or writes queue state — confirm you did none.

## Report

```markdown
## Why I organized it this way
<packet organization decisions: which evidence went where, fresh-PR vs retry-comment
routing, anything deliberately left out and why>

## What I actually did
Commit: <sha(s)> on <branch>, pushed to <remote ref>
Deliverable: draft PR #<n> <url> (fresh) | PR comment <url> (retry)
CandidateRef: kind=<variant> head <sha or digest>, block live at <body/comment url>
Result block: appended at <handoff path>; delta verdict: matched / drifted: <why>
Packet sections: <list of layered sections actually present in the body/comment>
E2E + manifest: <confirmation both are in the packet; auth referenced by location only>
Test delta line: <the exact line included in the packet>

## Problems
<anything the packet does not cover; structural defects found in an existing PR body;
push/PR command failures with exact output; side effects for the cleanup ledger
— or `none` per item>
```

## Acceptance

Report structurally missing any section → send back before judging substance.

- **Liveness** — the PR / PR comment actually exists: verify with a light `gh pr view <N> -R <REPO> --json url,body` / comment listing yourself. A reported URL that does not resolve is a hard gap (claim-vs-observation, `quality/honesty.md`).
- **Protocol** — fresh PR: created as draft, body first line exactly `Closes #<ISSUE>`; retry: a **new** PR-thread comment exists for this run (a body edit alone is a gap). The `coder-loop:candidate-ref` block resolves live and its SHA/digest equals the actually pushed revision — a missing or stale CandidateRef is a hard gap (verification executes nothing else). Structural body repairs on the open PR (closing keyword, wrong issue, missing required section) are legal and must be declared in this run's comment; a body edit that rewrites or deletes existing evidence narrative is a gap. Routing per `common/github-routing.md`.
- **Packet completeness** — fresh PR: the body carries the layered sections the target workflow demands, with commands/exits/excerpts, embedded screenshots, the E2E direct-run evidence, the runtime manifest, and the test-inventory delta line. Retry: the delta comment carries the headline, the updated CandidateRef, one entry per feedback item with its evidence pointer, and the fresh-check table — a retry comment that re-narrates the full four-layer packet instead of the delta is a shape gap, as is one missing any feedback item. Every claim traces back to this run's verify and e2e reports. A secret value pasted into the PR body/comment is a hard gap — auth appears by resolution location only.
- **Delta honesty** — the `Result (run …)` block exists and discloses drift; check it against the intent-action mismatch trigger (`quality/honesty.md`).
- **Hygiene** — no runtime artifacts staged; no merge/close performed.

Gaps go back to the same subagent with precise instructions. After acceptance, the iteration deliverable is review-ready.

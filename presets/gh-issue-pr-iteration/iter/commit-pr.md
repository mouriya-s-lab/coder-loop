# Fragment: iter/commit-pr

## Goal

Commit verified changes and create or update the implementation PR.

## Self-check intent vs action before writing the PR body or PR comment

You wrote an intent statement before starting (per `iter/implement` — Intent statement section). Now compare it to what you actually did this iteration.

Specifically reflect on:

- did the code you wrote actually do what the intent said you would do, or did the implementation drift?
- did the footprint you said you would touch match the files you actually touched, or did extra files / fewer files get changed?
- if drift happened, what caused it — finding the problem was different from what you thought, the original plan turned out infeasible, you discovered a better approach, you ran out of time?
- if you did research-only this iteration (no code), did you produce the research outputs your intent said you would, and what is the actual followup for the next iteration?
- are there things you noticed during implementation that the intent statement did not anticipate, and which review should also know about?

Reflect honestly. The point is not to make intent and action match by retroactively editing intent — the intent statement in handoff and the prior PR body / comment is immutable historical record. The point is to write the **delta** somewhere review will see, so review has full picture.

Where to write the intent-vs-action delta:

- the same place you wrote the iteration's intent statement: append to handoff under `Result (run {{RUN_ID}})`, and either fold it into the PR body (only for the first PR creation in this iteration) or post it as part of the PR thread comment (every retry / iteration after the first).
- when this iteration was research-only, the delta belongs in the same surface as the intent statement (handoff + PR comment / issue comment) — describe what the research surfaced and what it changes about the next iteration's plan.

If the delta is "no drift, did what I said" then say that plainly. A short honest "intent matched action" line is fine and useful — it tells review the surface match is clean. Do not pad it with prose to look thorough.

## Commit

If code changed and verification/evidence is credible:

```bash
git status --short
git add <specific feature/test files and committed screenshots only>
git commit -m "fix(issue-<ISSUE>): <concise description>

Refs: <REPO>#<ISSUE>"
git push -u origin <branch>
```

Do not stage `loop-data runtime artifacts`, central daemon scheduling state, run stdout log, secrets, unrelated files, or local-only evidence.

## PR

If an open PR already exists for this issue/branch, continue that PR unless it is explicitly invalid or unusable. Push updates to that PR, but do not rewrite the PR body as an iteration log or replace prior evidence history. The PR body is the immutable opening cover letter and initial evidence packet; all retry/iteration updates must be posted as new PR-thread comments.

For every iteration after an implementation PR exists, post a PR comment before handoff. The comment must:

- state which review feedback was addressed;
- summarize what changed in this iteration;
- include the current four-layer evidence packet using the workflow-defined PR body section structure, with commands, exit status, log excerpts/paths, screenshots, and analysis;
- embed any screenshot evidence as Markdown images and map each screenshot to the behavior it proves;
- state whether evidence was added, replaced, or deliberately left unchanged and why.

After a PR has been created, do not edit the PR body to update evidence, summarize retries, collapse history, or repair iteration output. If the created PR body has a structural defect such as a missing closing keyword or wrong target issue, report the exact defect in the PR thread/handoff and let review classify the PR as retry/invalid rather than silently rewriting history.

Otherwise create exactly one PR. The PR must follow the target workflow rules, including:

- first line exactly `Closes #<ISSUE>`;
- workflow-defined title, body, section, language, and evidence formatting;
- CI detection and local CI-parity evidence with command, architecture, exit status, and log excerpt/path when local CI is reproducible;
- runtime/startup/deployment-order evidence when relevant;
- workflow-required artifacts and screenshot evidence when required;
- screenshot evidence embedded in the PR body as Markdown images (`![alt](path-or-url)`), not plain links;
- screenshot image paths/URLs that resolve to committed PR-branch artifacts under `screenshots/`, not deleted head branches, local-only runtime paths, or stale files that only exist after merge;
- clear mapping from every artifact, screenshot, or log excerpt to the behavior it proves.

The PR body is a diff cover letter with evidence. Do not reconstruct the issue's why or move task scope/follow-up context into the PR body. Do not merge or close anything.

## Output verdict

Choose exactly one:

- `pr_ready` → read `iter/handoff`.
- `no_code_change` → read `iter/handoff` with evidence explaining why no PR was created.
- `commit_or_pr_blocked` → read `iter/handoff` with the exact failure.
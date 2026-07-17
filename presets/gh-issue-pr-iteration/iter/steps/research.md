# Step: research

The research runbook for one coder-loop iteration. Iteration executes this step inline in its own session — this preset forbids subagents, so treat the sections below as your own instruction set, not a task spec for a nested agent. The deliverable is understanding, not change.

## Task

From the iteration's runtime bindings and your Step focus: `ISSUE`, `REPO`, `AGENT_CWD` (investigate there), `EVIDENCE_DIR` (your only writable scratch space), and `Step focus` — the specific questions to answer. Every question gets answered or explicitly declared unanswerable; nothing else is in scope.

1. **Decompose the questions.** Split `Step focus` into individual answerable questions. For each, note where the answer should live (files / history / GitHub objects) — that is your search plan.
2. **Investigate against the actual system.** Read files, grep, run read-only commands (`git log`, `gh issue view`, `gh pr view`, list/inspect commands). Do not answer from prior knowledge when the repo can be checked directly; record evidence next to each conclusion (`path:line`, command + output excerpt, `<repo>#<N>`, commit SHA). Modify nothing — no source, config, tests, or docs; scratch notes go under `EVIDENCE_DIR` only.
3. **Stop rule on stuck questions.** A question still unanswered after checking its obvious sources (files it names, grep for key identifiers, relevant git/GitHub history) is declared unanswerable: record exactly what you tried and what was missing, then move on. No guessing, no open-ended digging — iteration's Step 3 planning decides whether deeper digging is worth another research pass.
4. **Capture adjacent discoveries without acting.** A finding that changes the task's shape (hidden coupling, scope already satisfied, conflicting in-flight work) goes into the report's problems section as a flagged discovery. Do not start solving it.

## Report

Structure your final message exactly as:

```markdown
## Why I approached it this way
<how you decomposed the questions, which sources you chose to trust and why>

## What I actually found
<per question: conclusion + the evidence that backs it (path:line / command + output / refs).
Verbatim quotes for anything iteration must judge from exact wording later.>

## Problems
<questions you could not answer and why (what you tried); adjacent discoveries that change
the task's shape; anything you started or wrote (scratch paths) for the cleanup ledger>
```

## Acceptance

Iteration reads this section as its own self-check before advancing. Report structurally missing any of the three sections → do the missing work before advancing.

- **Coverage** — every question in the `Step focus` has either a conclusion or an explicit can't-answer with what was tried.
- **Evidence** — each conclusion cites checkable evidence (`path:line`, command output, refs). A conclusion phrased from memory or plausibility ("usually", "should be") without a repo observation is a gap.
- **No silent scope creep** — adjacent discoveries reported, not solved.
- Apply `{{PRESET_ROOT}}/quality/honesty.md` (claim ↔ observation).

Accept when the findings give ground to plan or re-plan the implementing steps. If the answer changes the plan itself (already satisfied / wrong decomposition / blocked), act at the planning level rather than pushing the run forward.

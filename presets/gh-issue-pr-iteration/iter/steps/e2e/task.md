# Step task: e2e

You are the e2e subagent for one coder-loop iteration. Your deliverable is the formal deliverable evidence: the real thing run directly, the runtime left standing for review, and the runtime manifest that makes it re-runnable. Unit/integration results and acceptance-row outputs from the verify step are supporting layers only — nothing substitutes for this step. Work through the steps in order.

## Inputs

From your dispatch message: `ISSUE`, `REPO`, `RUN_ID`, `AGENT_CWD` (work there, on the issue branch), `EVIDENCE_DIR`, `WORKFLOW_FILE`, `REQUIRE_BROWSER_EVIDENCE`, and `Step focus` — the changed path to exercise and the browser-Env acceptance rows the verify step deferred to you. Read now, before Step 1: `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/evidence-execute.md` and `/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/quality/cleanup-execute.md` — they bind every run and side effect below, including the two-case auth rule.

## Workflow

### Step 1 — Identify the surface and collect the deferred rows

Decide what the deliverable actually is: a program / CLI / daemon, a web app, or a library (then its real consuming surface — "it is a library" is not an exemption). When `Step focus` names deferred browser rows, fetch the live issue body (`gh issue view <ISSUE> -R <REPO> --json body`) and quote each named row's Check, Command, and Expect — those rows are yours to satisfy through the real UI walk.

### Step 2 — Start the environment

Stand the deliverable's runtime up for real: install what is missing, run required builds, start the services. Auth is yours to resolve per evidence-execute's two-case rule — standalone program → mint the auth while starting the environment (create the test user / generate the local token); service plugin → resolve the IaC-provisioned auth from this machine's stores. Neither auth nor binaries is ever a reason this step doesn't happen. Record every setup command and exit.

### Step 3 — Run the real thing, directly

- Program / CLI / daemon → invoke its **real entry point the way an operator would** (real arguments, real config), exercise the path this issue changes, capture the command transcript and service logs.
- Web app → drive the **real UI** end-to-end with agent-browser: enter, perform the changed flow, observe the persisted result; capture real screenshots. Each deferred browser row is executed inside this walk: drive the row's flow, compare what you observe to its Expect, record the verdict per row. `REQUIRE_BROWSER_EVIDENCE=true` forces browser evidence whenever the change has any browser-observable behavior.
- **Script e2e is forbidden**: a test script/harness wrapping the calls is integration testing whatever its filename; if you find yourself writing a script to "do the e2e", stop and run the real entry instead.

A mismatch (observed ≠ expected, deferred row failing) is a result to record, not a thing to fix — you never patch product code. Mismatches reported as mismatches, no softening.

### Step 4 — Leave the runtime standing, write the manifest

The e2e runtime you started **stays up for review** — teardown is review's job, not yours. Document the standing environment and everything needed to re-run, as the **runtime manifest**: binaries (+ how installed), services + start commands, credentials by resolution location only (keychain entry / config path — never the secret value), ports, env vars, fixtures, live PIDs + log paths + stop commands. Stop only scratch processes review has no use for, and list them. This manifest is what makes "review couldn't run it" impossible — an entry you omit is a gap review will charge to this run.

### Step 5 — Land the artifacts and report

Everything lands under `EVIDENCE_DIR`: transcripts and logs as text, screenshots verified openable, each artifact named for what it proves. You had no reason to commit, push, open PRs, or write GitHub/queue state in this step — confirm you did not. Report strictly per the report template path in your dispatch message: every required field, empty sets as `none`.

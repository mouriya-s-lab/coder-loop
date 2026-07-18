# Test boundaries

## Commands

- `bun test` / `bun run test:unit`: deterministic unit and in-process component tests only. It must not start coder-loop daemons or runner subprocess workflows.
- `bun run test:integration`: daemon, CLI subprocess, scheduler runner, worktree, and end-to-end local integration suites. Integration files run sequentially with a 30-second per-test timeout so suites do not contend for daemon/process resources.
- `bun run test:all`: both layers, sequentially.
- `bun scripts/engine-integration.ts`: process-level engine acceptance driver; it is not collected by `bun test`.
- `bun scripts/real-e2e.ts`: real runner and GitHub E2E; it is not collected by `bun test`.
- `bun scripts/runner-filesystem-grants-integration.ts`: runner filesystem grant acceptance driver; it is not collected by `bun test`.

A file named `*.test.ts` belongs to the default unit/component layer. A process test must use `*.integration.ts` (or the explicit `scheduler.integration-suite.ts` name) and be listed in `test:integration`. Static tests that only grep implementation source for removed names are not accepted: test an exported boundary or execute the owning driver instead.

## Current inventory

### `scripts/engine-integration.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./engine-integration-stub-runner`, `./engine-integration`
- Runtime tests: 5

  - engine-integration stub runner prompt contract > parses PHASE/CHAIN/ITEM/RUN lines from a rendered entry prompt
  - engine-integration stub runner prompt contract > rejects prompts missing a required fact line
  - engine-integration stub runner prompt contract > extracts the prompt from agentClaudeArgs-shaped argv (`-p` carries the prompt)
  - engine-integration stub runner prompt contract > rejects argv without `-p`
  - engine-integration subprocess environment > strips outer run credential and loop-data pointer (dogfood isolation)

### `scripts/real-e2e-environment.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./real-e2e-environment`
- Runtime tests: 1

  - real-e2e operator subprocess environment > removes an inherited run credential without mutating the parent environment

### `scripts/sync-agents-md.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./sync-agents-md`
- Runtime tests: 1

  - AGENTS.md is a regular, current merge of CLAUDE.md and enabled Claude rules

### `src/central-cli.integration.ts`

- Layer: **integration**
- Direct code boundary: `./daemon`, `./runtime-paths`, `./sqlite-state`, `./runtime-data`, `./observability`
- Runtime tests: 39

  - central chain/item CLI > status reports runner persistence failures
  - central chain/item CLI > status exposes scheduler lifecycle event failure
  - central chain/item CLI > observes ordered mutation and read on one socket
  - central chain/item CLI > chain CRUD CLI
  - central chain/item CLI > chain umbrella parsing
  - central chain/item CLI > item CRUD CLI
  - central chain/item CLI > status commands use config-json presetPath statuses
  - central chain/item CLI > status CLI on mixed-preset chain selects foreign-preset item by its own continuable set (AC #3)
  - central chain/item CLI > item reorder CLI
  - central chain/item CLI > batch item add
  - central chain/item CLI > batch item add matches daemon
  - central chain/item CLI > chain status completion
  - central chain/item CLI > chain status reports dependency waiting reason
  - central chain/item CLI > daemon up down
  - central chain/item CLI > daemon down with CODER_LOOP_RUN_CRED env attaches agentCredential and is rejected by daemon (#409 CLI wiring)
  - central chain/item CLI > daemon up ignores reload/debug signals and SIGQUIT shuts down gracefully
  - central chain/item CLI > daemon shutdown cleans runtime after background rejection
  - central chain/item CLI > daemon down emits human text without json flag
  - central chain/item CLI > daemon commands expose json flag in help
  - central chain/item CLI > second daemon up fails without orphaning first daemon
  - central chain/item CLI > concurrent daemon up race leaves one usable daemon
  - central chain/item CLI > daemon not running explicit error
  - central chain/item CLI > daemon status and down --json emit JSON when central daemon is not running
  - central chain/item CLI > daemon status --json reports live pid with missing socket pathname
  - central chain/item CLI > daemon up --json emits JSON when loop-data root cannot be prepared
  - central chain/item CLI > daemon status target reports chain-only daemon from loop-data socket
  - central chain/item CLI > json output schema stable
  - central chain/item CLI > daemon start chain resolve
  - central chain/item CLI > daemon stop preserves chain as stopped (regression: PR #194 wired it to chain.delete)
  - central chain/item CLI > daemon target-cwd fails explicitly when no chain matches
  - central chain/item CLI > daemon start ambiguous chain
  - central chain/item CLI > status json reports DB snapshot and live process scan
  - central chain/item CLI > logs --chain reads stopped and completed chain history with explicit loop-data-root flag
  - central chain/item CLI > doctor checks operator machine and live runtime; no target file checks
  - central chain/item CLI > doctor repo access succeeds
  - central chain/item CLI > doctor repo access failure is fatal
  - central chain/item CLI > doctor omits repo access check without flag
  - central chain/item CLI > doctor passes regardless of target .coder-loop/runtime presence
  - central chain/item CLI > context append real daemon runtime

### `src/context-entry.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./context-entry`, `./sqlite-state`, `./daemon`, `./runtime-paths`
- Runtime tests: 6

  - context entry foundation > closed scope and author boundaries reject malformed variants
  - context entry foundation > CLI and persisted-row scope boundaries yield exhaustive discriminated products
  - context entry foundation > context entries are append-only and removed by chain delete
  - context entry foundation > orderly socket close before a complete response rejects
  - context entry foundation > context schema migration preserves existing data
  - context entry foundation > persisted context rows reject unknown scope kind and missing scope key

### `src/daemon.integration.ts`

- Layer: **integration**
- Direct code boundary: `./daemon`, `./loop`, `./scheduler`, `./runtime-paths`, `./sqlite-state`, `./observability`, `./runtime-data`, `./hook-declarations`
- Runtime tests: 131

  - daemon > hook declarations persist across all layers, reload on restart, and never execute during scheduling
  - daemon > persisted item hooks feed the effective view without entering status item or run surfaces
  - daemon > orders requests within one daemon connection
  - daemon > keeps independent daemon connections concurrent
  - daemon > continues ordered connection after request failure
  - daemon > drives chain-complete decision through a large runner event
  - daemon > daemon up creates socket and pid
  - daemon > daemon rebinds socket pathname after unlink
  - daemon > daemon startup rejects live pid with missing socket pathname
  - daemon > socket chain.create
  - daemon > socket chain.create is idempotent but rejects conflicting existing fields
  - daemon > socket chain.create rejects invalid names before db insert
  - daemon > socket chain.create validates repository format
  - daemon > socket chain.create validates baseBranch as a git branch name
  - daemon > socket chain.create rejects undeclared args
  - daemon > socket chain.create validates metadata keys and nesting before db insert
  - daemon > socket chain.create validates preset name and existence before db insert
  - daemon > daemon rejects existing chains with invalid or unknown presets instead of falling back
  - daemon > socket chain.create rejects oversized request and metadata payloads
  - daemon > daemon startup skips invalid existing chain rows
  - daemon > daemon startup repairs missing chain shared handoff file
  - daemon > daemon startup quarantines chain directories missing from DB
  - daemon > socket item CRUD
  - daemon > socket item list exposes per-item preset and presetPath (post-#412)
  - daemon > socket item batch add short-circuits on invalid input without partial write
  - daemon > socket item batch add rejects conflict with existing item without partial write
  - daemon > socket item.add rejects duplicate issue as conflict without SQL details
  - daemon > socket item.add rejects invalid issue and repo fields before db insert
  - daemon > socket item.add rejects daemon-owned, unsafe, and unknown fields before db insert
  - daemon > socket item.add acks before scheduler side effects finish
  - daemon > socket item.update validates status and dependency graph
  - daemon > daemon validates item statuses from config-json presetPath metadata
  - daemon > daemon reports custom presetPath load failures to each chain mutation request
  - daemon > daemon emits validation event naming chain.status when preset resolution refuses chain.status
  - daemon > daemon emits preset.dag_check validation events for cross-table DAG findings (issue #408)
  - daemon > daemon default scheduler prompt resolver consumes scheduler presetDir loaded preset
  - daemon > socket item.update writes typed blocker fields into extra without disturbing other keys
  - daemon > daemon loads legacy-shaped metadata and item extra from existing SQLite data before scheduling
  - daemon > socket item.reorder renumbers queue positions
  - daemon > socket item status validation follows the item preset (post-#412)
  - daemon > socket item.update applies preset phase status write policy
  - daemon > socket item.update with no active phase records no-phase-active admission audit
  - daemon > socket item.exits returns typed phase exits and parity with write-side allowed
  - daemon > socket item.exitAction stop maps to chain.stop and emits the audit + lifecycle events (#405 + #411)
  - daemon > credential-bound item.exitAction denies forged attribution and preserves overlapping already-stopped review attempts (#600)
  - daemon > socket item.update rejects immutable selectors and daemon-owned fields
  - daemon > socket chain.delete reports already_deleted consistently
  - daemon > socket chain lookup rejects conflicting chainId and chainName
  - daemon > socket chain.create force recreates deleted same-name chain
  - daemon > socket deleted chain remains read-only for item mutations
  - daemon > socket completed chain remains read-only for item mutations
  - daemon > socket chain.delete removes scheduler worktree registration and chain runtime layout
  - daemon > socket completed chain removes scheduler worktree registration and preserves audit runtime
  - daemon > socket chain.delete terminates active runs before marking chain deleted
  - daemon > auto chain completion
  - daemon > terminal item.update sets terminal status; active run finishes naturally, then chain completes
  - daemon > socket chain.stop terminates active runs and preserves stopped chain runtime
  - daemon > socket chain.resume restores scheduling for a stopped chain
  - daemon > daemon survives all chains complete
  - daemon > daemon shutdown cleans runtime files and records the terminated run (#467)
  - daemon > shutdown completes after scheduler tick rejection
  - daemon > socket repair failure does not kill daemon
  - daemon > daemon shutdown terminates active runs with bounded grace and reports them (#467)
  - daemon > daemon shutdown waits for pending scheduler close handlers before closing db
  - daemon > daemon shutdown preserves user terminal item status
  - daemon > daemon startup kills stale process group and clears current_run without rewriting item business fields (#508)
  - daemon > daemon startup reconciles an orphan run on a terminal non-current item
  - daemon > daemon startup terminates the process group of an orphaned non-current run
  - daemon > daemon startup reconciles an orphaned run before scheduler selection
  - daemon > daemon startup rejects socket commands before stale recovery finishes
  - daemon > chain status marks stale in_progress rows without active slots
  - daemon > subprocess exit callback writes db
  - daemon > daemon scheduler writes run artifacts and unified observability events
  - daemon > status snapshot recent events include scheduler phase.start / phase.end / queue.terminal
  - daemon > daemon suppresses repeated decision events while a slot remains busy
  - daemon > decision fingerprint suppresses only consecutive duplicates
  - daemon > decision fingerprint state follows active lifecycle
  - daemon > decision fingerprint churn returns to active-set baseline
  - daemon > daemon scheduler uses bundled preset directory declared on the item (post-#412)
  - daemon > socket item.update operator path emits operator-attributed caller-admission audit (#406)
  - daemon > socket item.update rejects an unknown agentCredential value (#406)
  - daemon > socket item.update rejects cross-item write with the wrong-item deny branch (live spawn, #406)
  - daemon > socket item.update admits the agent's own credential against its bound item (live spawn, #406 row 3)
  - daemon > socket item.update rejects an expired credential after the run ends (live spawn, #406)
  - daemon > active run terminating naturally invalidates its credential without explicit kill (#406 + #417)
  - daemon > daemon db unavailable explicit fail
  - daemon > unknown command rejected
  - daemon > daemon scheduler spawns blocked-responder trigger phase after review exits blocked (live integration, issue #290)
  - daemon > daemon re-spawns item after agent exits 0 without SUMMARY marker (live integration)
  - daemon > per-phase runner selection (issue #287 AC5) > live daemon with chain metadata claude/codex.binary spawns codex script for iter phase
  - daemon > per-phase runner selection (issue #287 AC5) > live daemon with chain metadata claude/codex.binary spawns codex script for review phase
  - daemon > per-item phase advancement (issue #289 AC7) > live daemon drives one item through iter → review in two distinct spawns (not one synchronous spawn-then-review)
  - daemon > per-(item, phase) runId + artifact directory (issue #294) > iter and review spawns produce distinct phase-tagged runIds with isolated artifact subdirs and SQLite runs rows
  - daemon > recordFatalSync durably writes the uncaught stack to the unified event stream
  - daemon > (#452) finalPrompt contains no summary-tag instruction
  - daemon > (#452) recycle zone SIGKILLs process after state write + timeout
  - daemon > recovers after scheduler lifecycle event failure
  - daemon > (#452) recycle zone admits natural exit when agent closes within window
  - daemon > (#452) stdout content (including forged tags) does not arm recycle; attempt timeout reclaims
  - daemon > attempt timeout kills long-running process
  - daemon > socket item.add denies an iteration-phase agentCredential with no-rights-segment (#407 row 1)
  - daemon > socket item.add admits a review-phase agentCredential and inserts the child (#407 row 2)
  - daemon > socket item.add operator path bypasses the rights gate with reason=operator (#407 row 3)
  - daemon > socket item.add default-deny on single-phase-example for agents; operator path still allowed (#407 row 4)
  - daemon > socket item.add review credential rejects illegal priority with the same invalid_request shape as item.update (#407 row 5)
  - daemon > daemon hard-denies chain.delete / chain.stop / daemon.down for agent credentials with no-preset-grammar message (#409 row 1)
  - daemon > daemon allows item.reorder for review agent and denies it for iteration agent (#409 row 2)
  - daemon > per-phase agent path emits deny event when item is not found (#409 retry audit edge)
  - daemon > daemon hard-denies logs.query for agent credentials; operator path returns events (#409 row 3)
  - daemon > daemon allows the full operator-issued chain/queue/inspect surface (#409 row 4)
  - daemon > queue unblock waits for in-flight scheduler tick
  - daemon > queue unblock always resumes scheduler
  - daemon > queue unblock caller admission
  - daemon > daemon allows review-phase agent to write declared passthrough fields branch + pr + extra blocker keys (#410 row 2)
  - daemon > daemon denies review-phase agent on control-plane fields and undeclared passthrough (#410 row 1)
  - daemon > daemon allows operator path to write every item.update field (#410 row 3)
  - daemon > preset load rejects control-plane field in [phases.rights] writableFields (#410 parse-side)
  - daemonRateLimitDecision (issue #478) > normal — no cooldown armed → no spawn cap
  - daemonRateLimitDecision (issue #478) > paused — cooldown armed, reset not elapsed → 0 spawns
  - daemonRateLimitDecision (issue #478) > stagger-wait — reset elapsed, stagger window still cooling → 0 spawns
  - daemonRateLimitDecision (issue #478) > stagger-ready — reset elapsed, stagger window passed (or never armed) → cap = 1
  - daemonRateLimitDecision (issue #478) > DAEMON_RATE_LIMIT_STAGGER_MS pins the post-reset stagger window per #157 history
  - daemonRateLimitDecision (issue #478) > context append derives author from credential
  - daemonRateLimitDecision (issue #478) > context denial audit preserves active agent attribution before request and chain rejection
  - daemonRateLimitDecision (issue #478) > context append sessions cannot outlive soft chain deletion
  - daemonRateLimitDecision (issue #478) > context write admission audit
  - daemonRateLimitDecision (issue #478) > context scope admission
  - rateLimitStatusFromState daemon.status wire shape (issue #478) > empty state — wire shape exposes all 10 fields with null/normal defaults
  - rateLimitStatusFromState daemon.status wire shape (issue #478) > populated state during cooldown — `active=true`, `mode=paused`, ISO + unix coexist (covers issue acceptance row 4)
  - rateLimitStatusFromState daemon.status wire shape (issue #478) > populated state after reset, before stagger — `active=true`, `mode=stagger-wait`
  - rateLimitStatusFromState daemon.status wire shape (issue #478) > populated state after stagger window — `active=false`, `mode=stagger-ready`

### `src/db-main-loop.integration.ts`

- Layer: **integration**
- Direct code boundary: `./daemon`, `./sqlite-state`, `./task-runtime`, `./runtime-data`
- Runtime tests: 4

  - db-backed loop CLI > status task tree projects persisted recursive identity without flat item synthesis
  - db-backed loop CLI > queue unblock mutates SQLite only
  - db-backed loop CLI > queue unblock restores preset-declared terminal status to preset entry
  - db-backed loop CLI > daemon start dry-run resolves the chain without per-target state writes

### `src/hook-declarations.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./hook-declarations`, `./runtime-data`
- Runtime tests: 14

  - hook declarations > merges all four layers in provenance order
  - hook declarations > parses the versioned global document and round-trips typed carriers
  - hook declarations > rejects undeclared keys in the versioned global document
  - hook declarations > requires and round-trips an explicit positive tick throttle
  - hook declarations > structurally includes future event points while excluding future hook events
  - hook declarations > rejects malformed declaration 0
  - hook declarations > rejects malformed declaration 1
  - hook declarations > rejects malformed declaration 2
  - hook declarations > rejects malformed declaration 3
  - hook declarations > rejects malformed declaration 4
  - hook declarations > rejects malformed declaration 5
  - hook declarations > rejects malformed declaration 6
  - hook declarations > rejects malformed declaration 7
  - hook declarations > rejects malformed declaration 8

### `src/install-commands.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./install-commands`, `./loop`, `./sqlite-state`, `./runtime-data`
- Runtime tests: 1

  - buildLiveRuntimeHealthLines > summarizes status snapshot health and stale loop ownership signals

### `src/internal-status-type.test.ts`

- Layer: **unit/component**
- Direct code boundary: script/source contract
- Runtime tests: 1

  - InternalStatus type branding > rejects bare strings and accepts boundary-constructed statuses

### `src/loop.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./loop`, `./runtime-data`, `./sqlite-state`, `./runner-output`
- Runtime tests: 52

  - ItemRecord prompt bindings > getItemId reads issueNumber when the preset idField is issue
  - ItemRecord prompt bindings > getItemId still honors explicit extra id fields
  - ItemRecord prompt bindings > renderPrompt resolves ItemRecord phase and nested sessionIds
  - ItemRecord prompt bindings > renderPrompt injects runtime inputs and phase exits docs from phase metadata
  - ItemRecord prompt bindings > resolveBinding keeps old item.issue and chain.requireBrowserEvidence compatibility
  - ItemRecord prompt bindings > parsePreset accepts nested ItemRecord fields but rejects unknown roots
  - runtime binding helpers > documentation keeps engine runtime binding count and list aligned with source
  - runtime binding helpers > reserved string registry includes engine-parsed summary enums
  - runtime binding helpers > buildRenderBindings returns transparent chain data
  - runtime binding helpers > preset-declared runtime business keys render without engine whitelist changes
  - runtime binding helpers > parsePreset rejects undeclared runtime business keys
  - runtime binding helpers > buildRuntimeBindings merges preset-supplied businessKeyValues literals
  - runtime binding helpers > buildRuntimeBindings maps issue run context into strings
  - runtime binding helpers > runtime bindings keep per-issue handoff optional
  - runtime binding helpers > makeIssueRunContext exposes current record data without LoopState
  - runtime binding helpers > renderFragmentIndex slices fragments to roles declared by the phase (issue #400)
  - runtime binding helpers > renderFragmentIndex returns empty string when the phase declares no roles
  - runner and daemon helpers > selectRunnerForPhase honors queue override on every non-trigger phase, regardless of phase name
  - runner and daemon helpers > selectRunnerForPhase uses engine-builtin fallback when role md omits defaultRunner
  - runner and daemon helpers > parsePreset reads phase model and rejects blank values
  - runner and daemon helpers > selectRunnerForPhase resolves the preset phase model when config declares none
  - runner and daemon helpers > explicit config model overrides the preset phase model
  - runner and daemon helpers > item runner override to a different kind does not inherit the preset phase model
  - runner and daemon helpers > stripRoleEntryFrontmatter removes leading frontmatter so prompts never start with --
  - runner and daemon helpers > buildDaemonStartPlan emits the central daemon command
  - runner and daemon helpers > agentCodexArgs and session path helpers keep runner plumbing stable
  - runner and daemon helpers > agentOpencodeArgs renders run subcommand with json format model dir and optional resume
  - runner and daemon helpers > parseSessionIdFromRunnerStream extracts opencode sessionID from JSONL first line
  - small parsers > runner filesystem grants project one declared surface model across runners
  - small parsers > runner filesystem grants reject equal-root and ancestor tree grants while retaining literal cwd traversal
  - small parsers > runner git metadata authorizes a real commit from a linked worktree
  - small parsers > runner filesystem grants let Bun discover a nested task cwd without broad parent authority
  - small parsers > runner filesystem grants deny undeclared writes and preserve every declared writable channel
  - small parsers > phase-scoped runner surfaces include only actually declared runtime binding paths
  - small parsers > runner authorization metadata cannot widen projections
  - small parsers > runner projections reach the chain-complete spawn path for every runner and resume mode
  - small parsers > reports ordered chain-complete status persistence failure
  - small parsers > rejects successful chain-complete decision when terminal status persistence fails
  - small parsers > detects session id across streamed chunk boundaries
  - small parsers > stream text state retains finalizer summary without retaining full history
  - small parsers > detectHostRunner defaults to Codex inside Codex env and Claude otherwise
  - small parsers > normalizeQueueIssueId accepts local and cross-repo forms
  - small parsers > runner stream parsers extract sessions
  - small parsers > extractErrorCode detects 429 in stdout JSONL (W3 fixture shape)
  - small parsers > isTransient5xx accepts the rate-limit error code
  - small parsers > decideResume resumes interrupted or transient prior sessions only
  - renderPrompt placeholder validation (issue #399) > extractPromptPlaceholders finds positional matches and distinguishes escapes
  - renderPrompt placeholder validation (issue #399) > validatePresetPhaseTemplate flags template-undeclared as error and declared-unused as warn
  - renderPrompt placeholder validation (issue #399) > validatePresetPhaseTemplate skips escaped literals when checking template-undeclared
  - renderPrompt placeholder validation (issue #399) > renderPrompt does positional substitution so values containing `{{` are not flagged as residue
  - renderPrompt placeholder validation (issue #399) > renderPrompt renders escape `\{{KEY}}` as literal `{{KEY}}`
  - renderPrompt placeholder validation (issue #399) > renderPrompt throws on undeclared placeholder (defense-in-depth — loadPreset normally catches this earlier)

### `src/observability.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./observability`
- Runtime tests: 8

  - observability > exports the canonical event schemas as runtime parsers
  - observability > task event identity is an exact all-or-none triple
  - observability > query filters by kind, type, chain, run, phase, and since
  - observability > query includes rotated event stream segments
  - observability > exported segment contract discovers a deterministic causal order
  - observability > segment discovery deterministically orders valid equal-timestamp legacy segments
  - observability > async and sync writers produce contract-recognized names and preserve exact sequence across day and size rotations
  - observability > excerpt collection carries only bounded tail records and marks truncation

### `src/preset-compile.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./loop`
- Runtime tests: 15

  - preset compiler > returns closed compiled and rejected variants
  - preset compiler > projection is deterministic and copies canonical semantic identities
  - preset compiler > execution content identity covers referenced fragments templates and auxiliary sources
  - preset compiler > canonical identities remain unique for delimiter-bearing legal phase names
  - preset compiler > preserves all warnings
  - preset compiler > preserves declared-unused placeholder warnings in compiled and public findings
  - preset compiler > rejected diagnostics are non-empty and error-only at type and public boundaries
  - preset compiler > direct and materialized compilation project identical source semantics
  - preset compiler > non-ENOENT source failures stay in the typed rejection channel
  - preset compiler > non-ENOENT compile source resolution failures emit structured rejections
  - preset compiler > empty statuses are rejected at the preset parse boundary
  - preset compiler > missing declared prompt and fragment sources return typed rejections
  - preset compiler > validation and DAG callback failures escape the compile-result channel
  - preset compiler > malformed compile CLI shape is rejected
  - preset compiler > bare cwd-relative preset directories win before bundled-name fallback

### `src/preset.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./loop`, `./runtime-data`, `./sqlite-state`
- Runtime tests: 84

  - loadPreset (bundled gh-issue-pr-iteration) > validates runtime handoff lifetime contract
  - loadPreset (bundled gh-issue-pr-iteration) > review exhaustively routes runtime handoff kinds
  - loadPreset (bundled gh-issue-pr-iteration) > limits changed-scope issue patterns to branch delta
  - loadPreset (bundled gh-issue-pr-iteration) > requires whole-tree issue pattern convergence
  - loadPreset (bundled gh-issue-pr-iteration) > rejects ambiguous issue pattern scope
  - loadPreset (bundled gh-issue-pr-iteration) > routes diff audit by declared issue pattern scope
  - loadPreset (bundled gh-issue-pr-iteration) > loads name, item.idField, agent.attemptTimeoutSeconds, statuses sets
  - loadPreset (bundled gh-issue-pr-iteration) > phases include iteration, review, blocked responder, and umbrella finalizer triggers
  - loadPreset (bundled gh-issue-pr-iteration) > each phase declares the shared variable bindings with parsed sources
  - loadPreset (bundled gh-issue-pr-iteration) > specific variable bindings reflect renderPrompt source mapping
  - loadPreset (bundled gh-issue-pr-iteration) > bundled preset declares issue doc prefix
  - loadPreset (bundled gh-issue-pr-iteration) > bundled umbrella binding flows through declared chain-binding mechanism (acceptance row 2)
  - loadPreset (bundled gh-issue-pr-iteration) > fragments match PROMPT_FRAGMENTS 1:1 by id+role+path and files exist
  - loadPreset (bundled gh-issue-pr-iteration) > contract.md describes four deliverable shapes without kind taxonomy
  - loadPreset (bundled gh-issue-pr-iteration) > iteration entry owns the task-list workflow, deliverable-shape routing, and dispatch protocol
  - loadPreset (bundled gh-issue-pr-iteration) > dispatch contract is runner-neutral while entry prompts retain semantic task decomposition
  - loadPreset (bundled gh-issue-pr-iteration) > review entry owns the mandatory dispatches, judgments, and action files
  - loadPreset (bundled gh-issue-pr-iteration) > blocked responder prompt carries the required cross-repo side effects
  - loadPreset (bundled gh-issue-pr-iteration) > umbrella finalizer prompt carries the required chain-complete assessment contract
  - parsePreset schema validation > runtime input doc decoration is schema driven
  - parsePreset schema validation > rejects doc decoration without a label but retains default-only object bindings
  - parsePreset schema validation > rejects unknown variable binding fields
  - parsePreset schema validation > rejects bogus variable prefix
  - parsePreset schema validation > rejects bare name (no dot) variable source
  - parsePreset schema validation > rejects continuable / terminal overlap
  - parsePreset schema validation > rejects a preset that omits statuses.exhausted (#402)
  - parsePreset schema validation > rejects a preset whose statuses.exhausted is not in terminal (#402)
  - parsePreset schema validation > rejects duplicate phase name
  - parsePreset schema validation > accepts trigger phases and exposes them via triggeredPhasesAfter
  - parsePreset schema validation > accepts per-phase exit declarations and per-phase runner overrides
  - parsePreset schema validation > preset loader accepts opencode runner
  - parsePreset schema validation > accepts manual unblock statuses declared as terminal subset
  - parsePreset schema validation > rejects manual unblock statuses outside terminal set
  - parsePreset schema validation > rejects duplicate manual unblock statuses
  - parsePreset schema validation > rejects per-phase exit declarations outside preset statuses
  - parsePreset schema validation > rejects duplicate per-phase exit declarations
  - parsePreset schema validation > accepts chain-complete trigger phases
  - parsePreset schema validation > rejects trigger afterPhase that does not name a declared phase
  - parsePreset schema validation > rejects trigger whenStatus outside preset statuses
  - parsePreset schema validation > rejects duplicate fragment id
  - parsePreset schema validation > rejects misspelled item field reference (e.g. item.stauts instead of item.status)
  - parsePreset schema validation > accepts declared runtime business keys
  - parsePreset schema validation > rejects undeclared runtime business keys
  - parsePreset schema validation > rejects runtime business key declarations that collide with engine facts
  - parsePreset schema validation > accepts preset-supplied literal business key values
  - parsePreset schema validation > rejects businessKeyValues entries not declared in businessKeys
  - parsePreset schema validation > rejects businessKeyValues entries with no value spec key
  - parsePreset schema validation > rejects businessKeyValues literal that is not a string
  - parsePreset schema validation > rejects businessKeyValues with multiple competing spec keys
  - parsePreset schema validation > accepts item.idField reference in variables
  - parsePreset schema validation > accepts known base item field reference in variables
  - parsePreset schema validation > accepts declared transparent item fields
  - parsePreset schema validation > accepts minimal valid preset and produces normalized shape
  - parsePreset schema validation > accepts agent attemptTimeoutSeconds override
  - parsePreset schema validation > rejects non-positive agent attemptTimeoutSeconds
  - loadPreset placeholder validation (issue #399) > rejects a preset whose entry md contains an undeclared placeholder
  - loadPreset placeholder validation (issue #399) > accepts a preset whose declared variables are all reachable from the entry md
  - loadPreset placeholder validation (issue #399) > accepts an escaped `\{{KEY}}` literal even when KEY is not declared
  - loadPreset placeholder validation (issue #399) > warns about declared-unused variables without failing the load
  - loadPreset placeholder validation (issue #399) > bundled gh-issue-pr-iteration preset loads with zero error findings
  - loadPreset placeholder validation (issue #399) > bundled single-phase-example preset loads with zero error findings
  - loadPreset cross-table DAG check (issue #408) > row #1 / row #5a: trigger edge keyed on a status no producer phase writes is rejected by the existing local check (DAG checker does not regress it)
  - loadPreset cross-table DAG check (issue #408) > row #2 / row #5b: deadlock-continuable surfaces as an error finding pinpointing the table and status
  - loadPreset cross-table DAG check (issue #408) > row #3: dead-vocabulary surfaces as a warn finding and does NOT block the load
  - loadPreset cross-table DAG check (issue #408) > row #4: every bundled preset loads with no DAG error findings
  - loadPreset cross-table DAG check (issue #408) > row #4 (chain-complete variant): a `trigger = { on = "chain-complete" }` phase with no exits is NOT misreported as a deadlock contributor
  - loadPreset cross-table DAG check (issue #408) > row #5: entry status outside continuable is rejected by the existing local check
  - loadPreset cross-table DAG check (issue #408) > row #5: unblockable status outside terminal is rejected by the existing local check
  - loadPreset cross-table DAG check (issue #408) > row #5: exit status outside the declared vocabulary is rejected by the existing local check
  - loadPreset cross-table DAG check (issue #408) > trigger-keyed phase whose exits all write back to its own keyed status is correctly identified as NOT a leaving edge
  - issue #400 — fragment index slicing per phase > bundled preset declares roles on every phase and the engine slices accordingly
  - issue #400 — fragment index slicing per phase > Row #4: phase↔role mapping comes from metadata and accepts non-convention names without engine guessing
  - issue #400 — fragment index slicing per phase > Row #4 (second half): missing phase.roles raises a load-time error when the preset declares fragments
  - issue #400 — fragment index slicing per phase > rejects phase.roles entries that name a role no fragment declares
  - issue #400 — fragment index slicing per phase > rejects duplicate role entries within a single phase
  - issue #400 — fragment index slicing per phase > Row #5: entry-prompt fragment references remain a subset of the per-phase sliced index
  - issue #400 — fragment index slicing per phase > assertReadable in loadPreset still covers every fragment regardless of phase slicing
  - materializePreset > replaces {{PRESET_ROOT}} in .md files with the target absolute path; non-md files pass through verbatim
  - materializePreset > content hash is stable across repeated calls (idempotent) and changes when source changes
  - materializePreset > loadPreset({ materialize }) points preset.presetDir + fragment/prompt paths at the materialized copy
  - materializePreset > materialize threads through gh-issue-pr-iteration end-to-end (all 57 references substituted, no residue in md files)
  - {{PRESET_ROOT}} placeholder handling > loadPreset does not flag {{PRESET_ROOT}} as undeclared even when the phase entry uses it (in-memory substitution runs before validate)
  - {{PRESET_ROOT}} placeholder handling > substitutePresetRootToken is idempotent (no-op on content that already has been substituted)
  - prunePresetMaterializedRoot > removes materialized dirs not present in the keep set; leaves kept dirs and returns cleanly on a missing root

### `src/rate-limit.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./rate-limit`
- Runtime tests: 6

  - rate-limit detection (#478) > extractRateLimitReset reverse-scans stdout for the rejected rate_limit_event and parses resetsAt
  - rate-limit detection (#478) > extractRateLimitReset returns null for streams without a rejected rate_limit_event
  - rate-limit detection (#478) > extractRateLimitErrorCodeFromEvent recognizes the three documented 429 shapes
  - rate-limit detection (#478) > isRateLimitErrorCode matches any of the documented spellings
  - rate-limit detection (#478) > classifyRateLimitFromStdout returns code + reset in one pass on a real W3 stream
  - rate-limit detection (#478) > classifyRateLimitFromStdout tolerates non-JSON lines and missing fields

### `src/runners/session-id.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./session-id`
- Runtime tests: 5

  - runner session id invalid detection > codex detects resume thread ids that no longer exist
  - runner session id invalid detection > claude detects missing conversation session ids
  - runner session id invalid detection > does not treat ordinary runner stderr as session-id invalid
  - runner session id invalid detection > opencode detects missing session ids with ANSI color codes
  - runner session id invalid detection > opencode rejects partial / adjacent stderr lines that mention session or not-found

### `src/runtime-data.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./runtime-data`
- Runtime tests: 2

  - hook declaration persistence carriers > chain metadata round-trips hooks exactly
  - hook declaration persistence carriers > item extra round-trips hooks with unrelated persisted state

### `src/runtime-paths.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./runtime-paths`
- Runtime tests: 8

  - runtime path model > loop-data root default resolves under user-level coder-loop data
  - runtime path model > global daemon process logs live under the loop-data root, not under any chain
  - runtime path model > loop-data root env override takes precedence over default
  - runtime path model > loop-data root env override rejects empty or relative paths instead of falling back
  - runtime path model > per-chain paths include shared, issues, evidence, runs, and daemon layout
  - runtime path model > sanitization rejects empty traversal absolute control and separator input
  - runtime path model > sanitization accepts letters digits hyphen underscore and dot
  - runtime path model > pure path module no side effect

### `src/scheduler.cross-runner.integration.ts`

- Layer: **integration**
- Direct code boundary: `./scheduler`, `./loop`, `./daemon`, `./sqlite-state`, `./runtime-data`
- Runtime tests: 5

  - cross-runner happy path stores iteration/codex and review/claude session ids independently
  - review writing changes_requested returns to iteration before review runs again
  - invalid review session id clears only review/claude and the next review spawn is fresh
  - invalid review session id on opencode clears only review/opencode and the next review spawn is fresh
  - exhausts on the declared attempt budget

### `src/scheduler.daemon.integration.ts`

- Layer: **integration**
- Direct code boundary: `./daemon`, `./scheduler`, `./runtime-paths`, `./sqlite-state`, `./loop`, `./runtime-data`
- Runtime tests: 6

  - forced spawn failures over thirty scheduler seconds are capped by persisted exponential backoff
  - item without per-issue handoff binds shared handoff and empty current issue file
  - stopped chain does not block another active chain in the same scheduler tick
  - completed chain removes its real git worktree registration and local directory
  - counts one retry cycle in the declared attempt unit
  - daemon restart after crash recovers in-flight item through observable socket status

### `src/scheduler.integration-suite.ts`

- Layer: **integration**
- Direct code boundary: `./scheduler`, `./daemon`, `./loop`, `./runtime-paths`, `./sqlite-state`, `./observability`, `./runtime-data`
- Runtime tests: 112

  - scheduler > execution content identity uses the canonical compiled source bundle hash
  - scheduler > runtime identity event chain starts from the canonical scheduler-persisted task-node identity
  - scheduler > runtime identity event conversion rejects a missing durable run join
  - scheduler > runner projections reach scheduler fresh and resume paths for every runner
  - scheduler > rejects successful scheduler completion when terminal persistence fails
  - scheduler > reports timeout event persistence failure without skipping termination
  - scheduler > reports lifecycle event persistence failures exhaustively
  - scheduler > context body is opaque to scheduling
  - scheduler > fixture worktree carries its own immutable closure branch identity
  - scheduler > single chain single repo serial
  - scheduler > single chain multi repo concurrent
  - scheduler > invalid chain names are ignored by scheduler ticks
  - scheduler > run preparation failure is contained
  - scheduler > active-child final trigger preparation abort remains retryable
  - scheduler > chain preparation failure does not starve sibling chain
  - scheduler > contained spawn failure releases repo scheduling
  - scheduler > multi chain same repo worktree isolation
  - scheduler > slot busy skip
  - scheduler > advance after terminal
  - scheduler > chain completion
  - scheduler > completed chain worktree cleanup is idempotent after prior removal
  - scheduler > chain-complete trigger runs before chain completion
  - scheduler > chain-complete trigger does not run twice during overlapping completion ticks
  - scheduler > chain-complete trigger can keep chain active
  - scheduler > manual terminal item update completes chain on next tick
  - scheduler > terminated child preserves user terminal item status
  - scheduler > same-chain same-repo SIGTERM retry cycle does not starve untouched sibling item
  - scheduler > default maxItemAttempts exhausts a continuable item at twenty attempts before spawning
  - scheduler > maxItemAttempts metadata override exhausts a continuable item before spawning and emits queue.terminal
  - scheduler > attempts-exhausted落点 status comes from the preset and emits an audit/engine event (#402, #411)
  - scheduler > failed spawns enter exponential backoff and a held item does not starve a sibling
  - scheduler > failed-spawn backoff persists across scheduler state restart
  - scheduler > failed-spawn default backoff sequence is 60, 120, 240, 480, then capped at 480 seconds
  - scheduler > failed-spawn backoff option override preserves a custom cadence
  - scheduler > forced failure fixture does not spin at 1Hz: thirty seconds spawn once before sixty-second backoff
  - scheduler > empty active chain remains active
  - scheduler > empty preset success statuses do not fall back to done for dependency unblock
  - scheduler > loadPreset rejects a preset that omits statuses.exhausted (#402: required, no opt-out)
  - scheduler > completed chain skipped
  - scheduler > stopped chain skipped
  - scheduler > resumed stopped chain is schedulable again
  - scheduler > deleted chain skipped
  - scheduler > real subprocess spawn end-to-end
  - scheduler > streams scheduler runner output without retaining full history
  - scheduler > scheduler run writes run-root artifacts
  - scheduler > scheduler emits phase.start / phase.end / queue.terminal with the expected payload
  - scheduler > non-terminal phase exit does not emit queue.terminal
  - scheduler > zero-output runner is killed at the startup idle threshold and keeps retry semantics
  - scheduler > rate-limit exit arms cooldown, emits event, fires callback, and does not consume an attempt
  - scheduler > runner that crosses the startup progress threshold outlives the idle window
  - scheduler > cooldown-armed state pauses tick spawn until reset elapses
  - scheduler > codex spawns inherit a default RUST_LOG while claude spawns do not
  - scheduler > CODER_LOOP_CODEX_RUST_LOG override controls or disables the codex RUST_LOG injection
  - scheduler > rate-limit exit preserves the sessionId and the next spawn resumes from it
  - scheduler reads the agent-written item status (v1 status model) > a terminal status the agent writes is recorded as the item's truth
  - scheduler reads the agent-written item status (v1 status model) > an iteration summary leaves the item continuable through phase order
  - scheduler reads the agent-written item status (v1 status model) > when the agent writes no status the item keeps its entry status
  - scheduler reads the agent-written item status (v1 status model) > the scheduler records the written status even when stdout carries a different SUMMARY verdict
  - scheduler reads the agent-written item status (v1 status model) > an item the agent keeps marking changes_requested is re-spawned across ticks
  - scheduler per-item phase advancement (issue #289) > AC3: queued item → first tick spawns iter phase and leaves item status unchanged
  - scheduler per-item phase advancement (issue #289) > unfinished current phase run blocks first-phase re-selection without a status lock
  - scheduler per-item phase advancement (issue #289) > AC4: completed iteration run → next tick spawns review without status-literal handoff
  - scheduler per-item phase advancement (issue #289) > custom three-step preset advances through the middle non-trigger phase
  - scheduler per-item phase advancement (issue #289) > AC5: daemon restart (no current run) at phase boundary — next tick spawns review only, does NOT re-spawn iter
  - scheduler per-item phase advancement (issue #289) > no-status review exit retries review for the same item
  - scheduler per-item phase advancement (issue #289) > changes_requested + phase=review → next tick retries iteration, not review
  - scheduler per-item phase advancement (issue #289) > changes_requested + phase=iteration → next tick still retries iteration
  - scheduler per-item phase advancement (issue #289) > AC6: completed iteration run followed by review accepted → item terminal=done, next tick does NOT spawn
  - scheduler item-level trigger phase advancement (issue #290) > AC2: blocked + phase=review → next tick spawns blocked-responder trigger phase
  - scheduler item-level trigger phase advancement (issue #290) > trigger phase terminal: blocked item triggered, phase exit 0 keeps terminal status and is not pulled back into iteration
  - scheduler item-level trigger phase advancement (issue #290) > AC4: blocked + phase=iteration (no matching trigger phase) → no spawn, chain proceeds to completion
  - scheduler item-level trigger phase advancement (issue #290) > dependsOn unblock: terminal item with all deps in success terminal is restored to actionable, next tick selects iteration
  - scheduler item-level trigger phase advancement (issue #290) > dependsOn unblock: item is NOT awakened when a dep is in-flight or ends in a non-success terminal status
  - scheduler item-level trigger phase advancement (issue #290) > dependsOn unblock: chain with an item whose dep is still in-flight is not completed
  - scheduler item-level trigger phase advancement (issue #290) > dependsOn unblock e2e: blocker chain reaching done auto-recovers the cross-chain blocked item to done with no manual intervention
  - scheduler item-level trigger phase advancement (issue #290) > race: review writes blocked, chain stays active until item-level trigger spawns
  - scheduler item-level trigger phase advancement (issue #290) > integration: real subprocess spawn for blocked-responder trigger phase
  - scheduler loaded preset prompt rendering > scheduler spawn renders loaded preset prompt before subprocess (entry md prose preserved, {{KEY}} placeholders replaced)
  - scheduler chain bindings (issue #288) > preset.toml declares CHAIN_NAME / CHAIN_UMBRELLA_REPO / CHAIN_UMBRELLA_ISSUE / REPO_CWD in every actionable phase (AC4, post-#457)
  - scheduler chain bindings (issue #288) > renderSchedulerSpawnPrompt against a template that references every declared iteration binding leaves zero residual {{[A-Z_]+}} tokens (AC2)
  - scheduler chain bindings (issue #288) > renderSchedulerSpawnPrompt with chain.name=my-chain umbrellaRepo=owner/repo umbrellaIssue=42 substitutes those literals (AC3, post-#457)
  - scheduler chain bindings (issue #288) > renderSchedulerSpawnPrompt leaves chain.umbrellaRepo and chain.umbrellaIssue empty when metadata.bindings has no umbrella entries
  - scheduler chain bindings (issue #288) > scheduler spawn end-to-end: chain literals reach agent stdout via echo runner (AC5 fixture-style integration)
  - scheduler per-phase runner selection (issue #287) > spawnSchedulerRun routes phase=iteration through phaseRunner and uses returned binary for spawn (AC2 iter)
  - scheduler per-phase runner selection (issue #287) > spawnSchedulerRun routes phase=review through phaseRunner and uses returned binary for spawn (AC2 review)
  - scheduler per-phase runner selection (issue #287) > falls back to options.runner when phaseRunner is not configured (backward compat)
  - scheduler per-phase runner selection (issue #287) > contains missing runner failure with diagnostic, backoff, and spawn.aborted
  - scheduler per-phase runner selection (issue #287) > resolvePhaseRunnerFromChain > chain default → iteration phase returns codex with binary 'codex'
  - scheduler per-phase runner selection (issue #287) > resolvePhaseRunnerFromChain > chain default → review phase returns codex with the preset-declared model
  - scheduler per-phase runner selection (issue #287) > resolvePhaseRunnerFromChain > chain metadata codex.model overrides the preset-declared review model
  - scheduler per-phase runner selection (issue #287) > resolvePhaseRunnerFromChain > item.runner='claude' overrides codex iteration default for non-review phase
  - scheduler per-phase runner selection (issue #287) > resolvePhaseRunnerFromChain > chain default → triggered/finalizer phase resolves to its preset codex runner
  - scheduler per-phase runner selection (issue #287) > resolvePhaseRunnerFromChain > preset-declared review model flows into review args via buildRunnerInvocation
  - scheduler per-phase runner selection (issue #287) > AC5 integration: chain-based phaseRunner honors item claude override on every non-trigger phase (iteration + review), regardless of phase name
  - runPresetChainCompleteTriggerPhases per-phase runner selection (issue #287 retry) > streams chain-complete runner output without retaining full history
  - runPresetChainCompleteTriggerPhases per-phase runner selection (issue #287 retry) > default chain metadata → triggered phase 'umbrella-finalizer' spawns preset codex via chain-derived selectRunnerForPhase
  - runPresetChainCompleteTriggerPhases per-phase runner selection (issue #287 retry) > phaseRunner override input wins over chain-derived selection for the triggered phase spawn
  - scheduler session-id resume (issue #291 / #311) > first spawn (no session id for phase/runner): buildRunnerInvocation argv has no --resume; rendered prompt's RESUMED_SESSION_ID is empty (AC6)
  - scheduler session-id resume (issue #291 / #311) > resume spawn (phase/runner session id set): buildRunnerInvocation argv contains --resume <id>; rendered prompt embeds the session id literal (AC4 / AC5)
  - scheduler session-id resume (issue #291 / #311) > codex resume spawn (phase/runner session id set): buildRunnerInvocation argv shape includes `resume <sessionId>` subcommand
  - scheduler session-id resume (issue #291 / #311) > resumeDecisionForItem selects only the current phase/runner session id (issue #311 AC3 / AC4)
  - scheduler session-id resume (issue #291 / #311) > selectNextPendingItemFromSnapshot ignores priority, follows queue position (issue #339 AC1)
  - scheduler session-id resume (issue #291 / #311) > selectNextPendingItemFromSnapshot returns the item reordered to position 0 (issue #339 AC3)
  - scheduler session-id resume (issue #291 / #311) > end-to-end (claude runner): session-id parsed from stdout first line is persisted to the phase/runner slot (AC3)
  - scheduler session-id resume (issue #291 / #311) > end-to-end composition: seeded phase/runner session id reaches subprocess argv as --resume <id> (AC7 wire-level proxy)
  - scheduler session-id resume (issue #291 / #311) > end-to-end (codex runner): codex thread.started event id is persisted to the phase/runner slot after exit
  - scheduler session-id resume (issue #291 / #311) > end-to-end two-phase run stores iteration/codex and review/claude session ids separately (issue #311 AC2 / AC3)
  - scheduler session-id resume (issue #291 / #311) > session-id-invalid stderr clears the phase/runner slot and the next spawn is fresh (issue #312 AC3)
  - scheduler session-id resume (issue #291 / #311) > normal non-invalid stderr updates the phase/runner session id instead of clearing it (issue #312 AC4)
  - scheduler session-id resume (issue #291 / #311) > makeRunId phase segment (issue #294) > phase is embedded in the runId so iter and review spawns never collide on the same item
  - scheduler session-id resume (issue #291 / #311) > makeRunId phase segment (issue #294) > phase name with unsafe characters is sanitized into a path-safe segment
  - per-run summary tag > renderSchedulerSpawnPrompt resolves business-key-example fixture preset's preset-supplied literal

### `src/scheduler.worktree.integration.ts`

- Layer: **integration**
- Direct code boundary: `./scheduler`, `./sqlite-state`, `./loop`, `./runtime-data`
- Runtime tests: 3

  - killed-run slot worktree holding the slot branch is self-healed from a new loop-data root
  - worktree registered but directory missing is pruned and recreated
  - worktree create failure is contained: backoff + schedulerSpawnError in extra, cleared on next successful spawn

### `src/smoke.integration.ts`

- Layer: **integration**
- Direct code boundary: `./daemon`, `./sqlite-state`, `./observability`, `./runtime-data`, `./runner-output`
- Runtime tests: 7

  - smoke: v2 central chain CLI > bounds runner memory while preserving large output artifacts
  - smoke: v2 central chain CLI > no-subcommand invocation is usage-only and does not enter a loop
  - smoke: v2 central chain CLI > chain set-runner-model patches chain.metadata.<kind>.model idempotently (#526)
  - smoke: v2 central chain CLI > chain set-runner-model rejects bogus --kind / empty / whitespace --model at parse time (#526)
  - smoke: v2 central chain CLI > status and queue unblock use SQLite state
  - smoke: v2 central chain CLI > queue unblock emits operator-subject caller-admission audit (#406 row 4)
  - smoke: v2 central chain CLI > daemon start dry-run resolves a chain and emits central-daemon plan

### `src/sqlite-state.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./sqlite-state`, `./loop`, `./task-runtime`, `./runtime-data`, `./issue-558-historical-fixture`
- Runtime tests: 46

  - sqlite state store > canonical historical runtime fixture preserves v13 and v14 foreign keys
  - sqlite state store > schema covers chain core columns (umbrella retired #457)
  - sqlite state store > fresh and migrated normalized runtime use the same runs schema
  - sqlite state store > closure active run round-trip
  - sqlite state store > existing task root materializes every phase for a newly encountered item with stable identities
  - sqlite state store > nested task tree round-trip
  - sqlite state store > nested task tree enforces each closure source par against its actual parent
  - sqlite state store > nested task tree seq cursor accepts only a direct child
  - sqlite state store > closure lifecycle preserves suspended resources and only consumed permits absence
  - sqlite state store > run closure identity survives active relation cleanup
  - sqlite state store > closure active run rejects conflicts and mismatches through typed errors
  - sqlite state store > closure active run permits sibling closures and clears only the selected run
  - sqlite state store > join binding and evaluation persisted shape round-trips
  - sqlite state store > durable run SQLite ingress rejects undeclared columns
  - sqlite state store > v13 to v14 migrates normalized runtime before reads
  - sqlite state store > normalized runtime delete advances a migrated seq cursor to the surviving direct child
  - sqlite state store > normalized runtime migration resolves persisted preset once and survives source removal
  - sqlite state store > normalized runtime migration rejects missing unreadable or invalid persisted preset declarations
  - sqlite state store > closure active run rejects completed run reactivation
  - sqlite state store > main v14 context database migrates normalized runtime without losing context
  - sqlite state store > items round-trip
  - sqlite state store > item session id helpers isolate values by phase and runner
  - sqlite state store > chains round-trip
  - sqlite state store > chains support stopped lifecycle status
  - sqlite state store > data access CRUD next pending and terminal status
  - sqlite state store > deleteItem removes normalized leaf ownership and run history
  - sqlite state store > next pending follows queue position regardless of attempts
  - sqlite state store > reorderItem renumbers queue positions and drives selection
  - sqlite state store > dependsOn gates pending item selection
  - sqlite state store > dependsOn releases item after dependency terminal status
  - sqlite state store > cross-chain dependency resolves through the global store, not the per-chain snapshot
  - sqlite state store > createItems happy path inserts every input atomically
  - sqlite state store > createItems rolls back the whole batch when a mid-batch insert violates UNIQUE
  - sqlite state store > wal mode
  - sqlite state store > concurrent reader continues while another connection has a writer transaction
  - sqlite state store > db unavailable explicit error
  - sqlite state store > phase migration is idempotent across repeated opens (issue #289 AC2)
  - sqlite state store > phase migration adds column to pre-v2 DB created without phase (issue #289 AC2)
  - sqlite state store > runs status migration adds canonical column without legacy extra-status backfill
  - sqlite state store > item session schema is idempotent across repeated opens
  - sqlite state store > v6 to v7 migration rebuilds chain status check for stopped
  - sqlite state store > v10 to v11 migration moves chains.umbrella_issue / umbrella_repo into metadata.bindings (acceptance row 4, #457)
  - sqlite state store > v11 to v12 migration retires issue_number/branch/pr into extra and item_id (acceptance row 1, #419)
  - sqlite state store > items table allows opencode runner after v12 to v13 migration (acceptance row 8, #481)
  - sqlite state store > v5 to v6 migration maps legacy last_session_id by current phase and chain runner (issue #330 AC8)
  - sqlite state store > pre-v3 item schema migration adds session_ids without reintroducing last_session_id

### `src/task-runtime.test.ts`

- Layer: **unit/component**
- Direct code boundary: `./task-runtime`
- Runtime tests: 2

  - task runtime exact boundary > rejects undeclared keys recursively across task runtime variants
  - task runtime exact boundary > rejects undeclared keys in seq, par, join and evaluation records

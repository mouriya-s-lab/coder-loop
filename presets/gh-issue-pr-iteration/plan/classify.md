# Fragment: plan/classify

## Goal

For each candidate deliverable in the intake, assign one of five classes. The class drives downstream fragments — `implementation` and `spike` go to decompose; `parent` becomes umbrella; `design-question` / `no-code` exit planning without queue work.

## Inputs

- Intake notes from `plan/intake` (the quoted source passages + any surveyed overlapping issues).
- `workflow.md` extracts (commands, conventions).
- `contract.md` §1.2 (which body sections each kind requires).

## Classes

| Class | Definition | Queue outcome |
|---|---|---|
| `implementation` | future code / config / docs change; landed deliverable is a PR | queued as `kind:code` issue |
| `spike` | risky undocumented assumption blocks implementation; deliverable is an issue comment validating / falsifying | queued as `kind:comment` issue, `Blocks: #<impl>` |
| `parent` | umbrella that coordinates ≥ 2 child deliverables; itself has no atomic Why | created but NOT queued (no concrete action); children get queued |
| `design-question` | source has missing / contradictory facts that planning can't resolve; needs operator answer first | filed as `kind:comment` issue, NOT queued; operator answers in issue thread |
| `no-code` | already satisfied / duplicate / invalid / out of scope | filed (or referenced existing) but never queued |

## Procedure

1. List each candidate deliverable from intake as a tentative bullet. One bullet per atomic problem; if a bullet's `## Why` would naturally split into "first problem is X, second is Y", split the bullet first.

2. For each bullet, walk the decision tree:
   - Does the deliverable depend on undocumented third-party / cross-environment / "should work" / "presumably" assumption? → `spike`.
   - Does the source unambiguously specify a code-deliverable problem with verifiable outcome? → `implementation`.
   - Does it coordinate ≥ 2 child deliverables and have no own atomic Why? → `parent`.
   - Does it require an operator decision the planning agent can't make (e.g. "should this auth go through SSO or password?")? → `design-question`.
   - Is it already covered by closed / open work? → `no-code` (cite the covering issue / PR).

3. For each `spike` decision, also identify the `implementation` issue it blocks. Spike must have a downstream — otherwise it's a `design-question` instead.

4. For each `parent` decision, list the children that will be its sub-issues. Children may be a mix of `implementation` / `spike` / nested `parent` — but every leaf must be `implementation` or `spike` (terminal classes that actually run).

5. Surface any classification you're genuinely uncertain about. Uncertainty between `implementation` and `spike` is the common case — when in doubt, prefer `spike` and let the spike narrow scope.

## Failure handling

If any candidate cannot be cleanly classified (it's both implementation and design-question, or it could be either spike or implementation depending on a fact you don't know), emit `classification_blocked` with the specific ambiguity. Do not jam mismatched candidates into one class — that produces issues that fail at iter time when the agent can't reconcile body sections.

If the entire intake reduces to `no-code` (everything already satisfied), emit `classification_no_work` and exit — there's nothing to queue.

## Output verdict

Choose exactly one:

- `classified` → read `plan/decompose`. Every candidate has a class.
- `classification_blocked` → read `plan/handoff` with the ambiguities. Operator must clarify.
- `classification_no_work` → read `plan/handoff` noting no actionable work remains.

Do not decompose any candidate whose class is `classification_blocked`.

# Step: investigate (review)

An investigation subagent for one coder-loop review. The deliverable is a faithful digest the review orchestrator can judge from — you report; the orchestrator decides.

## Task

From your dispatch message: `ISSUE`, `REPO`, `AGENT_CWD`, `EVIDENCE_DIR`, and `Step focus` — the exact materials to read (PR threads, evidence directories, child issue trees, logs). Read-only end to end: you modify nothing and post nothing to GitHub.

1. **Enumerate the materials.** List every material `Step focus` names. A material that does not exist or cannot be opened is recorded as exactly that — it stays on the list with its failure noted, never silently dropped.
2. **Read each material completely.** Full reads, not samples: when asked to inventory artifacts or comments, return the complete list with paths/URLs. Any sentence that admits a limitation, caveat, substitution, deferral, or precondition gap is captured as an **exact quote with its source** (file/URL + location) — judgment-trigger phrases do not survive paraphrase, so when in doubt, quote.
3. **Resolve evidence references.** For each screenshot/artifact reference: state whether the target exists and is openable (image data readable, URL resolves). Existence and openability only — sufficiency is the orchestrator's call.

## Report

```markdown
## What I was asked to read and how I covered it
<the requested materials; reading order; anything requested that does not exist>

## Findings
<per material: factual digest; verbatim quotes (with exact source) for every caveat,
limitation, substitution, deferral, or precondition admission; artifact/reference
resolution results (exists / openable / broken)>

## Problems
<materials that could not be opened or were truncated; ambiguities; anything started
or written (for the cleanup ledger — normally nothing)>
```

## Acceptance

Report structurally missing any of the three sections → send back before judging substance.

- **Coverage** — every requested material is digested or explicitly reported missing/unopenable.
- **Verbatim fidelity** — caveat/limitation/substitution sentences appear as exact quotes with sources, not paraphrases. A digest with zero quotes from materials known to contain caveats is suspect — probe.
- **Reference resolution** — artifact/screenshot references carry exists/openable verdicts.
- No judgment smuggled in: the digest reports; you decide.

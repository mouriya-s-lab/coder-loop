# Enrichment task

1. Fetch the complete issue body, comments, timeline, linked PR metadata and checks. Exhaust pagination.
2. Inspect the local checkout rather than using GitHub blobs as source.
3. Read target rules and identify the real build, test, startup, runtime and E2E entry points.
4. Convert intent into typed executable rows. A shell check is not a browser action; a canonical script that drives the real runtime is not rejected merely because it is a script.
5. Derive Pattern scope from the actual requested change and current tree. Do not force the issue author to have predicted source sites that only this investigation exposes.
6. State whether tests may change and what integrity constraints survive. Never authorize weakening assertions just to pass.
7. Identify deliverable route and external dependencies.
8. If a current marker already exists for the same source revision, verify it and update only by posting a new superseding marker when facts changed. Never create two simultaneously-current markers.

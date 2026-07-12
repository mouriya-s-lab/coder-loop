# Re-enrich an invalid executable contract

Use only when the current GitHub marker packet itself is missing, malformed, stale after an operator correction, internally contradictory, or lacks a fact that requires source/runtime investigation. Do not use this for implementation defects, failed evidence, PR protocol errors or code-review findings.

1. Post one PR-thread review comment separating the contract defect from all implementation findings and citing the exact marker URL/section.
2. Do not edit the original issue body and do not invent the corrected contract yourself.
3. Select the declared `contract_invalid` item-status exit. The preset frontier returns to `contract-enrichment`; its new marker must supersede the old marker before iteration resumes.

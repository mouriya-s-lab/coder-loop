# Retry action

Publish one executable defect packet naming the failed invariant, evidence, owning phase, exact acceptance condition, and prior identical-gap count. Use retry_contract for packet defects — run-head, phase, or child-state advancement produced by the run's own expected progress is not a packet defect and never grounds retry_contract. Use retry_prepare for any live-site reconstruction, retry_export only for committed-evidence reindexing, retry_restore for cleanup proof, and retry_writeback for findings/design gaps. Never use a narrow retry when its prerequisite no longer exists.

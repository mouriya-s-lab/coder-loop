import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { type as arkType } from "arktype"
import { Context, Effect, Layer } from "effect"
import type { BoundaryRecord } from "../boundary-types"
import type { AgentRunAuthority, FunctionCheckpoint } from "./context"
import {
	factKey,
	evaluateAdmission,
	groupKey,
	nextGroupState,
	taskKey,
	type AdmissionRequest,
	type AdmissionResult,
	type AwaitIdentity,
	type AwaitRecord,
	type CommittedTransition,
	type ObjectDomainSnapshot,
	type Task,
	type TaskGroup,
} from "./object-domain"
import {
	encodePersisted,
	parsePersistedAwait,
	parseFunctionCheckpoint,
	parsePersistedGroup,
	parsePersistedTask,
	type PersistenceParseError,
} from "./persistence"

const SCHEMA_VERSION = 3
const PayloadRowBoundary = arkType({ payload: "string" })
const IdentityPayloadRowBoundary = arkType({ identity_key: "string", chain_key: "string", payload: "string" })
const IdentityRowBoundary = arkType({ identity_key: "string" })
const TransitionRowBoundary = arkType({ chain_key: "string", family: "string", payload: "string" })

type SqlParams = Record<string, string | number | bigint | boolean | null | Uint8Array>

type TransitionRejectionReason =
	| "already-exists"
	| "not-found"
	| "state-mismatch"
	| "run-mismatch"
	| "identity-mismatch"
	| "position-mismatch"
	| "dependency-unsettled"
	| "deadline-mismatch"
	| "settlement-mismatch"
	| "publication-mismatch"
	| "invalid-transition"

export type ObjectStoreError =
	| { readonly kind: "store-io"; readonly operation: string; readonly message: string }
	| { readonly kind: "store-schema"; readonly reason: "legacy-schema" | "version-mismatch" | "persisted-shape-invalid"; readonly message: string }
	| { readonly kind: "transition-rejected"; readonly family: CommittedTransition["family"] | "bootstrap"; readonly reason: TransitionRejectionReason; readonly message: string }

export type TransitionRequest = {
	readonly identity: string
	readonly transition: CommittedTransition
}

export type CommitResult =
	| { readonly kind: "committed"; readonly identity: string }
	| { readonly kind: "already-committed"; readonly identity: string }
export type AdmissionStoreResult =
	| { readonly kind: "admitted"; readonly admission: Extract<AdmissionResult, { kind: "admitted" }>; readonly commit: CommitResult }
	| Extract<AdmissionResult, { kind: "rejected" }>


export type CommittedTransitionAudit = {
	readonly identity: string
	readonly family: CommittedTransition["family"]
	readonly committedAt: number
}

export type ObjectDomainStoreService = {
	readonly bootstrap: (snapshot: ObjectDomainSnapshot) => Effect.Effect<void, ObjectStoreError>
	readonly readSnapshot: (chain: ObjectDomainSnapshot["chain"]) => Effect.Effect<ObjectDomainSnapshot, ObjectStoreError>
	readonly commit: (request: TransitionRequest) => Effect.Effect<CommitResult, ObjectStoreError>
	readonly listChains: Effect.Effect<readonly ObjectDomainSnapshot["chain"][], ObjectStoreError>
	readonly listTransitions: (chain: ObjectDomainSnapshot["chain"], since: number) => Effect.Effect<readonly CommittedTransitionAudit[], ObjectStoreError>
	readonly readFunctionCheckpoint: (run: AgentRunAuthority) => Effect.Effect<FunctionCheckpoint | null, ObjectStoreError>
	readonly admit: (chain: ObjectDomainSnapshot["chain"], request: AdmissionRequest) => Effect.Effect<AdmissionStoreResult, ObjectStoreError>
	readonly writeFunctionCheckpoint: (checkpoint: FunctionCheckpoint) => Effect.Effect<void, ObjectStoreError>
}

export class ObjectDomainStore extends Context.Tag("coder-loop/v3/ObjectDomainStore")<ObjectDomainStore, ObjectDomainStoreService>() {}

export function makeObjectDomainStoreLive(databaseFile: string): Layer.Layer<ObjectDomainStore, ObjectStoreError> {
	return Layer.scoped(ObjectDomainStore, Effect.acquireRelease(
		Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(databaseFile), { recursive: true })
				const database = new Database(databaseFile, { create: true, strict: true })
				configureDatabase(database)
				return makeService(database)
			},
			catch: (error) => error instanceof StoreAbort ? error.detail : storeIo("open", error),
		}),
		(service) => Effect.sync(() => service.close()),
	))
}

function makeService(database: Database): ObjectDomainStoreService & { readonly close: () => void } {
	return {
		bootstrap: (snapshot) => attempt("bootstrap", () => bootstrap(database, snapshot)),
		readSnapshot: (chain) => attempt("read-snapshot", () => readSnapshot(database, chain)),
		commit: (request) => attempt("commit", () => commit(database, request)),
		listChains: attempt("list-chains", () => listChains(database)),
		listTransitions: (chain, since) => attempt("list-transitions", () => listTransitions(database, chain, since)),
		readFunctionCheckpoint: (run) => attempt("read-function-checkpoint", () => readFunctionCheckpoint(database, run)),
		writeFunctionCheckpoint: (checkpoint) => attempt("write-function-checkpoint", () => writeFunctionCheckpoint(database, checkpoint)),
		admit: (chain, request) => attempt("admit", () => admit(database, chain, request)),
		close: () => database.close(),
	}
}

function configureDatabase(database: Database): void {
	database.exec("PRAGMA foreign_keys = ON")
	database.exec("PRAGMA busy_timeout = 5000")
	const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()
	if (journal?.journal_mode.toLowerCase() !== "wal") throw new Error(`expected WAL, got ${journal?.journal_mode ?? "missing"}`)
	const existingTables = database.query<BoundaryRecord, []>("SELECT name AS identity_key FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
		.map((row) => IdentityRowBoundary.assert(row).identity_key)
	const allowedTables = new Set(["v3_meta", "v3_chains", "v3_groups", "v3_tasks", "v3_awaits", "v3_facts", "v3_transitions", "v3_function_checkpoints"])
	if (existingTables.some((table) => !allowedTables.has(table)) || (existingTables.length > 0 && !existingTables.includes("v3_meta"))) {
		throw new StoreAbort({ kind: "store-schema", reason: "legacy-schema", message: "v3 store refuses to interpret a legacy or mixed schema" })
	}
	database.exec(`
		CREATE TABLE IF NOT EXISTS v3_meta (schema_version INTEGER NOT NULL CHECK (schema_version = 3));
		CREATE TABLE IF NOT EXISTS v3_chains (chain_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS v3_groups (group_key TEXT PRIMARY KEY, chain_key TEXT NOT NULL REFERENCES v3_chains(chain_key) ON DELETE CASCADE, payload TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS v3_tasks (task_key TEXT PRIMARY KEY, chain_key TEXT NOT NULL REFERENCES v3_chains(chain_key) ON DELETE CASCADE, group_key TEXT NOT NULL REFERENCES v3_groups(group_key), payload TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS v3_awaits (await_key TEXT PRIMARY KEY, chain_key TEXT NOT NULL REFERENCES v3_chains(chain_key) ON DELETE CASCADE, payload TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS v3_facts (fact_key TEXT PRIMARY KEY, chain_key TEXT NOT NULL REFERENCES v3_chains(chain_key) ON DELETE CASCADE, task_key TEXT NOT NULL REFERENCES v3_tasks(task_key));
		CREATE TABLE IF NOT EXISTS v3_transitions (identity_key TEXT PRIMARY KEY, chain_key TEXT NOT NULL REFERENCES v3_chains(chain_key) ON DELETE CASCADE, family TEXT NOT NULL, payload TEXT NOT NULL, committed_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS v3_function_checkpoints (run_key TEXT PRIMARY KEY, chain_key TEXT NOT NULL REFERENCES v3_chains(chain_key) ON DELETE CASCADE, payload TEXT NOT NULL);
	`)
	const version = database.query<{ schema_version: number }, []>("SELECT schema_version FROM v3_meta").get()
	if (version === null) database.query<never, { version: number }>("INSERT INTO v3_meta (schema_version) VALUES ($version)").run({ version: SCHEMA_VERSION })
	else if (version.schema_version !== SCHEMA_VERSION) throw new StoreAbort({ kind: "store-schema", reason: "version-mismatch", message: `expected schema ${SCHEMA_VERSION}, got ${version.schema_version}` })
}

function bootstrap(database: Database, snapshot: ObjectDomainSnapshot): void {
	const run = database.transaction(() => {
		const chain = snapshot.chain.value
		if (exists(database, "v3_chains", "chain_key", chain)) reject("bootstrap", "already-exists", `chain ${chain} already exists`)
		database.query<never, SqlParams>("INSERT INTO v3_chains (chain_key,payload) VALUES ($key,$payload)").run({ key: chain, payload: JSON.stringify(snapshot.chain) })
		for (const group of Object.values(snapshot.groups)) insertGroup(database, group)
		for (const task of Object.values(snapshot.tasks)) insertTask(database, task)
		for (const record of Object.values(snapshot.awaits)) insertAwait(database, chain, record)
		for (const [key, task] of Object.entries(snapshot.admittedFacts)) {
			database.query<never, SqlParams>("INSERT INTO v3_facts (fact_key,chain_key,task_key) VALUES ($fact,$chain,$task)").run({ fact: key, chain, task: taskKey(task) })
		}
	})
	run.immediate()
}

function listChains(database: Database): readonly ObjectDomainSnapshot["chain"][] {
	return database.query<BoundaryRecord, []>("SELECT payload FROM v3_chains ORDER BY chain_key").all().map((row) => {
		const payload = PayloadRowBoundary(row)
		if (payload instanceof arkType.errors) throw new Error(payload.summary)
		const parsed = arkType({ kind: "'chain'", value: "string > 0", "+": "reject" })(parseJson(payload.payload))
		if (parsed instanceof arkType.errors) throw new Error(parsed.summary)
		return parsed
	})
}

function readSnapshot(database: Database, chain: ObjectDomainSnapshot["chain"]): ObjectDomainSnapshot {
	if (!exists(database, "v3_chains", "chain_key", chain.value)) reject("bootstrap", "not-found", `chain ${chain.value} not found`)
	const tasks = Object.fromEntries(readIdentityPayloads(database, "v3_tasks", "task_key", chain.value).map((row) => {
		const parsed = parsePersistedTask(parseJson(row.payload))
		if (parsed.kind === "rejected") throw persistedShape(parsed.error)
		const identity = taskKey(parsed.value.identity)
		requirePersistedIdentity("task", row, identity, parsed.value.identity.chain.value)
		return [identity, parsed.value]
	}))
	const groups = Object.fromEntries(readIdentityPayloads(database, "v3_groups", "group_key", chain.value).map((row) => {
		const parsed = parsePersistedGroup(parseJson(row.payload))
		if (parsed.kind === "rejected") throw persistedShape(parsed.error)
		const identity = groupKey(parsed.value.identity)
		requirePersistedIdentity("group", row, identity, parsed.value.identity.chain.value)
		return [identity, parsed.value]
	}))
	const awaits = Object.fromEntries(readIdentityPayloads(database, "v3_awaits", "await_key", chain.value).map((row) => {
		const parsed = parsePersistedAwait(parseJson(row.payload))
		if (parsed.kind === "rejected") throw persistedShape(parsed.error)
		const identity = awaitKey(parsed.value.identity)
		requirePersistedIdentity("await", row, identity, parsed.value.identity.parent.chain.value)
		return [identity, parsed.value]
	}))
	const admittedFacts = Object.fromEntries(database.query<BoundaryRecord, SqlParams>("SELECT fact_key AS identity_key,task_key FROM v3_facts WHERE chain_key=$chain").all({ chain: chain.value }).map((row) => {
		const candidate = arkType({ identity_key: "string", task_key: "string" })(row)
		if (candidate instanceof arkType.errors) throw new Error(candidate.summary)
		const task = tasks[candidate.task_key]
		if (task === undefined) throw new Error(`fact points to missing task ${candidate.task_key}`)
		return [candidate.identity_key, task.identity]
	}))
	return { chain, tasks, groups, awaits, admittedFacts }
}
function listTransitions(database: Database, chain: ObjectDomainSnapshot["chain"], since: number): readonly CommittedTransitionAudit[] {
	const boundary = arkType({
		identity_key: "string",
		family: "'task-admission' | 'lease-acquire' | 'lease-release' | 'task-held' | 'task-unhold' | 'task-resume' | 'task-settlement' | 'await-suspension' | 'await-resumption' | 'group-waiting' | 'group-termination' | 'group-consumer-start' | 'group-consumption' | 'resource-intent'",
		committed_at: "number",
		"+": "reject",
	})
	return database.query<BoundaryRecord, SqlParams>(
		"SELECT identity_key,family,committed_at FROM v3_transitions WHERE chain_key=$chain AND committed_at >= $since ORDER BY committed_at,rowid",
	).all({ chain: chain.value, since }).map((row) => {
		const parsed = boundary(row)
		if (parsed instanceof arkType.errors) throw new Error(parsed.summary)
		return { identity: parsed.identity_key, family: parsed.family, committedAt: parsed.committed_at }
	})
}
function readFunctionCheckpoint(database: Database, run: AgentRunAuthority): FunctionCheckpoint | null {
	const row = database.query<BoundaryRecord, SqlParams>("SELECT payload FROM v3_function_checkpoints WHERE run_key=$key").get({ key: functionRunKey(run) })
	if (row === null) return null
	const payload = PayloadRowBoundary(row)
	if (payload instanceof arkType.errors) throw new Error(payload.summary)
	const parsed = parseFunctionCheckpoint(parseJson(payload.payload))
	if (parsed.kind === "rejected") throw persistedShape(parsed.error)
	return parsed.value
}

function writeFunctionCheckpoint(database: Database, checkpoint: FunctionCheckpoint): void {
	const run = database.transaction(() => {
		const row = database.query<BoundaryRecord, SqlParams>(
			"SELECT payload FROM v3_tasks WHERE task_key=$task AND chain_key=$chain",
		).get({ task: checkpoint.run.taskId, chain: checkpoint.run.chainId })
		if (row === null) reject("lease-acquire", "not-found", `task ${checkpoint.run.taskId} not found`)
		const payload = PayloadRowBoundary(row)
		if (payload instanceof arkType.errors) throw new Error(payload.summary)
		const parsed = parsePersistedTask(parseJson(payload.payload))
		if (parsed.kind === "rejected") throw persistedShape(parsed.error)
		const task = parsed.value
		const expectedClosure = `${taskKey(task.identity)}/${task.state.kind === "leased" ? task.state.run.closure.attempt : -1}`
		if (task.state.kind !== "leased"
			|| task.state.run.value !== checkpoint.run.runId
			|| taskKey(task.state.run.closure.task) !== checkpoint.run.taskId
			|| expectedClosure !== checkpoint.run.closureId) {
			reject("lease-acquire", "run-mismatch", "function checkpoint requires the matching live lease")
		}
		database.query<never, SqlParams>(
			"INSERT INTO v3_function_checkpoints (run_key,chain_key,payload) VALUES ($key,$chain,$payload) ON CONFLICT(run_key) DO UPDATE SET payload=excluded.payload",
		).run({ key: functionRunKey(checkpoint.run), chain: checkpoint.run.chainId, payload: JSON.stringify(checkpoint) })
	})
	run.immediate()
}

function functionRunKey(run: AgentRunAuthority): string {
	return run.closureId
}



function admit(database: Database, chain: ObjectDomainSnapshot["chain"], request: AdmissionRequest): AdmissionStoreResult {
	const identity = `admit:${request.fact.source}:${request.fact.value}`
	const task: Task = { ...request.task, state: { kind: "ready" }, closure: { kind: "unallocated" } }
	const transition: Extract<CommittedTransition, { family: "task-admission" }> = {
		family: "task-admission",
		fact: request.fact,
		task,
		position: request.position,
	}
	const run = database.transaction((): AdmissionStoreResult => {
		const replay = matchingTransition(database, identity, transition)
		if (replay !== null) return { kind: "admitted", admission: { kind: "admitted", task, position: request.position }, commit: replay }
		const admission = evaluateAdmission(readSnapshot(database, chain), request)
		if (admission.kind === "rejected") return admission
		const committedTransition: Extract<CommittedTransition, { family: "task-admission" }> = { ...transition, task: admission.task, position: admission.position }
		applyTransition(database, committedTransition)
		insertTransition(database, identity, committedTransition)
		return { kind: "admitted", admission, commit: { kind: "committed", identity } }
	})
	return run.immediate()
}

function matchingTransition(database: Database, identity: string, transition: CommittedTransition): CommitResult | null {
	const existing = database.query<BoundaryRecord, SqlParams>(
		"SELECT chain_key,family,payload FROM v3_transitions WHERE identity_key=$identity",
	).get({ identity })
	if (existing === null) return null
	const parsed = TransitionRowBoundary(existing)
	if (parsed instanceof arkType.errors) throw new Error(parsed.summary)
	const payload = JSON.stringify(transition)
	if (parsed.chain_key !== transitionChain(transition) || parsed.family !== transition.family || parsed.payload !== payload) {
		reject(transition.family, "identity-mismatch", `transition identity ${identity} is already bound to a different mutation`)
	}
	return { kind: "already-committed", identity }
}

function insertTransition(database: Database, identity: string, transition: CommittedTransition): void {
	database.query<never, SqlParams>("INSERT INTO v3_transitions (identity_key,chain_key,family,payload,committed_at) VALUES ($identity,$chain,$family,$payload,$now)").run({
		identity,
		chain: transitionChain(transition),
		family: transition.family,
		payload: JSON.stringify(transition),
		now: Date.now(),
	})
}

function commit(database: Database, request: TransitionRequest): CommitResult {
	const run = database.transaction((): CommitResult => {
		const replay = matchingTransition(database, request.identity, request.transition)
		if (replay !== null) return replay
		applyTransition(database, request.transition)
		insertTransition(database, request.identity, request.transition)
		return { kind: "committed", identity: request.identity }
	})
	return run.immediate()
}
function applyTransition(database: Database, transition: CommittedTransition): void {
	switch (transition.family) {
		case "task-admission":
			admitTask(database, transition, transition.family)
			return
		case "lease-acquire": {
			const task = requireTask(database, transition.task, transition.family)
			if (task.state.kind !== "ready") reject(transition.family, "state-mismatch", "task is not ready")
			for (const dependency of task.dependsOn) {
				if (requireTask(database, dependency, transition.family).state.kind !== "settled") reject(transition.family, "dependency-unsettled", taskKey(dependency))
			}
			if (taskKey(transition.run.closure.task) !== taskKey(task.identity) || closureKey(transition.closure.identity) !== closureKey(transition.run.closure)) reject(transition.family, "identity-mismatch", "run, closure, and task identities disagree")
			if (transition.expiresAt <= transition.acquiredAt) reject(transition.family, "invalid-transition", "lease expiry must follow acquisition")
			updateTask(database, { ...task, state: { kind: "leased", run: transition.run, acquiredAt: transition.acquiredAt, expiresAt: transition.expiresAt }, closure: transition.closure })
			return
		}
		case "lease-release": {
			const task = requireLeasedTask(database, transition.task, transition.run, transition.family)
			updateTask(database, { ...task, state: { kind: "ready" } })
			return
		}
		case "task-held": {
			const task = requireTask(database, transition.task, transition.family)
			if (transition.expectedRun === null) {
				if (task.state.kind !== "ready") reject(transition.family, "state-mismatch", "pre-spawn hold requires a ready task")
			} else {
				if (task.state.kind !== "leased" || runKey(task.state.run) !== runKey(transition.expectedRun)) reject(transition.family, "run-mismatch", "unknown-effect hold requires the matching lease")
			}
			updateTask(database, { ...task, state: { kind: "held", reason: transition.reason } })
			return
		}
		case "task-unhold": {
			const task = requireTask(database, transition.task, transition.family)
			if (task.state.kind !== "held") reject(transition.family, "state-mismatch", "task is not held")
			updateTask(database, { ...task, state: { kind: "ready" } })
			return
		}
		case "task-resume": {
			const task = requireTask(database, transition.task, transition.family)
			if (task.state.kind !== "held" || task.state.reason.kind !== "unknown-effect" || runKey(task.state.reason.run) !== runKey(transition.run)) {
				reject(transition.family, "run-mismatch", "task resume requires a held unknown effect with the matching run")
			}
			if (task.closure.kind !== "active") reject(transition.family, "state-mismatch", "resumed task requires active closure resources")
			if (transition.expiresAt <= transition.resumedAt) reject(transition.family, "invalid-transition", "resume expiry must follow resume time")
			updateTask(database, { ...task, state: { kind: "leased", run: transition.run, acquiredAt: transition.resumedAt, expiresAt: transition.expiresAt } })
			return
		}
		case "task-settlement": {
			const task = requireTask(database, transition.task, transition.family)
			const matchesLease = task.state.kind === "leased" && runKey(task.state.run) === runKey(transition.run)
			const matchesHold = task.state.kind === "held" && task.state.reason.kind === "unknown-effect" && runKey(task.state.reason.run) === runKey(transition.run)
			if (!matchesLease && !matchesHold) reject(transition.family, "run-mismatch", "task settlement requires the matching lease or unknown-effect hold")
			updateTask(database, { ...task, state: { kind: "settled", settlement: transition.settlement, settledAt: Date.now() } })
			for (const successor of transition.successors) admitTask(database, successor, transition.family)
			return
		}
		case "await-suspension": {
			const task = requireLeasedTask(database, transition.task, transition.run, transition.family)
			if (task.closure.kind !== "active") reject(transition.family, "state-mismatch", "leased task does not have an active closure")
			if (taskKey(transition.record.identity.parent) !== taskKey(task.identity) || closureKey(transition.record.parentClosure) !== closureKey(transition.run.closure)) reject(transition.family, "identity-mismatch", "await identity does not belong to leased closure")
			if (taskKey(transition.record.child) !== taskKey(transition.child.task.identity)) reject(transition.family, "identity-mismatch", "await child identity does not match its admission")
			const admission = evaluateAdmission(readSnapshot(database, task.identity.chain), transition.child)
			if (admission.kind === "rejected") reject(transition.family, "invalid-transition", `await child admission was rejected: ${admission.reason.kind}`)
			admitTask(database, {
				fact: transition.child.fact,
				task: admission.task,
				position: admission.position,
			}, transition.family)
			insertAwait(database, task.identity.chain.value, transition.record)
			updateTask(database, { ...task, state: { kind: "suspended", await: transition.record.identity }, closure: { ...task.closure, kind: "suspended", continuation: transition.continuation } })
			return
		}
		case "await-resumption": {
			const task = requireTask(database, transition.task, transition.family)
			if (task.state.kind !== "suspended" || awaitKey(task.state.await) !== awaitKey(transition.record.identity)) reject(transition.family, "state-mismatch", "task is not suspended on this await")
			const existing = requireAwait(database, transition.record.identity, transition.family)
			if (existing.kind !== "waiting") reject(transition.family, "state-mismatch", "await is not waiting")
			if (transition.record.kind === "delivered") {
				const child = requireTask(database, transition.record.child, transition.family)
				if (child.state.kind !== "settled" || JSON.stringify(child.state.settlement) !== JSON.stringify(transition.record.settlement)) reject(transition.family, "settlement-mismatch", "child settlement differs from delivered value")
			}
			updateAwait(database, task.identity.chain.value, transition.record)
			if (transition.record.kind === "continuation-lost") {
				const closure = task.closure.kind === "suspended"
					? { ...task.closure, continuation: { kind: "lost" as const, observedAt: Date.now() } }
					: task.closure
				updateTask(database, {
					...task,
					state: {
						kind: "settled",
						settlement: {
							kind: "exception",
							cause: { kind: "exception", cause: { kind: "policy", reason: "program-fault" } },
							attempt: transition.record.identity.attempt,
							closure: transition.record.parentClosure,
						},
						settledAt: Date.now(),
					},
					closure,
				})
				return
			}
			updateTask(database, { ...task, state: { kind: "ready" } })
			return
		}
		case "await-consumption": {
			const existing = requireAwait(database, transition.record.identity, transition.family)
			if (existing.kind !== "delivered" || existing.token !== transition.record.token) reject(transition.family, "state-mismatch", "await delivery is not available for one-shot consumption")
			if (JSON.stringify(existing.settlement) !== JSON.stringify(transition.record.settlement)) reject(transition.family, "settlement-mismatch", "consumed await settlement differs from delivered value")
			updateAwait(database, transition.task.chain.value, transition.record)
			return
		}
		case "group-waiting": {
			const group = requireGroup(database, transition.group, transition.family)
			if (group.wait.kind === "none") reject(transition.family, "invalid-transition", "non-waiting group cannot enter waiting state")
			const tasks = Object.fromEntries(group.members.map((identity) => {
				const task = requireTask(database, identity, transition.family)
				return [taskKey(identity), task]
			}))
			const expected = nextGroupState(group, tasks, transition.state.deadline - group.wait.durationMs)
			if (expected.kind !== "waiting" || JSON.stringify(expected) !== JSON.stringify(transition.state)) reject(transition.family, "deadline-mismatch", "waiting state does not match group wait semantics")
			updateGroup(database, { ...group, state: transition.state })
			return
		}
		case "group-termination": {
			const group = requireGroup(database, transition.group, transition.family)
			const tasks = Object.fromEntries(group.members.map((identity) => {
				const task = requireTask(database, identity, transition.family)
				return [taskKey(identity), task]
			}))
			const expected = nextGroupState(group, tasks, transition.state.terminatedAt)
			if (expected.kind !== "terminated" || JSON.stringify(expected) !== JSON.stringify(transition.state)) reject(transition.family, "deadline-mismatch", "termination does not match group wait semantics")
			updateGroup(database, { ...group, state: transition.state })
			return
		}
		case "group-consumer-start": {
			const group = requireGroup(database, transition.group, transition.family)
			if (group.state.kind !== "terminated" || group.consumer.kind === "drain") reject(transition.family, "state-mismatch", "only a terminated group with a fixed task consumer can start consumption")
			const settlements = group.members.map((identity) => requireTask(database, identity, transition.family).state).map((state) => {
				if (state.kind !== "settled") reject(transition.family, "state-mismatch", "group member is not settled")
				return state.settlement
			})
			if (JSON.stringify(settlements) !== JSON.stringify(transition.settlements)) reject(transition.family, "settlement-mismatch", "consumer input is not the complete committed settlement vector")
			const digest = createHash("sha256").update(JSON.stringify(settlements)).digest("hex")
			if (
				transition.state.settlementsDigest !== digest
				|| taskKey(transition.state.consumerTask) !== taskKey(transition.task.identity)
				|| groupKey(transition.state.consumerGroup) !== groupKey(transition.consumerGroup.identity)
			) reject(transition.family, "identity-mismatch", "consumer state does not identify its task, group, and settlement vector")
			if (
				groupKey(transition.task.group) !== groupKey(transition.consumerGroup.identity)
				|| transition.consumerGroup.members.length !== 1
				|| taskKey(transition.consumerGroup.members[0] as Task["identity"]) !== taskKey(transition.task.identity)
				|| transition.consumerGroup.consumer.kind !== "drain"
				|| transition.consumerGroup.state.kind !== "open"
				|| transition.task.state.kind !== "ready"
				|| transition.task.closure.kind !== "unallocated"
			) reject(transition.family, "invalid-transition", "fixed consumer must start as one ready task in a fresh drain group")
			if (
				transition.task.identity.chain.value !== group.identity.chain.value
				|| transition.consumerGroup.identity.chain.value !== group.identity.chain.value
				|| transition.task.input.definition.content.digest !== group.consumer.definition.content.digest
				|| transition.task.input.definition.product.digest !== group.consumer.definition.product.digest
			) reject(transition.family, "identity-mismatch", "fixed consumer task does not use the pinned group definition")
			if (exists(database, "v3_tasks", "task_key", taskKey(transition.task.identity)) || exists(database, "v3_groups", "group_key", groupKey(transition.consumerGroup.identity))) {
				reject(transition.family, "already-exists", "fixed consumer task or group already exists")
			}
			insertGroup(database, transition.consumerGroup)
			insertTask(database, transition.task)
			updateGroup(database, { ...group, state: transition.state })
			return
		}
		case "group-consumption": {
			const group = requireGroup(database, transition.group, transition.family)
			if (group.state.kind !== "terminated" && group.state.kind !== "consuming") reject(transition.family, "state-mismatch", "group is neither terminated nor awaiting its fixed consumer result")
			const settlements = group.members.map((identity) => requireTask(database, identity, transition.family).state).map((state) => {
				if (state.kind !== "settled") reject(transition.family, "state-mismatch", "group member is not settled")
				return state.settlement
			})
			if (JSON.stringify(settlements) !== JSON.stringify(transition.settlements)) reject(transition.family, "settlement-mismatch", "consumption settlements are not the committed member settlements")
			updateGroup(database, { ...group, state: transition.state })
			return
		}
		case "resource-intent": {
			const task = requireTask(database, transition.closure.task, transition.family)
			if (task.closure.kind === "unallocated" || closureKey(task.closure.identity) !== closureKey(transition.closure)) reject(transition.family, "identity-mismatch", "closure is not owned by task")
			if (transition.action === "freeze-evidence") {
				if (task.closure.kind !== "active" && task.closure.kind !== "suspended") reject(transition.family, "state-mismatch", "freeze requires live closure resources")
				if (transition.publication === null) reject(transition.family, "publication-mismatch", "freeze requires publication evidence")
				updateTask(database, { ...task, closure: { ...task.closure, kind: "evidence-frozen", publication: transition.publication } })
				return
			}
			if (task.closure.kind !== "evidence-frozen") reject(transition.family, "state-mismatch", "collect requires frozen evidence")
			if (transition.publication !== null && JSON.stringify(transition.publication) !== JSON.stringify(task.closure.publication)) reject(transition.family, "publication-mismatch", "collection evidence differs from frozen evidence")
			updateTask(database, { ...task, closure: { kind: "collected", identity: transition.closure, publication: task.closure.publication, collectedAt: Date.now() } })
			return
	}
}
}

function admitTask(database: Database, admission: Extract<CommittedTransition, { family: "task-admission" }> | Extract<CommittedTransition, { family: "task-settlement" }>["successors"][number], family: CommittedTransition["family"]): void {
	const task = admission.task
	const group = requireGroup(database, admission.position.group, family)
	if (group.memberVersion !== admission.position.expectedMemberVersion || (group.state.kind !== "open" && group.state.kind !== "waiting")) reject(family, "position-mismatch", "group position is no longer open")
	if (task.identity.chain.value !== group.identity.chain.value || groupKey(task.group) !== groupKey(group.identity)) reject(family, "identity-mismatch", "task and group identities disagree")
	if (task.state.kind !== "ready" || task.closure.kind !== "unallocated") reject(family, "invalid-transition", "admitted task must start ready and unallocated")
	if (exists(database, "v3_tasks", "task_key", taskKey(task.identity)) || exists(database, "v3_facts", "fact_key", factKey(admission.fact))) reject(family, "already-exists", "task or admitted fact already exists")
	for (const dependency of task.dependsOn) requireTask(database, dependency, family)
	insertTask(database, task)
	database.query<never, SqlParams>("INSERT INTO v3_facts (fact_key,chain_key,task_key) VALUES ($fact,$chain,$task)").run({ fact: factKey(admission.fact), chain: task.identity.chain.value, task: taskKey(task.identity) })
	updateGroup(database, { ...group, members: [...group.members, task.identity], memberVersion: group.memberVersion + 1 })
}

function requireLeasedTask(database: Database, identity: Task["identity"], run: Extract<CommittedTransition, { family: "lease-acquire" }>["run"], family: CommittedTransition["family"]): Task {
	const task = requireTask(database, identity, family)
	if (task.state.kind !== "leased") reject(family, "state-mismatch", "task is not leased")
	if (runKey(task.state.run) !== runKey(run)) reject(family, "run-mismatch", "lease belongs to another run")
	return task
}

function requireTask(database: Database, identity: Task["identity"], family: CommittedTransition["family"]): Task {
	const payload = readPayload(database, "v3_tasks", "task_key", taskKey(identity))
	if (payload === null) reject(family, "not-found", `task ${taskKey(identity)} not found`)
	const parsed = parsePersistedTask(parseJson(payload))
	if (parsed.kind === "rejected") throw persistedShape(parsed.error)
	return parsed.value
}

function requireGroup(database: Database, identity: TaskGroup["identity"], family: CommittedTransition["family"]): TaskGroup {
	const payload = readPayload(database, "v3_groups", "group_key", groupKey(identity))
	if (payload === null) reject(family, "not-found", `group ${groupKey(identity)} not found`)
	const parsed = parsePersistedGroup(parseJson(payload))
	if (parsed.kind === "rejected") throw persistedShape(parsed.error)
	return parsed.value
}

function requireAwait(database: Database, identity: AwaitIdentity, family: CommittedTransition["family"]): AwaitRecord {
	const payload = readPayload(database, "v3_awaits", "await_key", awaitKey(identity))
	if (payload === null) reject(family, "not-found", `await ${awaitKey(identity)} not found`)
	const parsed = parsePersistedAwait(parseJson(payload))
	if (parsed.kind === "rejected") throw persistedShape(parsed.error)
	return parsed.value
}

function insertTask(database: Database, task: Task): void {
	database.query<never, SqlParams>("INSERT INTO v3_tasks (task_key,chain_key,group_key,payload) VALUES ($task,$chain,$group,$payload)").run({ task: taskKey(task.identity), chain: task.identity.chain.value, group: groupKey(task.group), payload: encodePersisted(task) })
}

function updateTask(database: Database, task: Task): void {
	database.query<never, SqlParams>("UPDATE v3_tasks SET payload=$payload WHERE task_key=$task").run({ task: taskKey(task.identity), payload: encodePersisted(task) })
}

function insertGroup(database: Database, group: TaskGroup): void {
	database.query<never, SqlParams>("INSERT INTO v3_groups (group_key,chain_key,payload) VALUES ($group,$chain,$payload)").run({ group: groupKey(group.identity), chain: group.identity.chain.value, payload: encodePersisted(group) })
}

function updateGroup(database: Database, group: TaskGroup): void {
	database.query<never, SqlParams>("UPDATE v3_groups SET payload=$payload WHERE group_key=$group").run({ group: groupKey(group.identity), payload: encodePersisted(group) })
}

function insertAwait(database: Database, chain: string, record: ObjectDomainSnapshot["awaits"][string]): void {
	database.query<never, SqlParams>("INSERT INTO v3_awaits (await_key,chain_key,payload) VALUES ($await,$chain,$payload)").run({ await: awaitKey(record.identity), chain, payload: encodePersisted(record) })
}

function updateAwait(database: Database, chain: string, record: ObjectDomainSnapshot["awaits"][string]): void {
	database.query<never, SqlParams>("UPDATE v3_awaits SET chain_key=$chain,payload=$payload WHERE await_key=$await").run({ await: awaitKey(record.identity), chain, payload: encodePersisted(record) })
}

type IdentityPayloadRow = typeof IdentityPayloadRowBoundary.infer

function readIdentityPayloads(
	database: Database,
	table: "v3_tasks" | "v3_groups" | "v3_awaits",
	keyColumn: "task_key" | "group_key" | "await_key",
	chain: string,
): IdentityPayloadRow[] {
	return database.query<BoundaryRecord, SqlParams>(
		`SELECT ${keyColumn} AS identity_key,chain_key,payload FROM ${table} WHERE chain_key=$chain`,
	).all({ chain }).map((row) => IdentityPayloadRowBoundary.assert(row))
}

function requirePersistedIdentity(entity: "task" | "group" | "await", row: IdentityPayloadRow, identity: string, chain: string): void {
	if (row.identity_key !== identity || row.chain_key !== chain) {
		throw new StoreAbort({
			kind: "store-schema",
			reason: "persisted-shape-invalid",
			message: `${entity}: relational identity ${row.identity_key} in chain ${row.chain_key} does not match payload identity ${identity} in chain ${chain}`,
		})
	}
}

function readPayload(database: Database, table: "v3_tasks" | "v3_groups" | "v3_awaits", keyColumn: "task_key" | "group_key" | "await_key", key: string): string | null {
	const row = database.query<BoundaryRecord, SqlParams>(`SELECT payload FROM ${table} WHERE ${keyColumn}=$key`).get({ key })
	return row === null ? null : PayloadRowBoundary.assert(row).payload
}

function exists(database: Database, table: "v3_chains" | "v3_tasks" | "v3_groups" | "v3_facts" | "v3_transitions", keyColumn: "chain_key" | "task_key" | "group_key" | "fact_key" | "identity_key", key: string): boolean {
	return database.query<{ found: number }, SqlParams>(`SELECT 1 AS found FROM ${table} WHERE ${keyColumn}=$key`).get({ key })?.found === 1
}

function transitionChain(transition: CommittedTransition): string {
	switch (transition.family) {
		case "task-admission": return transition.task.identity.chain.value
		case "lease-acquire":
		case "task-held":
		case "task-unhold":
		case "task-resume":
		case "lease-release":
		case "task-settlement":
		case "await-suspension":
		case "await-resumption":
		case "await-consumption": return transition.task.chain.value
		case "group-waiting":
		case "group-termination":
		case "group-consumer-start":
		case "group-consumption": return transition.group.chain.value
		case "resource-intent": return transition.closure.task.chain.value
	}
}

function awaitKey(identity: { readonly parent: Task["identity"]; readonly attempt: number; readonly site: string }): string {
	return `${taskKey(identity.parent)}/${identity.attempt}/${identity.site}`
}

function closureKey(identity: { readonly task: Task["identity"]; readonly attempt: number }): string {
	return `${taskKey(identity.task)}/${identity.attempt}`
}

function runKey(identity: { readonly closure: { readonly task: Task["identity"]; readonly attempt: number }; readonly value: string }): string {
	return `${closureKey(identity.closure)}/${identity.value}`
}

function parseJson(payload: string): unknown {
	return JSON.parse(payload)
}

function reject(family: CommittedTransition["family"] | "bootstrap", reason: TransitionRejectionReason, message: string): never {
	throw new StoreAbort({ kind: "transition-rejected", family, reason, message })
}

function persistedShape(error: PersistenceParseError): StoreAbort {
	return new StoreAbort({ kind: "store-schema", reason: "persisted-shape-invalid", message: `${error.entity}: ${error.message}` })
}

function attempt<A>(operation: string, work: () => A): Effect.Effect<A, ObjectStoreError> {
	return Effect.try({ try: work, catch: (error) => error instanceof StoreAbort ? error.detail : storeIo(operation, error) })
}

function storeIo(operation: string, error: unknown): ObjectStoreError {
	return { kind: "store-io", operation, message: error instanceof Error ? error.message : String(error) }
}

class StoreAbort extends Error {
	constructor(readonly detail: ObjectStoreError) {
		super(detail.message)
	}
}

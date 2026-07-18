import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"

import type { ClosureSnapshot, TaskNodeSnapshot, TaskTreeSnapshot } from "./task-runtime"

export type ClosureReachabilitySeed =
	| { kind: "active-run"; closureId: string }
	| { kind: "resumable-attempt"; closureId: string }
	| { kind: "decided-reopen"; closureId: string }
	| { kind: "seq-suffix"; closureId: string }
	| { kind: "open-par-epoch"; closureId: string }
	| { kind: "open-append"; closureId: string }
	| { kind: "next-epoch-candidate"; closureId: string }

export type ClosureReachabilityEdge =
	| { kind: "resume"; fromClosureId: string; toClosureId: string }
	| { kind: "scope-target"; fromClosureId: string; toClosureId: string }

export type ClosureReachabilityModel = {
	closures: readonly string[]
	seeds: readonly ClosureReachabilitySeed[]
	edges: readonly ClosureReachabilityEdge[]
}

export function computeClosureReachability(model: ClosureReachabilityModel): ReadonlySet<string> {
	const closures = new Set(model.closures)
	const reachable = new Set<string>()
	for (const seed of model.seeds) if (closures.has(seed.closureId)) reachable.add(seed.closureId)
	let changed = true
	while (changed) {
		changed = false
		for (const edge of model.edges) {
			if (!reachable.has(edge.fromClosureId) || !closures.has(edge.toClosureId) || reachable.has(edge.toClosureId)) continue
			reachable.add(edge.toClosureId)
			changed = true
		}
	}
	return reachable
}

export function persistedClosureReachabilityModel(
	tree: TaskTreeSnapshot,
	terminalItemRowIds: ReadonlySet<number>,
): ClosureReachabilityModel {
	const closures = collectTaskClosures(tree.root)
	const seeds: ClosureReachabilitySeed[] = tree.activeRuns.map((run) => ({ kind: "active-run", closureId: run.closureId }))
	const seeded = new Set(seeds.map((seed) => `${seed.kind}\0${seed.closureId}`))
	const addSeed = (seed: ClosureReachabilitySeed): void => {
		const identity = `${seed.kind}\0${seed.closureId}`
		if (seeded.has(identity)) return
		seeded.add(identity)
		seeds.push(seed)
	}
	const seedClosures = (node: TaskNodeSnapshot, kind: ClosureReachabilitySeed["kind"]): void => {
		for (const closure of collectTaskClosures(node)) {
			if (closure.lifecycle !== "consumed") addSeed({ kind, closureId: closure.closureId })
		}
	}
	const visit = (node: TaskNodeSnapshot): void => {
		switch (node.kind) {
			case "leaf":
				if (node.closure.lifecycle !== "consumed" && !terminalItemRowIds.has(node.closure.itemRowId)) addSeed({ kind: "resumable-attempt", closureId: node.closure.closureId })
				return
			case "seq": {
				const cursor = node.cursor
				if (cursor.kind === "next") {
					const cursorIndex = node.children.findIndex((child) => child.identity.runtimeNodeId === cursor.nodeId)
					for (const child of node.children.slice(cursorIndex < 0 ? 0 : cursorIndex)) {
						for (const closure of collectTaskClosures(child)) {
							if (closure.lifecycle !== "consumed" && !terminalItemRowIds.has(closure.itemRowId)) addSeed({ kind: "seq-suffix", closureId: closure.closureId })
						}
					}
				}
				for (const child of node.children) visit(child)
				return
			}
			case "par": {
				if (node.state === "open") seedClosures(node, "open-par-epoch")
				if (node.join.evaluation.kind === "decided") seedClosures(node, "decided-reopen")
				if (node.join.evaluation.kind !== "not-evaluating" && node.join.currentVersion > node.join.evaluation.bindingVersion) seedClosures(node, "next-epoch-candidate")
				for (const child of node.children) visit(child)
				return
			}
			default: return assertNever(node)
		}
	}
	visit(tree.root)
	return { closures: closures.map((closure) => closure.closureId), seeds, edges: [] }
}

function collectTaskClosures(node: TaskNodeSnapshot): ClosureSnapshot[] {
	if (node.kind === "leaf") return [node.closure]
	return node.children.flatMap(collectTaskClosures)
}

function assertNever(value: never): never {
	throw new Error(`unhandled task node ${JSON.stringify(value)}`)
}

function safeComponent(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.+/g, ".").replace(/^\.+|\.+$/g, "")
	return sanitized === "" || sanitized.includes("..") ? "closure" : sanitized
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

export function closureWorktreePath(loopDataRoot: string, chainName: string, repoCwd: string, closureId: string): string {
	const repoLabel = safeComponent(basename(repoCwd) || "repo")
	return resolve(loopDataRoot, "chains", safeComponent(chainName), "worktrees", `${repoLabel}-${shortHash(repoCwd)}-${shortHash(closureId)}`)
}

export function closureBranchName(chainName: string, closureId: string): string {
	return `${closureBranchPrefix(chainName)}${shortHash(closureId)}`
}

export function closureBranchPrefix(chainName: string): string {
	return `refs/heads/coder-loop/closures/${safeComponent(chainName)}/`
}

export function closureResourcesBelongToEngine(
	loopDataRoot: string,
	chainName: string,
	repoCwd: string,
	closureId: string,
	worktreePath: string,
	branchName: string,
): boolean {
	return resolve(worktreePath) === closureWorktreePath(loopDataRoot, chainName, repoCwd, closureId)
		&& branchName === closureBranchName(chainName, closureId)
}

export type PersistedParPinSource = {
	sourceParNodeId: string | null
	baseCommit: string
}

export type OriginFreshness =
	| { kind: "fetched"; remote: "origin"; commit: string; observedAt: string }
	| { kind: "no-origin"; availability: "unavailable"; commit: string }
	| { kind: "retained"; commit: string }

export type RepositoryGitSingleflightResult = {
	commit: string
	freshness: OriginFreshness
}

export function persistedParPin(closure: PersistedParPinSource | null): string | null {
	return closure?.sourceParNodeId === null || closure === null ? null : closure.baseCommit
}

export type RepositoryGitCoordinator = {
	run: <T>(repoCwd: string, operation: () => Promise<T>) => Promise<T>
	singleflight: (repoCwd: string, operationKey: string, operation: () => Promise<RepositoryGitSingleflightResult>) => Promise<RepositoryGitSingleflightResult>
}

export function createRepositoryGitCoordinator(): RepositoryGitCoordinator {
	const tails = new Map<string, Promise<void>>()
	const flights = new Map<string, Promise<RepositoryGitSingleflightResult>>()
	return {
		run: async <T>(repoCwd: string, operation: () => Promise<T>): Promise<T> => {
			const previous = tails.get(repoCwd) ?? Promise.resolve()
			let release!: () => void
			const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
			tails.set(repoCwd, current)
			await previous
			try {
				return await operation()
			} finally {
				release()
				if (tails.get(repoCwd) === current) tails.delete(repoCwd)
			}
		},
		singleflight: async (repoCwd, operationKey, operation) => {
			const key = `${repoCwd}\u0000${operationKey}`
			const existing = flights.get(key)
			if (existing !== undefined) return await existing
			const flight = operation().finally(() => {
				if (flights.get(key) === flight) flights.delete(key)
			})
			flights.set(key, flight)
			return await flight
		},
	}
}

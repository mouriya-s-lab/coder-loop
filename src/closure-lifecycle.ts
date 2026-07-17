import { createHash } from "node:crypto"
import { basename, dirname, resolve } from "node:path"

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

export function closureResourcesBelongToEngine(repoCwd: string, closureId: string, worktreePath: string, branchName: string): boolean {
	const branchParts = branchName.split("/")
	const worktreeRoot = dirname(worktreePath)
	const branchOwned = branchParts.length === 6
		&& branchParts.slice(0, 4).join("/") === "refs/heads/coder-loop/closures"
		&& branchParts[4] === basename(dirname(worktreeRoot))
		&& branchParts[5] === shortHash(closureId)
	const expectedSuffix = `-${shortHash(repoCwd)}-${shortHash(closureId)}`
	return branchOwned && basename(worktreeRoot) === "worktrees" && basename(worktreePath).endsWith(expectedSuffix)
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

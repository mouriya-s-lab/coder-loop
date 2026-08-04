import { createHash } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import type { ClosureIdentity, ClosureResourceState, PublicationEvidence } from "./object-domain"
import { runSubprocess, type SubprocessOutcome } from "./subprocess"

export type GitServiceConfig = {
	readonly repository: string
	readonly workspaceRoot: string
	readonly executable: string
	readonly env: Readonly<Record<string, string>>
	readonly timeoutMs: number
	readonly termGraceMs: number
	readonly maxOutputBytes: number
}

export type PrepareClosureRequest = {
	readonly identity: ClosureIdentity
	readonly basePin: string
	readonly branch: string
	readonly allocation: string
}

export type GitServiceError = {
	readonly kind: "git-service-error"
	readonly operation: string
	readonly message: string
}

export type GitService = {
	readonly resolveBasePin: (ref: string) => Effect.Effect<string, GitServiceError>
	readonly prepare: (request: PrepareClosureRequest) => Effect.Effect<Extract<ClosureResourceState, { kind: "active" }>, GitServiceError>
	readonly discard: (closure: Extract<ClosureResourceState, { kind: "active" }>) => Effect.Effect<void, GitServiceError>
	readonly publication: (closure: Extract<ClosureResourceState, { kind: "active" | "suspended" }>) => Effect.Effect<PublicationEvidence, GitServiceError>
	readonly collect: (closure: Extract<ClosureResourceState, { kind: "evidence-frozen" }>) => Effect.Effect<void, GitServiceError>
}

export class RepositoryGit extends Context.Tag("coder-loop/v3/RepositoryGit")<RepositoryGit, GitService>() {}

export function makeRepositoryGitLive(config: GitServiceConfig): Layer.Layer<RepositoryGit> {
	return Layer.effect(RepositoryGit, Effect.gen(function*() {
		const singleflight = yield* Effect.makeSemaphore(1)
		const serialized = singleflight.withPermits(1)
		return {
			resolveBasePin: (ref) => serialized(gitText(config, "resolve-base-pin", ["-C", config.repository, "rev-parse", `${ref}^{commit}`])),
			prepare: (request) => serialized(prepareClosure(config, request)),
			discard: (closure) => serialized(discardClosure(config, closure)),
			publication: (closure) => serialized(observePublication(config, closure)),
			collect: (closure) => serialized(collectClosure(config, closure)),
		}
	}))
}

function prepareClosure(config: GitServiceConfig, request: PrepareClosureRequest): Effect.Effect<Extract<ClosureResourceState, { kind: "active" }>, GitServiceError> {
	const root = closureRoot(config.workspaceRoot, request.identity, request.allocation)
	const worktree = join(root, "worktree")
	const scratch = join(root, "scratch")
	return Effect.gen(function*() {
		const basePin = yield* gitText(config, "resolve-base-pin", ["-C", config.repository, "rev-parse", `${request.basePin}^{commit}`])
		if (!request.branch.startsWith("coder-loop/v3/")) return yield* Effect.fail<GitServiceError>({ kind: "git-service-error", operation: "prepare", message: "closure branch is outside the engine namespace" })
		yield* fsEffect("prepare-directories", async () => {
			await mkdir(dirname(worktree), { recursive: true })
			await mkdir(scratch, { recursive: true })
		})
		const worktrees = yield* gitText(config, "worktree-list", ["-C", config.repository, "worktree", "list", "--porcelain"])
		if (worktrees.split("\n").includes(`worktree ${worktree}`)) {
			const branch = yield* gitText(config, "resolve-branch", ["-C", worktree, "branch", "--show-current"])
			const tip = yield* gitText(config, "resolve-tip", ["-C", worktree, "rev-parse", "HEAD"])
			if (branch !== request.branch || tip !== basePin) return yield* Effect.fail<GitServiceError>({ kind: "git-service-error", operation: "prepare", message: "existing closure residue does not match its declared branch and resolved base pin" })
			return { kind: "active", identity: request.identity, basePin, branch: request.branch, worktree, scratch }
		}
		yield* gitOptionalText(config, ["-C", config.repository, "branch", "-D", request.branch])
		yield* git(config, "worktree-add", ["-C", config.repository, "worktree", "add", "-b", request.branch, worktree, basePin])
		return { kind: "active", identity: request.identity, basePin, branch: request.branch, worktree, scratch }
	})
}

function discardClosure(config: GitServiceConfig, closure: Extract<ClosureResourceState, { kind: "active" }>): Effect.Effect<void, GitServiceError> {
	const root = dirname(closure.worktree)
	return Effect.gen(function*() {
		const worktrees = yield* gitText(config, "worktree-list", ["-C", config.repository, "worktree", "list", "--porcelain"])
		if (worktrees.split("\n").includes(`worktree ${closure.worktree}`)) {
			yield* git(config, "worktree-remove", ["-C", config.repository, "worktree", "remove", "--force", closure.worktree])
		}
		yield* gitOptionalText(config, ["-C", config.repository, "branch", "-D", closure.branch])
		yield* fsEffect("remove-unclaimed-closure-root", () => rm(root, { recursive: true, force: true }))
	})
}

function observePublication(config: GitServiceConfig, closure: Extract<ClosureResourceState, { kind: "active" | "suspended" }>): Effect.Effect<PublicationEvidence, GitServiceError> {
	return Effect.gen(function*() {
		const observedAt = Date.now()
		const tip = yield* gitText(config, "resolve-tip", ["-C", closure.worktree, "rev-parse", "HEAD"])
		const status = yield* gitText(config, "worktree-status", ["-C", closure.worktree, "status", "--porcelain"])
		if (status !== "") return { kind: "unpublished", tip, observedAt }
		if (tip === closure.basePin) return { kind: "no-work", observedAt }
		const upstream = yield* gitOptionalText(config, ["-C", closure.worktree, "rev-parse", "--symbolic-full-name", "@{upstream}"])
		if (upstream === null) return { kind: "unpublished", tip, observedAt }
		if (!upstream.startsWith("refs/remotes/")) return { kind: "unknown", tip, reason: `upstream is not a remote-tracking ref: ${upstream}`, observedAt }
		const counts = yield* gitOptionalText(config, ["-C", closure.worktree, "rev-list", "--left-right", "--count", `HEAD...${upstream}`])
		if (counts === null) return { kind: "unknown", tip, reason: "unable to compare upstream", observedAt }
		const [aheadText] = counts.split(/\s+/)
		const ahead = Number(aheadText)
		if (!Number.isInteger(ahead)) return { kind: "unknown", tip, reason: `invalid upstream count: ${counts}`, observedAt }
		return ahead === 0 ? { kind: "published", tip, remoteRef: upstream, observedAt } : { kind: "unpublished", tip, observedAt }
	})
}

function collectClosure(config: GitServiceConfig, closure: Extract<ClosureResourceState, { kind: "evidence-frozen" }>): Effect.Effect<void, GitServiceError> {
	const root = dirname(closure.worktree)
	const worktree = closure.worktree
	return Effect.gen(function*() {
		const worktrees = yield* gitText(config, "worktree-list", ["-C", config.repository, "worktree", "list", "--porcelain"])
		if (worktrees.split("\n").includes(`worktree ${worktree}`)) {
			yield* git(config, "worktree-remove", ["-C", config.repository, "worktree", "remove", "--force", worktree])
		}
		yield* gitOptionalText(config, ["-C", config.repository, "branch", "-D", closure.branch])
		yield* fsEffect("remove-closure-root", () => rm(root, { recursive: true, force: true }))
	})
}

function git(config: GitServiceConfig, operation: string, argv: readonly string[]): Effect.Effect<SubprocessOutcome, GitServiceError> {
	return Effect.flatMap(runSubprocess({
		executable: config.executable,
		argv,
		cwd: config.repository,
		env: config.env,
		stdin: null,
		timeoutMs: config.timeoutMs,
		termGraceMs: config.termGraceMs,
		maxOutputBytes: config.maxOutputBytes,
		sandbox: { filesystem: "unrestricted", network: "unrestricted", resources: [config.repository, config.workspaceRoot] },
	}), (outcome) => outcome.kind === "success"
		? Effect.succeed(outcome)
		: Effect.fail({ kind: "git-service-error", operation, message: describeOutcome(outcome) }))
}

function gitText(config: GitServiceConfig, operation: string, argv: readonly string[]): Effect.Effect<string, GitServiceError> {
	return Effect.map(git(config, operation, argv), (outcome) => outcome.kind === "success" ? new TextDecoder().decode(outcome.stdout).trim() : "")
}

function gitOptionalText(config: GitServiceConfig, argv: readonly string[]): Effect.Effect<string | null> {
	return Effect.map(runSubprocess({
		executable: config.executable,
		argv,
		cwd: config.repository,
		env: config.env,
		stdin: null,
		timeoutMs: config.timeoutMs,
		termGraceMs: config.termGraceMs,
		maxOutputBytes: config.maxOutputBytes,
		sandbox: { filesystem: "unrestricted", network: "unrestricted", resources: [config.repository, config.workspaceRoot] },
	}), (outcome) => outcome.kind === "success" ? new TextDecoder().decode(outcome.stdout).trim() : null)
}

function closureRoot(workspaceRoot: string, identity: ClosureIdentity, allocation: string): string {
	const digest = createHash("sha256").update(`${identity.task.chain.value}\0${identity.task.value}\0${identity.attempt}\0${allocation}`).digest("hex")
	return join(workspaceRoot, "closures", digest)
}

function describeOutcome(outcome: Exclude<SubprocessOutcome, { kind: "success" }>): string {
	switch (outcome.kind) {
		case "nonzero": return `exit ${outcome.exitCode}: ${new TextDecoder().decode(outcome.stderr).trim()}`
		case "timeout": return `timeout ${outcome.signal}`
		case "signal": return `signal ${outcome.signal}`
		case "spawn-failure": return outcome.message
	}
}

function fsEffect(operation: string, work: () => Promise<void>): Effect.Effect<void, GitServiceError> {
	return Effect.tryPromise({ try: work, catch: (error) => ({ kind: "git-service-error", operation, message: error instanceof Error ? error.message : String(error) }) })
}

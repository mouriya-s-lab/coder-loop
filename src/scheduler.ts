import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"

import {
	DEFAULT_TERMINAL_ITEM_STATUSES,
	type Chain,
	type Item,
	type StateStore,
} from "./state-db"

export type SchedulerRun = {
	runId: string
	pid: number
	itemId: number
}

export type SchedulerSlot = {
	chainId: number
	repoCwd: string
	worktreePath: string | null
	currentRun: SchedulerRun | null
}

export type SchedulerState = {
	slots: Map<string, SchedulerSlot>
}

export type SchedulerStore = Pick<
	StateStore,
	"listActiveChains" | "listRepoCwdsForChain" | "getNextPending" | "allItemsTerminal" | "completeChain"
>

export type SchedulerWorktreeInput = {
	chain: Chain
	item: Item
	slot: SchedulerSlot
}

export type SchedulerSpawnInput = {
	chain: Chain
	item: Item
	slot: SchedulerSlot
	worktreePath: string | null
}

export type SchedulerSpawnRecord = {
	chain: Chain
	item: Item
	slot: SchedulerSlot
	run: SchedulerRun
	worktreePath: string | null
}

export type SchedulerTickResult = {
	activeChains: number
	spawned: SchedulerSpawnRecord[]
	completedChains: Chain[]
	skippedBusySlots: SchedulerSlot[]
}

export type SchedulerTickOptions = {
	store: SchedulerStore
	state: SchedulerState
	terminalStatuses?: readonly string[]
	ensureWorktree?: (input: SchedulerWorktreeInput) => string | Promise<string>
	spawnAgent: (input: SchedulerSpawnInput) => SchedulerRun | Promise<SchedulerRun>
}

export type SchedulerLoopOptions = SchedulerTickOptions & {
	shouldContinue: () => boolean | Promise<boolean>
	waitForChildExitOrTimeout: (input: { state: SchedulerState; lastTick: SchedulerTickResult }) => Promise<void>
	maxTicks?: number
}

export type SchedulerLoopResult = {
	ticks: number
	lastTick: SchedulerTickResult | null
}

export function createSchedulerState(): SchedulerState {
	return { slots: new Map() }
}

export function schedulerSlotKey(chainId: number, repoCwd: string): string {
	return `${chainId}:${repoCwd}`
}

export function getOrCreateSchedulerSlot(state: SchedulerState, chainId: number, repoCwd: string): SchedulerSlot {
	const key = schedulerSlotKey(chainId, repoCwd)
	const existing = state.slots.get(key)
	if (existing !== undefined) return existing
	const created: SchedulerSlot = { chainId, repoCwd, worktreePath: null, currentRun: null }
	state.slots.set(key, created)
	return created
}

export function clearSchedulerRun(state: SchedulerState, runId: string): SchedulerSlot | null {
	for (const slot of state.slots.values()) {
		if (slot.currentRun?.runId !== runId) continue
		slot.currentRun = null
		return slot
	}
	return null
}

export function schedulerWorktreeBranchName(chainName: string, itemIssue: number | string): string {
	return `coder-loop/${sanitizeRefSegment(chainName)}/${sanitizeRefSegment(String(itemIssue))}`
}

export function schedulerWorktreePath(baseDir: string, chain: Chain, repoCwd: string): string {
	const repoName = sanitizePathSegment(basename(repoCwd) || "repo")
	const repoHash = createHash("sha1").update(repoCwd).digest("hex").slice(0, 10)
	return resolve(baseDir, sanitizePathSegment(chain.name), `${repoName}-${repoHash}`)
}

export async function runSchedulerTick(options: SchedulerTickOptions): Promise<SchedulerTickResult> {
	const terminalStatuses = options.terminalStatuses ?? DEFAULT_TERMINAL_ITEM_STATUSES
	const activeChains = options.store.listActiveChains()
	const result: SchedulerTickResult = {
		activeChains: activeChains.length,
		spawned: [],
		completedChains: [],
		skippedBusySlots: [],
	}

	for (const chain of activeChains) {
		const repoCwds = options.store.listRepoCwdsForChain(chain.id)
		if (repoCwds.length === 0) {
			completeChainIfTerminal(options, chain, terminalStatuses, result)
			continue
		}

		for (const repoCwd of repoCwds) {
			const slot = getOrCreateSchedulerSlot(options.state, chain.id, repoCwd)
			if (slot.currentRun !== null) {
				result.skippedBusySlots.push(slot)
				continue
			}

			const item = options.store.getNextPending(chain.id, repoCwd)
			if (item === null) {
				if (completeChainIfTerminal(options, chain, terminalStatuses, result)) {
					deleteChainSlots(options.state, chain.id)
					break
				}
				continue
			}

			const worktreePath = await ensureSlotWorktree(options, chain, item, slot)
			const run = await options.spawnAgent({ chain, item, slot, worktreePath })
			if (run.itemId !== item.id) throw new Error(`spawnAgent returned itemId ${run.itemId}, expected ${item.id}`)
			slot.currentRun = run
			result.spawned.push({ chain, item, slot, run, worktreePath })
		}
	}

	return result
}

export async function runSchedulerLoop(options: SchedulerLoopOptions): Promise<SchedulerLoopResult> {
	let ticks = 0
	let lastTick: SchedulerTickResult | null = null
	while (await options.shouldContinue()) {
		if (options.maxTicks !== undefined && ticks >= options.maxTicks) break
		lastTick = await runSchedulerTick(options)
		ticks++
		await options.waitForChildExitOrTimeout({ state: options.state, lastTick })
	}
	return { ticks, lastTick }
}

async function ensureSlotWorktree(
	options: SchedulerTickOptions,
	chain: Chain,
	item: Item,
	slot: SchedulerSlot,
): Promise<string | null> {
	if (options.ensureWorktree === undefined) return slot.worktreePath
	if (slot.worktreePath !== null) return slot.worktreePath
	const worktreePath = await options.ensureWorktree({ chain, item, slot })
	slot.worktreePath = worktreePath
	return worktreePath
}

function completeChainIfTerminal(
	options: SchedulerTickOptions,
	chain: Chain,
	terminalStatuses: readonly string[],
	result: SchedulerTickResult,
): boolean {
	if (chainHasBusySlot(options.state, chain.id)) return false
	if (!options.store.allItemsTerminal(chain.id, terminalStatuses)) return false
	const completed = options.store.completeChain(chain.id)
	result.completedChains.push(completed)
	return true
}

function chainHasBusySlot(state: SchedulerState, chainId: number): boolean {
	for (const slot of state.slots.values()) {
		if (slot.chainId === chainId && slot.currentRun !== null) return true
	}
	return false
}

function deleteChainSlots(state: SchedulerState, chainId: number): void {
	for (const [key, slot] of state.slots) {
		if (slot.chainId === chainId) state.slots.delete(key)
	}
}

function sanitizeRefSegment(value: string): string {
	return sanitize(value).replace(/^\.+|\.+$/g, "") || "unnamed"
}

function sanitizePathSegment(value: string): string {
	return sanitize(value) || "unnamed"
}

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-")
}

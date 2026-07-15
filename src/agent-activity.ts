import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export const AGENT_ACTIVITY_WINDOWS_SECONDS = [10, 30, 60, 300] as const
const MAX_WINDOW_SECONDS = AGENT_ACTIVITY_WINDOWS_SECONDS.at(-1)!

export type AgentActivityBucket = {
	second: number
	lines: number
}

export type AgentActivityArtifact = {
	updatedAt: string
	buckets: AgentActivityBucket[]
}

export type AgentActivityWindow = {
	seconds: number
	lines: number
}

export class AgentActivityAccumulator {
	private readonly linesBySecond = new Map<number, number>()

	observe(chunk: Uint8Array, observedAtMs: number): void {
		let lines = 0
		for (const byte of chunk) {
			if (byte === 0x0a) lines += 1
		}
		if (lines === 0) return
		const second = Math.floor(observedAtMs / 1000)
		this.linesBySecond.set(second, (this.linesBySecond.get(second) ?? 0) + lines)
		this.prune(second)
	}

	artifact(nowMs: number): AgentActivityArtifact {
		const nowSecond = Math.floor(nowMs / 1000)
		this.prune(nowSecond)
		return {
			updatedAt: new Date(nowMs).toISOString(),
			buckets: [...this.linesBySecond.entries()]
				.sort(([left], [right]) => left - right)
				.map(([second, lines]) => ({ second, lines })),
		}
	}

	private prune(nowSecond: number): void {
		const oldestIncludedSecond = nowSecond - MAX_WINDOW_SECONDS + 1
		for (const second of this.linesBySecond.keys()) {
			if (second < oldestIncludedSecond) this.linesBySecond.delete(second)
		}
	}
}

export function activityWindows(artifact: AgentActivityArtifact, nowMs: number): AgentActivityWindow[] {
	const nowSecond = Math.floor(nowMs / 1000)
	return AGENT_ACTIVITY_WINDOWS_SECONDS.map((seconds) => {
		const oldestIncludedSecond = nowSecond - seconds + 1
		const lines = artifact.buckets.reduce(
			(total, bucket) => bucket.second >= oldestIncludedSecond && bucket.second <= nowSecond ? total + bucket.lines : total,
			0,
		)
		return { seconds, lines }
	})
}

export class AgentActivityRecorder {
	private readonly accumulator = new AgentActivityAccumulator()
	private writeChain = Promise.resolve()
	private sequence = 0

	constructor(private readonly path: string) {}

	observe(chunk: Uint8Array, observedAtMs = Date.now()): void {
		this.accumulator.observe(chunk, observedAtMs)
		const artifact = this.accumulator.artifact(observedAtMs)
		const temporaryPath = `${this.path}.${process.pid}.${this.sequence++}.tmp`
		this.writeChain = this.writeChain.then(async () => {
			await mkdir(dirname(this.path), { recursive: true })
			await writeFile(temporaryPath, `${JSON.stringify(artifact)}\n`)
			await rename(temporaryPath, this.path)
		})
	}

	flush(): Promise<void> {
		return this.writeChain
	}
}

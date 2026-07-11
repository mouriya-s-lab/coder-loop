import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

export type RealE2eMutex = {
	domain: string
	lockPath: string
	ownerPid: number
	release: () => void
}

export type RealE2eMutexOptions = {
	domain: string
	ownerPid?: number
	lockRoot?: string
	onWait: (ownerPid: number | null) => void
}

function lockPathForDomain(domain: string, lockRoot: string): string {
	const key = createHash("sha256").update(domain).digest("hex")
	return resolve(lockRoot, `${key}.lock`)
}

function currentOwnerPid(lockPath: string): number | null {
	try {
		const value = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10)
		return Number.isInteger(value) && value > 0 ? value : null
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
		throw error
	}
}

export async function acquireRealE2eGlobalMutex(options: RealE2eMutexOptions): Promise<RealE2eMutex> {
	const ownerPid = options.ownerPid ?? process.pid
	const lockRoot = options.lockRoot ?? resolve(homedir(), ".coder-loop", "real-e2e-locks")
	mkdirSync(lockRoot, { recursive: true })
	const lockPath = lockPathForDomain(options.domain, lockRoot)
	let reportedOwner: number | null | undefined
	for (;;) {
		const result = spawnSync("shlock", ["-f", lockPath, "-p", String(ownerPid)], { stdio: "ignore" })
		if (result.status === 0) break
		const blockingOwner = currentOwnerPid(lockPath)
		if (blockingOwner !== reportedOwner) {
			options.onWait(blockingOwner)
			reportedOwner = blockingOwner
		}
		await Bun.sleep(1_000)
	}
	let released = false
	return {
		domain: options.domain,
		lockPath,
		ownerPid,
		release: () => {
			if (released) return
			released = true
			if (currentOwnerPid(lockPath) !== ownerPid) {
				throw new Error(`real-e2e mutex ownership changed before release: ${lockPath}`)
			}
			rmSync(lockPath)
		},
	}
}

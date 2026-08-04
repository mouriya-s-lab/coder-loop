#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { runCli } from "./cli"
import { parseRuntimeConfig } from "./config"
import { runRuntimeHost } from "./runtime-host"

export async function main(argv: readonly string[]): Promise<number> {
	if (argv[0] !== "daemon") return runCli(argv)
	const configPath = option(argv.slice(1), "--config")
	if (configPath === null) {
		process.stderr.write("daemon requires --config PATH\n")
		return 2
	}
	let candidate: unknown
	try { candidate = JSON.parse(await readFile(configPath, "utf8")) }
	catch (error) {
		process.stderr.write(`cannot read runtime config: ${error instanceof Error ? error.message : String(error)}\n`)
		return 2
	}
	const parsed = parseRuntimeConfig(candidate)
	if (parsed.kind === "rejected") {
		process.stderr.write(`${parsed.issues.join("; ")}\n`)
		return 2
	}
	const abort = new AbortController()
	const stop = (): void => abort.abort()
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	try {
		await Effect.runPromise(runRuntimeHost({
			...parsed.config,
			onTransportError: (error) => process.stderr.write(`${JSON.stringify(error)}\n`),
			onCycleError: (error) => process.stderr.write(`${JSON.stringify(error)}\n`),
		}), { signal: abort.signal })
		return 0
	} catch (error) {
		if (abort.signal.aborted) return 0
		throw error
	} finally {
		process.off("SIGINT", stop)
		process.off("SIGTERM", stop)
	}
}

function option(args: readonly string[], name: string): string | null {
	const index = args.indexOf(name)
	return index < 0 ? null : args[index + 1] ?? null
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))

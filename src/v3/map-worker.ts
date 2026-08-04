#!/usr/bin/env bun
import { pathToFileURL } from "node:url"

type MapWorkerResult = { readonly kind: "produced"; readonly value: unknown } | { readonly kind: "absent" }

async function main(argv: readonly string[]): Promise<number> {
	const [modulePath, exportName] = argv
	if (modulePath === undefined || exportName === undefined) throw new Error("usage: map-worker MODULE_PATH EXPORT_NAME")
	const input: unknown = await new Response(Bun.stdin.stream()).json()
	// Definition assets are runtime-selected plugins, so a static import cannot name this module.
	const loaded: Record<string, unknown> = await import(pathToFileURL(modulePath).href)
	const adapter = loaded[exportName]
	if (typeof adapter !== "function") throw new Error(`map export ${exportName} is not a function`)
	const candidate: unknown = await adapter(input)
	const result: MapWorkerResult = candidate === undefined
		? { kind: "absent" }
		: { kind: "produced", value: candidate }
	process.stdout.write(`${JSON.stringify(result)}\n`)
	return 0
}

if (import.meta.main) {
	try {
		process.exitCode = await main(process.argv.slice(2))
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
		process.exitCode = 1
	}
}

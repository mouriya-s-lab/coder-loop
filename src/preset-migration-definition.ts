#!/usr/bin/env bun

import { resolve } from "node:path"
import { type as arkType } from "arktype"

import { loadPreset, resolvePresetDir } from "./loop"
import { presetExecutionContentIdentity } from "./scheduler"

const MigrationPresetInputBoundary = arkType({
	preset: "string|null",
	presetPath: "string|null",
	repoCwd: "string>0",
	materializeRoot: "string>0",
})

async function main(): Promise<void> {
	const encoded = process.argv[2]
	if (encoded === undefined) throw new Error("missing migration preset input")
	const input = MigrationPresetInputBoundary.assert(JSON.parse(encoded))
	const presetDir = resolvePresetDir({ preset: input.preset, presetPath: input.presetPath }, resolve(import.meta.dir, ".."), input.repoCwd)
	const preset = await loadPreset(presetDir, { materialize: { root: input.materializeRoot } })
	const definitionContentIdentity = await presetExecutionContentIdentity({ presetDir, preset })
	process.stdout.write(JSON.stringify({
		definitionKind: "preset",
		definitionContentIdentity,
		definitionPhaseNames: preset.phases.map((phase) => phase.name),
	}))
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	return JSON.stringify(error)
}

main().catch((error: unknown) => {
	process.stderr.write(`${errorMessage(error)}\n`)
	process.exit(1)
})

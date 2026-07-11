import { LOOP_RUN_CREDENTIAL_ENV } from "./runtime-paths"

delete process.env[LOOP_RUN_CREDENTIAL_ENV]

function withRepositoryTestEnvironment(options: unknown): object {
	if (options === undefined) return { env: process.env }
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new TypeError("Bun spawn options must be an object")
	}
	if ("env" in options && options.env !== undefined) return options
	return { ...options, env: process.env }
}

function repositoryTestSpawnArguments(argumentsList: unknown[]): unknown[] {
	const nextArguments = [...argumentsList]
	const optionsIndex = Array.isArray(nextArguments[0]) ? 1 : 0
	nextArguments[optionsIndex] = withRepositoryTestEnvironment(nextArguments[optionsIndex])
	return nextArguments
}

// Bun's default spawn environment is the process environment captured at launch, so deleting
// from process.env alone does not affect subprocesses whose call sites omit `env`. Test-default
// subprocesses must inherit the sanitized repository test context; explicit env remains intact.
Bun.spawn = new Proxy(Bun.spawn, {
	apply(target, thisArgument, argumentsList) {
		return Reflect.apply(target, thisArgument, repositoryTestSpawnArguments(argumentsList))
	},
})
Bun.spawnSync = new Proxy(Bun.spawnSync, {
	apply(target, thisArgument, argumentsList) {
		return Reflect.apply(target, thisArgument, repositoryTestSpawnArguments(argumentsList))
	},
})

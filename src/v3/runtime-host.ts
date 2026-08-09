import { Effect, Layer } from "effect"
import { TypedAdmissionLive } from "./admission"
import { DaemonProtocolLive } from "./daemon-handler"
import { makeDaemonSocketLive, type DaemonSocketConfig, type DaemonTransportError } from "./daemon-socket"
import { makeDefinitionStoreLive } from "./definition-store"
import { makeMapRuntimeLive, PredicateRuntimeLive, type MapRuntimeConfig } from "./function-adapters"
import { makeFunctionRuntimeLive } from "./function-runtime"
import { makeRepositoryGitLive, type GitServiceConfig } from "./git-service"
import { GroupConsumerRuntimeLive } from "./group-consumer"
import { HookRuntime, makeHookRuntimeLive, type HookDeclaration, type HookRuntimeError } from "./hooks"
import { RuntimeOrchestrator, makeRuntimeOrchestratorLive, type OrchestratorError } from "./orchestrator"
import { makeProviderFactStoreLive, makeRunnerProviderLive, type RunnerConfig } from "./provider"
import { makeRuntimeRecoveryLive } from "./recovery"
import { SchedulerLive } from "./scheduler"
import { makeObjectDomainStoreLive, ObjectDomainStore, type ObjectStoreError } from "./sqlite-store"

export type RuntimeHostConfig = {
	readonly databaseFile: string
	readonly definitionRoot: string
	readonly providerFactRoot: string
	readonly hookRoot: string
	readonly socket: Omit<DaemonSocketConfig, "onError">
	readonly agentSubmitArgv: readonly string[]
	readonly map: MapRuntimeConfig
	readonly git: GitServiceConfig
	readonly runner: RunnerConfig
	readonly hooks: readonly HookDeclaration[]
	readonly hookShutdownWaitMs: number
	readonly leaseMs: number
	readonly maxConcurrency: number
	readonly cycleMs: number
	readonly onTransportError: DaemonSocketConfig["onError"]
	readonly onCycleError: (error: OrchestratorError) => void
}

export type RuntimeHostStartupError = ObjectStoreError | DaemonTransportError | HookRuntimeError

export function runRuntimeHost(config: RuntimeHostConfig): Effect.Effect<never, RuntimeHostStartupError> {
	if (!Number.isInteger(config.cycleMs) || config.cycleMs <= 0) throw new Error("cycleMs must be a positive integer")
	const store = makeObjectDomainStoreLive(config.databaseFile)
	const definitions = makeDefinitionStoreLive(config.definitionRoot)
	const providerFacts = makeProviderFactStoreLive(config.providerFactRoot)
	const repository = makeRepositoryGitLive(config.git)
	const hooks = makeHookRuntimeLive(config.hookRoot, config.hooks, config.hookShutdownWaitMs)
	const maps = makeMapRuntimeLive(config.map).pipe(Layer.provide(definitions))
	const predicates = PredicateRuntimeLive
	const consumers = GroupConsumerRuntimeLive
	const provider = makeRunnerProviderLive(config.runner).pipe(Layer.provide(providerFacts))
	const scheduler = SchedulerLive.pipe(Layer.provide(store))
	const recovery = makeRuntimeRecoveryLive(config.leaseMs).pipe(Layer.provide(Layer.mergeAll(store, providerFacts, repository)))
	const functionRuntime = makeFunctionRuntimeLive({ socketPath: config.socket.agentPath, submitArgv: config.agentSubmitArgv }).pipe(Layer.provide(Layer.mergeAll(definitions, store, maps, predicates, hooks, provider, providerFacts)))
	const admission = TypedAdmissionLive.pipe(Layer.provide(store))
	const services = Layer.mergeAll(store, definitions, providerFacts, repository, hooks, maps, predicates, consumers, provider, scheduler, recovery, functionRuntime, admission)
	const protocol = DaemonProtocolLive.pipe(Layer.provide(services))
	const socket = makeDaemonSocketLive({ ...config.socket, onError: config.onTransportError }).pipe(Layer.provide(protocol))
	const orchestrator = makeRuntimeOrchestratorLive(config.leaseMs, config.maxConcurrency).pipe(Layer.provide(services))
	const runtime = Layer.mergeAll(services, protocol, orchestrator)
	const program = Effect.gen(function*() {
		const daemon = yield* RuntimeOrchestrator
		const objectStore = yield* ObjectDomainStore
		const hookRuntime = yield* HookRuntime
		yield* hookRuntime.recover
		yield* Layer.build(socket)
		const cycle = Effect.catchAll(
			Effect.flatMap(objectStore.listChains, (chains) => daemon.cycle(chains, Date.now())),
			(error) => Effect.sync(() => config.onCycleError(error)),
		)
		yield* Effect.forkScoped(Effect.forever(Effect.zipRight(cycle, Effect.sleep(config.cycleMs))))
		return yield* Effect.never
	})
	return Effect.scoped(program.pipe(Effect.provide(runtime)))
}

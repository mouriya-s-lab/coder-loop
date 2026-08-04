import { Context, Effect, Layer } from "effect"
import {
	evaluateAdmission,
	type AdmissionRequest,
	type AdmissionResult,
	type ChainIdentity,
	type TaskIdentity,
} from "./object-domain"
import { ObjectDomainStore, type CommitResult, type ObjectStoreError } from "./sqlite-store"

export type AdmissionCommitResult =
	| { readonly kind: "admitted"; readonly admission: Extract<AdmissionResult, { kind: "admitted" }>; readonly commit: CommitResult }
	| Extract<AdmissionResult, { kind: "rejected" }>

export type AdmissionService = {
	readonly admit: (chain: ChainIdentity, request: AdmissionRequest) => Effect.Effect<AdmissionCommitResult, ObjectStoreError>
	readonly unhold: (task: TaskIdentity, commandIdentity: string) => Effect.Effect<CommitResult, ObjectStoreError>
}

export class TypedAdmission extends Context.Tag("coder-loop/v3/TypedAdmission")<TypedAdmission, AdmissionService>() {}

export const TypedAdmissionLive: Layer.Layer<TypedAdmission, never, ObjectDomainStore> = Layer.effect(TypedAdmission, Effect.gen(function*() {
	const store = yield* ObjectDomainStore
	return {
		admit: (chain, request) => Effect.flatMap(store.readSnapshot(chain), (snapshot) => {
			const admission = evaluateAdmission(snapshot, request)
			if (admission.kind === "rejected") return Effect.succeed(admission)
			return Effect.map(store.commit({
				identity: `admit:${request.fact.source}:${request.fact.value}`,
				transition: { family: "task-admission", fact: request.fact, task: admission.task, position: admission.position },
			}), (commit): AdmissionCommitResult => ({ kind: "admitted", admission, commit }))
		}),
		unhold: (task, commandIdentity) => store.commit({ identity: commandIdentity, transition: { family: "task-unhold", task } }),
	}
}))

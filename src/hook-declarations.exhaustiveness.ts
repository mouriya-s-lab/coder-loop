import type { HookDeclaration, HookInput, ObserverHookPointOf } from "./hook-declarations"
import type { ObservabilityEventType } from "./observability"

export const HOOK_DECLARATION_KIND_EXHAUSTIVENESS_FIXTURE = {
	observer: true,
	gate: true,
} satisfies Record<HookDeclaration["kind"], true>

export const HOOK_INPUT_KIND_EXHAUSTIVENESS_FIXTURE = {
	observer: true,
	gate: true,
} satisfies Record<HookInput["kind"], true>

type SyntheticFutureObservabilityEventType = ObservabilityEventType | "future.lifecycle" | "hook.future"
type SyntheticFutureObserverHookPoint = ObserverHookPointOf<SyntheticFutureObservabilityEventType>

export const SYNTHETIC_FUTURE_EVENT_IS_OBSERVER_POINT: "future.lifecycle" extends SyntheticFutureObserverHookPoint ? true : never = true
export const SYNTHETIC_FUTURE_HOOK_EVENT_IS_EXCLUDED: "hook.future" extends SyntheticFutureObserverHookPoint ? never : true = true

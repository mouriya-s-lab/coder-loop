import type { HookDeclaration, HookInput } from "./hook-declarations"

export const HOOK_DECLARATION_KIND_EXHAUSTIVENESS_FIXTURE = {
	observer: true,
	gate: true,
} satisfies Record<HookDeclaration["kind"], true>

export const HOOK_INPUT_KIND_EXHAUSTIVENESS_FIXTURE = {
	observer: true,
	gate: true,
} satisfies Record<HookInput["kind"], true>

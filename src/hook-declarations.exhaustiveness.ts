import type { HookDeclaration } from "./hook-declarations"

export const HOOK_DECLARATION_KIND_EXHAUSTIVENESS_FIXTURE = {
	observer: true,
	gate: true,
} satisfies Record<HookDeclaration["kind"], true>

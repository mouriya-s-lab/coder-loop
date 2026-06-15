import type { InternalStatus } from "./runtime-data"

type StatusLiteralComparable<T> =
	T extends InternalStatus ? string | InternalStatus
		: T extends readonly InternalStatus[] ? readonly (string | InternalStatus)[]
			: T

declare module "bun:test" {
	interface Matchers<T = unknown> {
		toBe(expected: StatusLiteralComparable<T>): void
		toEqual(expected: StatusLiteralComparable<T>): void
	}
}

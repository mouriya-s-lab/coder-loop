export type BoundaryValue = unknown
export type BoundaryRecord = { [key: string]: BoundaryValue }
export type BoundaryError = unknown

export function isBoundaryRecord(value: unknown): value is BoundaryRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

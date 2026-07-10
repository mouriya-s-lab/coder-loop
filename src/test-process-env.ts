import { LOOP_RUN_CREDENTIAL_ENV } from "./runtime-paths"

export function operatorFixtureEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	const environment = { ...process.env }
	delete environment[LOOP_RUN_CREDENTIAL_ENV]
	return { ...environment, ...overrides }
}

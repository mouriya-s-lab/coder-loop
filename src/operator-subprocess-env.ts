export type SubprocessEnvironment = Record<string, string | undefined>

export function operatorSubprocessEnv(overrides: SubprocessEnvironment = {}): SubprocessEnvironment {
	const environment = { ...process.env }
	delete environment.CODER_LOOP_RUN_CRED
	return { ...environment, ...overrides }
}

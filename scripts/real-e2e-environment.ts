export function operatorSubprocessEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...parentEnvironment }
	delete environment.CODER_LOOP_RUN_CRED
	return environment
}

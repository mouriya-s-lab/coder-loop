import { runCoderLoopCli } from "./loop"

type CliWorkerRequest = {
	id: string
	args: string[]
	env: Record<string, string>
}

type CliWorkerResponse = {
	id: string
	exitCode: number
	stdout: string
	stderr: string
}

let commandQueue: Promise<void> = Promise.resolve()

self.onmessage = (event: MessageEvent<unknown>) => {
	const request = parseRequest(event.data)
	commandQueue = commandQueue.then(async () => {
		const response = await runCommand(request)
		self.postMessage(response)
	})
}

async function runCommand(request: CliWorkerRequest): Promise<CliWorkerResponse> {
	let stdout = ""
	let stderr = ""
	const previousEnvironment = new Map<string, string | undefined>()
	const stdoutWrite = process.stdout.write
	const stderrWrite = process.stderr.write

	for (const [key, value] of Object.entries({ CODER_LOOP_RUN_CRED: "", ...request.env })) {
		previousEnvironment.set(key, process.env[key])
		if (key === "CODER_LOOP_RUN_CRED" && value.length === 0) delete process.env[key]
		else process.env[key] = value
	}
	Reflect.set(process.stdout, "write", (chunk: unknown) => {
		stdout += decodeChunk(chunk)
		return true
	})
	Reflect.set(process.stderr, "write", (chunk: unknown) => {
		stderr += decodeChunk(chunk)
		return true
	})
	let exitCode = 0
	try {
		exitCode = await runCoderLoopCli(request.args)
	} catch (error) {
		stderr += `${errorMessage(error)}\n`
		exitCode = 1
	} finally {
		Reflect.set(process.stdout, "write", stdoutWrite)
		Reflect.set(process.stderr, "write", stderrWrite)
		for (const [key, value] of previousEnvironment) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}

	return { id: request.id, exitCode, stdout, stderr }
}

function parseRequest(value: unknown): CliWorkerRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("central CLI worker request must be an object")
	const id = Reflect.get(value, "id")
	const args = Reflect.get(value, "args")
	const env = Reflect.get(value, "env")
	if (typeof id !== "string") throw new Error("central CLI worker request id must be a string")
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("central CLI worker args must be strings")
	if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error("central CLI worker env must be an object")
	const parsedEnvironment: Record<string, string> = {}
	for (const [key, entry] of Object.entries(env)) {
		if (typeof entry !== "string") throw new Error(`central CLI worker env ${key} must be a string`)
		parsedEnvironment[key] = entry
	}
	return { id, args, env: parsedEnvironment }
}

function decodeChunk(chunk: unknown): string {
	if (typeof chunk === "string") return chunk
	if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk)
	return String(chunk)
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	return JSON.stringify(error)
}

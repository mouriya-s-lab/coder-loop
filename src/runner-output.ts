import { StringDecoder } from "node:string_decoder"

export type StreamTextState = {
	observe: (chunk: Buffer) => void
	finish: () => void
	bytes: () => number
	pendingChars: () => number
}

/**
 * Incrementally decodes a byte stream and emits complete lines. Only the current
 * unterminated line is retained; completed output remains solely in the artifact
 * writer owned by the caller.
 */
export function createStreamTextState(onLine: (line: string) => void): StreamTextState {
	const decoder = new StringDecoder("utf8")
	let pendingLine = ""
	let byteCount = 0

	const observeText = (text: string): void => {
		pendingLine += text
		let newline = pendingLine.indexOf("\n")
		while (newline >= 0) {
			const line = pendingLine.slice(0, newline)
			pendingLine = pendingLine.slice(newline + 1)
			onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
			newline = pendingLine.indexOf("\n")
		}
	}

	return {
		observe: (chunk) => {
			byteCount += chunk.byteLength
			observeText(decoder.write(chunk))
		},
		finish: () => {
			observeText(decoder.end())
			if (pendingLine !== "") onLine(pendingLine)
			pendingLine = ""
		},
		bytes: () => byteCount,
		pendingChars: () => pendingLine.length,
	}
}

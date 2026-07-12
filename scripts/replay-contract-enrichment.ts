#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const REPOSITORY = "mouriya-s-lab/coder-loop"

export type ReplayFinding =
	| { kind: "intent-gap"; sourceUrl: string; rationale: string }
	| { kind: "preset-drift"; sourceUrl: string; rationale: string }
	| { kind: "reviewer-discretion"; sourceUrl: string; rationale: string }
	| { kind: "environment-failure"; sourceUrl: string; rationale: string }

export type ReplayContract = {
	deliverable: "implementation-pr" | "blocker-removal" | "spike-comment" | "source-writing-spike"
	checkHints: readonly string[]
	patternHint: "missing" | "changed" | "whole-tree"
	canonicalRuntimeHint: "missing" | "present"
	testDeltaHint: "missing" | "present"
}

export type ReplayResult = {
	kind: "issue-replay"
	number: number
	url: string
	contract: ReplayContract
	findings: readonly ReplayFinding[]
	evidenceDir: string
}

type IssueSnapshot = {
	number: number
	url: string
	body: string
	comments: readonly { url: string; body: string }[]
	labels: readonly { name: string }[]
}

type PullRequestSnapshot = {
	number: number
	url: string
	body: string
	reviews: readonly { url?: string; body: string; state: string }[]
	comments: readonly { url: string; body: string }[]
	closingIssueNumbers: readonly number[]
}

type PullRequestReplayResult = {
	kind: "pr-replay"
	number: number
	url: string
	closingIssueNumbers: readonly number[]
	reviewSignalCount: number
	environmentSignalCount: number
	evidenceDir: string
}

function record(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context}: expected object`)
	return value as Record<string, unknown>
}

function stringValue(value: unknown, context: string): string {
	if (typeof value !== "string") throw new Error(`${context}: expected string`)
	return value
}

function numberValue(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${context}: expected integer`)
	return value
}

function arrayValue(value: unknown, context: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`${context}: expected array`)
	return value
}

function ghJson(args: readonly string[]): unknown {
	const result = spawnSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
	if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr}`)
	return JSON.parse(result.stdout)
}

function ghPages(endpoint: string): unknown {
	return ghJson(["api", "--paginate", "--slurp", endpoint])
}

function parseIssueSnapshot(value: unknown): IssueSnapshot {
	const input = record(value, "issue")
	return {
		number: numberValue(input.number, "issue.number"),
		url: stringValue(input.url, "issue.url"),
		body: stringValue(input.body, "issue.body"),
		comments: arrayValue(input.comments, "issue.comments").map((entry, index) => {
			const comment = record(entry, `issue.comments[${index}]`)
			return { url: stringValue(comment.url, `issue.comments[${index}].url`), body: stringValue(comment.body, `issue.comments[${index}].body`) }
		}),
		labels: arrayValue(input.labels, "issue.labels").map((entry, index) => {
			const label = record(entry, `issue.labels[${index}]`)
			return { name: stringValue(label.name, `issue.labels[${index}].name`) }
		}),
	}
}

function parsePullRequestSnapshot(value: unknown): PullRequestSnapshot {
	const input = record(value, "pullRequest")
	return {
		number: numberValue(input.number, "pullRequest.number"),
		url: stringValue(input.url, "pullRequest.url"),
		body: stringValue(input.body, "pullRequest.body"),
		reviews: arrayValue(input.reviews, "pullRequest.reviews").map((entry, index) => {
			const review = record(entry, `pullRequest.reviews[${index}]`)
			return {
				...(typeof review.url === "string" ? { url: review.url } : {}),
				body: stringValue(review.body, `pullRequest.reviews[${index}].body`),
				state: stringValue(review.state, `pullRequest.reviews[${index}].state`),
			}
		}),
		comments: arrayValue(input.comments, "pullRequest.comments").map((entry, index) => {
			const comment = record(entry, `pullRequest.comments[${index}]`)
			return { url: stringValue(comment.url, `pullRequest.comments[${index}].url`), body: stringValue(comment.body, `pullRequest.comments[${index}].body`) }
		}),
		closingIssueNumbers: arrayValue(input.closingIssuesReferences, "pullRequest.closingIssuesReferences").map((entry, index) => {
			const issue = record(entry, `pullRequest.closingIssuesReferences[${index}]`)
			return numberValue(issue.number, `pullRequest.closingIssuesReferences[${index}].number`)
		}),
	}
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text))
}

export function classifyReplay(issue: IssueSnapshot, pullRequests: readonly PullRequestSnapshot[]): Omit<ReplayResult, "evidenceDir"> {
	const intentText = [issue.body, ...issue.comments.map((comment) => comment.body)].join("\n")
	const findings: ReplayFinding[] = []
	const hasChecks = hasAny(intentText, [/##\s*验收标准/i, /##\s*验证步骤/i, /acceptance criteria/i])
	const hasPattern = /pattern|全仓|whole[- ]tree|changed scope/i.test(intentText)
	const hasRuntime = /e2e|end[- ]to[- ]end|真实运行|runtime|browser/i.test(intentText)
	const hasTestDelta = /test[- ]delta|测试变更|测试.*允许|forbidden/i.test(intentText)
	if (!hasChecks || !hasPattern || !hasRuntime || !hasTestDelta) {
		findings.push({ kind: "intent-gap", sourceUrl: issue.url, rationale: "通用 issue 没有预先给出完整 Checks / Pattern / canonical runtime / Test delta；该缺项需要 enrichment 调查，不是 implementation failure。" })
	}
	if (/Pattern 验收|script-produced e2e|script e2e|live issue body executable/i.test(intentText)) {
		findings.push({ kind: "preset-drift", sourceUrl: issue.url, rationale: "输入携带旧 preset vocabulary；回放必须按 current marker schema 归一，不能把旧 wording 当当前 executable authority。" })
	}
	for (const pr of pullRequests) {
		const reviewInputs = [
			...pr.reviews.map((review) => ({ sourceUrl: review.url ?? pr.url, body: review.body })),
			...pr.comments.map((comment) => ({ sourceUrl: comment.url, body: comment.body })),
		]
		for (const review of reviewInputs) {
			if (review.body.trim() === "") continue
			if (hasAny(review.body, [/scope/i, /failure path/i, /evidence/i, /project convention/i, /pattern/i, /test/i, /证据/i, /失败路径/i, /项目约定/i])) {
				findings.push({ kind: "reviewer-discretion", sourceUrl: review.sourceUrl, rationale: "review 加码涉及 scope mapping、失败路径、证据真实性、Pattern 或项目约定，属于 reviewer 保留裁量；是否要求 re-enrichment 取决于它是否证明 marker executable fact 错误。" })
			}
			if (hasAny(review.body, [/timeout/i, /unreachable/i, /credential/i, /environment/i, /rate limit/i, /network/i, /环境/i, /凭据/i, /超时/i])) {
				findings.push({ kind: "environment-failure", sourceUrl: review.sourceUrl, rationale: "review 记录了运行环境/外部依赖失败；该来源必须与 intent gap、preset drift 和实现缺陷分开保存。" })
			}
		}
	}
	const labelNames = issue.labels.map((label) => label.name.toLowerCase())
	const deliverable: ReplayContract["deliverable"] = labelNames.some((label) => label.includes("spike"))
		? "spike-comment"
		: /unblock|解除阻塞|blocker/i.test(intentText)
			? "blocker-removal"
			: /source[- ]writing|源码写作/i.test(intentText)
				? "source-writing-spike"
				: "implementation-pr"
	return {
		kind: "issue-replay",
		number: issue.number,
		url: issue.url,
		contract: {
			deliverable,
			checkHints: hasChecks ? ["issue-provided-check-intent"] : [],
			patternHint: hasPattern ? (/whole[- ]tree|全仓/i.test(intentText) ? "whole-tree" : "changed") : "missing",
			canonicalRuntimeHint: hasRuntime ? "present" : "missing",
			testDeltaHint: hasTestDelta ? "present" : "missing",
		},
		findings,
	}
}

function parseNumberList(value: string): number[] {
	return value.split(",").map((part) => {
		const parsed = Number.parseInt(part, 10)
		if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid number list entry: ${part}`)
		return parsed
	})
}

function option(argv: readonly string[], flag: string): string {
	const index = argv.indexOf(flag)
	if (index === -1 || argv[index + 1] === undefined) throw new Error(`${flag} is required`)
	return argv[index + 1]!
}

function optionalOption(argv: readonly string[], flag: string): string | undefined {
	const index = argv.indexOf(flag)
	if (index === -1) return undefined
	if (argv[index + 1] === undefined) throw new Error(`${flag} requires a value`)
	return argv[index + 1]
}

function writeEvidence(dir: string, name: string, value: unknown): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function main(argv: readonly string[]): Promise<void> {
	const issueNumbers = parseNumberList(option(argv, "--issues"))
	const prNumbers = parseNumberList(option(argv, "--prs"))
	const outputRoot = resolve(optionalOption(argv, "--output") ?? ".coder-loop/runtime/contract-enrichment-replay")
	const prSnapshots = new Map<number, PullRequestSnapshot>()
	const pullRequestResults: PullRequestReplayResult[] = []
	for (const number of prNumbers) {
		const dir = resolve(outputRoot, `pr-${number}`)
		const view = ghJson(["pr", "view", String(number), "-R", REPOSITORY, "--json", "number,url,body,state,title,comments,reviews,reviewDecision,statusCheckRollup,labels,assignees,files,commits,closingIssuesReferences"])
		writeEvidence(dir, "view.json", view)
		writeEvidence(dir, "issue-comments-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/comments`))
		writeEvidence(dir, "review-comments-pages.json", ghPages(`repos/${REPOSITORY}/pulls/${number}/comments`))
		writeEvidence(dir, "reviews-pages.json", ghPages(`repos/${REPOSITORY}/pulls/${number}/reviews`))
		writeEvidence(dir, "timeline-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/timeline`))
		const snapshot = parsePullRequestSnapshot(view)
		prSnapshots.set(number, snapshot)
		const reviewTexts = [...snapshot.reviews.map((review) => review.body), ...snapshot.comments.map((comment) => comment.body)]
		pullRequestResults.push({
			kind: "pr-replay",
			number,
			url: snapshot.url,
			closingIssueNumbers: snapshot.closingIssueNumbers,
			reviewSignalCount: reviewTexts.filter((body) => hasAny(body, [/scope/i, /evidence/i, /pattern/i, /test/i, /证据/i, /失败路径/i])).length,
			environmentSignalCount: reviewTexts.filter((body) => hasAny(body, [/timeout/i, /unreachable/i, /credential/i, /environment/i, /network/i, /环境/i, /超时/i])).length,
			evidenceDir: dir,
		})
	}
	const results: ReplayResult[] = []
	for (const number of issueNumbers) {
		const dir = resolve(outputRoot, `issue-${number}`)
		const view = ghJson(["issue", "view", String(number), "-R", REPOSITORY, "--json", "number,url,body,state,title,comments,labels,assignees,projectItems,closedByPullRequestsReferences"])
		writeEvidence(dir, "view.json", view)
		writeEvidence(dir, "comments-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/comments`))
		writeEvidence(dir, "events-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/events`))
		writeEvidence(dir, "timeline-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/timeline`))
		const relatedPullRequests = [...prSnapshots.values()].filter((pr) =>
			pr.closingIssueNumbers.includes(number) || new RegExp(`(?:Closes|Fixes|Resolves)\\s+#${number}\\b`, "i").test(pr.body),
		)
		results.push({ ...classifyReplay(parseIssueSnapshot(view), relatedPullRequests), evidenceDir: dir })
	}
	writeEvidence(outputRoot, "report.json", { repository: REPOSITORY, generatedAt: new Date().toISOString(), issues: results, pullRequests: pullRequestResults })
	process.stdout.write(`${resolve(outputRoot, "report.json")}\n`)
}

if (import.meta.main) {
	await main(process.argv.slice(2))
}

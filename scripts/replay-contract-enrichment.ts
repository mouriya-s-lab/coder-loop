#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const REPOSITORY = "mouriya-s-lab/coder-loop"

type FindingEvidence = { sourceUrl: string; excerpt: string; rationale: string }
export type ReplayFinding =
	| ({ kind: "intent-gap" } & FindingEvidence)
	| ({ kind: "preset-drift" } & FindingEvidence)
	| ({ kind: "reviewer-discretion" } & FindingEvidence)
	| ({ kind: "environment-failure" } & FindingEvidence)
	| ({ kind: "contract-defect" } & FindingEvidence)

export type ReplayContract = { kind: "cannot-generate"; reasons: readonly string[] }

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

export function flattenPages(value: unknown, context: string): readonly unknown[] {
	return arrayValue(value, context).flatMap((page, index) => arrayValue(page, `${context}[${index}]`))
}

function restComments(value: unknown, context: string): { url: string; body: string }[] {
	return flattenPages(value, context).map((entry, index) => {
		const comment = record(entry, `${context}.entry[${index}]`)
		return { url: stringValue(comment.html_url, `${context}.entry[${index}].html_url`), body: typeof comment.body === "string" ? comment.body : "" }
	})
}

function restReviews(value: unknown, context: string): { url?: string; body: string; state: string }[] {
	return flattenPages(value, context).map((entry, index) => {
		const review = record(entry, `${context}.entry[${index}]`)
		return {
			...(typeof review.html_url === "string" ? { url: review.html_url } : {}),
			body: typeof review.body === "string" ? review.body : "",
			state: typeof review.state === "string" ? review.state : "COMMENTED",
		}
	})
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

function matchingExcerpt(text: string, patterns: readonly RegExp[]): string {
	const normalized = text.replace(/\s+/g, " ").trim()
	for (const pattern of patterns) {
		const match = pattern.exec(normalized)
		if (match === null || match.index === undefined) continue
		return normalized.slice(Math.max(0, match.index - 80), match.index + match[0].length + 180)
	}
	return normalized.slice(0, 280)
}

export function classifyReplay(issue: IssueSnapshot, pullRequests: readonly PullRequestSnapshot[]): Omit<ReplayResult, "evidenceDir"> {
	const intentText = [issue.body, ...issue.comments.map((comment) => comment.body)].join("\n")
	const findings: ReplayFinding[] = []
	const hasChecks = hasAny(intentText, [/##\s*验收标准/i, /##\s*验证步骤/i, /acceptance criteria/i])
	const hasPattern = /pattern|全仓|whole[- ]tree|changed scope/i.test(intentText)
	const hasRuntime = /e2e|end[- ]to[- ]end|真实运行|runtime|browser/i.test(intentText)
	const hasTestDelta = /test[- ]delta|测试变更|测试.*允许|forbidden/i.test(intentText)
	if (!hasChecks || !hasPattern || !hasRuntime || !hasTestDelta) {
		findings.push({ kind: "intent-gap", sourceUrl: issue.url, excerpt: matchingExcerpt(issue.body, [/验收标准/i, /acceptance/i]), rationale: "通用 issue 没有预先给出完整 Checks / Pattern / canonical runtime / Test delta；该缺项需要 enrichment 调查，不是 implementation failure。" })
	}
	const sourceEntries = [
		{ sourceUrl: issue.url, body: issue.body },
		...issue.comments.map((comment) => ({ sourceUrl: comment.url, body: comment.body })),
		...pullRequests.flatMap((pr) => [
			...pr.reviews.map((review) => ({ sourceUrl: review.url ?? pr.url, body: review.body })),
			...pr.comments.map((comment) => ({ sourceUrl: comment.url, body: comment.body })),
		]),
	]
	for (const source of sourceEntries) {
		const driftPatterns = [/Pattern 验收/i, /script-produced e2e/i, /script e2e/i, /script\/harness/i, /live issue body executable/i]
		if (!hasAny(source.body, driftPatterns)) continue
		findings.push({ kind: "preset-drift", sourceUrl: source.sourceUrl, excerpt: matchingExcerpt(source.body, driftPatterns), rationale: "该来源携带旧 preset vocabulary；回放必须按 current marker schema 归一，不能把旧 wording 当当前 executable authority。" })
	}
	for (const pr of pullRequests) {
		const reviewInputs = [
			...pr.reviews.map((review) => ({ sourceUrl: review.url ?? pr.url, body: review.body })),
			...pr.comments.map((comment) => ({ sourceUrl: comment.url, body: comment.body })),
		]
		for (const review of reviewInputs) {
			if (review.body.trim() === "") continue
			const defectPatterns = [/issue contract error/i, /contract.*malformed/i, /验收标准.*malformed/i, /缺.*Pattern 验收/i, /literal command.*fail/i]
			const discretionPatterns = [/code finding/i, /design-deviation/i, /logic @/i, /failure path/i, /evidence truth/i, /project convention/i, /证据真实性/i, /失败路径/i, /项目约定/i]
			const environmentPatterns = [/timeout/i, /unreachable/i, /credential/i, /environment/i, /rate limit/i, /network/i, /环境/i, /凭据/i, /超时/i]
			if (hasAny(review.body, defectPatterns)) findings.push({ kind: "contract-defect", sourceUrl: review.sourceUrl, excerpt: matchingExcerpt(review.body, defectPatterns), rationale: "该 review 命题明确指向 executable contract 的表格、命令或 Pattern scope 本身不可执行；应走 re-enrichment，而不是 implementation retry。" })
			if (hasAny(review.body, discretionPatterns)) findings.push({ kind: "reviewer-discretion", sourceUrl: review.sourceUrl, excerpt: matchingExcerpt(review.body, discretionPatterns), rationale: "该 review 命题可追溯到代码正确性、失败路径、证据真实性或项目约定，属于 reviewer 保留裁量。" })
			if (hasAny(review.body, environmentPatterns)) {
				findings.push({ kind: "environment-failure", sourceUrl: review.sourceUrl, excerpt: matchingExcerpt(review.body, environmentPatterns), rationale: "review 记录了运行环境/外部依赖失败；该来源必须与 intent gap、preset drift 和实现缺陷分开保存。" })
			}
		}
	}
	const missing: string[] = []
	if (!hasChecks) missing.push("no executable Check intent could be identified")
	if (!hasPattern) missing.push("Pattern scope requires source investigation")
	if (!hasRuntime) missing.push("canonical runtime requires target investigation")
	if (!hasTestDelta) missing.push("Test delta authorization is absent")
	if (missing.length === 0) missing.push("historical replay cannot verify source-derived Pattern criterion, canonical runtime fields, dependency edges, and explicit Test delta authorization")
	const contract: ReplayContract = { kind: "cannot-generate", reasons: missing }
	return {
		kind: "issue-replay",
		number: issue.number,
		url: issue.url,
		contract,
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
		const issueCommentPages = ghPages(`repos/${REPOSITORY}/issues/${number}/comments`)
		const inlineCommentPages = ghPages(`repos/${REPOSITORY}/pulls/${number}/comments`)
		const reviewPages = ghPages(`repos/${REPOSITORY}/pulls/${number}/reviews`)
		writeEvidence(dir, "view.json", view)
		writeEvidence(dir, "issue-comments-pages.json", issueCommentPages)
		writeEvidence(dir, "review-comments-pages.json", inlineCommentPages)
		writeEvidence(dir, "reviews-pages.json", reviewPages)
		writeEvidence(dir, "timeline-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/timeline`))
		const viewRecord = record(view, "pullRequest view")
		const snapshot = parsePullRequestSnapshot({
			...viewRecord,
			comments: [...restComments(issueCommentPages, "issue comments"), ...restComments(inlineCommentPages, "inline review comments")],
			reviews: restReviews(reviewPages, "reviews"),
		})
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
		const commentPages = ghPages(`repos/${REPOSITORY}/issues/${number}/comments`)
		writeEvidence(dir, "view.json", view)
		writeEvidence(dir, "comments-pages.json", commentPages)
		writeEvidence(dir, "events-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/events`))
		writeEvidence(dir, "timeline-pages.json", ghPages(`repos/${REPOSITORY}/issues/${number}/timeline`))
		const issueView = record(view, "issue view")
		const issueSnapshot = parseIssueSnapshot({ ...issueView, comments: restComments(commentPages, "issue comments") })
		const relatedPullRequests = [...prSnapshots.values()].filter((pr) =>
			pr.closingIssueNumbers.includes(number) || new RegExp(`(?:Closes|Fixes|Resolves)\\s+#${number}\\b`, "i").test(pr.body),
		)
		results.push({ ...classifyReplay(issueSnapshot, relatedPullRequests), evidenceDir: dir })
	}
	writeEvidence(outputRoot, "report.json", { repository: REPOSITORY, generatedAt: new Date().toISOString(), issues: results, pullRequests: pullRequestResults })
	process.stdout.write(`${resolve(outputRoot, "report.json")}\n`)
}

if (import.meta.main) {
	await main(process.argv.slice(2))
}

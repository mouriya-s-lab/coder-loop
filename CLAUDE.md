# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

coder-loop — 项目无关的 GitHub issue/PR agent loop。目标仓库提供 committed `.coder-loop/workflow.md` 和 ignored `.coder-loop/runtime/` 本地状态后，loop 交替运行 iteration agent（实现/证据/PR）和 review agent（审查/merge/close/state transition）直到队列完成。

## Commands

- **Type check**: `bun run typecheck` (alias for `bun x tsc --noEmit`)
- **Run orchestrator**: `bun run src/loop.ts [maxIter] [--target-cwd <path>] [--once]`
- **Check runtime**: `bun run src/loop.ts --target-cwd <path> --check-runtime`
- **Plan phase**: `/dev-plan` (大任务入口：读取设计/目标，生成 GitHub issues + `.coder-loop/runtime` 队列)
- **Loop phase**: `/dev-loop [N]` (消费现有队列并启动迭代循环，默认无限)

No test suite or linter — verification happens through checkpoint execution in target projects.

## Architecture

Three-phase signal pipeline: `plan → iter → review`

```
/dev-plan (large task/design → GitHub issues with checkpoint tables → .coder-loop/runtime queue)
    ↓
src/loop.ts (state machine orchestrator)
    ├→ spawn iteration agent (presets/gh-issue-pr-iteration/iter-entry.md) → implement + execute checkpoints
    ├→ write output to .dev-trace.txt
    ├→ spawn review agent (presets/gh-issue-pr-iteration/review-entry.md) → audit trace, post feedback to issue
    └→ repeat until issue closed or .dev-loop deleted
```

**Orchestrator** (`src/loop.ts`): Pure program state machine. Creates `.dev-loop` as on-switch, reads target `.coder-loop/runtime/state.json`, selects actionable issues, alternates spawning `claude -p` with iteration/review prompts, and writes trace/log/status files. It does not judge issue completion, evidence sufficiency, PR correctness, or parent closure.

**Target contract**: `loop.ts` only knows about `.coder-loop/workflow.md` (committed) and `.coder-loop/runtime/` (ignored). Other subdirectories under `.coder-loop/` (e.g. `templates/`, project-specific `prompts/`) are agent-readable convention only — they take effect only when `workflow.md` or an issue handoff explicitly points the agent at them. Runtime files must not be committed.

**Agent communication**: Iteration writes local handoff/evidence and PR updates; review reads trace, GitHub issue/PR live state, target workflow, and handoff. Durable task semantics belong in GitHub issues/PRs; `.coder-loop/runtime/` is local scheduling and handoff state.

## Key Design Concepts

**Checkpoint 4-tuples**: Each acceptance criterion compiles to `{dimension, command, env, expect}` — executable, not natural language. Agents can't skip or fake execution.

**Dimensional coverage**: Checkpoints must cover all relevant dimensions (function / environment / integration / assumption). Review agent verifies per-dimension coverage.

**Spike issues**: Risky third-party assumptions get a spike issue before implementation. Spike failure → design question, not wasted implementation.

**Inherited verification obligations**: Checkpoints that can't run in current environment are deferred to a downstream issue. Cannot be deferred twice.

## Agent Prompt 设计前提

修改 `presets/gh-issue-pr-iteration/iter-entry.md` / `presets/gh-issue-pr-iteration/review-entry.md` 之前必须理解以下前提。

### 这不是软件工程问题

Agent 的判断失误不能用工程手段（状态机、验证层、verdict 文件）修补。把判断交给没有判断能力的程序没有任何意义——正因为程序不可靠所以才交给 LLM 判断。任何试图用确定性逻辑替代 LLM 判断的方案都是在回避问题。

### 问题是 prompt 没有教 agent 怎么工作

Agent 不是"判断力差"——是没人教它怎么判断。当前 prompt 给了一个模糊目标（"verify no open issues → stop"），没有思维链，没有工作流程，没有待办事项管理。系统中最关键的决策得到了最少的认知支撑。Agent 当然走捷径，因为 prompt 给了它一个 Goal 而不是一个 Procedure。

### Agent 需要的信息分散在无数来源

做出正确的终止判断需要的证据不只在 issues 里——可能在 PR comments、SSH 日志、设计文档、git 历史中。不可能预取所有来源。所以不能用"注入 ground truth"的方式解决——需要教 agent 自己系统性地收集证据。

### 每个 agent 运行都是无状态的

每次 `claude -p` spawn 的 agent 是独立进程，没有跨轮次记忆。本地文件会丢失、会损坏、跨机器不可用。如果要用本地状态，必须每次做完即丢弃。持久化状态只能依赖 GitHub（issues / labels / comments）。

## Templates for target projects

`coder-loop` is a stateless program loop — it does not enforce PR shape, evidence rules, queue policy, or cross-issue memory. Those rules live in the target repo's `.coder-loop/workflow.md` + `.coder-loop/runtime/shared.md`, which the agents read at every spawn. Delete a rule there and the loop stops enforcing it.

`templates/` ships project-agnostic starting points distilled from a known-good default implementation (Fulcrum):

- `presets/gh-issue-pr-iteration/templates/workflow.md` — `.coder-loop/workflow.md` skeleton (goal, source-of-truth, PR/evidence rules, CI-parity, review behavior).
- `presets/gh-issue-pr-iteration/templates/shared.md` — `.coder-loop/runtime/shared.md` skeleton with allowed/forbidden memory policy.
- `presets/gh-issue-pr-iteration/templates/pr-body.md` — PR body evidence-layer skeleton.
- `templates/supervisor/` — optional outer-layer supervisor (cron-driven cross-patrol orchestration on top of the loop). Use only for long multi-mission work; short runs don't need it.

See `templates/README.md` for the copy table, minimum viable setup, and what each template is for.

## Tech Stack

Bun + TypeScript (strict, ESM). No runtime dependencies. Requires `claude` CLI and `gh` CLI on PATH.

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`
- Cross-repo refs in commit body: `Closes owner/repo#N`

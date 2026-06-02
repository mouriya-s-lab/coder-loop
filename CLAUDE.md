# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

coder-loop — 项目无关的 N 角色字符串调度引擎。给定一个 preset（角色定义、状态集、phase 列表、prompt 与变量绑定），引擎按 preset 描述的顺序 spawn 各 phase 的 agent，捕获输出，根据状态推进队列直到所有 item 落在 terminal 状态。

bundled `gh-issue-pr-iteration` preset 编码 GitHub issue/PR 两角色（iteration + review）迭代工作流，是默认 preset；`single-phase-example` 是验证 1 phase / 字符串 id / 双状态可行的最小 preset。引擎本身不知道 GitHub、不知道 phase 数量、不知道 status 字面量。

## Architecture / Layers

三层架构：

```
L1: 引擎（src/loop.ts）
    - 加载 preset、加载 target runtime、按 phase 顺序 spawn agent、resume、--check-runtime
    - 不知道 phase 数量 / status 字面量 / 已知 KEY / GitHub
    - 不判断 item 是否完成、PR 是否正确、证据是否充分

L2: Preset（presets/<name>/）
    - preset.toml: 形态契约 (item.idField / statuses / phases / fragments / agent)
    - <phase>-entry.md + fragments: 角色 prompt 与状态机语义
    - templates/: 目标侧 starter（仅当该 preset 需要 target-side policy 时）

目标侧策略：<TARGET>/.coder-loop/
    - workflow.md: committed 项目级策略（具体内容由 preset 定义）
    - runtime/{config,state,shared,issues,evidence,logs}: ignored 本地运行态
```

每层职责互不重叠：

| 层 | 知道什么 | 不知道什么 |
|---|---|---|
| L1 | 怎么 spawn / 怎么 resume / 怎么读 toml / 怎么校验 runtime | preset 名、phase 名、status 字面量、变量 KEY 含义 |
| L2 (preset) | phase 顺序、status 语义、角色边界、什么时候 verdict、什么时候 stop | target 项目命令、CI 配置、PR 模板细节 |
| target | 项目命令、CI-parity 规则、PR/evidence/review 具体形式 | 引擎调度细节、其他 preset 的事 |

## Commands

- **Type check**: `bun run typecheck` (alias for `bun x tsc --noEmit`)
- **Run unit + smoke tests**: `bun test` (覆盖 `src/loop.test.ts` + `src/smoke.test.ts`)
- **Run orchestrator directly**: `bun run src/loop.ts [N] [--target-cwd <path>] [--once]` (core loop path; operational callers should prefer daemon)
- **Status snapshot**: `coder-loop status <target> --json [--config <path>] [--repo <owner/repo>]` — stable read-only JSON API for supervisor/scripts; do not scrape runtime files first.
- **Daemon operations**: `coder-loop daemon status <target> --json`, `coder-loop daemon start|restart <target> [--max-iterations N] [--require-browser-evidence]`, `coder-loop daemon stop <target>` — stable central-daemon / target-chain control API.
- **Runtime inspection / model config**: `coder-loop runtime show <target> [--json]` 列出 preset 所有 phase（角色）当前解析到的 runner/binary/model/source；`coder-loop runtime set <target> [--claude-model opus-4-7|opus-4-8] [--codex-model gpt-5.5]` 用枚举值幂等改写 `.coder-loop/runtime/config.json` 的 `claude.model` / `codex.model`（Claude 模型自动加 `[1m]` 后缀；TOML config 不可写）。Runner kind 归 role entry md，不是 CLI 表面。
- **Check runtime**: `bun run src/loop.ts --target-cwd <path> --check-runtime`
- **Dry run**: `bun run src/loop.ts --target-cwd <path> --dry-run` (渲染 + 选 item，不 spawn agent)
- **Install target**: `coder-loop install <target> [--repo <owner/repo>] [--preset <name>] [--force] [--dry-run] [--install-skills]` — 幂等四层 bootstrap（slash commands + runtime 目录 + config + workflow.md + GitHub `kind:code`/`kind:comment`/`kind:code-spike`/`kind:blocked` 标签 + PATH/skill 检查）。源：`src/install-commands.ts`。
- **Uninstall target**: `coder-loop uninstall <target>` — 仅删 `.claude/commands/dev-*.md`；runtime 和 GitHub labels 保留。
- **Doctor**: `coder-loop doctor <target> [--repo <owner/repo>]` — 只读四层体检（target 文件 / GitHub 标签 / 操作员 PATH / writing-issue skill 版本）并输出 live runtime health。
- **Plan phase**: `/dev-plan` （`gh-issue-pr-iteration` preset 配套的规划器）
- **Loop phase**: `/dev-loop [N]` （`gh-issue-pr-iteration` preset 配套的循环入口；内部走 `coder-loop daemon start`）

## Runner Selection

Runner 默认值跟随角色 entry md，而不是 target config 或 `preset.toml`。每个 phase 的 `<role>-entry.md` 顶部可声明：

```markdown
---
defaultRunner: codex
---
```

`defaultRunner` 只能是 `claude` 或 `codex`。角色 md 未声明时走单一 engine-builtin fallback（当前为 `codex`），并在 status 中显示 `source=engine-builtin`。`target.runner.hostDefault` 只保留宿主诊断信息，不决定 phase runner。

覆盖顺序：

1. centralized queue item 上的 `"runner": "claude" | "codex"`，只影响允许 item override 的普通执行 phase（`gh-issue-pr-iteration` 中是 iteration）。
2. phase 角色 entry md 的 `defaultRunner`，status 中显示 `source=role-md`。
3. 角色 md 未声明时的 engine-builtin fallback，status 中显示 `source=engine-builtin`。

Runner binary、模型与额外参数由 config 的 `claude.binary` / `claude.model` / `claude.extraArgs`、`codex.binary` / `codex.model` / `codex.extraArgs` 提供——iteration 与 review 共享同一份 `claude.model` / `codex.model`，源码不再为 review phase 强制覆盖模型。要改 runner / 模型推荐用 `coder-loop runtime set`，它把枚举值落到 config 里（Claude 模型固定带 `[1m]` 后缀）；手写 config 也可以。`coder-loop status <target> --json` 暴露 `target.runner.phases.<phase>`、`target.runner.default`、`target.runner.reviewDefault`、`queue.selected.phaseRunners.<phase>`、`queue.selected.runner`、`queue.selected.reviewRunner`、`current.runner` 和 `current.phaseStatus.value.runner/model`；`doctor` 按 phase role-md 推导出的 runner binary 做 PATH 检查。不要从旧 flat log 或 agent `status.json` 反推 runner/model，除非 `status` 已经指出需要 fallback debug；新版 agent status 位于 `<logDir>/<runId>/<phase>/status.json`。

### 写一个新 preset 的最小流程

1. `mkdir presets/<name>/` 写 `preset.toml`（schema 见 README §「写一个新 preset」）。
2. 给每个 phase 写一份 `<phase>-entry.md`，用 frontmatter 自声明 `defaultRunner`，正文用 `{{KEY}}` 占位符引用 preset.toml `[phases.variables]` 表的 key。
3. target 在 `.coder-loop/runtime/config.json` 写 `{ "preset": "<name>" }` 或 `{ "presetPath": "<absolute-or-relative>" }`。
4. `bun src/loop.ts --target-cwd <target> --check-runtime` 应输出 `preset=<name>`、exit 0。
5. `bun src/loop.ts --target-cwd <target> --dry-run` 应输出 `selected=<id>`、exit 0。
6. 真跑前用 `doctor` 确保各 entry md 声明的 runner CLI 在 PATH 上可运行。

## gh-issue-pr-iteration preset 的设计前提

下面四条**全部是 `gh-issue-pr-iteration` preset 的前提**，不是 L1 行为。修改 `presets/gh-issue-pr-iteration/iter-entry.md` / `review-entry.md` 之前必须理解；写其他 preset 时这些可以替换或删掉。

### 这不是软件工程问题

Agent 的判断失误不能用工程手段（状态机、验证层、verdict 文件）修补。把判断交给没有判断能力的程序没意义——正因为程序不可靠所以才交给 LLM 判断。任何试图用确定性逻辑替代 LLM 判断的方案都是在回避问题。

### 问题是 prompt 没有教 agent 怎么工作

Agent 不是「判断力差」——是没人教它怎么判断。当前 prompt 给了一个模糊目标（"verify no open issues → stop"），没有思维链、没有工作流程、没有待办事项管理。系统中最关键的决策得到了最少的认知支撑。Agent 当然走捷径，因为 prompt 给了它一个 Goal 而不是一个 Procedure。

### Agent 需要的信息分散在无数来源

做出正确的终止判断需要的证据不只在 issues 里——可能在 PR comments、SSH 日志、设计文档、git 历史中。不可能预取所有来源。所以不能用「注入 ground truth」的方式解决——需要教 agent 自己系统性地收集证据。

### 每个 agent 运行都是无状态的

每次 `claude -p` spawn 的 agent 是独立进程，没有跨轮次记忆。本地文件会丢失、损坏、跨机器不可用。如果要用本地状态，必须每次做完即丢弃。持久业务语义只能依赖 GitHub（issues / labels / comments）。

## Supervisor pattern

跨 preset 通用，包在 loop 外面。`templates/supervisor/` 提供 cron-driven cross-patrol orchestration starter，long multi-mission work 适用。短单 issue 跑不需要它。

supervisor 的正常接口是 coder-loop 运维 API：

- bootstrap / repair: `coder-loop install <target>` then `coder-loop doctor <target>`
- observe: `coder-loop status <target> --json` or `coder-loop daemon status <target> --json`
- control: `coder-loop daemon start|stop|restart <target>`

不要把 runtime 文件、events JSONL、agent `status.json`、旧 `.dev-loop` 当作第一层契约来 scrape。先用 `doctor/status/daemon`；只有这些 API 指向具体异常、或需要人工恢复 runtime 时，才按 `status` 返回的路径读取 centralized DB / events / `<logDir>/<runId>/<phase>/status.json` 作为 fallback/debug evidence。

## Templates for target projects

`coder-loop` 是 stateless program loop——它不内置 PR 形态、证据规则、queue 策略、跨 issue 记忆。这些规则的具体内容由 preset 决定（preset 的 entry prompt 引用 target 的 `workflow.md / shared.md`），target 拷 starter 后改本项目命令。

starter 位置：

- `presets/<preset-name>/templates/` — 该 preset 配套的目标侧 starter（如 `gh-issue-pr-iteration/templates/{workflow,shared,pr-body}.md`）
- `templates/supervisor/` — 跨 preset 通用的 supervisor starter

详见 `templates/README.md`。

## 当前实现 vs 分层契约的差距

记录 `src/loop.ts` 仍接受 PR-shaped 概念的位置，作为下一轮重构的工单参考。这些不是 bug，是 Stage 1-3 重构尚未触及的区域：

- **supervisor bootstrap 要手动改占位符**：项目级 bootstrap skill 应自动 dispatch 到 `<TARGET>/.coder-loop/runtime/supervisor/` 下最近活动 mission（#31）。
- **runtime.\* 白名单**：当前 19 key，新增需改源码两处（`RUNTIME_BINDING_KEYS` 与 `buildRuntimeBindings`）。任何新 key 必须先 grep `presets/<preset>/` 证明已有 fragment 在 work-around 该值缺失（参考 #32 audit）。例外：与新 fragments / 新引擎能力同 issue 一并引入的 key（如 `issueKind` 配 commitment-gate fragments，#40；`agentCwd` 让 spawn cwd 可 per-item 覆盖跨 repo）不在 audit 适用范围。
- **`QueueItem` 索引签名**：preset.toml 没有声明 item 字段 schema，preset 拼错 `item.<f>` 会通过 `stringifyBindingValue` 静默生成空串。可加 `[item.fields]` schema 表把这类错误移到 preset 加载期。独立 issue 评估。

## Tech Stack

Bun + TypeScript (strict, ESM). Runtime dependencies are external CLIs: `gh` plus the selected iteration/review runner CLIs (`claude` or `codex`, optionally via config custom binary) on PATH。

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`
- Cross-repo refs in commit body: `Closes owner/repo#N`
- 引擎层禁止任何 `gh-issue-pr-iteration` 字面量（status 字符串、phase 名、`{{REPO}}` 等已知 KEY、GitHub-specific 字段名）。新增引擎代码触碰这些时一律改成读 preset。

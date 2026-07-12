# CLAUDE.md

面向在本仓库工作的 agent。项目形态、机制、CLI 细节的详细说明分散在 `docs/`，本页只钉住"改代码前必须知道的东西"。

## Project

coder-loop 是项目无关的 N-phase 字符串调度引擎。给定一个 preset（phase 列表、状态词表、prompt 与变量绑定），中央 daemon 按 preset 描述的顺序在 chain × item 上 spawn agent，捕获 trace，按 agent 写回的 item.status 推进队列，直到所有 item 落 terminal 状态。引擎不知道 phase 数量、phase 名字、status 字面量、item id 字段、GitHub。判断（issue 是否完成、PR 是否正确、证据是否充分）全部在 preset 的 agent prompt 里。

内置 preset：

- `gh-issue-pr-iteration` — 生产使用的 GitHub issue/PR 迭代 preset，四个 phase（`iteration` / `review` / `blocked-responder` / `umbrella-finalizer`）。设计思路在 `presets/gh-issue-pr-iteration/DESIGN.md`，fragment 跳转在 `docs/gh-issue-pr-iteration-fragments.md`。
- `real-e2e-minimal` — 两 phase 的最小 GitHub loop，`scripts/real-e2e.ts` 默认走这个。
- `single-phase-example` — 一 phase / 字符串 id / 双状态的最小示例。
- `business-key-example` — 演示 `[runtime].businessKeys` 声明位。

## Architecture

代码实然形态见 `docs/architecture-v2.md`（daemon + chain + scheduler + SQLite），历史演变主线（机制归引擎、参数归 preset）见 `docs/architecture-v1.md` 第四节。三层职责边界：

| 层 | 知道 | 不知道 |
|---|---|---|
| L1 引擎 (`src/loop.ts`、`src/daemon.ts`、`src/scheduler.ts`、`src/sqlite-state.ts`) | 怎么加载 preset、按 phase 顺序 spawn / resume、写 SQLite、跨 chain 调度、孤儿回收 | phase 数量与名字、status 字面量、item id 字段、已知变量 KEY、GitHub |
| L2 preset (`presets/<name>/`) | phase 顺序、状态词表与转移、角色 prompt、chain-action exits、post-review trigger DAG | target 项目命令、CI 配置、PR 模板细节 |
| target | 项目命令、CI-parity 规则、PR/evidence/review 具体形式 | 引擎调度、其他 preset |

engine-owned `runtime.*` fact 清单、preset-declared runtime business key、`[[phases]]` / `[[fragments]]` / `[item.fields]` 全部字段语义见 `docs/preset-authoring.md`。Engine runtime fact key count: 26.（`src/loop.test.ts` 用此计数守护 CLAUDE.md / `docs/preset-authoring.md` 与 `ENGINE_RUNTIME_BINDING_KEYS` 三处对齐；新增 engine runtime fact 时同步改本计数与 `docs/preset-authoring.md` 内嵌列表。）

## Commands

Root usage（源：`src/loop.ts:2684 rootUsage`）：

```
coder-loop status  <target> --json
coder-loop logs    <target> --json [--kind K] [--type T] [--chain C] [--item ID] [--run RUN_ID] [--phase P] [--since TS] [--follow]
coder-loop daemon  <up|down|status|start|stop|restart>
coder-loop chain   <create|list|status|stop|resume|delete|set-runner-model>
coder-loop item    <add|batch-add|list|update|reorder|exits|exit-action>
coder-loop queue   unblock <target> --item <item>
coder-loop doctor  <target>
```

`item exits` / `item exit-action` 是 agent 面（`--agent-run-id` / `--agent-phase` 必填），不是 operator 面。operator 常用运维流程见 `docs/operations.md`。

开发工作面：

- **Type check**: `bun run typecheck`
- **Unit + smoke tests**: `bun test`
- **Real e2e（引擎全链路验收）**: `bun scripts/real-e2e.ts [--preset <name>] [flags]` — 隔离 daemon（`--loop-data-root`，绝不碰生产 `~/.coder-loop`）→ 在 fixture repo `mouriya-s-lab/coder-loop-e2e-fixture` seed 一个 trivial issue → 跑完整 loop（spawn → iteration → review → PR merged → issue closed）→ 断言 GitHub 终态 → tripwire/teardown。默认 `real-e2e-minimal` preset（~3-5min）；`--preset gh-issue-pr-iteration` 跑全保真。runbook 见 `docs/real-e2e-fixture.md`。这只在 code 仓跑，不在 app 跑。

### 引擎/调度改动的验收主线是 real-e2e

改 `src/loop.ts` / `src/scheduler.ts` / `src/daemon.ts` 里的调度 / worktree / 终止 / resume 语义、或 preset 加载路径后，`bun test`（unit + smoke，mock 掉真实调度）**不足以证明正确**——这类路径的 bug 只在真实 daemon 调度真实 agent 时才暴露，type-check / unit test 全绿也照样带病。完成判定必须包含一次 `bun scripts/real-e2e.ts` 绿跑（观察到 PR MERGED / issue CLOSED）。它慢、真打 GitHub，不是 per-commit gate，但引擎 / 调度类改动的**验收主线是 real-e2e，不是 unit test**。

## Runner selection

Runner 与 model 声明在 preset per-phase，item 可选择性覆盖。

```toml
[[phases]]
name  = "review"
runner = "claude"       # "claude" | "codex" | "opencode"
model  = "claude-opus-4-7"
```

- Phase runner 未声明时走 engine-builtin fallback（当前 `codex`）。
- Item 上的 `--runner` 只覆盖非 trigger phase（`gh-issue-pr-iteration` 中是 `iteration` 与 `review`；`blocked-responder` / `umbrella-finalizer` 是 trigger phase，不受 item override 影响）。
- Runner binary 是 PATH 上的 `claude` / `codex` / `opencode`；模型来自 phase 的 `model`。
- Chain 级 model 覆盖走 `coder-loop chain set-runner-model <chain> --kind <k> --model <m>`（patch `chain.metadata.<kind>.model`）。
- `coder-loop status <target> --json` 暴露 `target.runner.phases.<phase>`、`queue.selected.phaseRunners.<phase>`、`current.runner`、`current.phaseStatus.value.runner/model` — 这是 runner/model 的唯一稳定读面。agent 每个 phase 的 `status.json` 位于 `<logDir>/<runId>/<phase>/status.json`，只作 fallback debug。

## Preset 与 target starter

preset 层配套的 target-side starter 在 `presets/<name>/templates/`。跨 preset 通用的 supervisor starter（cron 驱动跨 patrol orchestration）在 `templates/supervisor/`。项目命令 / PR 约定由 target 自有的 `CLAUDE.md` / `AGENTS.md` 承载，preset prompt 显式读取这两份文件。写新 preset 的最小流程见 `docs/preset-authoring.md`。

## Tech stack

Bun + TypeScript (strict, ESM)。runtime 依赖是 PATH 上的 CLI：`gh` + 每个 phase 声明的 runner CLI（`claude` / `codex` / `opencode`）。

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`。
- 跨 repo commit body 引用：`Closes owner/repo#N`。
- 引擎层禁止任何 preset 字面量（status 字符串、phase 名、`{{REPO}}` 等已知 KEY、GitHub-specific 字段名）。新增引擎代码触碰这些时一律改成读 preset。

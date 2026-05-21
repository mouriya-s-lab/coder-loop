# CLAUDE.md

## 这是什么

coder-loop 是队列到 phase 的调度引擎。给定一个 preset（item schema、status 集合、phase 列表、带 `{{KEY}}` 变量绑定的 prompt 模板），引擎选取 continuable item、渲染 prompt、spawn runner CLI（codex/claude）、捕获 trace、循环直到队列全部进入 terminal 状态。

引擎层不含任何 preset 专属字面量。Status 字符串、phase 名、GitHub 概念、fragment 内容——全部来自 `presets/<name>/preset.toml` 及其 prompt 文件。

现有两个 preset：`gh-issue-pr-iteration`（生产用 GitHub issue/PR iteration+review+blocked-responder 工作流，48 个 fragment）和 `single-phase-example`（最小验证 preset）。

## 引擎源码结构

引擎分 6 个模块，入口仍为 `src/loop.ts`：

| 文件 | 职责 |
|---|---|
| `src/loop.ts` | 引擎核心：主循环、preset/config 加载、prompt 渲染、状态推进 |
| `src/agent.ts` | Agent 执行：spawn、backoff、watchdog、worktree、session |
| `src/status.ts` | 状态快照：`buildCoderLoopStatusSnapshot` 及子函数 |
| `src/daemon-client.ts` | Daemon 客户端命令：start/stop/restart plan、probe、queue unblock |
| `src/cli.ts` | CLI 子命令：parseArgs、install/doctor/status/daemon handler |
| `src/util.ts` | 共享工具：log、error、JSON guards、sleep、file ops |

所有模块的导出通过 `loop.ts` re-export，外部消费者只需 `import { ... } from "./loop"`。

## 三层架构

**L1 引擎** — `src/loop.ts` + 上表中的引擎模块：加载 preset → 选 item → 渲染 prompt → spawn agent → 捕获 trace → 推进状态。不知道 phase 语义、status 含义、GitHub。

**L2 Preset** — `presets/<name>/`：`preset.toml` 定义 `[item].idField`、`[statuses].continuable`/`terminal`、`[[phases]]` 含 prompt 模板和 `[phases.variables]` 绑定表、`[[fragments]]`、`[agent]` 配置。Entry prompt + fragment 编码所有领域行为。

**L3 Target** — `<repo>/.coder-loop/`：`workflow.md`（committed）定义项目级策略。`runtime/`（gitignored）放 config、legacy state、evidence、日志。

引擎层代码禁止出现任何 `gh-issue-pr-iteration` 字面量（status 字符串、phase 名、`{{REPO}}` 式 key、GitHub 专属字段名）。

## 状态管理

集中式 daemon（`src/daemon.ts`）管理所有 target：
- `~/Ext/loop-data/state.db` — SQLite DB，三张表：`chains`（命名工作队列）、`items`（队列条目）、`runs`（执行记录）
- `~/Ext/loop-data/daemon.sock` — Unix domain socket，JSONL 请求/响应
- `~/Ext/loop-data/chains/<name>/` — per-chain 运行时（issues、evidence、runs、daemon 日志）

调度器（`src/scheduler.ts`）：每 5 秒 tick，每 (chainId, repoCwd) 一个 slot，为 pending item spawn 引擎子进程。支持 rate-limit 感知的 pause/stagger 行为。

Legacy per-target `state.json` 在 `install` 或 `daemon start` 时自动迁移到 DB。

## 命令

```bash
bun run typecheck                              # tsc --noEmit
bun test                                       # 全部测试
coder-loop install <target> --repo <slug>      # 幂等 bootstrap（四层校验）
coder-loop doctor <target>                     # 只读体检
coder-loop status <target> --json              # 结构化运行快照
coder-loop daemon start <target>               # 导入队列 + 开始执行
coder-loop daemon status [<target>] --json     # daemon/chain 状态
coder-loop daemon stop <target>                # 暂停 target items
coder-loop daemon restart <target>             # stop + start
coder-loop daemon down                         # 关闭 daemon
coder-loop queue unblock <target> --issue N    # 解除 blocked item
```

引擎直接调用（daemon 内部使用）：

```bash
bun run src/loop.ts --target-cwd <path> --check-runtime   # 校验 schema
bun run src/loop.ts --target-cwd <path> --dry-run          # 选 item，不 spawn
bun run src/loop.ts --target-cwd <path> --once              # 跑 1 轮
```

## Runner 选择

Iteration 默认 `codex`，review 默认 `claude`（model 强制 `claude-opus-4-7`）。Iteration 覆盖链：queue item `"runner"` > config `"runner"` > 内置默认。Review：config `"reviewRunner"` > 内置默认。`status --json` 在 `target.runner` 和 `queue.selected.runner` 下暴露实际选择结果。

## 变量绑定

Prompt 模板用 `{{KEY}}` 占位符。`preset.toml` 的 `[phases.variables]` 把 key 映射到 `<prefix>.<field>`：

- `item.<f>` → queue item 字段（缺失 → `""`）
- `config.<f>` → target config.json 字段（缺失 → throw）
- `runtime.<k>` → 引擎计算值，来自 `RUNTIME_BINDING_KEYS` 白名单（24 个 key，含 `runId`、`targetCwd`、`agentCwd`、`issueKind`、`fragmentIndex`、`runIdGeneration` 等）

新增 runtime key 必须同时改 `RUNTIME_BINDING_KEYS` 数组和 `buildRuntimeBindings` 返回对象——TypeScript 强制一致性。

## 约定

- Conventional commits：`feat:`、`fix:`、`refactor:`、`docs:`
- 跨仓引用：`Closes owner/repo#N`
- Bun + TypeScript（strict ESM）
- `bun run typecheck && bun test` 是完整门禁

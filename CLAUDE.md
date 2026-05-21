# CLAUDE.md

## Project

coder-loop — 给 AI agent 排队列、跑循环的调度引擎。给定 preset（角色定义、状态集、phase 列表、prompt 模板），引擎按 phase 顺序 spawn agent、捕获 trace、推进队列直到 terminal。

内置 `gh-issue-pr-iteration` preset 编码 GitHub issue/PR 两角色（iteration + review）迭代工作流。`single-phase-example` 是最小验证 preset。

## Architecture

```
L1: Engine (src/loop.ts)
    加载 preset → 选 item → spawn agent → 捕获 trace → 推进状态
    不知道 phase 含义 / status 语义 / GitHub

L2: Preset (presets/<name>/)
    preset.toml 定义 item idField / statuses / phases / fragments
    entry prompt + fragments 定义 agent 行为

L3: Target (<repo>/.coder-loop/)
    workflow.md: committed 项目级策略
    runtime/: ignored 运行态（config, state, evidence, logs）
```

引擎层禁止任何 `gh-issue-pr-iteration` 字面量（status 字符串、phase 名、`{{REPO}}` 等 KEY、GitHub-specific 字段名）。

## Commands

```bash
bun run typecheck                    # tsc --noEmit
bun test                             # 全部测试（loop.test.ts + smoke.test.ts + ...）
coder-loop status <target> --json    # 结构化运行快照
coder-loop doctor <target>           # 只读体检
coder-loop install <target> --repo <slug>  # 幂等 bootstrap
coder-loop daemon start <target>     # 导入 queue + 开始执行
coder-loop daemon status <target> --json   # daemon 状态
coder-loop daemon stop <target>      # 暂停 target items
coder-loop daemon down               # 关闭 daemon
coder-loop queue unblock <target> --issue N  # 解除 blocked item
```

直接跑引擎（daemon 内部调用，通常不直接用）：

```bash
bun run src/loop.ts --target-cwd <path> --check-runtime  # 校验 schema
bun run src/loop.ts --target-cwd <path> --dry-run         # 选 item 不 spawn
bun run src/loop.ts --target-cwd <path> --once             # 跑 1 轮
```

## Runner Selection

Iteration 默认 `codex`，review 默认 `claude`（model 强制 `claude-opus-4-7`）。覆盖：target config `"runner"` / `"reviewRunner"`，queue item `"runner"`（只影响 iteration）。`status --json` 的 `target.runner` 暴露实际选择。

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`
- Cross-repo refs: `Closes owner/repo#N`
- Bun + TypeScript (strict ESM)

## Tech Debt

- supervisor bootstrap 要手动改占位符（#31）
- `runtime.*` 白名单新增需改源码两处（`RUNTIME_BINDING_KEYS` + `buildRuntimeBindings`）
- `QueueItem` 索引签名：preset 拼错 `item.<f>` 静默生成空串

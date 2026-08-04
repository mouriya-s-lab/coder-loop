# CLAUDE.md

面向在本仓库工作的 agent。实现必须以 `v3-issue/B.md` 为设计事实源；`v3-issue/BE.md` 只规定 B.md 到 Effect v3 的实现映射，不得从历史 issue 或已删除的 v2 runtime 反推设计。

## Project

coder-loop 是 typed、recursive、durable 的 task engine。生产入口是 `src/v3/main.ts`，生产模块位于 `src/v3/`；`src/boundary-types.ts` 仅承载不可信边界的通用 record guard。

核心不变量：

1. preset 只在 publish 边界 compile；运行时按 immutable `DefinitionRef` 精确 resolve。
2. `context-0`、`context-1`、`context-2`、`context-3` 单调推进。item、map、agent 值各有唯一来源；agent 只能通过 parser self-report。
3. task/group/join/await/closure/settlement 是封闭 ADT。SQLite committed transition 是对象状态唯一写权威。
4. scheduler 只选择 ready task；orchestrator 负责 lease、runner、group consumption、recovery 与 GC。
5. operator 与 agent 使用不同 Unix socket。operator 发 typed command；agent 必须携带匹配当前 run 的 `AgentRunAuthority`。
6. status/events 是 durable facts 的只读 projection，不得承载 decision 或第二状态机。
7. closure 固定 resolved base pin，使用 engine namespace branch、独立 worktree 与 scratch；仅在 group consumed 且 publication evidence 可证明后冻结并回收。
8. runner absence 在 spawn 前 hold；spawn 后的 nonzero/timeout/signal 转 typed exception；unknown effect hold 等待 operator 明示恢复。
9. hook 是只读 observer，不得 gate、改写 context、决定 transition 或 reopen。

旧 phase/status DAG、historical schema migration、legacy CLI/runtime、bundled v2 preset、alias、shim 和兼容分支已删除；禁止重新引入。

## Architecture

| Owner | Modules |
|---|---|
| compile/publish/pin/resolve | `definition.ts`, `schema.ts`, `definition-store.ts` |
| typed context/function execution | `context.ts`, `function-runtime.ts`, `function-adapters.ts` |
| object ADT/persistence | `object-domain.ts`, `sqlite-store.ts`, `persistence.ts` |
| scheduling/orchestration/recovery | `scheduler.ts`, `orchestrator.ts`, `recovery.ts` |
| daemon/CLI/projection | `daemon-protocol.ts`, `daemon-handler.ts`, `daemon-socket.ts`, `cli.ts`, `projection.ts` |
| external adapters/resources | `provider.ts`, `subprocess.ts`, `git-service.ts`, `hooks.ts`, `group-consumer.ts` |
| composition | `runtime-host.ts`, `config.ts`, `main.ts` |

## Commands

- Type check: `bun run typecheck`
- Unit/contract tests: `bun run test:unit`
- Direct CLI: `bun src/v3/main.ts ...`
- Daemon: `bun src/v3/main.ts daemon --config <runtime.json>`

`src/v3/main.ts` 以外不存在生产 CLI 入口。runtime smoke 必须使用隔离 SQLite、definition/provider/workspace roots 和独立 operator/agent socket；不得接触中央 `~/.coder-loop`。

## Verification boundary

普通 implementation issue 运行 `bun run typecheck`、`bun run test:unit`，再直接触发该合同的最小 runtime 场景。只有专用 compatibility issue 才能承担发布候选上的外部 compatibility E2E；不得用旧 v2 preset 路径冒充 v3 语义验证。

## Tech stack

Bun + TypeScript strict ESM + Effect v3 + ArkType。外部 runtime 依赖是 Git 和 phase runner executable。

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`。
- Expected failure 使用显式 ADT/tagged error；programmer defect 才 die/throw。
- 输入只在 boundary parse；内部不重复猜测或降级。
- 新 variant 必须 exhaustive handling；不得用 catch-all/default 隐藏遗漏。
- 不建立第二种 persistence、command、identity、context 或 lifecycle 表达。

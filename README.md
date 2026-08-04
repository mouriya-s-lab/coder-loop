# coder-loop

coder-loop 是一个 typed、recursive、durable 的 task engine。当前生产实现是 `src/v3/`；设计事实源是 [`v3-issue/B.md`](v3-issue/B.md)，Effect v3 映射见 [`v3-issue/BE.md`](v3-issue/BE.md)。

## 核心边界

- preset 在 publish 时编译为 immutable `DefinitionRef`，运行时只按精确 ref resolve。
- `context-0` → `context-1` → `context-2` → `context-3` 单调推进；item、map、agent 值各有唯一来源。
- task、group、join、await、closure 与 committed transition 使用封闭 ADT。
- SQLite transaction 是对象状态的唯一写入权威；status/events 只是 projection。
- operator 与 agent 使用隔离的 Unix socket。agent 只能凭 `AgentRunAuthority` 提交已声明值。
- runner loss 进入 typed exception/held 路径；hook 只做 operator/global observer。
- closure 固定 base pin、独立 worktree/scratch，并在 publication evidence 冻结后回收。

## 命令

```bash
bun run typecheck
bun run test:unit

coder-loop daemon --config /path/to/runtime.json
coder-loop --socket /path/to/operator.sock definition publish --definition definition.json --assets assets.json
coder-loop --socket /path/to/operator.sock chain bootstrap --chain CHAIN --definition-ref definition-ref.json --base-pin COMMIT --input input.json --priority 0
coder-loop --socket /path/to/operator.sock status --chain CHAIN
coder-loop --socket /path/to/operator.sock events --chain CHAIN --since 0
```

agent 进程由 runtime 注入 `CODER_LOOP_SOCKET` 与 `CODER_LOOP_AGENT_AUTHORITY`，并通过：

```bash
coder-loop --socket "$CODER_LOOP_SOCKET" agent submit --values values.json
```

提交声明值。daemon runtime 配置的严格边界定义在 `src/v3/config.ts`，preset definition 边界定义在 `src/v3/schema.ts`。

## 源码结构

| 模块 | Owner |
|---|---|
| `definition.ts` / `definition-store.ts` / `schema.ts` | compile、publish、pin、resolve |
| `context.ts` / `function-runtime.ts` / `function-adapters.ts` | 五时态函数运行与 typed value |
| `object-domain.ts` / `sqlite-store.ts` / `persistence.ts` | 对象 ADT、committed transition、durable read model |
| `scheduler.ts` / `orchestrator.ts` / `recovery.ts` | 选择、执行编排、恢复、GC |
| `daemon-protocol.ts` / `daemon-handler.ts` / `daemon-socket.ts` / `cli.ts` | typed command、caller authority、projection transport |
| `provider.ts` / `subprocess.ts` / `git-service.ts` / `hooks.ts` | runner、进程、closure resource、observer adapters |

旧 phase/status DAG、historical schema migration、legacy CLI/runtime 与 bundled v2 preset 已删除，不是兼容入口。

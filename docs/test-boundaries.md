# Test boundaries

测试所在目录就是执行边界。新增或迁移测试时先选择边界，再按该目录的命名与准入规则落文件；测试 runner 不维护逐文件白名单。

## Directory admission

### `tests/unit/**`

- 文件使用 `*.test.ts` 后缀。
- 只接收确定性的 unit 与进程内 component 测试。
- 不得启动 coder-loop daemon、runner workflow 或 worktree 生命周期，也不得依赖 GitHub、网络或操作员的生产 runtime。
- 测试可以使用临时文件与进程内 SQLite，但必须自行隔离和清理状态。

`bun test` 与 `bun run test:unit` 运行 Bun 默认收集到的全部 unit 测试，统一位于 `tests/unit/**`。

### `tests/integration/**`

- 文件使用 `*.integration.ts` 后缀。
- 只接收真实经过进程、socket、daemon、scheduler、runner stub 或 worktree 边界的本地 integration 测试。
- 按最主要的被测运行边界放入一个批次目录：

  - `tests/integration/cli/`：CLI 子进程、命令协议与 CLI 驱动的本地 smoke 路径。
  - `tests/integration/scheduler/`：scheduler、runner subprocess 与 worktree 调度路径。
  - `tests/integration/daemon/`：daemon 生命周期、socket 并发与 daemon 驱动的调度路径。

- 每个 integration 批次按文件名字典序逐文件串行运行 `bun test --timeout 30000`，避免 daemon、进程和 worktree 资源互相争用。
- 一个文件只能归入一个批次；跨多个组件时按拥有完整生命周期的边界归类，不复制测试。
- 静态 grep 实现源码以证明名字被删除的测试不准入；应执行所属 driver 或测试 exported boundary。

`scripts/engine-integration.ts`、`scripts/real-e2e.ts` 与 `scripts/runner-filesystem-grants-integration.ts` 是显式 acceptance/E2E driver，不由 unit 或 integration 目录自动收集。

## Batches and commands

`scripts/run-tests.ts` 严格按以下顺序执行，任一批失败就立即停止：

1. `unit`：一次运行 `bun test tests/unit`。
2. `integration-cli`：逐文件运行 `tests/integration/cli/*.integration.ts`。
3. `integration-scheduler`：逐文件运行 `tests/integration/scheduler/*.integration.ts`。
4. `integration-daemon`：逐文件运行 `tests/integration/daemon/*.integration.ts`。

目录不存在或没有匹配测试文件时，该批输出警告并记为 `skipped`，不导致整轮失败。

- `bun run test:unit`：Bun 默认 unit 收集面。
- `bun run test:integration -- --log-file /tmp/integration.log`：只按序运行三个 integration 批次；package script 不写死日志路径，调用者在 `--` 后透传。
- `bun run test:all -- --log-file /tmp/all-tests.log` 或 `bun scripts/run-tests.ts --log-file /tmp/all-tests.log`：运行全部四个批次。
- `bun scripts/run-tests.ts --batch integration-cli --log-file /tmp/integration-cli.log`：只运行指定批次；可用批次名为 `unit`、`integration-cli`、`integration-scheduler`、`integration-daemon`。

任何包含 integration 批次的调用都必须传 `--log-file <path>`；缺失时 runner 在执行任何测试前向 stderr 打印原因和用法，并以 2 退出。相对日志路径按调用者 cwd 解析，runner 自动创建缺失的父目录，每轮开始时 truncate 重写文件。

默认模式是 detached 后台运行：父进程以相同参数追加 `--foreground` 重启自身，将子进程 stdout/stderr 全部重定向到日志文件，打印子 PID 与绝对日志路径后立即以 0 退出。后台与前台模式都持续更新 `.test-runs/<runId>/state.json`；状态记录 PID、批次状态、pass/fail 数、耗时和整轮结论。

追加 `--foreground` 后阻塞到测试完成；测试与 runner 输出只写日志，终端 stdout 只打印最终一行摘要，进程退出码反映真实结果。两种模式都会把 `FINAL exit=<code>` 写成日志末行。

```sh
bun scripts/run-tests.ts --integration --log-file /tmp/integration.log
bun scripts/run-tests.ts --integration --log-file /tmp/integration.log --foreground
bun scripts/run-tests.ts --batch integration-daemon --log-file ./logs/daemon.log
```

`--batch unit` 是唯一例外：不传 `--log-file` 时保持原有前台透传行为；若传日志，则遵循相同的默认后台、`--foreground`、统一日志和 `FINAL` 契约。

## Run status

```sh
bun scripts/run-tests.ts --status
bun scripts/run-tests.ts --status <runId>
```

不带 `runId` 时读取时间戳最新的一轮。`.test-runs/` 是本地运行产物，不提交到 git。

## Shared preload

`bunfig.toml` 为所有 Bun 测试加载 `tests/preload.ts`。preload 只负责清除外层 runner credential，并让未显式传 `env` 的测试子进程继承同一份已清理环境；不得在这里启动服务或写共享状态。

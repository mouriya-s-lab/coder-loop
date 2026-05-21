# coder-loop

给 AI agent 排队列、跑循环的调度引擎。你准备一批 GitHub issue，coder-loop 逐个 spawn iteration agent 实现 + review agent 审核，accept 或 retry，直到队列清空。

## 工作流程

```
GitHub issues ──→ coder-loop queue
                      │
                      ▼
              ┌── 选 actionable item
              │
              ▼
         iteration agent（写代码、开 PR）
              │
              ▼
         review agent（审证据、判 accept/retry/block）
              │
              ├─ accept → merge PR、close issue、选下一个
              ├─ retry  → 回 iteration，带 review feedback
              └─ block  → 标记 blocked，触发 blocked-responder
```

上面是内置 preset `gh-issue-pr-iteration` 的行为。引擎本身是通用的 queue→phase 调度器：从队列里选 item，按 preset 定义的 phase 顺序 spawn agent，每个 phase 用渲染后的 prompt 模板调用 runner CLI（codex/claude），捕获输出写 trace，循环直到队列清空。哪些 phase、agent 在每个 phase 里干什么、什么算 accept 什么算 retry——全部由 preset 的 prompt 定义，引擎不介入。写不同的 preset 就是不同的工作流。只用默认 preset 的话不需要关心这个区分。

## 安装

```bash
git clone https://github.com/mouriya-s-lab/coder-loop.git
cd coder-loop
bun install
bun link                                              # 注册全局 `coder-loop` 命令
cp .claude/commands/dev-*.md ~/.claude/commands/       # 注册 /dev-plan /dev-loop slash commands
```

## 快速开始

### 1. 初始化目标 repo

```bash
coder-loop install /path/to/target --repo owner/repo
coder-loop doctor  /path/to/target --repo owner/repo   # 只读体检
```

`install` 幂等：写 slash commands、建 `.coder-loop/runtime/` 目录结构、写 config、从 preset 拷 workflow.md starter、确保 GitHub 上有 `kind:*` 标签。

### 2. 创建 issue 队列

在 Claude Code 里：

```
/dev-plan <design-doc | github-issue-url | "描述">
```

`/dev-plan` 把大任务拆成原子 GitHub issue（含验收 checkpoint），建 parent/child 关系，推进 queue。

### 3. 启动循环

```bash
coder-loop daemon start /path/to/target --require-browser-evidence
```

或在 Claude Code 里 `/dev-loop`。daemon 会自动导入 target queue 到集中 SQLite DB，开始逐 item 跑 iteration → review 循环。

### 4. 监控

```bash
coder-loop status /path/to/target --json | jq '.queue, .current'
coder-loop daemon status /path/to/target --json
```

### 5. 停止

```bash
coder-loop daemon stop /path/to/target     # 暂停该 target 的 items，daemon 继续在线
coder-loop daemon down                     # 关闭 daemon 进程
```

## 架构

```
┌─────────────────────────────────────────────────────┐
│  L1: Engine (src/loop.ts)                           │
│  加载 preset → 选 item → spawn agent → 捕获 trace   │
│  不知道 phase 含义，不判断完成/正确/证据             │
├─────────────────────────────────────────────────────┤
│  L2: Preset (presets/<name>/)                       │
│  preset.toml 定义 status 集合、phase 顺序、变量绑定 │
│  entry prompt + fragments 定义 agent 行为           │
├─────────────────────────────────────────────────────┤
│  L3: Target (<your-repo>/.coder-loop/)              │
│  workflow.md 定义项目级策略（命令、证据规则等）       │
│  runtime/ 下是运行态（config、state、logs、evidence）│
└─────────────────────────────────────────────────────┘
```

## Daemon

coder-loop 使用单进程集中 daemon 管理所有 target。

- **SQLite 状态**：`~/Ext/loop-data/state.db` 存 chains/items/runs
- **Unix socket**：`~/Ext/loop-data/daemon.sock` 接收 JSONL 命令
- **每个 target** 的 queue 通过 `daemon start <target>` 导入 daemon，daemon 调度执行

```bash
coder-loop daemon start /path/to/target     # 导入 queue + 开始执行
coder-loop daemon status /path/to/target --json  # 查看 chain/items/slots
coder-loop daemon stop /path/to/target      # 暂停 target items
coder-loop daemon restart /path/to/target   # stop + start
coder-loop daemon down                      # 关闭整个 daemon
```

`daemon start` 幂等：socket 在线时只导入 queue；不在线时自动启动 daemon 再导入。

## Runner 选择

Iteration 和 review 分别有独立的 runner（`codex` 或 `claude`）。

| 维度 | 默认值 | 覆盖方式 |
|---|---|---|
| Iteration runner | `codex` | config `"runner"` 或 queue item `"runner"` |
| Review runner | `claude` | config `"reviewRunner"` |
| Claude review model | `claude-opus-4-7`（强制） | 不可覆盖 |

Target config 示例（`.coder-loop/runtime/config.json`）：

```json
{
  "runner": "codex",
  "reviewRunner": "claude",
  "codex": { "model": "gpt-5.4" },
  "claude": { "model": "sonnet" }
}
```

`status --json` 的 `target.runner` 和 `queue.selected.runner` 暴露实际选择结果。`doctor` 检查对应 runner binary 在 PATH 上。

## CLI

| 命令 | 用途 |
|---|---|
| `install <target> --repo <slug>` | 幂等 bootstrap target |
| `uninstall <target>` | 删 slash commands，保留 runtime |
| `doctor <target>` | 只读体检 |
| `status <target> --json` | 结构化运行快照 |
| `daemon start <target>` | 导入 queue + 开始执行 |
| `daemon stop <target>` | 暂停 target items |
| `daemon restart <target>` | stop + start |
| `daemon status [<target>] --json` | daemon / target 状态 |
| `daemon down` | 关闭 daemon 进程 |
| `queue unblock <target> --issue N` | 解除 blocked item |

主循环 flags（通常不直接用，daemon 内部调用）：

| Flag | 含义 |
|---|---|
| `--target-cwd <path>` | target 目录 |
| `--require-browser-evidence` | 启用最强 E2E 证据要求 |
| `--once` | 跑 1 轮 |
| `--dry-run` | 选 item 后停，不 spawn |
| `--check-runtime` | 只校验 schema |
| `--worktree` | 在 git worktree 中执行 iteration |

## 文档

| 文档 | 读者 |
|---|---|
| [operator-quickstart](./docs/operator-quickstart.md) | 第一次跑 coder-loop 的人 |
| [operations](./docs/operations.md) | 循环挂了 / 想 debug / 想改状态 |
| [preset-authoring](./docs/preset-authoring.md) | 写新 preset 的人 |
| [gh-issue-pr-iteration-fragments](./docs/gh-issue-pr-iteration-fragments.md) | 改 bundled preset fragments 的人 |

## 前置依赖

- [bun](https://bun.sh)
- [gh](https://cli.github.com)（需 `gh auth login`）
- iteration runner CLI（默认 `codex`）
- review runner CLI（默认 `claude`）

## References

1. ReVeal: Self-Evolving Code Agents via Iterative Generation-Verification. arxiv 2506.11442, 2025.
2. VeRPO: Verifiable Dense Reward Policy Optimization for Code Generation. arxiv 2601.03525, 2025.
3. DynaFix: Iterative Automated Program Repair Driven by Execution-Level Dynamic Information. arxiv 2512.24635, 2025.
4. EDDOps: Evaluation-Driven Development and Operations of LLM Agents. arxiv 2411.13768, 2024.
5. Beyond Task Completion: An Assessment Framework for Evaluating Agentic AI Systems. arxiv 2512.12791, 2024.
6. Exploring Autonomous Agents: A Closer Look at Why They Fail When Completing Tasks. arxiv 2508.13143, 2025.
7. VMAO: Verified Multi-Agent Orchestration. arxiv 2603.11445, 2025.

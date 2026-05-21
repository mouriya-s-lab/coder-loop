# coder-loop

给 AI coding agent 排队列、跑循环的调度引擎。给定一批工作 item，引擎逐个选取，按 preset 定义的 phase 顺序 spawn agent，捕获输出，循环直到队列清空。

## 工作原理

引擎（`src/loop.ts`）是 preset 驱动的有限状态机，做三件事：

1. **选取**队列中首个 status 属于 preset `continuable` 集合的 item
2. **按 phase 顺序 spawn agent**——每个 phase 有一个 prompt 模板，引擎将 `{{KEY}}` 占位符替换为从 item / target config / 引擎运行时绑定解析出的值，然后把渲染后的 prompt 传给 runner CLI（`codex` 或 `claude`）
3. **循环**直到没有 continuable item、loop 控制文件被删除、或某个 phase 非零退出

引擎不知道任何 phase 在做什么、任何 status 代表什么、什么算成功。所有领域逻辑——iteration agent 该写什么代码、review agent 该怎么验收、什么证据才算充分——全部在 preset 的 prompt 模板和 fragments 里。写不同的 preset 就是不同的工作流。

### 内置 preset：`gh-issue-pr-iteration`

内置 preset 定义了 GitHub issue/PR 的 iteration→review→blocked-responder 流水线：

```
queue item（GitHub issue）
  │
  ├─ iteration phase：agent 写代码、开 PR
  │
  ├─ review phase：agent 审核证据、发 verdict
  │     ├─ accepted → merge PR、close issue、下一个
  │     ├─ retry → 带 feedback 回 iteration
  │     └─ blocked → 触发 blocked-responder phase
  │
  └─ blocked-responder phase（条件触发）：
        在 blocker 仓创建 follow-up issue，注入 queue，启动 daemon
```

该 preset 有 48 个 prompt fragment（分布在 `common/`、`plan/`、`iter/`、`review/` 目录），以及 4 种 issue kind 路由（`code`、`comment`、`code-spike`、`blocked`），根据 GitHub label 改变 iteration 行为。

## 安装

```bash
git clone https://github.com/mouriya-s-lab/coder-loop.git
cd coder-loop
bun install
bun link                                              # 注册全局 `coder-loop` 命令
cp .claude/commands/dev-*.md ~/.claude/commands/       # 注册 /dev-plan /dev-loop slash commands
```

## 快速开始

### 1. Bootstrap 目标 repo

```bash
coder-loop install /path/to/target --repo owner/repo
coder-loop doctor  /path/to/target --repo owner/repo
```

`install` 幂等，检查四层：

- **A（项目文件）**：写 `.claude/commands/dev-{plan,loop}.md`，从模板种 `.coder-loop/workflow.md`，在集中 SQLite DB 中创建 chain + runtime skeleton
- **B（GitHub 状态）**：确保 `kind:code`、`kind:comment`、`kind:code-spike`、`kind:blocked` 标签存在
- **C（机器先决条件）**：检查 `gh`（已 auth + repo scope）、runner CLI、`coder-loop` 在 PATH
- **D（skill 版本）**：检查 `~/.claude/skills/writing-issue/SKILL.md` 有当前 reserved-strings marker

`doctor` 只读——同样的检查，不写文件。

### 2. 创建 issue 队列

在 Claude Code 里：

```
/dev-plan <design-doc | github-issue-url | "描述">
```

`/dev-plan` 把输入拆成原子 GitHub issue（含验收 checkpoint），建 parent/child 关系，推入 queue。

### 3. 启动循环

```bash
coder-loop daemon start /path/to/target --require-browser-evidence
```

或在 Claude Code 里 `/dev-loop`。Daemon 把 target 的 queue 导入集中 SQLite DB，开始调度执行。

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
┌──────────────────────────────────────────────────────────┐
│  引擎 (src/loop.ts)                                      │
│                                                          │
│  loadPreset → selectIssue → 对每个 phase：                │
│    renderPrompt(模板, {item, config, runtime})             │
│    → buildRunnerInvocation(runner, prompt, resume)        │
│    → spawn 子进程，stdout/stderr 写 trace                 │
│    → parseSessionId, arm watchdog, arm attempt timeout    │
│    → 退出后：记录 session, 检查 verdict, 推进状态          │
│                                                          │
│  引擎不变量：零 preset 专属字面量。                        │
│  Status 名、phase 名、GitHub 概念、fragment 内容           │
│  全部来自加载的 preset。                                   │
├──────────────────────────────────────────────────────────┤
│  Preset (presets/<name>/)                                │
│                                                          │
│  preset.toml：                                           │
│    [item] idField                                        │
│    [statuses] continuable / terminal                     │
│    [[phases]] name, prompt, variables, trigger?           │
│    [[fragments]] id, path                                │
│    [agent] binary, attemptTimeoutSeconds                 │
│                                                          │
│  变量绑定把 {{KEY}} 映射到：                               │
│    item.<field>    → queue item 字段                      │
│    config.<field>  → target config.json 字段              │
│    runtime.<key>   → 引擎计算值（24 个白名单 key）         │
├──────────────────────────────────────────────────────────┤
│  Target (<your-repo>/.coder-loop/)                       │
│                                                          │
│  workflow.md — committed 项目级策略                        │
│    （构建命令、证据规则、repo 约定）                        │
│  runtime/ — gitignored，集中 daemon 不再依赖               │
├──────────────────────────────────────────────────────────┤
│  Daemon (src/daemon.ts)                                  │
│                                                          │
│  单进程集中状态：                                         │
│    ~/Ext/loop-data/state.db  — SQLite (chains/items/runs)│
│    ~/Ext/loop-data/daemon.sock — Unix socket (JSONL)     │
│    ~/Ext/loop-data/daemon.pid  — PID file                │
│    ~/Ext/loop-data/chains/<name>/ — per-chain runtime    │
│                                                          │
│  调度器 (src/scheduler.ts)：                              │
│    每 5 秒 tick。每 (chainId, repoCwd) 一个 slot。         │
│    每 tick：从每个 slot 选下一个 pending item → spawn       │
│    引擎子进程。支持 rate-limit pause/stagger。              │
│                                                          │
│  State DB (src/state-db.ts)：                             │
│    chains — 命名工作队列 (active/completed/archived)       │
│    items — 队列条目，映射 GitHub issue                     │
│    runs — 执行记录，per (item, phase)                      │
└──────────────────────────────────────────────────────────┘
```

### Agent 在 phase 内的生命周期

1. 引擎检查 `sessions.jsonl` 是否有兼容当前 runner/model 的历史 session。如果有且上次是非正常终止，以 `--resume <sessionId>` 续跑而不是重新 spawn。
2. Fresh spawn：`buildRunnerInvocation` 构造 CLI 命令。Codex：`codex --ask-for-approval never exec --json --cd <agentCwd> --sandbox danger-full-access <prompt>`。Claude：`claude -p --output-format stream-json --verbose <prompt>`。
3. 子进程以 `detached: true` 启动，stdout/stderr 写入 trace 文件。引擎从 JSONL 事件流中解析 session ID、summary marker、rate-limit 信号。
4. **Post-summary watchdog**：agent 输出 `ITERATION SUMMARY:` 或 `REVIEW SUMMARY:` 后启动 5 分钟定时器。超时发 SIGTERM（给进程组），5 秒后 SIGKILL。
5. **Attempt timeout**：默认来自 `preset.toml` 的 `attemptTimeoutSeconds`（通常 3600s）。如果 agent 在此时间内未产出 summary marker 则强杀。Watchdog 已 armed 时 attempt timeout 自动取消。
6. 退出后，session 记录追加到 `sessions.jsonl`。如果 agent 遇到 rate limit，reset 时间戳被提取并传递给 daemon 做 cooldown。

### Runner 选择

Iteration 和 review 独立选 runner：

| 维度 | 默认 | 覆盖 |
|---|---|---|
| Iteration runner | `codex` | config `"runner"` 或 queue item `"runner"`（item 优先） |
| Review runner | `claude` | config `"reviewRunner"` |
| Review model | `claude-opus-4-7` | 不可覆盖 |

每个 runner 有 `binary`（CLI 可执行文件名）、可选 `model`、可选 `extraArgs`。Config 示例：

```json
{
  "runner": "codex",
  "reviewRunner": "claude",
  "codex": { "model": "gpt-5.4" },
  "claude": { "model": "sonnet" }
}
```

### Trigger Phase

Phase 可以在 `preset.toml` 中声明 trigger：

```toml
[[phases]]
name = "blocked-responder"
prompt = "blocked-responder-entry.md"
  [phases.trigger]
  afterPhase = "review"
  whenStatus = "blocked"
```

每个非 trigger phase 完成后，引擎检查所有 trigger phase——如果 item 当前 status 匹配 `whenStatus` 且 `afterPhase` 匹配刚跑完的 phase，spawn 该 trigger phase。

### Worktree 模式

`--worktree` 在 `<targetCwd>/.coder-loop-worktrees/` 下为每个 item 创建 git worktree，基于 `origin/<baseBranch>` 创建分支。Item 进入 terminal 后自动 remove。启动时 prune stale worktree。

## CLI

| 命令 | 用途 |
|---|---|
| `install <target> --repo <slug>` | 幂等 bootstrap（四层校验） |
| `uninstall <target>` | 删 slash commands，保留 runtime 和 DB |
| `doctor <target>` | 只读体检 |
| `status <target> --json` | 结构化运行快照 |
| `daemon start <target>` | 导入 queue + 开始执行 |
| `daemon stop <target>` | 暂停 target items |
| `daemon restart <target>` | stop + start |
| `daemon status [<target>] --json` | daemon / target 状态 |
| `daemon down` | 关闭 daemon 进程 |
| `queue unblock <target> --issue N` | 解除 blocked item |

引擎 flags（daemon 内部调用）：

| Flag | 用途 |
|---|---|
| `--target-cwd <path>` | target 目录 |
| `--require-browser-evidence` | 启用最强 E2E 证据要求 |
| `--once` | 跑 1 轮退出 |
| `--dry-run` | 选 item、校验、不 spawn |
| `--check-runtime` | 只校验 runtime schema |
| `--worktree` | 在 git worktree 中执行 |

## 文档

| 文档 | 读者 |
|---|---|
| [operator-quickstart](./docs/operator-quickstart.md) | 第一次跑 coder-loop 的人 |
| [operations](./docs/operations.md) | 排障、debug、daemon 运维 |
| [preset-authoring](./docs/preset-authoring.md) | 写新 preset 的人 |
| [gh-issue-pr-iteration-fragments](./docs/gh-issue-pr-iteration-fragments.md) | 改内置 preset fragments 的人 |
| [codex-runner-parity](./docs/codex-runner-parity.md) | Runner 契约审计 |
| [reserved-strings](./docs/reserved-strings.md) | 引擎 sentinel 字符串注册表 |

## 前置依赖

- [bun](https://bun.sh)
- [gh](https://cli.github.com)（需 `gh auth login --scopes repo`）
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

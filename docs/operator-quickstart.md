# 操作员快速入门

从零到跑通 coder-loop 的端到端路径。

## 前置依赖

| 依赖 | 检查 | 安装 |
|---|---|---|
| bun | `bun --version` | https://bun.sh |
| gh CLI | `gh auth status`（必须有 `repo` scope） | https://cli.github.com → `gh auth login --scopes repo` |
| Iteration runner | `codex --version`（默认） | Codex CLI |
| Review runner | `claude --version`（默认） | `npm install -g @anthropic-ai/claude-code` |

安装 coder-loop 本身：

```bash
git clone https://github.com/mouriya-s-lab/coder-loop.git
cd coder-loop && bun install && bun link
```

可选——注册 `/dev-plan` 和 `/dev-loop` 为 Claude Code slash commands：

```bash
cp .claude/commands/dev-*.md ~/.claude/commands/
```

## 1. Bootstrap 目标 repo

```bash
coder-loop install /path/to/target --repo owner/repo
```

`install` 幂等，检查四层：

- **A（项目文件）** — 写 `.claude/commands/dev-{plan,loop}.md` 到 target，从模板种 `.coder-loop/workflow.md`，在集中 SQLite DB（`~/Ext/loop-data/`）中创建 chain 行 + runtime skeleton
- **B（GitHub 状态）** — 在 GitHub repo 上创建 `kind:code` / `kind:comment` / `kind:code-spike` / `kind:blocked` 标签
- **C（机器先决条件）** — 校验 `gh`（auth + repo scope）、iteration runner binary、review runner binary、`coder-loop` 均在 PATH
- **D（skill 版本）** — 检查 `~/.claude/skills/writing-issue/SKILL.md` 含当前 reserved-strings marker。用 `--install-skills` 可自动从模板同步

只读体检：

```bash
coder-loop doctor /path/to/target --repo owner/repo
```

任何 `FAIL` 行说明需要修什么。`doctor` 不写文件。

加到 `.gitignore`：

```
.coder-loop/runtime/
.dev-loop
.dev-trace.txt
```

`.coder-loop/workflow.md` **必须 commit** — agent 读它来了解项目的构建命令、证据规则和 repo 约定。

## 2. 创建 issue 队列

在目标 repo 的 Claude Code 里：

```
/dev-plan <design-doc 路径 | github-issue-url | 描述>
```

`/dev-plan` 读输入，拆成带验收 checkpoint 的原子 GitHub issue，建 parent/child 关系，推入 DB 队列。

检查队列状态：

```bash
coder-loop status /path/to/target --json | jq '.queue.total, .queue.continuable, .queue.selected'
```

## 3. 启动 daemon

```bash
coder-loop daemon start /path/to/target --require-browser-evidence
```

启动过程：

1. 如果没有 daemon 进程在运行，启动一个（`~/Ext/loop-data/daemon.sock`）
2. Target 的队列导入 daemon 的 SQLite DB 作为一条 chain
3. 调度器每 5 秒 tick。每次 tick 从每个 slot（每 chain × repoCwd 一个）选下一个 pending item → spawn 引擎子进程，跑 iteration → review → 条件 trigger phase
4. `--require-browser-evidence` 注入 spawned agent prompt，作为 `config.requireBrowserEvidence = true`，要求 iteration agent 截浏览器截图作为 PR 证据

`daemon start` 幂等——daemon 已在运行时只导入/更新队列。

## 4. 监控

结构化快照：

```bash
coder-loop status /path/to/target --json | jq '.queue, .current, .events.latest'
coder-loop daemon status /path/to/target --json
```

实时日志：

```bash
# Per-chain daemon 日志
ls -lt ~/Ext/loop-data/chains/<chain-name>/daemon/
tail -f ~/Ext/loop-data/chains/<chain-name>/daemon/<latest>/engine.log

# Per-run phase trace
ls -lt ~/Ext/loop-data/chains/<chain-name>/runs/<run-id>/
```

## 5. 停止

```bash
coder-loop daemon stop /path/to/target     # 暂停该 target 的 items，daemon 继续在线服务其他 target
coder-loop daemon restart /path/to/target   # stop + start（重新导入队列）
coder-loop daemon down                     # 关闭 daemon 进程
```

## Runner 配置

默认：iteration 用 `codex`，review 用 `claude`（model 强制 `claude-opus-4-7`）。

在 target config（`.coder-loop/runtime/config.json`）中覆盖：

```json
{
  "runner": "codex",
  "reviewRunner": "claude",
  "codex": { "model": "gpt-5.4", "extraArgs": [] },
  "claude": { "model": "sonnet", "extraArgs": [] }
}
```

Per-item 覆盖：在 queue item 上设 `"runner": "claude"` 可让该 item 的 iteration phase 用 Claude。Review runner 不支持 per-item 覆盖。

`status --json` 在 `queue.selected.runner` 和 `queue.selected.reviewRunner` 下暴露当前选中 item 的实际 runner。`doctor` 校验解析后的 runner binary 在 PATH 上。

## 常见问题

| 症状 | 原因与修法 |
|---|---|
| `FAIL: gh 未认证` | `gh auth login --scopes repo` |
| `FAIL: codex runner CLI (codex) 未在 PATH` | 安装 Codex CLI，确保 `codex` 可执行 |
| `FAIL: chain row missing` | 跑 `coder-loop install <target> --repo <slug>` |
| `FAIL: label kind:code` | `gh` 需要 repo scope，重新认证后再 install |
| `.coder-loop/runtime/` 出现在 git diff | 加到 `.gitignore`，然后 `git rm --cached -r .coder-loop/runtime/` |
| Agent 行为退化（缺证据、命令错） | `.coder-loop/workflow.md` 缺失或未 commit |
| Iteration 以 `infrastructure_failure` 退出 | `gh auth status` 失败，重新认证 |
| `--check-runtime` 报 `repository mismatch` | 对齐 `config.json` 的 `"repository"` 和实际 remote |
| 崩溃后残留 `.dev-loop` | `rm .dev-loop` 或 `coder-loop daemon restart` |

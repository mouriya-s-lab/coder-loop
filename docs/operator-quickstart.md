# Operator Quickstart

从零到跑通 coder-loop 的完整路径。

## 前置依赖

- `bun`（`bun --version`）
- `gh` CLI 已 auth（`gh auth status`），有目标 repo 的 issue/PR 写权限
- Runner CLI 在 PATH：iteration 默认 `codex`，review 默认 `claude`
- 目标 repo 在本地，有 base branch（通常 `main`）

安装 coder-loop 本身：

```bash
git clone https://github.com/mouriya-s-lab/coder-loop.git
cd coder-loop && bun install && bun link
```

可选注册全局 slash commands：

```bash
cp .claude/commands/dev-*.md ~/.claude/commands/
```

## 1. Bootstrap 目标 repo

```bash
coder-loop install /path/to/target --repo owner/repo
coder-loop doctor  /path/to/target --repo owner/repo
```

`install` 做四件事（幂等）：

- 写 `.claude/commands/dev-{plan,loop}.md` 到 target
- 建 `.coder-loop/runtime/` 目录结构 + config + workflow.md starter
- 确保 GitHub 上有 `kind:code` / `kind:comment` / `kind:code-spike` / `kind:blocked` 标签
- 检查 PATH 上的 runner binary + 用户级 skill 版本

`doctor` 只读体检——不改文件，只报告哪些层有问题。

常用 flag：`--force`（覆盖已存在文件）、`--dry-run`（打印不执行）、`--install-skills`（同步 writing-issue skill）。

加 `.gitignore`：

```bash
echo '.coder-loop/runtime/' >> .gitignore
echo '.dev-loop' >> .gitignore
echo '.dev-trace.txt' >> .gitignore
```

`.coder-loop/workflow.md` 要入仓——agent 读它判断项目工作方式。

## 2. 创建 issue 队列

在 Claude Code 里：

```
/dev-plan <design-doc-path | github-issue-url | "描述">
```

`/dev-plan` 读源头 → 拆原子 issue（含 checkpoint 验收表）→ 建 parent/child → 推进 `state.json.queue`。

跑完验证：

```bash
coder-loop status /path/to/target --json | jq '.queue.total, .queue.selected'
```

## 3. 启动循环

```bash
coder-loop daemon start /path/to/target --require-browser-evidence
```

或在 target 内 `/dev-loop`。

daemon 逐 item 交替 spawn iteration + review agent。review 判断：

- **accept** → merge PR、close issue、下一个
- **retry** → 带 feedback 回 iteration
- **block** → 触发 blocked-responder 跨仓处理

## 4. 监控

```bash
coder-loop status /path/to/target --json | jq '.queue, .current, .events.latest'
coder-loop daemon status /path/to/target --json
```

看 agent 输出：

```bash
ls -lt .coder-loop/runtime/logs/                  # agent 输出/状态
tail -f .coder-loop/runtime/logs/coder-loop-*.log  # daemon 日志
tail -f .dev-trace.txt                            # 当前迭代 trace
```

## 5. 停止

```bash
coder-loop daemon stop /path/to/target     # 暂停该 target items
coder-loop daemon down                     # 关闭 daemon 进程
```

## Runner 配置

详见 [README §Runner 选择](../README.md#runner-选择)。核心：

- Iteration 默认 `codex`，可用 config `"runner"` 或 queue item `"runner"` 覆盖
- Review 默认 `claude`（model 强制 `claude-opus-4-7`），可用 config `"reviewRunner"` 覆盖
- `status --json` 和 `doctor` 暴露实际选择

## 常见问题

| 现象 | 原因 + 修法 |
|---|---|
| `.coder-loop/runtime/` 进了 git diff | 加 `.gitignore` 后 `git rm --cached -r .coder-loop/runtime/` |
| agent 行为退化（漏证据、写错命令） | `.coder-loop/workflow.md` 缺失或没入仓 |
| iter 以 `infrastructure_failure` 出局 | `gh auth status` 失败，重新 `gh auth login` |
| `--check-runtime` 报 `repository mismatch` | config.json 的 `repository` 与远端不一致，改 config |

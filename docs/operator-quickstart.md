# Operator Quickstart

读者：第一次想在一个 repo 上跑通 coder-loop 的人。

读完后你能：bootstrap 一个新 repo 的 `.coder-loop/`、用稳定 CLI 体检 target、用 `/dev-plan` 灌一批 GitHub issue 进队列、通过 daemon API 起停 `/dev-loop`、用 `coder-loop status <target> --json` 判断当前进度。

不在范围内：preset 内部怎么写（看 [preset-authoring](./preset-authoring.md)）、`gh-issue-pr-iteration` fragments 跳转细节（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）、centralized runtime / chain debug 细节（看 [operations](./operations.md)）。

---

## 0. 前置依赖

跑 coder-loop 之前要有：

- `bun` 已安装（`bun --version` 能跑）。
- `gh` CLI 已 auth（`gh auth status` 不报错），有目标 repo 的 issue / PR 写权限。
- runner CLI 在 PATH：phase 默认 runner 由 preset 声明，bundled workflow 需要 `codex` 和 `claude`。
- 目标 repo 在本地，有可用的 base branch（通常 `main`）。
- 可选用户级 skill / rule（仅作为 `/dev-plan` 的 operator 个人参考，缺失不阻塞；`/dev-loop` 不读取）：
  - `~/.claude/rules/github-issue-pr-routing.rule.md`
  - skill `writing-issue` / `writing-pr` / `review-pr`

第一次安装本 repo：

```bash
git clone https://github.com/Mouriya-Emma/coder-loop.git
cd coder-loop
bun install
bun link                                              # 注册 `coder-loop` 全局 bin（推荐）
```

不 `bun link` 也行——把后面命令里的 `coder-loop` 换成 `bun /path/to/coder-loop/src/loop.ts`。

slash command（`/dev-plan` `/dev-loop`）有两种 scope：

- **per-target**（仅在该 target repo 内可用）：下一步的 `coder-loop install <target>` 会自动写到 `<target>/.claude/commands/`，不用手工拷。
- **global**（所有 repo 内都可用）：必须手工 `cp .claude/commands/dev-*.md ~/.claude/commands/`，install 子命令不碰 home 目录。

只用一个 target 的话 per-target 就够；常态 operator 通常两个都做。

---

## 1. Bootstrap 目标 repo 的 `.coder-loop/`

在**目标 repo**（不是本 repo）里先启动 central daemon，再执行 install：

```bash
coder-loop daemon up
coder-loop install /path/to/your-target-repo --repo <owner>/<repo>
```

幂等。它做这些事：

- **A) target 项目文件**：写 `.claude/commands/dev-plan.md` / `dev-loop.md`、建/刷新 `.coder-loop/runtime/{issues,evidence,logs}/` 并初始化 centralized chain、merge `.coder-loop/runtime/config.json`（含 preset 绑定）、若 `workflow.md` 缺失则从 preset 模板拷一份。
- **B) 操作员机器前置**：只做检查、不安装——`gh`(+ auth) / preset phase runner CLI / `coder-loop` 是否在 PATH。

`gh-issue-pr-iteration` 需要的 `kind:*` GitHub label 资产不由 install / doctor 管理；planning agent 在 `plan/create-issues` 路径首次创建 issue 前按 preset 声明幂等确保，缺失则创建，color / description 漂移则更新。

`install` 第一件事会确认 central daemon 可达；daemon 不在线时会在写 `.coder-loop/workflow.md` 之前 fail-fast。使用自定义 `--loop-data-root` 时，`daemon up` 与后续 `install` / `doctor` / `status` 要传同一个 root。

常用 flag：

| Flag | 用途 |
|---|---|
| `--repo <owner>/<repo>` | 写进 config，用于后续 GitHub issue / PR / label 操作 |
| `--preset <name>` | 默认 `gh-issue-pr-iteration` |
| `--force` | 覆盖已存在的 slash command / workflow.md（其他文件仍幂等） |
| `--dry-run` | 打印每一步将做什么，不写盘 |

之后做一次只读体检：

```bash
coder-loop doctor /path/to/your-target-repo --repo <owner>/<repo>
coder-loop status /path/to/your-target-repo --json
```

target 文件、operator 前置、live runtime health 全 OK 且 `status` 能输出 JSON，才能进下一步。doctor 不改任何文件——失败时按它指出的项目重跑 `install`（或修 PATH / `gh auth login`）。`status` 也只读；即使 runtime 缺失或损坏，它也会用 `state.kind` 返回机器可读状态。

想精确看一遍 install 会做什么、不会做什么，直接 `coder-loop install <target> --repo <slug> --dry-run`——它会逐行打印每个 layer 的动作和 `would-write` 标记。

### Runner 默认值与覆盖

默认 runner 与 model 由 `preset.toml` 的每个 phase 声明；bundled `gh-issue-pr-iteration` 中 iteration 是 `codex`，review 是 `codex` + `model = "gpt-5.5"`。Review 不继承宿主或 queue item；config 显式 `claude.model` / `codex.model` 优先于 phase 的 `model` 声明，源码不再为 review 强制覆盖模型。最简单的改模型方式：

```bash
coder-loop runtime set <target> --claude-model opus-4-8 --codex-model gpt-5.5
```

`--claude-model opus-4-7|opus-4-8` 写入时强制加 `[1m]` 后缀。也可以直接编辑 `.coder-loop/runtime/config.json`：

```json
{
  "codex": { "binary": "codex", "model": "gpt-5.5", "extraArgs": [] },
  "claude": { "binary": "claude", "model": "claude-opus-4-8[1m]", "extraArgs": [] }
}
```

单个 queue item 可加 `"runner": "claude" | "codex"` 覆盖允许 item override 的普通执行 phase；review 和 trigger 角色用自己的 preset phase 声明。`doctor` 检查所有 phase runner 的实际 binary；`status --json` 暴露 `target.runner.phases`、`queue.selected.phaseRunners`、`current.runner` 与 phase status 的 runner/model。

把运行期文件加 `.gitignore`：

```bash
echo '.coder-loop/runtime/' >> .gitignore
# 新版不再依赖 .dev-loop/.dev-trace.txt；若旧 target 曾产生过，可一并忽略：
echo '.dev-loop' >> .gitignore
echo '.dev-trace.txt' >> .gitignore
```

`.coder-loop/workflow.md` **要**入仓——agent 读这一份判断本项目的工作方式。

拆掉 slash command（保留 runtime）：`coder-loop uninstall /path/to/your-target-repo`。

---

## 2. 健康检查与状态快照

常规检查先看两条：

```bash
coder-loop doctor /path/to/your-target-repo --repo <owner>/<repo>
coder-loop status /path/to/your-target-repo --json | jq '.state.kind, .queue, .current, .processes.live'
```

`doctor` 给人看 bootstrap / live runtime health；`status --json` 给 supervisor、脚本、cron 看结构化状态。常见判断：

| 字段 | 期望 |
|---|---|
| `.state.kind` | `"ok"` 表示 config/state/preset/runtime 都可读；其他值按错误继续排 |
| `.queue.total` / `.queue.selected` | 有可推进 item 时 selected 不为 null |
| `.target.runner.phases` / `.queue.selected.phaseRunners` | 每个 phase 的 effective runner；含 kind/source/binary/model |
| `.target.runner.default` / `.queue.selected.runner` | 默认执行 phase 与 selected item 默认执行 phase runner |
| `.target.runner.reviewDefault` / `.queue.selected.reviewRunner` | review phase runner；model 解析为 config 显式 `claude.model` / `codex.model`（override）或 preset phase `model` 声明，源码不再强制覆盖 |
| `.current.run` | 正在跑或可 resume 的 run；null 表示当前没有 in-flight phase |
| `.events.latest` | 当前或最近 run 的最后一条结构化事件 |
| `.processes.live` / `.processes.scanError` | live process scan 结果；daemon 详情看 `coder-loop daemon status` |

如果你只想看 runtime/schema，不想同时检查 PATH / runner CLI 等 bootstrap 层，直接读结构化 status：

```bash
coder-loop status /path/to/your-target-repo --json \
  | jq '.state.kind, .target.configPath, .target.preset, .queue.total, .queue.selected'
```

`.state.kind == "ok"` 表示 target config、preset、central chain runtime、queue/current 都能解析；其他 kind 先按 [operations runtime health](./operations.md#4-runtime-health-错误分类) 继续排。

---

## 3. 用 `/dev-plan` 灌队列

把大任务 → GitHub issue 队列的工作交给 `/dev-plan`。在 Claude Code 内：

```
/dev-plan <design-doc-path | github-issue-url | "<用户描述>" | <repo-path> <goal>>
```

它读源头 → 按 preset contract 拆原子 issue（含 `## 验收标准` checkpoint 表）→ 用 `addSubIssue` 建 parent/child → 写 chain handoff / evidence 目录（per-issue handoff 只是可选附件），并把可执行 issue 推进 centralized chain queue。

跑完后再做一次 schema 自检：

```bash
coder-loop status /path/to/your-target-repo --json | jq '.state.kind, .queue.total, .queue.selected'
```

`.state.kind == "ok"` 且 `.queue.selected` 不为 null，才有东西可跑。schema 细节异常时先看 `status` 的 `.state` / `.target`，需要 bootstrap 层排查再跑 `coder-loop doctor <target> --repo <owner>/<repo>`。

---

## 4. 用 `/dev-loop` 或 daemon API 起循环

```
/dev-loop          # 不限轮次，通过 coder-loop daemon start 起后台循环
/dev-loop 10       # 最多 10 轮
```

`/dev-loop` 是人类在 target 内的快捷入口。它会先跑 `coder-loop doctor "$PWD"` 和 `coder-loop status "$PWD" --json`，再调用 daemon API。脚本或 supervisor 直接用 daemon 命令：

```bash
coder-loop daemon start /path/to/your-target-repo
coder-loop daemon start /path/to/your-target-repo --max-iterations 10
coder-loop daemon status /path/to/your-target-repo --json
```

`daemon start` 对已运行 target 幂等：返回 `alreadyRunning: true`，不会启动重复 loop。

循环消费现有队列，按 preset 的 phase 顺序交替 spawn `iter` + `review` agent；每轮 review agent 判断 continue / retry / accept / block / stop。

监控优先用稳定 API：

```bash
coder-loop status /path/to/your-target-repo --json | jq '.state.kind, .queue, .current, .events.latest, .processes'
coder-loop daemon status /path/to/your-target-repo --json | jq '.processes'
```

需要看原始输出时再下钻到 `status` 暴露的 runtime 文件：

**人类肉眼**（stdout / stderr / status 含 stack trace 与 prompt 内容）：

```bash
STATUS=$(coder-loop status /path/to/your-target-repo --json)
echo "$STATUS" | jq -r '.current.phaseStatus.value.outputPath // empty'
echo "$STATUS" | jq -r '.current.phaseStatus.value.statusPath // empty'
echo "$STATUS" | jq -r '.target.logDir'
```

新版 agent 输出 layout 是 `<logDir>/<runId>/<phase>/stdout.jsonl`、`stderr.txt`、`status.json`、`sessions.jsonl`。

**事件流 fallback**（结构化 JSONL，适合需要非轮询的 watcher）：

```bash
EVENTS=$(coder-loop status /path/to/your-target-repo --json | jq -r '.events.path // empty')
test -n "$EVENTS" && tail -F "$EVENTS"
```

事件类型：`queue.select` / `phase.start` / `phase.end` / `attempt.start` / `attempt.timeout` / `attempt.close` / `watchdog.fire` / `queue.terminal`。详见 [operations.md §6.3](./operations.md#63-agent-进程与监控fallback-reference)。

停：

```bash
coder-loop daemon stop /path/to/your-target-repo
```

`daemon stop` 解析 target chain 并通过 central daemon 调用 `chain.delete`；它不是旧式删除 loop file + SIGTERM target-owned PID。需要强制处理 wedged 子进程时，先用 `status` / `daemon status` 定位 live process，按 operations 的 recovery 流程处理。

---

## 5. 一轮跑完后怎么看 trace

先用 status 找当前或最近 run：

```bash
coder-loop status /path/to/your-target-repo --json | jq '.current, .events, .queue.selected'
```

每轮结束后这些文件出现在 `status` 暴露的 `<logDir>/<runId>/<phase>/`：

| 文件 | 内容 |
|---|---|
| `stdout.jsonl` | 该 phase agent stdout stream |
| `stderr.txt` | 该 phase agent stderr |
| `status.json` | exit code / signal / bytes / runner / model / sessionId / termination metadata |
| `sessions.jsonl` | 可 resume session id 索引 |

run 级事件在 `<logDir>/<runId>/events.jsonl`，也由 `status.events.path` 暴露。

读输出的常用判断：

- phase `status.json` 的 `exitCode != 0` → spawn 失败（不是 agent 内部逻辑失败），看 `stderr.txt`。
- iteration `stdout.jsonl` 末尾的 `## Output verdict` 表明 iter 选了哪个出口（如 `implementation_ready_for_verification`），跳进 `iter/verify-evidence` 等下一 fragment。
- review `stdout.jsonl` 末尾的 verdict 决定本轮命运：`accepted_pr` → PR 已 merge / issue 已 close；`retry` → iter 下一轮继续；`blocked` / `loop_stopped` → 需人介入。

当前 / resume 状态先看 `coder-loop status` 的 `.current`。`current.phase == "iteration"` 表示当前/上次崩在 iter；`"review"` 表示在 review。重启 `/dev-loop` 或 `coder-loop daemon restart` 时引擎会按 `current.phase` 续跑，不重头来。详见 [operations#resume](./operations.md#5-resume-行为)。

---

## 6. 常见坑

- **`.coder-loop/runtime/` 入了 git** → runtime handoff / logs 进了 PR diff；把整个目录加 `.gitignore` 后 `git rm --cached -r .coder-loop/runtime/`。
- **`.coder-loop/workflow.md` 缺失或没入仓** → iter/review agent 读不到项目工作方式，行为退化为 bundled preset 默认值，往往写错命令 / 漏证据 layer。
- **`gh` 未 auth** → `iter/read-context` 会以 `infrastructure_failure` 出局，trace 里能看到 `gh auth status` 失败回显。
- **chain identity 与目标 repo 不一致** → `status` / `daemon start` 会在解析 chain 时报告 repository/baseBranch 不匹配；指定正确 `--chain`，或修正 centralized chain identity。
- **按旧 flat log / `.dev-loop` 找不到状态** → 新版以 central daemon + chain runtime 为准；先看 `coder-loop status <target> --json` 返回的 `target.logDir`、`events.path`、`processes.live`。

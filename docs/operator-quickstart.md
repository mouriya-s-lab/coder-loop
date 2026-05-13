# Operator Quickstart

读者：第一次想在一个 repo 上跑通 coder-loop 的人。

读完后你能：bootstrap 一个新 repo 的 `.coder-loop/`、用 `/dev-plan` 灌一批 GitHub issue 进队列、起 `/dev-loop` 让循环跑起来、查 trace 判断是哪一轮成功/失败。

不在范围内：preset 内部怎么写（看 [preset-authoring](./preset-authoring.md)）、`gh-issue-pr-iteration` fragments 跳转细节（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）、`state.json` schema 细节（看 [operations](./operations.md)）。

---

## 0. 前置依赖

跑 coder-loop 之前要有：

- `bun` 已安装（`bun --version` 能跑）。
- `gh` CLI 已 auth（`gh auth status` 不报错），有目标 repo 的 issue / PR 写权限。
- 目标 repo 在本地，有可用的 base branch（通常 `main`）。
- 用户级 skill / rule（仅 `/dev-plan` 需要，`/dev-loop` 本身不需要）：
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

在**目标 repo**（不是本 repo）里一条命令完成：

```bash
coder-loop install /path/to/your-target-repo --repo <owner>/<repo>
```

幂等。它做四层事：

- **A) target 项目文件**：写 `.claude/commands/dev-plan.md` / `dev-loop.md`、建 `.coder-loop/runtime/{issues,evidence,logs}/`、merge `.coder-loop/runtime/config.json`（含 preset 绑定）、若 `workflow.md` 缺失则从 preset 模板拷一份。
- **B) target GitHub state**：通过 `gh` 确保 `kind:code` / `kind:comment` 标签存在（preset fragments 依赖它们做 issue 分类）。
- **C) 操作员机器前置**：只做检查、不安装——`gh`(+ auth) / `claude` / `coder-loop` 是否在 PATH。
- **D) 用户级 skill 版本**：检查 `~/.claude/skills/writing-issue/SKILL.md` 是否含新版 marker；加 `--install-skills` 会自动同步到最新。

常用 flag：

| Flag | 用途 |
|---|---|
| `--repo <owner>/<repo>` | 写进 config，并用来创建 GitHub 标签；省略则跳过 B 层 |
| `--preset <name>` | 默认 `gh-issue-pr-iteration` |
| `--force` | 覆盖已存在的 slash command / workflow.md（其他文件仍幂等） |
| `--dry-run` | 打印每一步将做什么，不写盘 |
| `--install-skills` | 同步 `writing-issue` skill 到 `~/.claude/skills/` |
| `--skip-skill-check` | 跳过 D 层检查 |

之后做一次只读体检：

```bash
coder-loop doctor /path/to/your-target-repo --repo <owner>/<repo>
```

四层全 OK 才能进下一步。doctor 不改任何文件——失败时按它指出的项目重跑 `install`（或修 PATH / `gh auth login`）。

想精确看一遍 install 会做什么、不会做什么，直接 `coder-loop install <target> --repo <slug> --dry-run`——它会逐行打印每个 layer 的动作和 `would-write` 标记。

把运行期文件加 `.gitignore`：

```bash
echo '.coder-loop/runtime/' >> .gitignore
echo '.dev-loop' >> .gitignore
echo '.dev-trace.txt' >> .gitignore
```

`.coder-loop/workflow.md` **要**入仓——agent 读这一份判断本项目的工作方式。

拆掉 slash command（保留 runtime 和 GitHub labels）：`coder-loop uninstall /path/to/your-target-repo`。

---

## 2. Schema 自检

`coder-loop doctor` 已经覆盖 bootstrap 完整性。如果你只想看 schema（不查 PATH / 标签 / skill），用：

```bash
coder-loop --target-cwd /path/to/your-target-repo --check-runtime
```

期望输出：

```
Runtime check passed: target=...
Runtime check passed: repo=<owner>/<repo>
Runtime check passed: config=.coder-loop/runtime/config.json (json)
Runtime check passed: state=.coder-loop/runtime/state.json
Runtime check passed: queue=0, selected=none
Runtime check passed: preset=gh-issue-pr-iteration
```

exit 0 表示 schema OK；任何 exit 1 + `Runtime check failed:` 提示先按错误清单修文件，再继续。常见错误见 [operations#--check-runtime](./operations.md#--check-runtime-错误分类)。

---

## 3. 用 `/dev-plan` 灌队列

把大任务 → GitHub issue 队列的工作交给 `/dev-plan`。在 Claude Code 内：

```
/dev-plan <design-doc-path | github-issue-url | "<用户描述>" | <repo-path> <goal>>
```

它读源头 → 按 `writing-issue` 规则拆原子 issue（含 `## 验收标准` checkpoint 表）→ 用 `addSubIssue` 建 parent/child → 写 `.coder-loop/runtime/issues/<issue>.md` + 把可执行 issue 推进 `state.json.queue`。

跑完后再做一次 schema 自检：

```bash
coder-loop --target-cwd /path/to/your-target-repo --check-runtime
```

`queue=N, selected=<issue>` 出现且 `N ≥ 1` 才能进下一步。

---

## 4. 用 `/dev-loop` 起循环

```
/dev-loop          # 不限轮次，循环直到 review agent 停或 .dev-loop 被删
/dev-loop 10       # 最多 10 轮
```

底层等价于：

```bash
LOGFILE="/tmp/coder-loop-$$.$(date +%Y%m%d-%H%M%S).log"
nohup coder-loop > "$LOGFILE" 2>&1 &
echo "coder-loop started (pid=$!, log=$LOGFILE)"
```

循环消费现有队列，按 preset 的 phase 顺序交替 spawn `iter` + `review` agent；每轮 review agent 判断 continue / retry / accept / block / stop。

监控分两路 audience：

**人类肉眼**（自由文本，stdout / trace 含 stack trace 与 prompt 内容）：

```bash
tail -f $LOGFILE                                                            # 进程级日志
ls -lt /path/to/your-target-repo/.coder-loop/runtime/logs/                  # agent 输出/状态
tail -f /path/to/your-target-repo/.dev-trace.txt                            # 当前迭代 trace（每轮覆盖）
```

**agent / 自动化 watcher**（结构化 JSONL，行级解析，不要 scrape 上面那条 stdout）：

```bash
RUNID=$(jq -r '.current.runId // empty' /path/to/your-target-repo/.coder-loop/runtime/state.json)
tail -F /path/to/your-target-repo/.coder-loop/runtime/events/$RUNID.jsonl   # per-run 事件流
```

事件类型：`queue.select` / `phase.start` / `phase.end` / `attempt.start` / `attempt.close` / `watchdog.fire` / `queue.terminal`。详见 [operations.md §6.3](./operations.md#63-agent-进程与监控非-cli-参数但运维需要知道)。

停：

```bash
rm /path/to/your-target-repo/.dev-loop
```

agent 跑到下一次循环条件检查时正常退出；不会强杀正在跑的 agent。

---

## 5. 一轮跑完后怎么看 trace

每轮结束后这些文件出现在 `.coder-loop/runtime/logs/`：

| 文件 | 内容 |
|---|---|
| `<runId>.iteration.txt` | iter agent 当前轮的全部 stdout（latest，覆盖式） |
| `<runId>.iteration.attempt-<timestamp>.<pid>.txt` | iter agent 的归档（每次 spawn 一份） |
| `<runId>.iteration.status.json` | exit code / signal / bytes / 错误（spawn 结束写入） |
| `<runId>.review.txt` / `.attempt-*.txt` / `.status.json` | review agent 同上 |

读 trace 的常用判断：

- iter `status.json` 的 `exitCode != 0` → spawn 失败（不是 agent 内部逻辑失败），看 stderr。
- iter `txt` 末尾的 `## Output verdict` 表明 iter 选了哪个出口（如 `implementation_ready_for_verification`），跳进 `iter/verify-evidence` 等下一 fragment。
- review `txt` 末尾的 verdict 决定本轮命运：`accepted_pr` → PR 已 merge / issue 已 close；`retry` → iter 下一轮继续；`blocked` / `loop_stopped` → 需人介入。

`state.json.current` 会在每轮开始时写、phase 切换时更新——出问题时先看它：

```bash
jq . .coder-loop/runtime/state.json | head -30
```

`current.phase == "iteration"` 表示当前/上次崩在 iter；`"review"` 表示在 review。重启 `/dev-loop` 时引擎会按 `current.phase` 续跑，不重头来。详见 [operations#resume](./operations.md#resume-行为)。

---

## 6. 常见坑

- **`.coder-loop/runtime/` 入了 git** → state.json 与 trace 进了 PR diff；把整个目录加 `.gitignore` 后 `git rm --cached -r .coder-loop/runtime/`。
- **`.coder-loop/workflow.md` 缺失或没入仓** → iter/review agent 读不到项目工作方式，行为退化为 bundled preset 默认值，往往写错命令 / 漏证据 layer。
- **`gh` 未 auth** → `iter/read-context` 会以 `infrastructure_failure` 出局，trace 里能看到 `gh auth status` 失败回显。
- **`config.json` 的 `repository` 字段与远端不一致** → `--check-runtime` 报 `repository mismatch`；改文件，不是改 `--repo` 参数。
- **删了 `.dev-loop` 但发现下一轮还跑了一次** → 引擎在每轮入口检查 sentinel，删除生效在当前轮的下一次循环边界。

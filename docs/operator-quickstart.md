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
bun link                                              # 注册 `coder-loop` 全局 bin（可选）
cp .claude/commands/dev-*.md ~/.claude/commands/      # 注册 /dev-plan /dev-loop slash command
```

不 `bun link` 也行——把后面命令里的 `coder-loop` 换成 `bun /path/to/coder-loop/src/loop.ts`。

---

## 1. Bootstrap 目标 repo 的 `.coder-loop/`

在**目标 repo**（不是本 repo）里：

```bash
cd /path/to/your-target-repo
mkdir -p .coder-loop/runtime/{issues,evidence,logs}
```

写三个 starter 文件。`.coder-loop/workflow.md` 给 iter/review agent 读本项目特有的命令 / PR 风格 / 证据 layer 约定；起点直接拷 bundled preset 的模板：

```bash
cp /path/to/coder-loop/presets/gh-issue-pr-iteration/templates/workflow.md    .coder-loop/workflow.md
cp /path/to/coder-loop/presets/gh-issue-pr-iteration/templates/shared.md      .coder-loop/runtime/shared.md
cp /path/to/coder-loop/presets/gh-issue-pr-iteration/templates/pr-body.md     .coder-loop/runtime/pr-body.md
```

拷完按本项目改：项目命令（`mise run test` vs `npm test` 等）、PR 证据 layer 的截图位置、CI parity 行为。删一条规则就停止生效——bundled preset 不内置 fallback。

`.coder-loop/runtime/config.json`：

```json
{
  "repository": "<owner>/<repo>",
  "baseBranch": "main"
}
```

`repository` 与 GitHub 远端一致；`baseBranch` 是 PR target。不写 `preset` 字段默认走 `gh-issue-pr-iteration`。

`.coder-loop/runtime/state.json`（空队列起手）：

```json
{
  "version": 1,
  "queue": [],
  "repository": "<owner>/<repo>",
  "baseBranch": "main",
  "recentRuns": [],
  "current": null
}
```

把整个 `.coder-loop/runtime/` 加进 `.gitignore`，运行期 state 不入仓：

```bash
echo '.coder-loop/runtime/' >> .gitignore
echo '.dev-loop' >> .gitignore
echo '.dev-trace.txt' >> .gitignore
```

`.coder-loop/workflow.md` **要**入仓——agent 读这一份判断本项目的工作方式。

---

## 2. Schema 自检

在 bootstrap 完、灌队列**前**先校验：

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

监控：

```bash
tail -f $LOGFILE                                                            # 进程级日志
ls -lt /path/to/your-target-repo/.coder-loop/runtime/logs/                  # agent 输出/状态
tail -f /path/to/your-target-repo/.dev-trace.txt                            # 当前迭代 trace（每轮覆盖）
```

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

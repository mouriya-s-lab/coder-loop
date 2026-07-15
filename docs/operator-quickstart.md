# Operator Quickstart

读者：第一次想在一个 repo 上跑通 coder-loop 的人。

读完后你能：用一条 `chain create` 把新 target 接入中央 daemon、用稳定 CLI 体检 operator 机器与 live runtime、把 GitHub issue 加入队列、通过 daemon API 起停循环、用 `coder-loop status <target> --json` 判断当前进度。

不在范围内：preset 内部怎么写（看 [preset-authoring](./preset-authoring.md)）、`gh-issue-pr-iteration` fragments 跳转细节（看 [gh-issue-pr-iteration-fragments](./gh-issue-pr-iteration-fragments.md)）、centralized runtime / chain debug 细节（看 [operations](./operations.md)）。

---

## 0. 前置依赖

跑 coder-loop 之前要有：

- `bun` 已安装（`bun --version` 能跑）。
- `gh` CLI 已 auth（`gh auth status` 不报错），有目标 repo 的 issue / PR 写权限。
- runner CLI 在 PATH：每个 phase 的 runner 由 preset 声明；bundled `gh-issue-pr-iteration` 与 `real-e2e-minimal` 目前都把 phase 声明为 `codex`。目标是覆盖 preset 里出现过的所有 runner kind（`claude` / `codex` / `opencode`）。
- 目标 repo 在本地，有可用的 base branch（通常 `main`）。

第一次安装本 repo：

```bash
git clone https://github.com/Mouriya-Emma/coder-loop.git
cd coder-loop
bun install
bun link                                              # 注册 `coder-loop` 全局 bin（推荐）
```

不 `bun link` 也行——把后面命令里的 `coder-loop` 换成 `bun /path/to/coder-loop/src/loop.ts`。

---

## 1. 把新 target 接入中央 daemon

新接入只需中央 socket 上一条 `chain create`；target 目录不需要任何 bootstrap 文件，工作流约定 / 项目命令的真源是 target 自有的 `CLAUDE.md` / `AGENTS.md`（committed），preset prompt 显式读取。

```bash
coder-loop daemon up
coder-loop chain create <name> \
  --config-json '{"repository":"<owner>/<repo>","baseBranch":"main"}' \
  --preset gh-issue-pr-iteration
```

`chain create` 的 chain identity 与 per-target 偏差都写在 `--config-json` 里：`{"repository":"...","baseBranch":"...","bindings":{"<key>":"<value>"}}`。`--preset` 可选：chain 级 preset 是 legacy default seed（不传则 seed 为 bundled `gh-issue-pr-iteration`），驱动 item 的仍是 `coder-loop item add` 的 `--preset <name>` / `--preset-path <abs>`（必填，每 item 挂一个 preset）。`gh-issue-pr-iteration` 需要的 GitHub label 资产由 issue writer / operator 在 target 侧自己按需管理，不由本 CLI 负责。

用自定义 `--loop-data-root` 时，`daemon up` 与后续 `chain create` / `doctor` / `status` 要传同一个 root。

之后做一次只读体检：

```bash
coder-loop doctor /path/to/your-target-repo --repo <owner>/<repo>
coder-loop status /path/to/your-target-repo --json
```

`doctor` 只看 operator 机器（gh + auth、preset phase 声明的 runner CLI、`coder-loop` 在 PATH）和中央 daemon / chain 的 live runtime（state、queue、events、live process）——零 target 文件检查。失败时按它指出的项目修 PATH / `gh auth login` / 起 daemon。`status` 也只读；即使 runtime 缺失或损坏，它也会用 `state.kind` 返回机器可读状态。

### Runner 默认值与覆盖

Runner 与 model 默认值写在 `preset.toml` 的 `[[phases]].runner` 与 `[[phases]].model`，允许值是 `claude` / `codex` / `opencode`。未声明 runner 的 phase 走 engine-builtin fallback；`status --json` 的 `target.runner.phases.<phase>.source` 会显示 `preset` 还是 `engine-builtin`。没有 per-target 的 runtime override 通道——改 phase 默认模型直接改 preset.toml 的 `model` 字段。

`coder-loop chain set-runner-model <chain> --kind <k> --model <m>` 提供 chain 级 model 覆盖：patch `chain.metadata.<kind>.model`，只对 kind 匹配的 phase 生效。单个 queue item 可加 `"runner": "claude"|"codex"|"opencode"` 覆盖非 trigger phase（bundled 中是 `iteration` 与 `review`）；trigger phase（`blocked-responder` / `umbrella-finalizer`）用自己的 phase runner 声明，不受 item override 影响。`doctor` 按 preset 声明的所有 phase runner 检查 binary 是否在 PATH；`status --json` 暴露 `target.runner.phases`、`queue.selected.phaseRunners`、`current.runner` 与 phase status 的 runner/model。

### 项目命令与运行期文件

把运行期文件加 `.gitignore`：

```bash
echo '.coder-loop/' >> .gitignore
```

项目命令 / PR 约定 / 项目专属注意事项要落在 target 自有的 `CLAUDE.md` / `AGENTS.md`（committed）——`gh-issue-pr-iteration` preset 的各执行 phase workflow 显式读取这两份。

要从某 target 撤出 coder-loop：直接 `coder-loop chain delete <name>` 删除 chain。

---

## 2. 健康检查与状态快照

常规检查先看两条：

```bash
coder-loop doctor /path/to/your-target-repo --repo <owner>/<repo>
coder-loop status /path/to/your-target-repo --json | jq '.state.kind, .queue, .current, .processes.live'
```

`doctor` 给人看 operator 机器先决条件 + live runtime health；`status --json` 给 supervisor、脚本、cron 看结构化状态。常见判断：

| 字段 | 期望 |
|---|---|
| `.state.kind` | `"ok"` 表示 state/preset/runtime 都可读；其他值按错误继续排 |
| `.queue.total` / `.queue.selected` | 有可推进 item 时 selected 不为 null |
| `.target.runner.phases` / `.queue.selected.phaseRunners` | 每个 phase 的 effective runner；含 `kind`/`source`/`binary`/`model` |
| `.target.runner.default` / `.queue.selected.runner` | 默认执行 phase 与 selected item 默认执行 phase runner |
| `.current.run` | 正在跑或可 resume 的 run；null 表示当前没有 in-flight phase |
| `.events.latest` | 当前或最近 run 的最后一条结构化事件 |
| `.processes.live` / `.processes.scanError` | live process scan 结果；daemon 详情看 `coder-loop daemon status` |

如果你只想看 runtime/schema，不想同时检查 PATH / runner CLI 等 operator 机器层，直接读结构化 status：

```bash
coder-loop status /path/to/your-target-repo --json \
  | jq '.state.kind, .target.preset, .queue.total, .queue.selected'
```

`.state.kind == "ok"` 表示 preset、central chain runtime、queue/current 都能解析；其他 kind 先按 [operations runtime health](./operations.md#4-runtime-health-错误分类) 继续排。

### items 在 wire 上的 shape

`items` 表按 preset `[item.fields]` 声明的透明字段落盘，engine 只保留 `item_id`（opaque string）作 identity。`gh-issue-pr-iteration` 声明 `issue`（number）/ `branch`（string）/ `pr`（number）/ `lastRunId`（string）四个透明字段。`status --json` 的 `queue.selected.item.<field>` 通过 `flattenExtraReplacer` 把这些字段平铺到父级；**消费者按字段名直接读 `queue.selected.item.branch` / `.pr`**（不要走 `.extra.branch` / `.extra.pr` 嵌套路径，`queue.selected.item.extra` 在 wire 上为 `null`）。daemon wire 上 `item.add` / `item.update` 的 identity 字段是 `itemId: string`；CLI flag 仍是 `--issue`（接受 opaque 字符串 id）。完整映射见 [operations wire-shape 段](./operations.md#items-wire-shape)。

---

## 3. 把 issue 加入队列

Operator 自行开好 GitHub issue，用 `coder-loop item add` 或 `item batch-add` 把它们加进中央 chain：

```bash
coder-loop item add <chain> --issue 123 --repo-cwd /path/to/target --json
coder-loop item batch-add <chain> --items-json '[{"issue":124,"repoCwd":"..."},{"issue":125,"repoCwd":"..."}]' --json
```

加完后做一次 schema 自检：

```bash
coder-loop status /path/to/your-target-repo --json | jq '.state.kind, .queue.total, .queue.selected'
```

`.state.kind == "ok"` 且 `.queue.selected` 不为 null，才有东西可跑。schema 细节异常时先看 `status` 的 `.state` / `.target`，需要 operator 机器层排查再跑 `coder-loop doctor <target> --repo <owner>/<repo>`。

---

## 4. 用 daemon API 起循环

```bash
coder-loop daemon start /path/to/your-target-repo
coder-loop daemon status /path/to/your-target-repo --json
```

`daemon start` 对已运行 target 幂等：返回 `alreadyRunning: true`，不会启动重复 loop。

循环消费现有队列，按 preset 的 phase 顺序 spawn agent；每个 phase 声明的 `[[phases.exits]]` 决定 agent 允许写出的状态，agent 通过 `coder-loop item exits` / `item update --status` / `item exit-action` 显式表达出口。

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

Agent 输出 layout 是 `<logDir>/<runId>/<phase>/stdout.jsonl`、`stderr.txt`、`status.json`、`sessions.jsonl`。

无需读取 `stdout.jsonl` 判断 agent 是否仍在输出。查询指定任务：

```bash
coder-loop activity item <chain> --issue <item-id>
```

一次查看全部仍存活任务：

```bash
coder-loop activity all
```

取得指定存活任务当前 session stdout log 的完整路径（输出可直接交给 `tail -F`）：

```bash
coder-loop activity log <chain> --issue <item-id>
```

三种命令都可加 `--json` / `--loop-data-root <dir>`，直接读取本地 SQLite 与
`activity.json`，不连接 daemon socket，也不要求 daemon 正在运行。输出固定包含最近
10 秒、30 秒、60 秒、300 秒的 stdout 完整行数；窗口按引擎观察输出的秒级时间桶近似计算。

**事件流 fallback**（结构化 JSONL，适合需要非轮询的 watcher）：

```bash
EVENTS=$(coder-loop status /path/to/your-target-repo --json | jq -r '.events.path // empty')
test -n "$EVENTS" && tail -F "$EVENTS"
```

事件类型（`src/observability.ts` `ObservabilityEventTypeBoundary` 的 union）常见成员：`phase.start` / `phase.end` / `attempt.timeout` / `run.startup_idle_kill` / `recycle.pending_entered` / `recycle.timeout_kill` / `recycle.natural_exit` / `queue.terminal` / `chain.completed` / `agent.spawn` / `agent.exit`；`item.*` / `chain.*` / `daemon.*` / `scheduler.*` 等 audit / lifecycle 事件也全部落这条流。详见 [operations.md §6.3](./operations.md#63-agent-进程与监控fallback-reference)。

停：

```bash
coder-loop daemon stop /path/to/your-target-repo
```

`daemon stop` 解析 target chain 并通过 central daemon 调用 `chain.stop`（scheduler 停止在该 chain 选 item，in-flight run 自然完成，可 `chain resume` 恢复）。需要强制处理 wedged 子进程时，先用 `status` / `daemon status` 定位 live process，按 operations 的 recovery 流程处理。

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
| `activity.json` | 最近 5 分钟的有界逐秒行计数；不含 session 正文 |

run 级事件在 `<logDir>/<runId>/events.jsonl`，也由 `status.events.path` 暴露。

读输出的常用判断：

- phase `status.json` 的 `exitCode != 0` → spawn 失败（不是 agent 内部逻辑失败），看 `stderr.txt`。
- iteration `stdout.jsonl` 尾部的调度者派发账（dispatch ledger）反映本次走的步骤 checklist（`implement` / `verify` / `e2e` / `submit` 等）与各步 verdict。
- 各 phase 的状态转移通过 `coder-loop item exits` + `item update --status` / `item exit-action` 落地：`status.json` 里能看到 phase 结束时 agent 选择的 exit；`gh-issue-pr-iteration` 的终局动作（PR merge、issue close、写 `done` / `moot`）归 closure phase，事件流里看 `queue.terminal`。

当前 / resume 状态先看 `coder-loop status` 的 `.current`。`current.phase` 指向当前/上次崩在哪个 phase；重启 `coder-loop daemon start` 或 `coder-loop daemon restart` 时引擎会按 `current.phase` 续跑，不重头来。详见 [operations#resume](./operations.md#5-resume-行为)。

---

## 6. 常见坑

- **`.coder-loop/` 入了 git** → runtime handoff / logs 进了 PR diff；把整个目录加 `.gitignore` 后 `git rm --cached -r .coder-loop/`。
- **target 的 `CLAUDE.md` / `AGENTS.md` 缺失或没入仓** → 各执行 phase 读不到项目工作方式（项目命令 / PR 约定），行为退化为推测项目命令，往往写错命令 / 漏证据 layer。
- **`gh` 未 auth** → iteration 的 Step 0 / Step 2 亲读 issue body 就会失败，trace 里能看到 `gh auth status` 失败回显。
- **chain identity 与目标 repo 不一致** → `status` / `daemon start` 会在解析 chain 时报告 repository/baseBranch 不匹配；指定正确 `--chain`，或修正 centralized chain identity。
- **找不到 target 的状态** → 权威路径是 central daemon + chain runtime；先看 `coder-loop status <target> --json` 返回的 `target.logDir`、`events.path`、`processes.live`，不要按老式的 target-local flat log layout 找。

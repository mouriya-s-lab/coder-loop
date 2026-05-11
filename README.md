# coder-loop

N 角色字符串调度引擎。给定一个 preset（角色定义、状态集、phase 列表、prompt 与变量绑定），coder-loop 按 preset 描述的顺序 spawn 各 phase 的 agent，捕获输出，根据状态推进队列，直到队列里所有 item 落在 terminal 状态。

**这不是一个 GitHub PR loop。** GitHub issue/PR 迭代是它内置的一个 preset（`gh-issue-pr-iteration`）。引擎本身不知道 GitHub 的存在、不知道 phase 数量、不知道 phase 名字、不知道 status 字面量。

---

## 设计思想

### 核心模型：信号生成 → 信号产生 → 信号消费

迭代收敛系统能否走到正确结果，取决于每次迭代是否产生足够的**信号**驱动下一次迭代。

这个认识来自 2024-2025 年四组研究：

| 问题 | 研究 | 发现 |
|---|---|---|
| 迭代系统为什么不收敛？ | ReVeal (2025), VeRPO (2025), DynaFix (2025) | binary pass/fail 是 sparse reward，无法指导迭代方向；dense per-step signal 使收敛效率提升 10%-37% |
| 评估为什么漏判？ | EDDOps (2024), Beyond Task Completion (2024) | 单维度评估掩盖其他维度的缺陷；agent 可在功能维度 100% 通过但策略维度仅 33% |
| 任务分解为什么导致失败？ | Agent Failure Taxonomy (2025) | planning phase defects 是 agent 任务失败的首要类别（约 50% 的失败源于此） |
| 怎么防止无限低质量推进？ | VMAO (2025) | completeness threshold + diminishing returns 检测 |

这些是**preset 设计原则**，不是引擎行为。引擎不知道「信号」是什么——它只调度 phase 顺序、传变量、捕获 trace。是 preset（默认 `gh-issue-pr-iteration`）按 plan/iter/review 三段切分把信号生成/产生/消费做成了 phase 流水线。

不同 preset 可以选择不同的切分：1 phase（如 `single-phase-example`，仅 run）、2 phase（如 `gh-issue-pr-iteration`，iter+review）、N phase（plan+iter+review+publish 等）都行。引擎对 N 没有上界。

### 四个设计决策（gh-issue-pr-iteration preset）

下面四条是 `gh-issue-pr-iteration` preset 的设计前提，不是引擎契约。换 preset 时这些可以改。

**1. Checkpoint 取代 checkbox**

传统 issue 写 `- [ ] docker build 成功`。这是自然语言，不是可执行验证。iteration agent 可以跳过、重新解释、或声称完成。`gh-issue-pr-iteration` 的 plan 把每条验收标准编译为 `{dimension, command, env, expect}` 四元组，agent 无法跳过。

**2. 维度覆盖强制**

issue #69 事后分析：Phase 3 验收标准全是功能维度，但 7 个 bug 中 6 个属于环境/集成/假设维度。`gh-issue-pr-iteration` 的 plan 要求每个 issue 的 checkpoint 覆盖 function / environment / integration / assumption；review 检查每个维度是否有至少一个 PASS。

**3. Spike 前置于实现**

如果 Phase 的架构假设依赖第三方组件未文档化行为，假设必须在实现前被验证。`gh-issue-pr-iteration` 的 plan 扫描风险信号、为高风险假设创建 spike issue。spike 失败触发设计调整，而非在错误假设上堆叠代码。

**4. 推迟验证不可遗忘**

某 checkpoint 当前环境无法执行（如本机没 Docker daemon），plan 将其作为 inherited verification obligation 分配到下游 issue，不可二次推迟。

---

## L1 引擎契约

`src/loop.ts` 是一个有限状态机，行为由 preset 驱动。引擎本身的职责：

| 引擎职责 | 说明 |
|---|---|
| **加载 preset** | 从 `<pkg>/presets/<name>/` 或 target 指定的 `presetPath` 读 `preset.toml`，解析 `name / version / item.idField / statuses / phases / fragments / agent`。每个 fragment 路径必须可读。 |
| **加载 target runtime** | 读 target `.coder-loop/runtime/{config.json, state.json, shared.md}`，校验路径都落在 target 目录下。 |
| **选 actionable item** | 若 `state.current` 存在且其 status 在 preset 的 `statuses.continuable` 集合内，继续它；否则在队列里找首个 `continuable` item。`continuable` 集合外的所有 item 是 terminal，引擎不动它们。 |
| **按 phase 顺序 spawn agent** | 遍历 `preset.phases`：对每个 phase，read 它的 entry prompt 模板，按 phase 的 `[phases.variables]` 表绑定变量（`item.<f>` / `config.<f>` / `runtime.<k>`）替换 `{{KEY}}`，把渲染后的 prompt 作为 argv 传给 `preset.agent.binary`。捕获 stdout/stderr 写到 trace 文件。每个 phase spawn 完毕后写一个 status JSON。 |
| **resume / 不丢工作** | 若 spawn 中途崩溃，重启时根据 `state.current.phase` 跳到当前 phase 而非从头跑。 |
| **`.dev-loop` 开关** | 引擎启动时创建 `.dev-loop`；删除该文件即正常退出当前轮，不强杀正在跑的 agent。 |
| **`--check-runtime` 健康检查** | 不 spawn agent。校验 preset、target 文件、queue item id / status 是否合法、`state.current` 是否一致。返回错误清单。 |
| **`--dry-run` 渲染检查** | 选 actionable item，跑到 spawn 前为止，输出选中的 item id；不写 trace、不调 agent。 |

引擎**不知道**：phase 数量、phase 名字、status 字面量（`queued / done / pending` 之类）、item id 字段名、已知变量 KEY（`{{REPO}}` / `{{ISSUE}}` 之类）、preset 之间的差异、GitHub。所有这些来自 preset 与 target config。

引擎**不判断**：item 是否完成、PR 是否正确、证据是否充分、parent 是否可关闭、queue 优先级。这些由 preset 的 agent prompt 判断（默认 preset 让 agent 改 GitHub state；其他 preset 可以让 agent 改任何东西）。

---

## 写一个新 preset

最小可跑示例在 `presets/single-phase-example/`。结构：

```
presets/<preset-name>/
  preset.toml          # 必需：schema 见下
  <phase>-entry.md     # 每个 phase 一个 entry prompt 模板
  [common/, role-x/, ...]   # 可选：fragment 文件，preset.toml 里 [[fragments]] 声明
```

### `preset.toml` schema

```toml
name        = "single-phase-example"      # preset 标识
version     = 1                           # 整数
description = "..."

[item]
idField = "id"                            # queue item 的 id 字段名

[statuses]
continuable = ["pending"]                 # 引擎会调度的 status 集合
terminal    = ["done"]                    # 引擎跳过的 status 集合（合并去重）

[[phases]]
name   = "run"                            # phase 名字，写入 state.current.phase
prompt = "run-entry.md"                   # 相对 preset.toml 的 entry prompt 模板路径

  [phases.variables]                      # 模板中 {{KEY}} 的解析表
  ITEM_ID    = "item.id"                  # → queue item 的 id 字段
  RUN_ID     = "runtime.runId"            # → 引擎生成的本轮 run id
  TARGET_CWD = "runtime.targetCwd"        # → target 目录绝对路径

# [[fragments]] 可省略；写时声明 fragment 文件供 entry prompt 引用

[agent]
binary    = "echo"                        # 实际生产 preset 通常是 "claude"
extraArgs = []
```

### 变量绑定 DSL（三前缀）

`[phases.variables]` 表的右侧字符串必须 match `^(item|config|runtime)\.[a-zA-Z][a-zA-Z0-9_]*$`：

| 前缀 | 来源 | 行为 |
|---|---|---|
| `item.<field>` | 当前 actionable queue item 的字段（包括 `idField` 与任意附加字段） | 字段缺失/null → `""`；string/number/boolean → `String(...)`；其他类型 → throw |
| `config.<field>` | target `.coder-loop/runtime/config.{json,toml}` 的字段 | 字段不存在 → throw；`null/undefined` → throw；类型同上 |
| `runtime.<key>` | 引擎计算的运行期值 | key 必须在引擎白名单内（见下）；否则 throw |

`runtime.*` 白名单（17 key）：`runId / targetCwd / workflowPath / sharedContextPath / statePath / currentIssueFile / issueDir / evidenceDir / evidenceRootDir / logDir / traceFile / loopFile / presetDir / fragmentIndex / runIdGeneration / resumedFromPhase / resumedStartedAt`。新增一个白名单 key 必须改引擎源码（`RUNTIME_BINDING_KEYS` 与 `buildRuntimeBindings` 两处同时改）。

`runIdGeneration` 是引擎对「这次 spawn 是新生成 runId 还是从 state.current 恢复」的客观回答；preset 自行用这一信号 + `item.status` + `item.lastRunId` 派生 fresh / retry / resume 三种调度形态，引擎不识别这些领域分类。

### Target 选 preset 的方式

target 在 `.coder-loop/runtime/config.json`（或 `config.toml`）写：

```json
{ "preset": "single-phase-example" }            // 用 bundled preset
```

或：

```json
{ "presetPath": "../my-custom-preset" }         // target-side 路径，相对 target 目录
```

或：

```json
{ "presetPath": "/abs/path/to/preset" }         // 绝对路径
```

两者互斥。都不写时引擎走默认的 `gh-issue-pr-iteration`。`preset` 名只允许 `^[a-zA-Z][a-zA-Z0-9_-]*$`，禁止路径分隔符与 `..`，所以 bundled name 一定落在 `<pkg>/presets/<name>/` 内。

### 最小 target

跑一个新 preset 所需的最小 target 文件（参见 `src/smoke.test.ts`）：

```
<target>/.coder-loop/
  workflow.md                   # 占位即可，preset 是否引用看 entry prompt
  runtime/
    config.json                 # { "preset": "<name>" }
    state.json                  # { version: 1, queue: [{<idField>, status}], recentRuns: [], current: null }
    shared.md                   # 占位
    issues/                     # 空目录
    evidence/                   # 空目录
    logs/                       # 空目录
```

`bun src/loop.ts --target-cwd <target> --check-runtime` 应当 exit 0、输出 `preset=<name>` 与 `queue=N, selected=<id>`。

---

## 内置 preset：`gh-issue-pr-iteration`

bundled 默认 preset，编码两角色（iteration + review）GitHub issue/PR 迭代工作流。下面所有内容都属于该 preset，不是引擎契约。

### 形态

| 维度 | 值 |
|---|---|
| `item.idField` | `issue`（GitHub issue number） |
| `statuses.continuable` | `queued / in_progress / changes_requested` |
| `statuses.terminal` | `blocked / moot / done` |
| phases | `iteration` → `review`（两段固定顺序） |
| `agent.binary` | `claude` |
| fragments | 27 个，分布在 `common/ / iter/ / review/` 三个角色目录 |

### 状态机语义

- `queued`：尚未开始（fresh / mid-iteration / mid-review 状态都用它——「正在跑」由 `state.current.id == X` 表达，而不是 status 字段）
- `in_progress`：legacy 值，引擎不再主动写入；仍接受历史 state.json 含此状态的 item，prompt 可以选择继续写它
- `changes_requested`：review 要求 iteration 重做
- `blocked`：spike 失败 / 设计问题，需人介入
- `moot`：上游已解决，不再跟
- `done`：review 判定关闭

所有 status 字面量都是 preset 自己的字符串，引擎只识别 `continuable / terminal` 二元集合。除上述外的转移（包括 `queued → done` 等）也合法，由 preset/agent 通过 prompt 写入 state.json。

iteration agent：实现 + 验证 checkpoint + 写证据 + 开/更新 PR + 写 handoff。
review agent：读 trace + 读 GitHub live state + 决定 status 转移 + post review comments + close issue/PR。

### Fragments

`presets/gh-issue-pr-iteration/` 下：

| 目录 | 内容 |
|---|---|
| `common/` | 程序↔agent 边界、GitHub 路由、状态文件不变量、shared memory policy |
| `iter/` | iteration 分阶段：读上下文 / 分类 / 实现 / 验证 / PR / handoff / final |
| `review/` | review 分阶段：读证据 / PR-evidence-code-closure 四 gate / 动作 / state transition / global assessment / stop / final |
| `templates/` | 目标侧 starter：`workflow.md / shared.md / pr-body.md` |

### Target 侧约定（仅在用 `gh-issue-pr-iteration` 时）

`workflow.md` / `shared.md` / `pr-body.md` 的 starter 在 `presets/gh-issue-pr-iteration/templates/`。target 拷过去后改本项目命令、PR 格式、证据 layer、CI-parity 行为。删一条规则就停止生效——bundled preset 不内置 fallback。

PR body 四层证据：functional / environment / integration / assumption。每层带可执行命令 + actual 输出 + verdict。任何 layer 缺失 → review 拒绝合并。

agent-browser 证据：UI 改动必须截图，截图保存到 `<TARGET>/.coder-loop/runtime/evidence/<issue>/`，PR body 引用绝对路径。

### Queue 优先级

queue item 字段（除 `issue / status` 外）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `attempts` | number / null | iteration 累计次数；review 判循环失败的硬上限 |
| `title` | string / null | 人类可读标题 |
| `priority` | `high \| medium \| low` / null | review 决定下一选哪个 |
| `branch` | string / null | iteration 创建的 PR 分支名 |
| `pr` | number / null | iteration 开的 PR 号 |
| `lastRunId` | string / null | 上一次 iteration 的 runId，supervisor 用于 trace 跳转 |
| `issueFile` | string / null | issue handoff 文件相对路径 |
| `evidenceDir` | string / null | 该 issue 的证据目录相对路径 |

这些字段对 `gh-issue-pr-iteration` 是 part-of-the-spec；对其他 preset 完全可忽略（引擎层从 Stage 2 起 type 上 nullable）。

---

## 用法

### 阶段一：规划（大任务入口，跑一次）

```
/dev-plan
```

读取设计文档、GitHub issue/PR/RFC 或用户描述的大任务，产出 GitHub issues + checkpoint 表 + 维度标注 + spike issue + parent/child graph + `.coder-loop/runtime` 队列。`/dev-plan` 是 `gh-issue-pr-iteration` preset 配套的规划器，对其他 preset 不直接适用。

写完 runtime queue 后必须先跑 schema check：

```bash
bun src/loop.ts --target-cwd <target-repo-path> --check-runtime
```

### 阶段二：循环

```
/dev-loop        # 无限循环
/dev-loop 10     # 最多 10 轮
```

循环消费现有队列，按 preset 的 phase 顺序交替 spawn agent。删除 `.dev-loop` 即停止。

`/dev-loop` 也是 `gh-issue-pr-iteration` 的入口；其他 preset 直接调 `bun src/loop.ts --target-cwd <path>`。

---

## 安装

仓库本身用 bun + TypeScript，不发布到 npm：

```bash
bun install                                          # 安装 devDependencies
bun link                                             # 注册 coder-loop bin 到全局
cp .claude/commands/dev-*.md ~/.claude/commands/     # 注册 slash commands
```

之后 `coder-loop` 命令和 `/dev-plan` `/dev-loop` 在任意目录可用。也可以不 `bun link`，调用改成 `bun /path/to/coder-loop/src/loop.ts`。

## `/dev-plan` 的前置依赖

`.claude/commands/dev-plan.md` 引用以下用户级规则与 skill：

- `~/.claude/rules/github-issue-pr-routing.rule.md`
- skill `writing-issue / writing-pr / review-pr`

不是 coder-loop 仓库内的资产，由用户自己维护。缺失时 `/dev-plan` 仍可运行，但 issue 形式、PR 路由、review gate 设计会退化。`/dev-loop` 没有此类依赖。

## References

1. ReVeal: Self-Evolving Code Agents via Iterative Generation-Verification. arxiv 2506.11442, 2025.
2. VeRPO: Verifiable Dense Reward Policy Optimization for Code Generation. arxiv 2601.03525, 2025.
3. DynaFix: Iterative Automated Program Repair Driven by Execution-Level Dynamic Information. arxiv 2512.24635, 2025.
4. EDDOps: Evaluation-Driven Development and Operations of LLM Agents. arxiv 2411.13768, 2024.
5. Beyond Task Completion: An Assessment Framework for Evaluating Agentic AI Systems. arxiv 2512.12791, 2024.
6. Exploring Autonomous Agents: A Closer Look at Why They Fail When Completing Tasks. arxiv 2508.13143, 2025.
7. VMAO: Verified Multi-Agent Orchestration. arxiv 2603.11445, 2025.

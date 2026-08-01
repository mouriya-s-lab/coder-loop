# #586 feat(engine): v3 hook 声明模型——四层声明位装载合并与生效视图

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:39Z  | updated: 2026-07-15T18:56:40Z
- closed: 2026-07-15T18:56:19Z  | state_reason: `completed`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/586
- comments: 6  | timeline events: 41

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）。继承条款逐字快照：

> "**声明位**：四层全支持——全局 loop-data root、chain 级（metadata）、preset 级（抽象 gate 点，接口与实现分离）、item 级。" — #543 设计裁决 4

> "四层声明位（裁决 4）。同一挂点多层命中时全部执行，顺序 全局 → chain → preset → item；gate decision 合成为「任一非 advance 即不放行」（AND 放行）；hold 与 reopen 并存时 reopen 优先，多 reopen 并存的冲突语义见开放问题。preset 级是抽象 gate 点：preset 只声明「此处需要一道命名 gate」（保持 preset 可分发、不含本机脚本路径），具体脚本由全局/chain 层绑定到该名字；声明语法归 RFC-2 的 DSL（见接口假设）。" — #543 声明位与合成语义

> "**observer**：订阅生命周期事件，异步旁路执行，不影响调度；失败只记 diagnostic 事件。挂点 = observability 事件类型枚举（hook 点清单不另发明命名，直接复用事件类型词表；事件枚举扩张时 observer 挂点面自动扩张）。" — #543 核心设计·两类 hook

> "**gate**：挂在调度决策点上……gate 决策点是引擎内禀闭集（与事件枚举分列）：至少含 run pre-spawn、run post-exit（下一次选择前）、item 状态转移、容器推进/par join（#546 判定点）、chain-complete（吸收现有 trigger 先例；#546 定性为顶层 join 实例）、daemon startup/shutdown、tick（须带节流声明才可挂）。" — #543 核心设计·两类 hook

> "每 hook 声明超时；超时/崩溃按其 `onFailure` 声明走 `hold`（该决策点退避重问，事件流可见）或 `advance`（记 diagnostic 后放行）。" — #543 执行模型

> "gate hold 状态与 hook 声明清单（四层合成后的生效视图）进 status 快照新增的 hooks 节，并入 #544 已裁的快照 boundary 收紧工作。" — #543 跨 RFC 接口假设·RFC-5

## 目标

hook 声明的 typed 模型（observer|gate、挂点、脚本、超时、onFailure）与四层声明位的装载、校验、合并——产出供执行 children 与 #575 消费的单一 typed 生效视图；本 child 不拥有 `StatusSnapshotBoundary` 或 `status --json` 投影。

## 使用场景

- operator 在全局 loop-data root 或 chain 级声明 observer/gate hook；声明装载后，引擎内部得到四层合成的 typed 生效视图（哪个挂点有哪些 hook、来自哪层、执行顺序），执行 children 只消费该视图；`status --json` 与 GUI 投影唯一归 #575。
- 基座 child：observer 派发、gate 评估、具名 gate 绑定各 child 只消费生效视图，不各自读原始声明——本 child 是 hook 声明的唯一事实源。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- hook 机制不存在：`grep -rn "hook" src/ --include="*.ts"` 全部 7 处命中均为注释里对既有函数的口语化指代（如 `src/loop.ts:5632`），无任何注册机制（2026-07-02 核实）。
- chain 级声明载体先例：`ChainMetadata`（`src/runtime-data.ts:105`，12 字段 + `CHAIN_METADATA_KEYS` 白名单 `src/runtime-data.ts:246-259`）——`maxItemAttempts` / `coderLoopChainCompleteTrigger` 是「参数归元数据」先例。
- 全局层持久化先例：`rate-limit.json`（路径构造 `src/daemon.ts:922-927`、读 `:930`、写 `:985`）——daemon 级独立文件、刻意不进 db.sqlite；loop-data root 解析 `resolveLoopDataRoot`（`src/runtime-paths.ts:98`）。
- observer 挂点词表 = `ObservabilityEventTypeBoundary`（`src/observability.ts:24`，44 成员 union，五 kind `src/observability.ts:16`）；gate 决策点闭集 = #543 挂点清单（引擎内禀，与事件枚举分列）。
- **闭包转移边入 observer 事件词表**（#546 body「答复 #543（RFC-4）」节 2026-07-10 修订 + 权威记录 `v3/closure-lifecycle-decision.md` §2「hook 挂点」）：闭包生命周期转移边六事件 `closure.create` / `closure.run-spawn` / `closure.run-exit` / `closure.suspend` / `closure.reopen` / `closure.consume`（具体命名归事件词表落地时裁）作为新事件类型进入 `ObservabilityEventTypeBoundary` 后，本 child 的声明模型须能表达对它们的 observer 订阅（依「observer 挂点类型直接引用事件类型词表」自动扩张，本 child 零字面量）。**gate 决策点闭集不因此扩大**——转移边 observer-only，不可 gate（副作用上放 gate 即发明第二推进语义）；相关合成半边归 #590。
- item 级载体候选：items 表 `extra` 透明字段（#419 先例）——载体裁决是本 child 显式决策项。
- status 快照：`StatusSnapshotBoundary`（`src/loop.ts:490`，顶层匿名 `"object"` 槽的整体收紧归 #544 的快照 boundary 收紧 child）、`buildCoderLoopStatusSnapshot`（`src/loop.ts:2724`）。

## 问题

#543 的一切执行语义都以「引擎知道哪里挂了什么 hook」为前提；当前引擎没有任何 hook 声明面——四层声明位（裁决 4）与合成顺序（全局→chain→preset→item）无载体，执行 children 无从启动。

> "**hook 机制不存在**：全仓无注册回调点、无 preset 侧脚本声明、无 pre-spawn/post-exit/pre-transition 扩展点" — #543 现状事实

## 预期结果

性质表述：

1. **声明是穷尽 ADT**：`observer(事件类型) | gate(决策点)` 判别 union + 脚本路径 + 超时 + gate 的 `onFailure = hold | advance`；新增声明 kind / 挂点 variant 时编译器暴露全部处置点，无 default 兜底。observer 挂点类型直接引用事件类型词表（词表扩张时挂点面自动扩张、hook 侧零代码变更）；gate 决策点是引擎内禀闭集类型。
2. **四层装载合并**：全局（loop-data root 载体）+ chain（metadata）+ item 三层直接声明装载合并为单一生效视图，顺序保持 全局 → chain → preset → item；preset 层在视图中是具名 gate 点占位 variant（声明来自 #555 编译产物、绑定解析归#591（具名 gate）——本 child 只留穷尽 variant 位）。一切执行侧消费该视图，不重读原始声明。
3. **边界 parse 与装载拒绝**：声明经 arktype 边界 parse；非法声明装载期拒绝并点名——未知事件类型、未知决策点、gate 缺 onFailure，以及 **`hook.*` 自反挂点**（本 child 裁决：observer 不得订阅 `hook.*` 事件类型——hook 执行事件再派发 hook 构成无限自激励回路，与 #543「异步旁路执行，不影响调度」直接冲突；hook 观测 hook 的需求已由事件流查询面覆盖。裁决记录见本 thread）。
4. **投影输入契约**：生效视图是精确 typed ADT，可被 #575 直接投影为 `status --json` hooks 节，不需要重读或重新解释原始声明；本 child 不修改 `StatusSnapshotBoundary`。声明存在不改变任何调度行为（执行归后续 children）。
5. **写入面 operator 专属**：hook 声明（含后续具名 gate 绑定）的一切写入通道对 agent 主体 deny——agent 可改 hook 声明 = agent 可自行解除 gate，破坏 gate 的存在意义。与 #546 的判定权保护原则同构：定义态 join 实例内不可变，物化态 join 只能经 #564 的独立版本化演化通道改变；hook 声明同样不得落入 agent 可自行解除的普通写入面。本 child 的声明载体从第一天起归为 operator-only，拒绝留审计事件。

### 显式决策项（落地时裁，裁决留本 thread）

- RFC 开放问题逐字："item 级 hook 的声明载体与寿命（item 是消耗品，声明随 item 终态失效的清理语义）。"
- 全局层声明载体形态（loop-data root 下的文件名/格式）——RFC 只裁「全局 loop-data root」层存在，载体形态归本 child（`rate-limit.json` 独立文件先例可参照）。

## 不应残留

- 本 child 范围内：hook 声明以匿名 JSON / 裸 string 透传；生效视图之外的第二套声明读取路径；在本 child 内直接修改 `StatusSnapshotBoundary` 或另造 hooks 快照投影。
- 本 issue 范围之外不应改动：hook 进程执行（spawn/stdin/decision，归 observer/gate children）；具名 gate 点的绑定解析与未绑定语义（归#591（具名 gate））；#555 的声明语法与编译产物 shape；全部快照投影（hooks 节归 #575，其余匿名槽收紧归 #574）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 引擎无 gate 策略业务语义（#543 约束逐字）："引擎不含任何 gate 策略业务语义：轮数阈值、检查任务内容、插队位置全在 operator 脚本内；引擎只提供挂点、元数据、decision 协议"。
- hook 身份裁决（#543 裁决 3）："operator 全权——hook 子进程无凭证调 CLI，走操作员路径，不新增第三类主体。"——声明模型不引入凭证字段或第三类主体。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：静态类型、单元/contract、boundary round-trip；涉及真实 daemon 边界时增加最小进程级 integration fixture。
- **本 issue 必须证明**：正文定义的输入能产生精确稳定输出，非法/缺失输入在指定边界被拒绝，下游可直接消费而不猜字段或增加私有 fallback。
- **不在本 issue 内执行**：不运行整个 v3 场景，不运行 `scripts/real-e2e.ts`。多个编译/边界产物合流后的真实消费由 #684 证明；现有 GitHub preset 兼容性由 #685 证明。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 四层声明合成视图 | 用声明装载测试读取 typed effective view | local | 视图呈现各挂点合成清单，来源层与顺序（全局→chain→preset→item）可见；不经 status 快照反推 |
| function | 非法声明装载拒绝 | 分别声明：未知事件类型 observer、未知决策点 gate、缺 onFailure 的 gate、订阅 `hook.*` 的 observer | local | 均装载期拒绝且错误点名违规字段 |
| function | 声明零执行副作用 | 声明 hook 后真跑一轮 | local | 调度行为与未声明时一致；无任何脚本被 spawn |
| function | agent 写入被拒 | 以 agent 主体（run-scoped 凭证）尝试写 hook 声明 | local | 被拒 + 审计事件；operator 路径写入成功 |
| type | 声明 ADT 穷尽 | `bun run typecheck`；临时向声明 union 加一个 kind variant 观察编译错误面 | local | typecheck 过；新增 variant 使全部处置点报错，无 default 吞掉 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: 无（本树地基 child，先行）。
- Blocks: #588（observer 执行）、#589（gate 执行）、#591（具名 gate）、#575（status hooks 投影）。
- 协调边：#555（preset 级 gate 点声明经编译产物进入生效视图的占位读取，本 child 不硬依赖——占位 variant 先行，内容随 #591 填充）；#590 拥有 `GateDecisionPoint` 的接线语义，本 child 只引用同一共享 ADT，不复制 point 词表。


---

## Comments (6)

### comment #4866575474 by `RiriAgent` — 2026-07-02T14:01:29Z


## 架构切片

1. **系统定位**：三层模型（CLAUDE.md L1/L2/target）中 L1 引擎新增的 hook 声明面——「机制归引擎、参数归声明」在 hook 维度的参数半边；引擎持有声明 schema 与合成规则（机制），挂什么脚本在哪层全归 operator 声明（参数）。
2. **全局坐标**：operator 声明域（不可信输入：全局文件 / chain metadata / item extra）→ arktype 边界 parse → 引擎 typed 生效视图域 → status 快照投影（外部消费者域）。信任级在 parse 点一次升格，视图是 typed 域的合成产物、快照是其投影，无二次 parse。
3. **类型↔值不漂移**：防值漂移——四层原始声明若被执行侧各自读取即出现同一声明多处解释；生效视图作为唯一消费面封死。防类型泄露——observer 挂点类型引用事件词表本身而非复制枚举，词表演进零同步代码。
4. **消除的错误类别**：「执行侧对声明的解释不一致」不可表达（单一视图）；「声明了却静默无效」不可表达（未知挂点装载期拒绝）；「hook 自激励回路」不可表达（自反挂点声明期拒绝）。

## log/观测义务

- 装载期拒绝沿既有 preset load 失败形态（错误点名，`status --json` 可体现 invalid 状态）；无新增运行期事件义务（hook 执行事件归执行 children）。
- hooks 节进 status 快照是本 child 的观测交付物本体。



### comment #4866578182 by `RiriAgent` — 2026-07-02T14:01:45Z

## 决策记录：observer 自反挂点（`hook.*`）声明期拒绝

body 预期结果 3 所引裁决的依据展开（#543 拆解会话当场裁决，2026-07-02）：

- **问题**：#543 已裁「observer 挂点 = observability 事件类型枚举，事件枚举扩张时挂点面自动扩张」；本树新增 `hook.*` 事件类型后，按字面 observer 可订阅 `hook.start` 一类事件——hook 执行发事件、事件再派发 hook，构成无限自激励回路。
- **裁决**：observer 挂点词表 = 事件类型枚举 **减去 `hook.*` 子集**；订阅 `hook.*` 的声明装载期拒绝，事件发射路径对 `hook.*` 类型零派发（双层防护，#588（observer 执行）承接发射期半边）。
- **依据**：自激励回路与 #543「异步旁路执行，不影响调度」直接冲突（进程风暴挤占调度资源即影响调度）；「hook 观测 hook」的真实需求已由事件流查询面（`coder-loop logs` / events JSONL）覆盖，无场景损失。「挂点面自动扩张」的设计意图是「事件词表演进零 hook 侧同步代码」，减去固定自反子集不破坏该意图。
- **可判定性**：手头事实（回路必然失控）+ 全局求解（禁订阅无场景损失）可靠判定，按 decision-closure 当场裁，不回传操作员。



### comment #4953812495 by `RiriAgent` — 2026-07-13T02:11:37Z

<!-- coder-loop:executable-contract schema=1 source-issue=586 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/586
- Observed issue-body update timestamp: `2026-07-11T08:48:26Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866575474
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866578182
- Investigated source revision: `f01560d5d0b324e791db7f599e502f09fc78a652` (`origin/main`, observed 2026-07-13).

## Deliverable

`implementation-pr`

Implement the declaration foundation only: an exhaustive typed hook declaration model, boundary parsing, the four-layer load/merge path, and one effective-view constructor consumed by later execution/projection children. Do not implement hook process execution, stdin/decision protocol, named-gate binding resolution, gate scheduling semantics, or `StatusSnapshotBoundary`/GUI projection; those remain owned by #588, #589, #591/#590, and #575 respectively.

The two issue-level open carrier decisions are resolved for this implementation as follows:

1. Global declarations live in one versioned JSON document at `<loop-data-root>/hooks.json`, resolved from the same root as `db.sqlite` and `rate-limit.json`; malformed or unknown content is a load error, never ignored.
2. Chain and item declarations are typed `hooks` carrier fields on `ChainMetadata` and `ItemExtra`. Item declarations have the same lifetime as the item record: they remain attached through actionable/final states and disappear only when that item record is deleted. `hooks` is a control-plane field: operator writes are accepted, while every run-credential/agent mutation path is rejected and emits the existing field-write/caller-admission audit evidence.
3. Preset participation is an explicit named-gate-placeholder variant in the effective-view algebra. This PR supplies the exhaustive variant/merge slot but does not parse #555 syntax or resolve bindings; those behaviors remain #555/#591 work.
4. Effective ordering is stable `global -> chain -> preset -> item`, retaining source-layer provenance. Observer declarations reference the exported observability event-type boundary/type rather than copying its literals; the admissible observer point is that vocabulary minus `hook.*`. Gate decision points have one exported closed ADT shared with #590, not a second string list.

Current-tree anchors: `ChainMetadata` and `ItemExtra` are the typed persistence carriers (`src/runtime-data.ts:105`, `src/runtime-data.ts:155`); their known-key and serialization paths are centralized (`src/runtime-data.ts:255`, `src/runtime-data.ts:339`, `src/runtime-data.ts:406`); loop-data root resolution is centralized (`src/runtime-paths.ts:100`); the observability vocabulary currently has one arktype boundary (`src/observability.ts:24`); and agent item mutations already pass caller plus per-field admission (`src/daemon.ts:2707`, `src/daemon.ts:3818`).

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | function: four-layer effective view | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; fixtures prove global/chain/preset-placeholder/item entries converge through one constructor in exact source order with provenance retained. |
| C2 | function: boundary rejection | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; separate fixtures reject unknown observer event, unknown gate decision point, gate missing `onFailure`, malformed timeout/script, and observer subscription to every `hook.*` event, with the failing field named. |
| C3 | function: declaration-only, zero spawn | shell | `bun test src/daemon.test.ts src/scheduler.integration.test.ts` in repository root; local env | Exit `0`; loading valid declarations and running a scheduler tick preserves ordinary scheduling and spawns no declared hook executable. |
| C4 | security: operator-only mutation | shell | `bun test src/daemon.test.ts` in repository root; local env | Exit `0`; operator global/chain/item declaration paths succeed; run-scoped credentials cannot write/patch/clear `hooks`, and denial is present in the existing caller/field-write audit stream. |
| C5 | persistence and lifetime | shell | `bun test src/runtime-data.test.ts src/daemon.test.ts` in repository root; local env | Exit `0`; global JSON plus chain/item declarations round-trip exactly; restart reloads the same effective view; item terminal-state changes do not delete item hook declarations. |
| C6 | type and schema integrity | shell | `bun run typecheck && bun test` in repository root; local env | Exit `0`; strict typecheck and complete unit/smoke suite pass. Tests may demonstrate exhaustiveness with compile-time fixtures, but must not weaken existing assertions. |
| C7 | pattern: no parallel/untyped declaration shape | shell | `rg -n 'HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint|hooks.json|\bhooks\b' src` in repository root; local env | Exit `0`; declarations/boundaries/effective-view construction converge in the hook declaration module plus typed carrier/path/daemon integration sites; no execution implementation or status snapshot projection appears. |
| C8 | pattern: red-line type constructs | shell | `git diff origin/main -- src | rg --pcre2 -n '\bany\b|:\s*unknown\b|\bas\s+(?!const\b)'` in repository root; local env | Exit `1` with no matches; changed production code adds no `any`, non-boundary `unknown`, or type assertion other than `as const`. |
| C9 | canonical runtime | shell | `bun scripts/real-e2e.ts` in repository root; authenticated `gh`, runner CLIs on `PATH`; use the script-owned isolated loop-data root | Exit `0`; transcript reports the fixture PR `MERGED`, fixture issue `CLOSED`, and teardown/tripwire success. |

## Pattern scope

| Type | Pattern/query | Allowed sites | Expected convergence |
|---|---|---|---|
| `changed` | `HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint` | One dedicated hook declaration module and its focused test; imports at carrier/loader/admission integration boundaries only | Exactly one declaration ADT, one parser boundary, one gate-point ADT, and one effective-view constructor. All consumers import them; no copied unions or switch defaults. |
| `changed` | `hooks.json|\bhooks\b` | `src/runtime-paths.ts`, typed persistence carriers in `src/runtime-data.ts`, daemon/global loader and operator admission wiring, focused tests | Global/chain/item raw inputs are parsed once and merged once. No scheduler/execution/status-projection behavior is introduced. |
| `whole-tree` | observability event literals used as observer hook points | `src/observability.ts` is the event vocabulary authority; hook module may derive/filter its exported boundary/type | Zero copied observer-event string unions; adding an observability event reaches the observer declaration type automatically, with the structural `hook.*` exclusion remaining enforced. |
| `whole-tree` | agent-writable `hooks` | Operator-only global/chain control plane and operator branch of item mutation admission | Zero preset-grantable or agent-credential path can create, replace, patch, or clear hook declarations. |

## Canonical runtime

- Setup: `bun install --frozen-lockfile` when dependencies are not already materialized; verify active GitHub account is `RiriAgent` and required runner binaries are on `PATH`.
- Start: no new standalone service is introduced. The target-mandated real driver is `bun scripts/real-e2e.ts`; it creates and owns an isolated daemon/loop-data root and a real GitHub fixture issue.
- Readiness: the driver must report its isolated daemon ready before seeding/scheduling the fixture.
- Behavior: first exercise declaration load/merge/rejection and operator-only writes through the focused integration tests; then run the real driver through daemon spawn, iteration, review, merge, and issue closure. A declaration-only fixture must prove the declared script is never spawned in this child.
- Logs: retain the real-E2E transcript and the script-reported isolated run/event paths in PR evidence. Required terminal observations are PR `MERGED`, issue `CLOSED`, and successful tripwire/teardown.
- Stop ownership: `scripts/real-e2e.ts` owns daemon shutdown, fixture teardown, and isolated artifacts. Do not stop or mutate the production daemon under `~/.coder-loop`.

## Test delta

`required`

Add focused declaration-model/boundary/merge tests and daemon integration coverage for persistence, restart reload, operator allow, agent deny plus audit, and zero execution side effects. Existing tests and assertions remain intact; tests must not permit unknown declarations, silent defaults, copied event/decision vocabularies, or a second effective-view construction path merely to obtain green results.

## Dependencies

- No implementation blocker and no prerequisite merge: the issue explicitly marks this as the foundation child, and the current GitHub graph reports no `blockedBy` nodes. Parent #543 is open: https://github.com/mouriya-s-lab/coder-loop/issues/543.
- #555/#591 are coordination edges only. This PR reserves the typed preset-placeholder variant, but does not ingest or bind future named-gate syntax: https://github.com/mouriya-s-lab/coder-loop/issues/555 and https://github.com/mouriya-s-lab/coder-loop/issues/591.
- #590 must consume the same exported `GateDecisionPoint` ADT when it wires decision sites; it must not introduce another point vocabulary: https://github.com/mouriya-s-lab/coder-loop/issues/590.
- This issue blocks execution/projection children #588, #589, and #575; their current open state does not block declaration-model delivery: https://github.com/mouriya-s-lab/coder-loop/issues/588, https://github.com/mouriya-s-lab/coder-loop/issues/589, https://github.com/mouriya-s-lab/coder-loop/issues/575.
- There is no existing issue PR, no closing PR reference, and no existing executable-contract marker as observed from the complete issue metadata/comments/timeline on 2026-07-13.

## Supersedes

none



### comment #4981760712 by `RiriAgent` — 2026-07-15T14:32:00Z

<!-- coder-loop:executable-contract schema=1 source-issue=586 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/586
- Observed issue-body update timestamp: `2026-07-15T12:58:28Z` (`lastEditedAt`, re-read from live GitHub).
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866575474
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866578182
- Investigated revisions: `55ff3b2b7345a8e3d975934a53997d074aa02380` (`origin/main`) and existing PR head `0172878adc88c58f5c57a7d2d7db1b08d01f5a29`, observed 2026-07-15.

## Deliverable

`implementation-pr`

Continue the existing branch `coder-loop/v3-586-6ac101ef751a` and PR https://github.com/mouriya-s-lab/coder-loop/pull/672. Deliver only the hook declaration foundation: an exhaustive typed `observer | gate` declaration ADT, strict boundary parsing, global/chain/preset-placeholder/item loading and stable merge with provenance, and one typed effective-view entry for downstream execution/projection children.

The carrier decisions remain:

1. Global declarations are one versioned JSON document at `<loop-data-root>/hooks.json`; malformed JSON, unknown fields, and invalid declarations fail loading and are never ignored.
2. Chain and item declarations are typed `hooks` carrier fields on `ChainMetadata` and `ItemExtra`. Item declarations live with the item record across actionable and terminal statuses and disappear only when the item record is deleted.
3. Preset participation is a typed `named-gate-placeholder` effective-view variant only. Parsing #555 syntax and resolving its binding remain #555/#591 work.
4. Effective order is exactly `global -> chain -> preset -> item`, retaining source-layer provenance. Observer points derive from the shared observability vocabulary with structural `hook.*` exclusion; gate points have one closed exported value/type authority shared with #590.
5. Every declaration write path is operator-only. Run credentials cannot create, replace, patch, indirectly clear, or directly clear hooks; each rejection uses the existing admission audit stream.

Do not implement hook execution, decision stdin/protocol, named-gate binding, gate scheduling, a positive hooks status section, or GUI projection. Those remain owned by #588, #589, #590/#591, and #575. Current source anchors are `src/hook-declarations.ts:8-47,56-169`, `src/runtime-data.ts:105-176,263-299,349-443`, `src/daemon.ts:233,1095-1124,3965-3980,5101-5124`, and `src/observability.ts:25-135,731-732,825-826`.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | function: four-layer effective view | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; fixtures reach the single typed constructor and show exact `global -> chain -> preset -> item` order plus provenance. |
| C2 | function/type: strict boundary and vocabulary evolution | shell | `bun run typecheck && bun test src/hook-declarations.test.ts src/observability.test.ts` in repository root; local env | Exit `0`; unknown observer/gate points, missing gate `onFailure`, invalid tick throttle, malformed script/timeout, undeclared fields, and `hook.*` observer subscriptions are rejected by named fields. A compile-time fixture must prove that adding a synthetic non-`hook.*` event needs no hook-side synchronization while a synthetic `hook.*` event remains excluded, with no cast or copied event union. |
| C3 | function: declaration-only zero execution | shell | `bun test src/daemon.test.ts src/scheduler.integration.test.ts` in repository root; local env | Exit `0`; a valid declaration loads, ordinary scheduling reaches its existing terminal behavior, and the declared sentinel executable is never spawned. |
| C4 | security: operator-only mutation | shell | `bun test src/daemon.test.ts` in repository root; local env | Exit `0`; operator global/chain/item writes work; run-credential add, batch-add, replace, patch, direct clear, and omission-based indirect clear are denied and audited. |
| C5 | persistence/boundary: lifetime and projection separation | shell | `bun test src/runtime-data.test.ts src/daemon.test.ts` in repository root; local env | Exit `0`; global/chain/item declarations round-trip, daemon restart reloads the same effective view, terminal status retains item hooks, raw hooks remain absent from all public item/run status surfaces, unrelated explicit `null` persists, own `__proto__` is rejected, and only operator `hooks: null` clears hooks. |
| C6 | environment: complete local gate | shell | `bun run typecheck && bun test` in repository root; local env | Exit `0`; strict typecheck and the complete unit/smoke suite pass with no removed, renamed, skipped, weakened, or timeout-relaxed pre-existing test. |
| C7 | architecture: complete Pattern inventory | shell | `rg -n 'HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint|hooks.json|\bhooks\b|ObservabilityEventType|parseObservabilityEventType' src` in repository root; local env | Exit `0`; every match is classified against all Pattern rows below, with no parallel declaration/event authority, execution implementation, positive hooks status projection, or agent-writable hooks path. |
| C8 | type red lines | shell | `git diff "$(git merge-base HEAD origin/main)" HEAD -- src | rg --pcre2 -n '\bany\b|:\s*unknown\b|\bas\s+(?!const\b)'` in repository root after `git fetch origin main`; local env | Exit `1` with no matches; changed production code adds no `any`, non-boundary `unknown`, or type assertion other than `as const`. The comparison is pinned to the PR merge base, not a moving two-dot `origin/main` diff. |
| C9 | process integration: existing engine behavior | shell | `bun scripts/engine-integration.ts` in repository root; local env with Bun and Git on `PATH`; script-owned isolated loop-data | Exit `0`; transcript shows isolated daemon socket readiness, real CLI/socket/spawn/admission/worktree/SQLite progression, terminal item, reclaimed worktree, no orphan, and teardown. This is the strongest process-level runtime check authorized for #586 and must not be described as real E2E. |

No browser row applies: this is a pure engine/CLI change and browser evidence is not required.

## Pattern scope

| Type | Pattern/query | Allowed sites | Expected convergence |
|---|---|---|---|
| `changed` | `HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint` | One hook-declaration authority, its compile-time/focused tests, and typed imports at persistence/daemon integration boundaries | Exactly one declaration ADT, strict parser, gate-point authority, exhaustive conversion path, and effective-view constructor. No copied union, catch-all/default, cast, or second merge path. |
| `changed` | `hooks.json|\bhooks\b` | `src/runtime-paths.ts`, hook declaration loader, typed chain/item persistence, daemon load/effective-view/admission wiring, status omission boundary, and focused tests | Raw inputs parse once and merge once; persistence remains distinct from public status output. No hook execution or positive `StatusSnapshotBoundary`/GUI projection is introduced. |
| `whole-tree` | `ObservabilityEventType|parseObservabilityEventType|ObserverHookPoint|hook\.` | `src/observability.ts` as the sole event vocabulary/parser authority; hook declaration code may derive and structurally narrow its observer point type; focused compile/runtime tests | Zero copied event literal union. A new non-`hook.*` observability event automatically becomes an observer point; a new `hook.*` event automatically remains unrepresentable/rejected without editing hook declarations. The current `src/hook-declarations.ts:109-112` full-union return must converge to that invariant. |
| `whole-tree` | `PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS|collectProtectedItemUpdateFieldKeys|assertItemAddRightsForCaller|\bhooks\b` | Central daemon control-plane classification plus operator branch and focused admission tests | Zero preset-grantable or run-credential path can create, replace, patch, directly clear, or indirectly clear hooks; operator writes preserve unrelated extra/null/reserved-key semantics. |

## Canonical runtime

- Setup: run `bun install --frozen-lockfile` when dependencies are not materialized; use the repository root and existing local Bun/Git binaries.
- Start: the authorized process-level driver for this issue is `bun scripts/engine-integration.ts`. It creates a run-owned local git fixture and isolated loop-data root, then starts its own daemon. No standing service or TCP port is introduced.
- Readiness: require the driver transcript to report the isolated daemon socket ready before chain/item operations.
- Behavior: execute C1-C8 first, then C9 to prove the declaration changes preserve the real daemon/CLI/socket/spawn/admission/worktree/SQLite process path. Declaration-specific behavior is proved by C1-C5; C9 is the repository process gate and is not evidence of real-agent/GitHub business completion.
- Logs: retain the literal command, exit status, stdout/stderr transcript, and script-reported run/event paths in the VerificationPacket/PR evidence.
- Stop ownership: `scripts/engine-integration.ts` owns daemon shutdown, fixture/worktree cleanup, and orphan checks on success or failure. Do not touch the production daemon or `~/.coder-loop` runtime.
- Explicit exclusion: the repository real-E2E driver is `bun scripts/real-e2e.ts`, but the current issue body forbids it for #586. Do not run the full v3 scenario or `scripts/real-e2e.ts`; frozen-SHA integration and bundled-preset compatibility belong to #684 and #685.

## Test delta

`required`

Retain the focused declaration, persistence, daemon-admission, status-boundary, zero-spawn, null/reserved-key, and exhaustiveness coverage already introduced, and add the compile-time/runtime regression that proves observer vocabulary expansion remains automatic while `hook.*` stays excluded. Existing tests and assertions must remain intact: no deletion, rename, skip/only/todo, assertion weakening, timeout relaxation, fallback union, cast, or copied vocabulary may be used to obtain green results.

## Dependencies

- No implementation blocker. The audit-order prerequisites #535, #536, and #538 are closed: https://github.com/mouriya-s-lab/coder-loop/issues/535, https://github.com/mouriya-s-lab/coder-loop/issues/536, https://github.com/mouriya-s-lab/coder-loop/issues/538. Parent #543 remains open and supplies the inherited hook semantics: https://github.com/mouriya-s-lab/coder-loop/issues/543.
- Existing PR #672 is open, non-draft, mergeable/CLEAN, targets `main`, has no reported checks, and closes only #586 at head `0172878adc88c58f5c57a7d2d7db1b08d01f5a29`: https://github.com/mouriya-s-lab/coder-loop/pull/672.
- Latest review found one current candidate defect at `src/hook-declarations.ts:109-112`: future `hook.*` vocabulary variants leave the parsed point typed as the full `ObservabilityEventType`, violating automatic expansion/exclusion. Iteration must correct it before verification: https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4981659217.
- #555/#591 are coordination edges for preset named-gate syntax/binding; #590 must consume the same exported `GateDecisionPoint`; they are not prerequisites for this declaration foundation: https://github.com/mouriya-s-lab/coder-loop/issues/555, https://github.com/mouriya-s-lab/coder-loop/issues/591, https://github.com/mouriya-s-lab/coder-loop/issues/590.
- #588, #589, and #575 remain downstream owners for observer execution, gate execution, and hooks/status GUI projection: https://github.com/mouriya-s-lab/coder-loop/issues/588, https://github.com/mouriya-s-lab/coder-loop/issues/589, https://github.com/mouriya-s-lab/coder-loop/issues/575.
- #684 owns frozen-candidate full-chain integration and #685 alone owns the existing GitHub preset compatibility real E2E. Both are open, and neither check may be pulled into #586: https://github.com/mouriya-s-lab/coder-loop/issues/684, https://github.com/mouriya-s-lab/coder-loop/issues/685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4953812495



### comment #4983175178 by `RiriAgent` — 2026-07-15T16:53:23Z

<!-- coder-loop:executable-contract schema=1 source-issue=586 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/586
- Observed issue-body update timestamp: `2026-07-15T12:58:28Z` (`lastEditedAt`, re-read from live GitHub).
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866575474
  - https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4866578182
  - https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4983120098
- Investigated revisions: `55ff3b2b7345a8e3d975934a53997d074aa02380` (`origin/main`) and existing PR head `8611851e7ff045d5a6d5f7b667239f3a19b8e15e`, observed 2026-07-16.

## Deliverable

`implementation-pr`

Continue the existing branch `coder-loop/v3-586-6ac101ef751a` and PR https://github.com/mouriya-s-lab/coder-loop/pull/672. Deliver only the hook declaration foundation: an exhaustive typed `observer | gate` declaration ADT, strict boundary parsing, global/chain/preset-placeholder/item loading and stable merge with provenance, and one typed effective-view entry for downstream execution/projection children.

The carrier decisions remain:

1. Global declarations are one versioned JSON document at `<loop-data-root>/hooks.json`; malformed JSON, unknown fields, and invalid declarations fail loading and are never ignored.
2. Chain and item declarations are typed `hooks` carrier fields on `ChainMetadata` and `ItemExtra`. Item declarations live with the item record across actionable and terminal statuses and disappear only when the item record is deleted.
3. Preset participation is a typed `named-gate-placeholder` effective-view variant only. Parsing #555 syntax and resolving its binding remain #555/#591 work.
4. Effective order is exactly `global -> chain -> preset -> item`, retaining source-layer provenance. Observer points derive from the shared observability vocabulary with structural `hook.*` exclusion; gate points have one closed exported value/type authority shared with #590.
5. Every declaration write path is operator-only. Run credentials cannot create, replace, patch, indirectly clear, or directly clear hooks; each rejection uses the existing admission audit stream.

Do not implement hook execution, decision stdin/protocol, named-gate binding, gate scheduling, a positive hooks status section, or GUI projection. Those remain owned by #588, #589, #590/#591, and #575. Current source anchors are `src/hook-declarations.ts:8-47,56-169`, `src/runtime-data.ts:105-176,263-299,349-443`, `src/daemon.ts:233,1095-1124,3965-3980,5101-5124`, and `src/observability.ts:25-135,731-732,825-826`.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C1 | function: four-layer effective view | shell | `bun test src/hook-declarations.test.ts` in repository root; local env | Exit `0`; fixtures reach the single typed constructor and show exact `global -> chain -> preset -> item` order plus provenance. |
| C2 | function/type: strict boundary and vocabulary evolution | shell | `bun run typecheck && bun test src/hook-declarations.test.ts src/observability.test.ts` in repository root; local env | Exit `0`; unknown observer/gate points, missing gate `onFailure`, invalid tick throttle, malformed script/timeout, undeclared fields, and `hook.*` observer subscriptions are rejected by named fields. A compile-time fixture must prove that adding a synthetic non-`hook.*` event needs no hook-side synchronization while a synthetic `hook.*` event remains excluded, with no cast or copied event union. |
| C3 | function: declaration-only zero execution | shell | `bun test src/daemon.test.ts src/scheduler.integration.test.ts` in repository root; local env | Exit `0`; a valid declaration loads, ordinary scheduling reaches its existing terminal behavior, and the declared sentinel executable is never spawned. |
| C4 | security: operator-only mutation | shell | `bun test src/daemon.test.ts` in repository root; local env | Exit `0`; operator global/chain/item writes work; run-credential add, batch-add, replace, patch, direct clear, and omission-based indirect clear are denied and audited. |
| C5 | persistence/boundary: lifetime and projection separation | shell | `bun test src/runtime-data.test.ts src/daemon.test.ts` in repository root; local env | Exit `0`; global/chain/item declarations round-trip, daemon restart reloads the same effective view, terminal status retains item hooks, raw hooks remain absent from all public item/run status surfaces, unrelated explicit `null` persists, own `__proto__` is rejected, and only operator `hooks: null` clears hooks. |
| C6 | environment: complete local gate | shell | `bun run typecheck && bun test` in repository root; local env | Exit `0`; strict typecheck and the complete unit/smoke suite pass with no removed, renamed, skipped, weakened, or timeout-relaxed pre-existing test. |
| C7 | architecture: complete Pattern inventory | shell | `LC_ALL=C rg --text -n 'HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint|hooks.json|\bhooks\b|ObservabilityEventType|parseObservabilityEventType' src --glob '*.ts'` in repository root; local env | Exit `0` with no `stopped searching binary file` diagnostic; every match, including matches after embedded NUL bytes, is classified against all Pattern rows below, with no parallel declaration/event authority, execution implementation, positive hooks status projection, or agent-writable hooks path. |
| C8 | type red lines | shell | `git diff "$(git merge-base HEAD origin/main)" HEAD -- src | rg --pcre2 -n '\bany\b|:\s*unknown\b|\bas\s+(?!const\b)'` in repository root after `git fetch origin main`; local env | Exit `1` with no matches; changed production code adds no `any`, non-boundary `unknown`, or type assertion other than `as const`. The comparison is pinned to the PR merge base, not a moving two-dot `origin/main` diff. |
| C9 | process integration: existing engine behavior | shell | `bun scripts/engine-integration.ts` in repository root; local env with Bun and Git on `PATH`; script-owned isolated loop-data | Exit `0`; transcript shows isolated daemon socket readiness, real CLI/socket/spawn/admission/worktree/SQLite progression, terminal item, reclaimed worktree, no orphan, and teardown. This is the strongest process-level runtime check authorized for #586 and must not be described as real E2E. |

No browser row applies: this is a pure engine/CLI change and browser evidence is not required.

## Pattern scope

| Type | Pattern/query | Allowed sites | Expected convergence |
|---|---|---|---|
| `changed` | `HookDeclaration|EffectiveHook|GateDecisionPoint|ObserverHookPoint` | One hook-declaration authority, its compile-time/focused tests, and typed imports at persistence/daemon integration boundaries | Exactly one declaration ADT, strict parser, gate-point authority, exhaustive conversion path, and effective-view constructor. No copied union, catch-all/default, cast, or second merge path. |
| `changed` | `hooks.json|\bhooks\b` | `src/runtime-paths.ts`, hook declaration loader, typed chain/item persistence, daemon load/effective-view/admission wiring, status omission boundary, and focused tests | Raw inputs parse once and merge once; persistence remains distinct from public status output. No hook execution or positive `StatusSnapshotBoundary`/GUI projection is introduced. |
| `whole-tree` | `LC_ALL=C rg --text -n 'ObservabilityEventType|parseObservabilityEventType|ObserverHookPoint|hook\.' src --glob '*.ts'` | `src/observability.ts` as the sole event vocabulary/parser authority; hook declaration code may derive and structurally narrow its observer point type; focused compile/runtime tests; comments containing the ordinary English word “hook” are classified but do not create declaration authority | Exit `0` with no binary-file diagnostic and every text match classified, including content after embedded NUL bytes. Zero copied event literal union. A new non-`hook.*` observability event automatically becomes an observer point; a new `hook.*` event automatically remains unrepresentable/rejected without editing hook declarations. |
| `whole-tree` | `PRESET_PHASE_RIGHTS_CONTROL_PLANE_FIELDS|collectProtectedItemUpdateFieldKeys|assertItemAddRightsForCaller|\bhooks\b` | Central daemon control-plane classification plus operator branch and focused admission tests | Zero preset-grantable or run-credential path can create, replace, patch, directly clear, or indirectly clear hooks; operator writes preserve unrelated extra/null/reserved-key semantics. |

## Canonical runtime

- Setup: run `bun install --frozen-lockfile` when dependencies are not materialized; use the repository root and existing local Bun/Git binaries.
- Start: the authorized process-level driver for this issue is `bun scripts/engine-integration.ts`. It creates a run-owned local git fixture and isolated loop-data root, then starts its own daemon. No standing service or TCP port is introduced.
- Readiness: require the driver transcript to report the isolated daemon socket ready before chain/item operations.
- Behavior: execute C1-C8 first, then C9 to prove the declaration changes preserve the real daemon/CLI/socket/spawn/admission/worktree/SQLite process path. Declaration-specific behavior is proved by C1-C5; C9 is the repository process gate and is not evidence of real-agent/GitHub business completion.
- Logs: retain the literal command, exit status, stdout/stderr transcript, and script-reported run/event paths in the VerificationPacket/PR evidence.
- Stop ownership: `scripts/engine-integration.ts` owns daemon shutdown, fixture/worktree cleanup, and orphan checks on success or failure. Do not touch the production daemon or `~/.coder-loop` runtime.
- Explicit exclusion: the repository real-E2E driver is `bun scripts/real-e2e.ts`, but the current issue body forbids it for #586. Do not run the full v3 scenario or `scripts/real-e2e.ts`; frozen-SHA integration and bundled-preset compatibility belong to #684 and #685.

## Test delta

`required`

Retain the focused declaration, persistence, daemon-admission, status-boundary, zero-spawn, null/reserved-key, and exhaustiveness coverage already introduced, and add the compile-time/runtime regression that proves observer vocabulary expansion remains automatic while `hook.*` stays excluded. Existing tests and assertions must remain intact: no deletion, rename, skip/only/todo, assertion weakening, timeout relaxation, fallback union, cast, or copied vocabulary may be used to obtain green results.

## Dependencies

- No implementation blocker. The audit-order prerequisites #535, #536, and #538 are closed: https://github.com/mouriya-s-lab/coder-loop/issues/535, https://github.com/mouriya-s-lab/coder-loop/issues/536, https://github.com/mouriya-s-lab/coder-loop/issues/538. Parent #543 remains open and supplies the inherited hook semantics: https://github.com/mouriya-s-lab/coder-loop/issues/543.
- Existing PR #672 is open, non-draft, mergeable/CLEAN, targets `main`, has no reported checks, and closes only #586 at head `8611851e7ff045d5a6d5f7b667239f3a19b8e15e`: https://github.com/mouriya-s-lab/coder-loop/pull/672.
- The contract-defect review proved that the prior whole-tree query stopped at NUL bytes in `src/scheduler.test.ts`. The text-mode C7 and Pattern commands above are the executable replacement. The same review identified two separate implementation findings still owned by iteration: operator whole-carrier replacement must preserve existing hooks unless `hooks: null` is explicit, and the unused parallel `HookSourceLayer` vocabulary must be removed or made the single derived authority: https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4983120098.
- The replacement VerificationPacket must also label the measured base revision accurately (the prior base suite measured `55ff3b2b7345a8e3d975934a53997d074aa02380`, not merge-base `07dad882ded934766f51e53a5e0a04605a18c697`) and explicitly map the setup artifact. These are evidence corrections, not new implementation scope: https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4983120098.
- #555/#591 are coordination edges for preset named-gate syntax/binding; #590 must consume the same exported `GateDecisionPoint`; they are not prerequisites for this declaration foundation: https://github.com/mouriya-s-lab/coder-loop/issues/555, https://github.com/mouriya-s-lab/coder-loop/issues/591, https://github.com/mouriya-s-lab/coder-loop/issues/590.
- #588, #589, and #575 remain downstream owners for observer execution, gate execution, and hooks/status GUI projection: https://github.com/mouriya-s-lab/coder-loop/issues/588, https://github.com/mouriya-s-lab/coder-loop/issues/589, https://github.com/mouriya-s-lab/coder-loop/issues/575.
- #684 owns frozen-candidate full-chain integration and #685 alone owns the existing GitHub preset compatibility real E2E. Both are open, and neither check may be pulled into #586: https://github.com/mouriya-s-lab/coder-loop/issues/684, https://github.com/mouriya-s-lab/coder-loop/issues/685.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/586#issuecomment-4981760712



### comment #4984244372 by `RiriAgent` — 2026-07-15T18:56:40Z

## Coder-loop closure (run-1784141673560-27-closure-item-6)

Accepted: merged https://github.com/mouriya-s-lab/coder-loop/pull/672 at squash commit `b2b92952d464f135109242f8cf5bdb9dae3397e3`; consumed verdict https://github.com/mouriya-s-lab/coder-loop/pull/672#issuecomment-4984212736.


---

## Timeline (41)

- 2026-07-02T12:02:40Z `assigned` @RiriAgent
- 2026-07-02T14:00:51Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-02T14:00:53Z `cross-referenced` @RiriAgentsrc=588
- 2026-07-02T14:00:54Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T14:00:57Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-02T14:00:59Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:15Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:29Z `commented` @RiriAgent
- 2026-07-02T14:01:45Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-05T07:48:27Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-10T11:19:06Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-12T00:09:03Z `cross-referenced` @RiriAgentsrc=656
- 2026-07-13T02:11:37Z `commented` @RiriAgent
- 2026-07-13T03:28:26Z `referenced` @RiriAgentcommit=c0be249f653df6b883fa4e59d02215beef4eab9a
- 2026-07-13T03:29:27Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-13T04:03:15Z `referenced` @RiriAgentcommit=24365a19ce45ac8d4bce73620ba4f5da58c48ee2
- 2026-07-13T05:12:28Z `referenced` @RiriAgentcommit=95d604ba07bf8352dd1a19527a73262b9219743a
- 2026-07-13T05:51:25Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-13T08:12:25Z `referenced` @RiriAgentcommit=16511ff5e05f44badaca715b593f4cd8ce5b02d7
- 2026-07-13T08:12:25Z `referenced` @RiriAgentcommit=45787d3ab45e21151159fc4981a0fc526406aeaa
- 2026-07-13T08:12:26Z `referenced` @RiriAgentcommit=288a77ec1e17d8a8b871ba0f790de5056b61b610
- 2026-07-13T08:12:26Z `referenced` @RiriAgentcommit=79e9d4c99baea4d2eeedd7203b259b70227e8728
- 2026-07-13T10:29:28Z `referenced` @RiriAgentcommit=e25885122eaab93335a252291c3dc33b3fe8a9b5
- 2026-07-13T11:46:39Z `referenced` @RiriAgentcommit=0708c81c14fe66a3eae37cc470db2015e14e3f93
- 2026-07-15T06:20:38Z `referenced` @RiriAgentcommit=0172878adc88c58f5c57a7d2d7db1b08d01f5a29
- 2026-07-15T14:32:00Z `commented` @RiriAgent
- 2026-07-15T15:31:06Z `referenced` @RiriAgentcommit=8611851e7ff045d5a6d5f7b667239f3a19b8e15e
- 2026-07-15T16:53:23Z `commented` @RiriAgent
- 2026-07-15T17:20:45Z `referenced` @RiriAgentcommit=803c825a1949027c97846b8afa627a9fca356029
- 2026-07-15T18:05:32Z `referenced` @RiriAgentcommit=fa451b65e9bc326e09c4694a4dc4cbce52b7cd6b
- 2026-07-15T18:56:19Z `referenced` @RiriAgentcommit=b2b92952d464f135109242f8cf5bdb9dae3397e3
- 2026-07-15T18:56:20Z `closed` @RiriAgentcommit=None
- 2026-07-15T18:56:40Z `commented` @RiriAgent
- 2026-07-16T23:38:35Z `referenced` @RiriAgentcommit=05ee53cc42027da2343ce5f24c5a0103e919fdb8
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:19Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:24Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:36:38Z `cross-referenced` @RiriAgentsrc=719
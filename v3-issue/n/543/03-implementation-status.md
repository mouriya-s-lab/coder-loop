# RFC #543 当前实现状态调查

调查基线是 `main` 的 `699842e`（`feat(scheduler): 任务闭包资源生命周期——起点、挂起/重开/消费与启动状态对账 (#749)`）。本次只读调查完整阅读了 `01-clauses.md` 与 `aggregation.md`，并检查 `src/`、`tests/`、必要的 `scripts/`、`presets/` 及 git 历史；按要求未运行测试。判定口径是：条款的全部运行时语义都存在才算“已实现”；只落了声明、类型或上游基础能力算“部分实现”；不存在该条款要求的生产消费路径算“未实现”。

总体结论：**A–M 没有任何一个域整体完成**。域 A/D 已落声明骨架；B/C/F/I/J/K 只有声明、既有 CLI、闭包/指纹或 task-join 等局部基础；E/G/H/L/M 对本 RFC 要求的 hook 事件、执行、gate 协议、script join/reopen 与收尾验收仍是空白。当前落地集中在 #586 的声明基础（observer 事件词表结构减法、hook ADT、gate point 声明闭集、四层生效视图骨架、tick 声明校验、operator-only 持久化语义）以及 #749 的闭包生命周期/部分 `closure.*` 统一事件；真正的 hook 进程执行、stdin payload、`hook.*` 事件、gate decision 协议、通用指纹/评估 journal、具名 gate 绑定、script join/reopen 和综合验收均未接线。最强反证是生产代码中 `buildEffectiveHookView` 只有 `effectiveHookViewForItem` 这一条组装路径，而该方法没有生产调用者；现有集成测试还明确断言声明在调度中不执行（`tests/integration/daemon/hooks.integration.ts:5-5,45-48`）。

有一处需要显著更新聚合视图：`aggregation.md` 把“闭包转移边事件入词表”列为 RFC-1 外部待供给能力，但当前 HEAD 的 #749 已在 `ObservabilityEventTypeBoundary` 加入五种 `closure.*` 类型（`src/observability.ts:33-37`）。不过它们不是 A4 所列 create/run-spawn/run-exit/suspend/reopen/consume 六条边的一一对应事件，因此是**依赖部分就绪**，不是 A4 已完成。

## A. 两类 hook 模型

本域执行面检索：`rg -n 'buildEffectiveHookView\(|effectiveHookViewForItem\(' src tests` 只命中组装函数、daemon 暴露方法及测试；`rg -n 'executeHook|spawnHook|dispatchObserver|evaluateGate' src tests scripts` 为 0 命中。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| A1 | 部分实现 | `src/hook-declarations.ts:29-34`; `tests/integration/daemon/hooks.integration.ts:45-48` | observer 的订阅声明 shape 已存在，但集成测试明确确认声明脚本不会执行，异步旁路和失败 diagnostic 尚无实现。 |
| A2 | 已实现 | `src/hook-declarations.ts:8-13`; `tests/unit/daemon/hook-declarations.exhaustiveness.ts:14-18` | `ObserverHookPointOf` 直接对事件 union 做 `Exclude<..., \`hook.${string}\`>`，类型测试证明未来普通事件自动进入、未来 `hook.*` 自动排除。 |
| A3 | 部分实现 | `src/hook-declarations.ts:112-116`; `src/daemon.ts:2285-2294` | 装载期已拒绝 `hook.*`，但事件写入函数只持久化/渲染事件，没有 observer 派发层，故发射期“零派发”尚未成为可执行的双层防护。 |
| A4 | 部分实现 | `src/observability.ts:33-37`; `src/scheduler.ts:243-247`; `src/scheduler.ts:1638-1639,1766-1773,2147-2150` | #749 已加入并发射 `closure.resource_prepared/lifecycle_changed/consumed/git_failed/reconciled`，但没有按条款完整表达六条转移边，observer 执行也未落地。 |
| A5 | 部分实现 | `src/hook-declarations.ts:36-45`; `tests/integration/daemon/hooks.integration.ts:18-18,45-48` | gate 声明含 script/timeout/onFailure，但调度仍完全不执行脚本，也没有 hold 宿主决策点。 |
| A6 | 部分实现 | `src/hook-declarations.ts:15-27` | 八个 gate point 已形成单一常量/type 闭集，但它们仅用于声明 parse，未接入相应调度决策点。 |
| A7 | 部分实现 | `src/hook-declarations.ts:15-24`; `src/observability.ts:33-37` | closure 名称没有进入 gate point 闭集且 closure 事件独立存在，满足声明层 observer-only 边界；post-exit hold 阻止挂起的运行时路径不存在。 |

## B. 执行模型与 decision 协议

本域未实现检索：`rg -n 'GateDecisionBoundary|correctionItemIds|decision_not_allowed_at_point|evaluationScope|evaluation_scope|gate_held|starting-held|shutdown-held' src tests scripts` 为 0 命中；`"advance"|"hold"|"reopen"` 在 hook 代码中只出现在声明的 `onFailure`，不存在 decision ADT。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| B1 | 部分实现 | `src/hook-declarations.ts:29-45`; `tests/integration/daemon/hooks.integration.ts:5-5,48-48` | 任意 script 路径与 timeout 已可声明，但没有 hook spawn、stdin 元数据或 gate stdout 解析。 |
| B2 | 未实现 | 域检索（0 命中） | 没有 `advance \| hold \| reopen` decision wire ADT 或 point×decision 合法性消费路径。 |
| B3 | 未实现 | 域检索（0 命中） | 没有 evaluation-scoped correction 创建或 `correctionItemIds` 引用协议。 |
| B4 | 未实现 | 域检索（0 命中） | 没有 reopen consumer，更没有认领 corrections、重开与 decision consumed 的事务。 |
| B5 | 部分实现 | `src/hook-declarations.ts:36-45,66-80,118-129` | timeout 与 `onFailure = hold \| advance` 已做声明边界校验，但没有超时/崩溃执行处置。 |
| B6 | 部分实现 | `src/scheduler.ts:2752-2757,2793-2816,2819-2857` | chain-complete 已有 canonical fingerprint、keep-active 命中吸收和持久化先例，但尚未泛化给 hook gate。 |

## C. 能力契约

本域检索 `rg -n 'evaluationScope|evaluation_scope|correctionItemIds' src tests scripts` 为 0 命中；现有 CLI/socket mutation 面则可见于下列锚点。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| C1 | 部分实现 | `src/loop.ts:1704-1750`; `src/daemon.ts:1725-1766,2887-2937` | `coder-loop item add` 已经走 daemon socket 与既有 admission/audit，但 hook 子进程尚不存在，故“hook 以内 operator 身份调用”未连通。 |
| C2 | 未实现 | 域检索（0 命中） | 没有 evaluation identity、post-run hold 或检查/修复 subtree 与被扣决策点的稳定关联。 |

## D. 声明位与合成语义

多 reopen 检索 `rg -n 'correctionItemIds|conflict.*target|reopen.*union|reopen.*dedup' src tests scripts` 为 0 命中；具名绑定只命中 placeholder type 和测试 fixture。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| D1 | 部分实现 | `src/hook-declarations.ts:49-58,138-144`; `src/daemon.ts:1215-1232,1239-1244`; `src/runtime-data.ts:107-137,159-176` | global/chain/preset/item 四层 shape 与顺序视图已存在，global/chain/item 可持久化；preset 仅是调用参数中的 placeholder，未由 preset compiler 生产。 |
| D2 | 部分实现 | `src/hook-declarations.ts:138-144`; `tests/unit/daemon/hook-declarations.test.ts:11-20` | 声明视图顺序已固定为 global→chain→preset→item，但 gate 未执行，AND、hold/reopen 优先级均不存在。 |
| D3 | 未实现 | 域检索（0 命中） | 没有 reopen decision，更没有同 target 去重或异 target 合成 hold 的逻辑。 |
| D4 | 部分实现 | `src/hook-declarations.ts:48-53`; `src/loop.ts:508-518` | `named-gate-placeholder` shape 已有，但 `PresetTomlBoundary` 没有具名 gate DSL，global/chain binding 也不存在。 |

## E. 可观测性

本域关键检索：`rg -n 'arkType\.unit\("hook\.|type: arkType\.unit\("hook\.' src/observability.ts` 为 0 命中；`rg -n 'hook\.start|hook\.end|hook\.failed|hook\.decision' src tests scripts` 为 0 命中。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| E1 | 未实现 | `src/observability.ts:25-80` | canonical 事件词表没有任何 `hook.*` 类型。 |
| E2 | 未实现 | `src/loop.ts:936-945`; `src/runtime-data.ts:438-443`; `tests/integration/daemon/hooks.integration.ts:117-128` | status snapshot 没有 `hooks` 节，且现有投影主动删除 item/run 的 hooks。 |
| E3 | 未实现 | 本域检索（0 命中） | 没有 observer failure diagnostic schema 或失败原因分类。 |
| E4 | 未实现 | 本域检索（0 命中） | 没有 gate decision/协议违规/超时/崩溃事件。 |
| E5 | 未实现 | 本域检索（0 命中） | 没有 gate hold 重问、evaluation key 命中、状态机转移或恢复事件；现有 chain-complete fingerprint 先例不提供这些 hook 事件。 |

## F. hook stdin payload 契约

本域检索 `rg -n 'HookPayload|hookPayload|buildHook|payloadVersion|evaluationScope|effectiveHook.*status' src tests scripts` 为 0 命中；因此不存在可导出的 hook payload boundary/assembler。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| F1 | 未实现 | 本域检索（0 命中） | 没有 observer/gate 共用的 typed payload 或唯一组装函数。 |
| F2 | 未实现 | `src/loop.ts:520-529` | 当前 status 顶层多数仍是匿名 `"object"`，且没有从 compile/status/event boundary 派生的 payload shape。 |
| F3 | 未实现 | `src/loop.ts:533-583` | 已有编译投影 boundary，但没有 hook payload，更没有从运行实例 pinned definition 解引用投影。 |
| F4 | 未实现 | `src/loop.ts:520-529` | 没有选择性 status 投影适配层，无法兑现匿名槽不透传。 |
| F5 | 未实现 | 本域检索（0 命中） | 没有 payload 版本字段。 |
| F6 | 未实现 | 本域检索（0 命中） | 没有可导出的 hook payload schema。 |
| F7 | 部分实现 | `src/task-runtime.ts:13-26,45-53`; `src/loop.ts:936-945,3173-3175` | status 的 `taskTree` 已携带 lifecycle/worktree/branch/base commit/sessions，par 节点另有 `pinCommit`；但没有把这些事实派生投影进 hook payload。 |
| F8 | 未实现 | 本域检索（0 命中） | hook payload 尚不存在，不能把“未注入 GitHub 字段”视为已实现的 payload 契约。 |

## G. observer 执行

本域检索 `rg -n 'executeHook|spawnHook|dispatchObserver|HookPayload|hook\.start|hook\.failed' src tests scripts` 为 0 命中；现有 `Bun.spawnSync` 命中均为既有非 hook 路径（`src/sqlite-state.ts:1189`、`src/loop.ts:3678,4349,4357`、`src/daemon.ts:4914`）。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| G1 | 未实现 | `tests/integration/daemon/hooks.integration.ts:5-5,45-48` | 当前真实调度明确不 spawn observer，fire-and-forget 不存在。 |
| G2 | 未实现 | 本域检索（0 命中） | 没有 payload 写 stdin 的路径。 |
| G3 | 未实现 | `src/hook-declarations.ts:29-34` | timeout 只是声明字段，没有 hook 子进程组回收或 observer-only diagnostic。 |
| G4 | 未实现 | 本域检索（0 命中） | observer/gate 共同进程执行层不存在。 |
| G5 | 未实现 | 本域检索（0 命中） | 虽然没有新增 hook `spawnSync`，但异步 hook spawn/stdin/回收本身也没有实现。 |
| G6 | 部分实现 | `src/hook-declarations.ts:8-13,29-34` | observer 的声明 point 直接使用事件 union 的结构减法，没有平行挂点映射；实际事件派发 matcher 尚不存在。 |

## H. gate 决策协议（单点语义）

本域检索 `rg -n 'GateDecisionBoundary|decision_not_allowed_at_point|correctionItemIds|evaluateGate|gate_held' src tests scripts` 为 0 命中。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| H1 | 未实现 | 本域检索（0 命中） | 没有逐层逐个 gate 执行或 AND 合成，也没有 point-specific decision 子集。 |
| H2 | 未实现 | 本域检索（0 命中） | 没有 stdout arktype decision boundary、非法输出分类或 onFailure 消费。 |
| H3 | 未实现 | 本域检索（0 命中） | 没有 per-chain hold/backoff/re-evaluate 运行路径。 |
| H4 | 未实现 | 本域检索（0 命中） | 没有 `decision_not_allowed_at_point` 边界或 container-only binding 校验。 |
| H5 | 未实现 | 本域检索（0 命中） | parse/consumer 两侧共享的 decision ADT 尚不存在。 |

## I. 决策点闭集接线与指纹泛化

本域检索 `rg -n 'gate_held|starting-held|shutdown-held|FingerprintInput|effective.*declaration.*hash' src tests scripts` 为 0 命中；`minIntervalMs` 仅命中声明 parser 与单元测试。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| I1 | 部分实现 | `src/hook-declarations.ts:15-27` | point 名称闭集已物化，但没有任何 point 接到统一 gate evaluator。 |
| I2 | 部分实现 | `src/hook-declarations.ts:15-27,66-80` | 声明校验共享同一 tuple/type；payload、事件字段、评估接线尚无相应 exhaustive consumer。 |
| I3 | 部分实现 | `src/hook-declarations.ts:43-45,73-80,118-127`; `tests/unit/daemon/hook-declarations.test.ts:34-45,53-58` | tick 的正整数 `minIntervalMs` 无默认并在装载期拒绝非法值；每声明独立节流时钟和 evaluation epoch 未实现。 |
| I4 | 部分实现 | `src/scheduler.ts:2752-2757,2793-2816` | chain-complete keep-active 有“同 fingerprint 不重问、状态变化再问”的先例，仍是专用形态，未收编为通用 gate 机制。 |
| I5 | 部分实现 | `src/scheduler.ts:2819-2861`; `src/runtime-data.ts:81-95` | 先例使用 canonical JSON SHA-256 并剔除自身状态，但它 hash 的是 chain completion 全量投影，且结果存入 `chain.metadata`，不满足 per-point typed input/store 条款。 |
| I6 | 未实现 | 本域检索（0 命中） | item status RPC 没有 hook gate 或结构化 `gate_held` 返回。 |
| I7 | 未实现 | 本域检索（0 命中） | daemon 没有 `starting-held`/`shutdown-held` 状态，tick 也没有 hook hold 行为。 |
| I8 | 未实现 | 本域检索（0 命中） | 没有 daemon-host payload envelope。 |
| I9 | 部分实现 | `src/hook-declarations.ts:138-144` | 四层声明顺序由一个 helper 保证，但全部决策点的 AND 放行不存在。 |

## J. 评估代次、幂等与恢复

本域检索 `rg -n 'evaluationScope|evaluation_scope|idempotency.*response|GateEvaluation|gate.*epoch|decision.*journal|correctionItemIds' src tests scripts` 为 0 命中。SQLite 的 `journal_mode` 是数据库 WAL 配置，不是本条款的 decision journal。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| J1 | 部分实现 | `src/task-runtime.ts:34-38`; `src/sqlite-state.ts:718-724,2430-2433` | RFC-1 task join 已有 `evaluating/decided/consumed` 持久化 shape，但没有 gate point identity、spawn write-ahead、decision/effect 原子消费或 epoch 递增实现。 |
| J2 | 未实现 | 本域检索（0 命中） | 没有 evaluation scope env、规范化 mutation key 或首次 response 回放。 |
| J3 | 未实现 | 本域检索（0 命中） | 没有 gate decision ingress/journal/consumer 或 decided/evaluating 重启恢复。 |
| J4 | 未实现 | 本域检索（0 命中） | 没有 gate epoch 与 hold fingerprint 正交状态。 |
| J5 | 未实现 | `src/daemon.ts:2920-2935` | `item.created` 目前只携带 operator 或 agent/run 身份，没有 evaluation scope 审计字段。 |
| J6 | 未实现 | 本域检索（0 命中） | 普通 operator 路径仍维持既有语义，但尚不存在需与其隔离的 evaluation-scope 幂等分支。 |
| J7 | 未实现 | 本域检索（0 命中） | 没有 script/validator typed ingress seam，也没有统一 gate journal/consumer。 |

## K. preset 具名 gate 绑定

本域检索 `rg -n 'gateBinding|gateBindings|required.*named-gate|optional.*named-gate|shadowed.*binding|selected.*binding' src tests scripts presets` 为 0 命中；`named-gate-placeholder` 只命中 type 和测试 fixture。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| K1 | 部分实现 | `src/hook-declarations.ts:48-58`; `tests/unit/daemon/hook-declarations.test.ts:11-20` | preset placeholder 能占据生效视图的 preset 顺序位，但 global/chain 的 name→script binding boundary 不存在。 |
| K2 | 未实现 | 本域检索（0 命中） | 没有 bound/optional-unbound/required-unbound 三态解析、创建拒绝或恢复 hold。 |
| K3 | 未实现 | `src/loop.ts:508-518` | preset compiler 目前根本没有 named gate DSL，故不能把“未绑定不在 compile 报错”当作已实现的实例解析规则。 |
| K4 | 未实现 | 本域检索（0 命中） | 没有 chain-over-global binding 遮蔽、selected/shadowed 视图或与普通 hooks 的角色分离。 |
| K5 | 部分实现 | `src/loop.ts:508-518`; `src/hook-declarations.ts:48-48` | 当前 preset schema 确实没有本机 hook script 路径，placeholder shape 也只含 name/point；但可分发的 named-gate DSL 尚未实现。 |

## L. join script 判定器与 reopen

本域检索 `rg -n 'join_kind.*script|kind: "script"|join.*script|correctionItemIds|decision_not_allowed_at_point' src tests scripts` 为 0 命中。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| L1 | 未实现 | `src/task-runtime.ts:28-38`; `src/sqlite-state.ts:703-724` | 当前 join 只有 `drain \| validator`，没有 additive `script` variant 或 script spawn。 |
| L2 | 未实现 | 本域检索（0 命中） | validator 与 script 尚未共享 `advance/hold/reopen` ADT 或派发路径。 |
| L3 | 未实现 | `src/sqlite-state.ts:298-303`; `tests/unit/runtime/closure-lifecycle.test.ts:37-47` | 只有 `decided-reopen` reachability seed 基础 shape，测试还明确其“without producer APIs”；没有 target 校验、correction 认领、游标回退消费通道。 |
| L4 | 未实现 | `src/scheduler.ts:310-315,2752-2780` | chain-complete 仍走专用 `complete \| keep-active` trigger，不是可绑定 script 的顶层 join。 |
| L5 | 未实现 | 本域检索（0 命中） | script 判定器与 hook payload都不存在；当前引擎没有 mergedness 字段不能替代该条款的完整通道。 |

## M. 收尾：综合验收、文档与守护

本域检索 `rg -n 'hook 作者|hook author|payload schema|评估代次|evaluation scope|具名 gate' docs presets tests src` 为 0 命中；hook 测试仅覆盖声明基础及“零执行副作用”。

| 条款 ID | 判定 | 代码锚点 | 证据一句话 |
|---|---|---|---|
| M1 | 未实现 | `tests/integration/daemon/hooks.integration.ts:5-5,45-48` | 当前集成测试证明 hook 不执行，因而不存在轮数→检查→修复→advance 的端到端链。 |
| M2 | 未实现 | 本域检索（0 命中） | 没有 hook 作者文档、payload schema 文档或枚举派生守护。 |
| M3 | 未实现 | 本域检索（0 命中） | 没有针对 gate 策略业务字面量的全局守护测试。 |
| M4 | 未实现 | 本域检索（0 命中） | 没有 RFC 8 行到交付证据的关闭映射登记。 |
| M5 | 未实现 | `src/scheduler.ts:2147-2150`; `src/hook-declarations.ts:16-17` | closure 在 phase-left 时会真实 suspend，且 post-exit point 已声明；但没有 post-exit gate 可在该转移前 hold，故无法完成该验证。 |

## 三个专项疑点

### a. observer 挂点是否仍是 full-union 返回

**结论：已修复，不再是 full-union。** `ObserverHookPointOf<EventType>` 在 `src/hook-declarations.ts:8-9` 使用 `Exclude<EventType, \`hook.${string}\`>` 从 `ObservabilityEventType` 结构派生减法；运行时 narrowing 在 `src/hook-declarations.ts:11-13` 同样排除 `hook.` 前缀。`tests/unit/daemon/hook-declarations.exhaustiveness.ts:14-18` 构造未来 `future.lifecycle | hook.future`，编译期证明前者进入、后者排除；`tests/unit/daemon/hook-declarations.test.ts:48-51` 还有运行时对应断言。因此未来 `hook.*` variant 不会泄进 `ObserverHookPoint`。

### b. 是否存在未被消费的平行 `HookSourceLayer` 词表

**结论：finding 所指问题已修复；符号名仍存在，但不是平行词表，也不是未消费。** `HookSourceLayer` 在 `src/hook-declarations.ts:49-55` 定义为 `keyof HookLayers`，没有另写 `"global" | "chain" | ...`；它随 `HookLayers` 键结构派生。随后 `src/hook-declarations.ts:56-58` 直接以该类型映射 `EffectiveHook` 的 source/declaration 对应关系，所以它被消费。全仓 `rg -n 'HookSourceLayer|HookLayers' src tests` 只命中这组定义/消费，没有第二份 source-layer 枚举。

### c. operator whole-carrier replacement 是否会静默清除 hooks

**结论：已修复；省略 `hooks` 会保留，只有显式 `hooks: null` 清除。** `replaceItemExtra` 在 `src/daemon.ts:5273-5281` 对 replacement 有 `hooks` 时只把 `null` 解释为删除；replacement 省略时从 existing 复制原 hooks。`mergeItemExtraPatch` 在 `src/daemon.ts:5284-5287` 同样只对显式 null 删除。集成覆盖位于 `tests/integration/daemon/admission.integration.ts:1843-1859`：先写 hook，whole-carrier replacement 省略 hooks 后仍保留，随后 `extra.hooks: null` 与 `extraPatch.hooks: null` 才清除。agent 试图通过省略 whole-carrier 间接清除还会被保护字段检测成 hooks 写入（`src/daemon.ts:5253-5270`）。

## 附加调查

### 1. `ObservabilityEventTypeBoundary` 是否已有 `hook.*`

**没有。** `src/observability.ts:25-80` 的 canonical event type boundary 没有任何 `hook.*`；针对性检索 `rg -n 'arkType\.unit\("hook\.|type: arkType\.unit\("hook\.' src/observability.ts` 为 0 命中。因此 E1 以及 A3 的发射期自反防护依赖尚未就绪。

### 2. `closure.*` 转移边事件是否已进词表

**已有部分 `closure.*` 事件进入词表，但尚未按 A4 的六条边完整建模。** 当前 boundary 在 `src/observability.ts:33-37` 包含：

- `closure.resource_prepared`
- `closure.lifecycle_changed`
- `closure.consumed`
- `closure.git_failed`
- `closure.reconciled`

对应精确 payload boundary 在 `src/observability.ts:355-383`，scheduler union 在 `src/scheduler.ts:241-247`，真实发射点包括 resource prepare（`src/scheduler.ts:1638-1639`）、suspend/activate（`src/scheduler.ts:1766-1773,2147-2150`）和 consume（`src/scheduler.ts:1520-1523`），daemon 统一转换在 `src/daemon.ts:827-878`。这证明 #749 之后 aggregation 的“完全外部待供给”描述已过时；但 create/run-spawn/run-exit/suspend/reopen/consume 没有六个独立 event type，尤其没有显式 create、run-spawn、run-exit、reopen 类型，所以 A4/F7 只能判部分就绪。

### 3. chain-complete trigger fingerprint 先例位置

先例的核心路径是：

- 决策 ADT 仍为专用 `complete | keep-active`：`src/scheduler.ts:303-315`。
- 每次 chain completion 候选先计算 fingerprint，并在相同 keep-active fingerprint 时直接不重问：`src/scheduler.ts:2752-2757`、`src/scheduler.ts:2793-2796`。
- keep-active 后把 decision/fingerprint/recordedAt/reason/runId 持久化到 chain metadata：`src/scheduler.ts:2798-2816`，carrier shape 在 `src/runtime-data.ts:81-95,203-209`。
- fingerprint 输入由 chain、terminal statuses、items 的 canonical 投影组成，先稳定 JSON 序列化再 SHA-256：`src/scheduler.ts:2819-2857`；自身 `coderLoopChainCompleteTrigger` 状态在 hash 前剔除，避免自扰：`src/scheduler.ts:2860-2861`。

这正是 B6/I4 要收编的 keep-active 防抖先例，但它目前仍是 chain-complete 专用代码，且把状态写入 `chain.metadata`，不满足 I5 要求的通用 per-point evaluation store。

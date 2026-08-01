# R7-06 · Binding create/update admission 与 render 失败时点

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 调查边界：只回答 R7-06；不裁决、不估规模、不写实施方案。  
> 设计锚点：`AGGREGATE-547.md` §2 D、§2.3、P-D2-2/3。  
> 总账输入：`D-08,D-09,A-07,J-04,T-03`。

## A. 主 agent 摘要

### A1. 问题

稳定设计要求：绑定失败在值最早可决定的阶段被拒；缺值不得静默变成 `""`；如果只能在 render 判定，异常须点名 binding key 与来源。R7-06 要查清的不只是 resolver 反例，而是 chain create、item add/batch/update、SQLite、migration/restart 与 scheduler spawn 的完整时间线。

### A2. 结论与置信边界

**P-D2-2、P-D2-3、D-08、D-09 均不符合。结论对本仓生产入口与本次隔离实验为高置信。**

1. chain create 只验证通用 metadata JSON；它不依据 preset 声明检查 binding required/type/default。
2. item add/batch add 虽加载 preset 来取得 rights、初始 status、`idField`，但不消费 `[item.fields].type`，缺字段与错类型都可落库。
3. item update 的 `extra` replacement / `extraPatch` 只走通用 JSON、size/depth、rights 和少数历史专用字段检查；任意 preset field 不按声明类型复验。
4. batch 的数据库写是单个 SQLite `IMMEDIATE` transaction；这保证通用写失败时整批回滚，却对 binding schema 错误表现为**整批原子地接受**，不是按 typed admission 整批拒绝。
5. missing item/chain 值在 render resolver 被显式转换为 `""`；object/array 才抛普通 `Error`，且消息只有 source label，没有 phase binding key。
6. object/array render 错误发生在 worktree/closure、run、current-run 与 item attempt 准备写之后。catch 会关闭失败 run、清 current run、恢复 item status/statusUpdatedAt/phase，保留已增加的 attempts/lastRunId/agentCwd 等准备痕迹，并写 scheduler backoff + `schedulerSpawnError`，发 `spawn.aborted`；后续按 backoff 重试。真实 runner 尚未 spawn。
7. migration 与 row decode 只保护 generic JSON/identity，不加载 preset 重验 field schema；隔离 DB close/reopen 后错类型值原样可读。因此 restart/recovery 不是补验入口。

### A3. 复杂因果

这不是单一漏掉 validator：

- 声明侧保存了 `[item.fields].type`，生产 create/update 不消费它；
- chain bindings 本身只有开放 generic JSON boundary，没有与所选定义关联的 required/type schema；
- persistence 保真地保存 JsonValue，因而结构值合法落盘；
- renderer 的目标类型固定为 string，把 missing 定义为空串，却拒绝 object/array；
- admission 与 render 不在同一事务，render 又位于 spawn 资源准备写之后；
- scheduler 将确定性的 schema/render 错误归入通用可重试 preparation failure。

于是同一坏值在 create/update 时是成功，在 status/restart 时仍是合法数据，到 spawn 时才成为带资源副作用的可重试失败。

### A4. 影响分类

- **当前影响**：缺值会让 agent 收到空占位符继续运行；结构值会生成失败 run、backoff 与重复重试，且错误不能直接归因到具体 binding key。
- **未来影响**：新增 typed producer、GUI/hook 或更多结构值后，generic JSON 可写面会继续绕过声明；migration/restart 会长期保留这些值。
- **纯证明缺口**：本次没有启动真实 runner；生产顺序已经证明 render 位于 `spawn()` 之前，所以该缺口不影响“runner 未启动”的静态结论。本次未做 crash 注入；异常窗口的 durable 组合仅按逐调用事务边界陈述，不声称枚举了所有 crash interleaving。

### A5. 可保留资产

- wire known-key、JSON size/depth/shape boundary；
- item mutation caller/rights gate；
- `idField` 与 opaque `itemId` 一致性检查；
- SQLite `IMMEDIATE` write transaction 及 batch 单事务；
- update 时 dependency graph 与少数字段专用验证；
- migration 的 JSON 保真与 row decode 的 generic JSON 校验；
- spawn preparation failure 的 run closure、current-run 清理、status 恢复、可观察事件与 backoff 容器。

这些资产都不能充当 typed binding admission 的证明。

### A6. 尚未确定与下一步

- chain binding 的最终 schema owner、递归 ValueType 与外部 producer 需求属于 R7-04/R7-05/R7-14，不在本报告裁决。
- 哪些 admission 点应承担哪些检查、是否允许 render-only 值、确定性错误是否重试，均需 R8 基于多份报告交给操作员裁决。
- 本报告事实已足够进入 R8 档案输入；无需为 R7-06 再查一次同类 create/update 入口。

---

## B. 证据附录

### B1. 设计对照

| 条款 | 判定 | 生产事实 |
|---|---|---|
| §2 D | 不符合 | 实例值不按声明 required/type/default admission；missing 转空串，结构值迟至 render 抛错。 |
| §2.3 | 不符合 | chain/item 已在 create/update 可决定的值被拖到 render；restart 不补验。 |
| P-D2-2 | 不符合 | `stringifyBindingValue(null/undefined) => ""`；object error 不含 binding key。 |
| P-D2-3 | 不符合 | create/update 成功持久化错误实例；spawn preparation 才失败。 |
| D-08 | 不符合 | item/chain missing 的空串通路物理存在。 |
| D-09 | 不符合 | 所有 mutation 入口均无统一 preset-driven instance admission。 |
| A-07 | 可保留但不证明符合 | generic JSON 安全、事务和 migration 保真存在。 |
| J-04 | 互证成立 | S2 的 binding 偏离与 S6 的通用 wire/persistence 入口在本调查落到同一生产时间线。 |
| T-03 | 同错仍在 | 既有测试主动固定 scalar stringify/default 空串；generic transaction tests 未注入声明错类型。 |

### B2. 全入口与最早可决定时点

| 入口/层 | 已拥有的信息 | 当前 admission | 写与副作用 | 结论 |
|---|---|---|---|---|
| CLI | chain/item/preset/path/extra 参数 | 转成 daemon wire 请求；无独立 typed binding schema | 无直接 DB 写 | 不是 schema owner。 |
| daemon wire | 完整 JSON request | known-key、基础 scalar、size/depth、rights | 失败在 store 前 | generic boundary 可保留。 |
| chain create | preset 名（可 null）、metadata.bindings | preset 名只验证 bundled 可加载；metadata 走 generic chain metadata | `store.createChain` 后成功 | required/type 已可结合定义判定却未判。 |
| item add | per-item preset、完整 extra | rights、entry status、idField 一致性、generic extra | 单行 insert；随后 `item.created`、tick | arbitrary field type/required/default 未判。 |
| item batch add | 每个 item 的 preset/extra | 逐项做 add 的同类 generic validation | 所有 input 建成后一次 `createItems`；成功后逐条 event | typed 错误不会阻断，整批接受。 |
| item update extra | 当前 item/preset、replacement | caller/rights、generic extra、少数 branch/pr | `updateItem` 后按需 event/tick | arbitrary declared field 未复验。 |
| item update extraPatch | 当前 item/preset、旧值与 patch | merge 后 generic extra；同上 | 单个 update transaction | merge 结果不按字段声明复验。 |
| store API | 已构造 typed TS input（仍含 generic JsonObject extra） | SQL constraints、JSON serialization | 每次 write 为 IMMEDIATE transaction | 不知道 preset schema。 |
| migration | legacy physical columns、extra JSON | JSON object/identity salvage | schema rebuild transaction | 不知道 item preset field schema。 |
| row/status/restart | persisted preset refs 与 extra JSON | parse generic JsonObject、runner/status | 只读展示/调度 | 不补验错类型。 |
| spawn render | loaded preset、phase variables、chain/item/runtime | 此时才 resolve/stringify | 已越过 closure/run/current/item preparation writes | object/array 转通用 preparation failure；missing 仍成功为空串。 |

### B3. chain create

`src/daemon.ts:2166-2198` 显示：create 解析 `preset`、repository/base branch 和 generic `metadata`，然后直接 `store.createChain(input)`。它没有加载该 preset 的 variable sources 后校验 `metadata.bindings`。注释声称“preset arktype boundary”会拒绝 malformed entries，但生产调用只见 `validateChainMetadata(...)`，未形成按具体 preset required/type/default 的实例 admission。

隔离实验中 `metadata.bindings.need = "wrong-string"` 被接受；chain status 原样返回。

### B4. item add 与 idField 特例

`src/daemon.ts:2887-2937` 的 add 流程先做 request、chain、caller/rights，再构造 input 并写 store。`buildCreateItemInput`（`3001-3057`）确实加载 preset，但用途是：

1. entry status；
2. preset `idField`；
3. `itemId` 与 `extra[idField]` 一致性；
4. generic `validateItemExtra`。

没有遍历 `[item.fields]` 或读取其 `type`。因此 idField 是 preset-driven admission 的局部特例，不能推广成全部 binding 字段已验证。

隔离实验：

- missing `foo`/`obj` 的 item add 成功，只自动补 `id`；
- 声明 `foo="number"` 却写入 `"not-number"` 成功；
- `obj={nested:1}` 成功落库。

### B5. batch 原子性

`src/daemon.ts:2940-2998` 在内存中先构造全部 inputs，随后只调用一次 `store.createItems(inputs)`。`src/sqlite-state.ts:1605-1612,1739-1743` 将整个 map insert 包在一个 `db.transaction(...).immediate()` 中。

因此：

- generic request、rights、duplicate 或 SQL constraint 在 commit 前失败时，没有部分 item rows；
- events 在 commit 后逐条发出，不属于同一 DB transaction；
- binding schema 错误当前根本不会成为 failure，所以不存在“typed 拒绝的原子性”；实验 b1 的错 `foo` 与 b2 的 array `obj` 同批全部持久化。

“batch 是事务”与“batch 有 typed admission”是两个不同命题。

### B6. update replacement 与 patch

`src/daemon.ts:3110-3239` 的 update 顺序是：caller admission → per-phase writable-field rights → top-level/control validation → `extra`/`extraPatch` size boundary → replacement/merge → dependency与历史 `branch`/`pr` 专用检查 → `store.updateItem`。

这条路径会加载 preset 来做 rights/status，但不会把 merge 后的 arbitrary extra 与 `[item.fields]` 声明比对。隔离实验对原本缺字段的 item 执行 patch，成功写入：

```json
{"foo":{"later":true},"obj":["x"]}
```

status API 随即完整返回这些结构值。

### B7. resolver 的两套缺值语义

`src/loop.ts:6032-6080`：

- item field 经 `lookupItemField` 后交给 `stringifyBindingValue`；
- chain field使用 value 或 literal fallback，再 stringify；
- `null|undefined` 明确返回 `""`；
- string、finite number、boolean转 string；
- object/array抛 `Error("item.foo: cannot stringify value of type object")`；
- runtime missing 则由 `runtimeBindingValue` 立即 throw。

所以 missing 的语义按 source kind 分裂；item/chain 静默，runtime 抛错。结构值错误只点 source label；当同一 source 被多个 phase binding key 引用时，消息不能说明是哪个 binding key 失败。

### B8. spawn 前后副作用顺序

生产顺序见 `src/scheduler.ts:1565-1751`：

1. resolve runner、load preset、计算 definition identity/resume；
2. prepare/reopen worktree/closure resources；
3. `recordRunWithClosureResources`：持久化 running run 与 closure；
4. emit `closure.resource_prepared`，进入 closure phase；
5. `setCurrentRun`；
6. update item：attempts（fresh first phase 时 +1）、lastRunId、agentCwd、phase；
7. 读取 raw prompt；
8. `renderSchedulerSpawnPrompt`；
9. 只有 render 成功后才写 runner artifacts、mint credential、调用 Node `spawn()`。

因此结构值异常不是“完全无副作用的 render error”。它发生在 2–6 后、9 前。

catch 调 `cleanupFailedRunPreparation` 后再调用 `containSchedulerPreparationFailure`（`src/scheduler.ts:1885-1917`）。后者从 persisted item 出发：

- 恢复原 status、statusUpdatedAt、phase；
- 添加 scheduler backoff 与 `schedulerSpawnError`；
- emit `spawn.aborted`，reason 是 resolver message；
- scheduler 后续在 backoff 后仍可尝试同一确定性坏值。

cleanup 会把已记录 run complete 为失败并清 current run；worktree/closure资源由既有 preparation cleanup/retention 语义处理。contain 没有恢复 attempts、lastRunId 或 agentCwd，故这些准备痕迹可能保留。没有 `agent.spawn`/`phase.start`，也没有真实 runner child。

本节以生产代码的严格控制流为证；未另启真实 runner，避免越过实验边界。

### B9. migration、restart 与 recovery

`src/sqlite-state.ts:1229-1365` 的 v11→v12 migration 只：

- parse `extra` 为 generic JsonObject；非法 JSON退为空 object；
- salvage `issue/branch/pr`；
- 推导 opaque item id；
- rebuild table并保留其余 extra。

它明确不知道 preset，因而不可能按 `[item.fields]` 类型重验。后续 table rebuild 同样只是列复制与 SQL CHECK。

`rowToItem`（`src/sqlite-state.ts:2230-2258`）验证 runner/status，并把 `extra` parse 成 generic JsonObject；不会加载 preset。daemon startup recovery面向 current run、stale state、worktree/tree 等生命周期资源，不建立 binding schema admission。

隔离实验停止 daemon、关闭 DB、重新打开 store 后，wrong/missing/array/object 值原样存在并可列出。这证明常规 restart 不补验；本报告不把该实验外推为所有古老 schema migration 的 exhaustive crash proof。

### B10. 错误出口与 retry 分类

| 情况 | 当前出口 | status/event | retry |
|---|---|---|---|
| create/update generic JSON非法 | daemon request error，写前 | 无 item mutation | caller可修后重试 |
| create/update binding required/type错误 | 不被识别，返回成功 | created/updated state | 无错误 |
| missing item/chain binding render | 成功得到空串 | 正常继续 spawn | 不触发 retry |
| object/array binding render | 普通 Error进入 scheduler preparation catch | failed run；item status恢复；`spawn.aborted`；extra写错误/backoff | 自动 backoff 后可再次尝试 |
| missing runtime binding | throw进入同一 preparation failure容器 | 同上 | 同上 |

确定性 schema 错误没有独立错误 variant，也没有 no-retry 分类。

### B11. 测试同错与盲区

- `tests/unit/loop/prompt-bindings.test.ts:89-103` 固定 number/boolean stringify 与 default/empty-string 行为；它是旧语义回归，不是 P-D2-2 证明。
- daemon create/batch/update 测试主要证明 generic boundary、rights、duplicate、SQL transaction；未将 preset field 声明与错类型实例成对注入。
- batch conflict 测试能证明 SQL 原子性，不能证明 binding schema rejection。
- scheduler preparation failure 测试覆盖通用 cleanup/backoff 时，也会把确定性 render schema error吞入同一类别，若不专门断言错误分类就与生产共同同错。
- S2 的完整既有测试盘点见 `06-r4-binding-type-flow.md:270-280`；本报告不重复把测试绿当设计证据。

### B12. 根因集合与放大条件

#### 直接机制

1. mutation生产路径不消费 field declaration；
2. generic JSON storage允许所有 JsonValue；
3. resolver将 missing定义为空串、结构值定义为异常；
4. render位于资源准备写之后；
5. scheduler catch不区分确定性 schema错误与临时 preparation错误。

#### 上游/历史来源

- idField、branch/pr等逐项专用验证形成局部强类型外观，但没有推广为声明驱动入口；
- migration必须兼容旧 generic extra，因此保真搬运而非重验；
- string prompt pipeline使 scalar stringify成为既有合同，却没有结构值投影合同。

#### 放大条件

- GUI/hook/外部 typed producer开始写结构值；
- 一个source被多个binding key/phase复用，错误信息更难归因；
- daemon长期运行并自动调度，确定性错误重复生成run/backoff；
- 存量DB携带旧错值，升级/restart不会自动隔离。

### B13. 事实支持的候选形态（非完备、不推荐）

以下只是地面事实可区分出的形态，**候选非完备，且本报告不推荐任何一项**：

1. **定义关联的 mutation admission**：在chain/item可决定时验证；确定后果是错误不落库，但需明确chain definition owner、update后完整对象与migration策略。
2. **存储层 schema admission**：所有写者共享约束；确定后果是减少 daemon 旁路，但 store 当前不知道 preset/definition，必须改变其输入合同。
3. **render-only admission**：保留开放存储，到每个消费点严格拒绝；确定后果是历史值可保真，但错误仍晚于落库，若仍位于当前顺序则保留run/closure副作用。
4. **分阶段混合**：已可决定值在mutation拒绝，真正run-time值在render/finalize判；确定后果最贴近 §2.3 的时间语义，但哪些source属于哪一阶段需由权威类型模型决定。
5. **历史数据隔离/显式迁移**：restart不静默补验；确定后果是需可观察地处理存量违规值，而不是在row decode偶然爆炸。

这些形态还依赖 R7-04/05/14 的 owner/type/fallback事实，不能在此收敛成方案。

### B14. 实验登记

- 脚本：`/tmp/rfc547-r7-06-experiment.ts`
- 输出：`/tmp/rfc547-r7-06-experiment.out`
- 隔离 root/loop-data：`/tmp/rfc547-r7-06-ce27fc56-36a5-49e4-9169-e7b764ba3515`
- 环境：`startCoderLoopDaemon({scheduler:{enabled:false}})`；custom preset；无中央 daemon、无真实 runner、无网络、无生产 DB。
- 覆盖：chain create、item add missing/wrong、batch add wrong、update patch object/array、status read、DB close/reopen。
- teardown：daemon正常 stop；临时文件保留供复核。

未运行真实 runner 或中央 scheduler。spawn 的顺序与错误容器来自生产控制流；这比用 fake runner更直接证明错误发生在 Node `spawn()` 前，但不替代未来针对 crash窗口的专用实验。

### B15. 证据索引

| 事实 | 证据 |
|---|---|
| 稳定条款 | `AGGREGATE-547.md:93-94,286,291,300` |
| resolver missing/scalar/object | `src/loop.ts:6032-6080` |
| chain create | `src/daemon.ts:2166-2198` |
| item add/batch | `src/daemon.ts:2887-2998` |
| create input/idField | `src/daemon.ts:3001-3057` |
| update replacement/patch | `src/daemon.ts:3110-3239` |
| store transaction/batch | `src/sqlite-state.ts:1605-1612,1739-1743` |
| migration | `src/sqlite-state.ts:1229-1365` |
| row decode | `src/sqlite-state.ts:2230-2258` |
| spawn preparation/render | `src/scheduler.ts:1565-1751` |
| failure containment/event | `src/scheduler.ts:1885-1917` |
| S2原结论/测试盘点 | `06-r4-binding-type-flow.md:19,71-83,160,270-280` |
| 总账 | `11-r5-supply-ledger.md:63,81-82,115,128,157` |
| 隔离运行证据 | `/tmp/rfc547-r7-06-experiment.out` |

## 尾部结论

R7-06 已把 resolver 反例扩展为完整生产时间线：所有 mutation 入口都只有 generic admission；batch 仅保证 SQL 原子性；migration/restart保持错值；missing在render静默空串，结构值则在run/closure/item准备写之后成为通用可重试 `spawn.aborted`。因此 P-D2-2/3 与 D-08/D-09 的不符合不是单点bug，而是声明、入口、存储、render和scheduler错误分类共同形成的跨层结果。可保留的 generic 安全、事务和cleanup资产明确存在，但不能冒充 typed binding admission。报告没有裁决补法，候选形态非完备且不推荐。

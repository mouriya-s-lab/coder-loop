# R7-11 — Execution definition 内容、创建 pin 与 resume/restart resolver

> 基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。锚点：`12-r6-detail-index.md:268-278`、D10 P-D10-1…6、总账 `D-21,D-22,U-03,A-03,A-09,J-02,J-05,J-07,T-04,T-05`。本文只报告事实，不决定 artifact 介质、不提出方案、不估算规模。

## A. 主 agent 摘要（≤一页）

### A1. 问题、结论与置信边界

问题是：production execution instance 是否在创建时持有可恢复的完整执行定义，且 spawn、resume、restart、status/events 等消费者都沿该定义读取，而非重读可变源。

**结论：没有。** 当前有真实的全 source SHA-256、tagged `ExecutionDefinitionRef`、SQLite FK、compiled leaf identity 与 run→closure→node attribution；但没有 execution definition 内容 artifact，没有 chain/item 创建 pin，也没有按 persisted ref 解析行为的 resolver。首次 run 在 worktree 已准备后，才从 daemon 当前路径/cache 得到 `sourceHash` 和 phase→node-id packet，并在一次 SQLite immediate transaction 内懒建 identity row、root/leaf/closure、run。`execution_definitions` 只存 `(kind,content_identity,semantic_hash,schema_version)`，且 `semantic_hash=content_identity`；无 content/path/manifest。production 未产生 `ChainDefinitionRef`。

同一 daemon 的成功 Promise cache 以 absolute preset path 为 key，H1→H2 编辑后旧实例**偶然**继续用 H1；kill/restart 清空 cache，旧实例下一次调度按同一路径装载 H2。persisted H1 ref只用于 attribution/phase identity，不控制 prompt、fragment、词表、rights、runner/model 或 status。resume 只改变 runner session argv及运行时绑定，effective prompt仍由此次 current/cache-loaded preset完整重渲染。

materialized directory 与 SQLite definition row 是两套不连接的资产。materialization 在 compile 前发布、写 marker、prune同名旧版本；marked corrupt目录直接复用且不自愈。旧目录缺失时按当前 source重建；当前源缺失/非法时报普通 preset load failure。没有按 definition identity 的 hold/recovery/retention。SQLite definition rows无显式 DELETE/GC，但空identity row也无法恢复内容。

源码调用图、SQL与R7-02/03既有隔离实验足以确定 resolver/事务/故障语义；本片未执行会创建worktree/runner的完整timeline。外部只对已检查owner有把握：`mouriya-s-lab/coder-loop`是当前已知producer；GUI owner未定且无已实现consumer；hook runtime不存在；`github-hapi-agent-router`与`hapi`不消费definition artifact；`hapi-remote-session`无本地checkout，仍未知。不能外推“全系统无外部consumer”。

### A2. 简明因果

1. compile可在运行前算出完整`CompiledTaskModel`。
2. 创建API只存source locator/业务数据，不compile或写definition ref。
3. scheduler每次spawn经path resolver/cache取current compiled model，再从hash生成packet。
4. packet只在首次`(item,phase)` run-start创建runtime attribution；已有closure甚至在比较新旧hash前返回。
5. 行为消费者持有loaded preset，不反向查询definition row；restart把旧实例行为重绑H2。

### A3. 当前/未来/纯证明缺口、资产与下一步

- **当前不符合**：D-21/P-D10-1/2（无内容、创建不pin）；D-22/P-D10-3/4/5（消费者不沿ref、restart漂移、无hold、隐式rebind）。P-D10-6只有join binding追加不改node ref的局部事实。
- **未来裁决输入**：保护闭集可由下文pre-run全集界定；artifact owner/介质、chain definition精确边界、hold外显状态、migration政策仍需R8裁决。
- **纯证明缺口**：没有production H1 create→spawn→edit→resume→kill/restart自动测试；现有测试只能分别证明hash、cache、FK或resume argv。
- **可保留**：全树hash、compile boundary/projection、tagged ref、FK、phase→definition-node packet、run-start本地原子事务、identity连续性、join binding版本追加。
- **未知**：未checkout外部owner；未来GUI/hook协议；哪些chain declaration字段归`ChainDefinitionRef`；历史migration政策。

**下一步是R8裁决，不需继续本仓源码调查；仅外部owner清单变化时补调查。**

---

## B. 证据附录

## B1. 设计条款与总账对照

| 条款/账项 | production事实 | 边界 |
|---|---|---|
| P-D10-1 / D-21 | pre-run字段可计算，但未持久内容/schema | 不符合 |
| P-D10-2 / D-21 | tagged ref/FK真实；create不写；首run才写preset ref；无production chain ref | 部分资产 |
| P-D10-3 / D-22 | behavior读path/cache；CLI status另直读current source；ref只显示identity | 不符合 |
| P-D10-4 / D-22 | restart重读H2；missing/corrupt不按H1 hold | 不符合 |
| P-D10-5 / J-07 | 无显式rebind API，但restart/migration current-source是隐式rebind | 不符合 |
| P-D10-6 / J-05 | join binding按version追加，node ref不更新；candidate ref仍无content resolver | 局部资产 |
| A-03 | source hash覆盖source tree路径与bytes | 可保留 |
| A-09 | run→closure→runtime node→tagged ref/node id连续 | 可保留 |
| J-02 | compiled leaf id进入run packet/node | 关联≠resolver |
| T-04 | nested tree/chain refs多为fixture直接构造 | 非production producer证据 |
| T-05 | run-start atomic、resume argv、recovery identity测试 | 不证明pin/hold |
| U-03 | 已知owner收窄，一个checkout未知 | 未全闭合 |

## B2. 运行前可计算字段全集

`Preset`与`CompiledTaskModel`给出从source可在execution前计算的全集（`src/loop.ts:660-787`）：

| 组 | 字段 | 当前持有 |
|---|---|---|
| identity | `name,presetDir,sourceDir,sourceHash` | loaded model；run extra仅hash |
| item schema | `idField`、fields schema | current/cache model |
| runtime | business keys、literal values | model；spawn转bindings |
| status | continuable/terminal/success/entry/unblockable/exhausted/retry | model；daemon/status读取 |
| phase/tree | order/name、root seq id、每phase seq id、leaf id/kind/phase | packet仅phase→leaf id |
| prompt | path、validated file bytes | materialized/current path，不入row |
| exit | tagged item-status/chain-action、when | model |
| variable | key、item/chain/runtime source、fallback、doc metadata | model；projection只保留摘要 |
| trigger | trigger ADT/条件 | model/projection |
| runner | phase default runner/model；chain/item override可在dispatch前合成 | model/metadata |
| fragment | id/role/path/bytes、phase roles | model/path；projection只存relative metadata |
| rights | createItems、writableFields、privilegedOps | model/projection |
| agent | attemptTimeoutSeconds | model |
| diagnostics | DAG/placeholder warnings | compile result/observability，非执行内容 |

compile顺序是parse→DAG→逐phase读/验证prompt→fragment readable→hash→build tree（`src/loop.ts:4608-4695`）。公开projection含status graph、exits/trigger/runner/model/variable摘要/rights/task tree/fragments（`:2900-2959`），但丢prompt/fragment bytes、完整variable source/doc、phase roles、item schema、runtime literals、agent timeout，故它不是完整definition content。

chain创建前已知name/repository/baseBranch、preset locator、bindings、runner/model及调度metadata；item添加前已知item id/fields/status/dependencies/repoCwd/preset locator/runner override。runId、worktree/branch/base commit、session、attempt、cursor/evaluation/decision/result是运行态，不是pre-run定义。哪些chain字段属于`ChainDefinitionRef`需裁决，不能从当前空row反推。

三类实际持有：

| 类别 | 字段 |
|---|---|
| persisted | definition四列；node的kind/content identity/node id；run extra的kind/content identity/phase map |
| packet/in-memory | 完整CompiledTaskModel、effective runner、resumeDecision、phase map、raw/rendered prompt、authorization phase |
| only current/materialized/cache | prompt/fragment bytes、完整status/exits/variables/rights/triggers/schema/literals/timeout/order/default behavior |

## B3. 全production consumer / resolver矩阵

| consumer | 用途 | resolver | ref作用 |
|---|---|---|---|
| daemon chain.status | status/waits | representative item/chain locator→path Promise cache→materialized compile (`src/daemon.ts:2453-2491,4448-4476`) | 无 |
| queue.unblock | entry/unblockable | chain→same cache (`:2754`) | 无 |
| item create/id | idField/schema | request spec→same cache (`:3022,4430-4438`) | 无 |
| item terminal update | terminal vocabulary | item→same cache (`:3133`) | 无 |
| exits/exit-action | exit declarations | item→same cache (`:3305,3364`) | 无 |
| privileged ops | phase rights | item→same cache (`:2058`) | 无 |
| writable fields | phase rights | item→same cache (`:4291-4299`) | 无 |
| status admit/allowed | phase/status | chain→same cache (`:3908,4403`) | 无 |
| scheduler selection | phases/default runner/model+override | daemon item/chain cache (`:3681-3710`) | 无 |
| spawn | hash/phase ids/prompt/fragments/bindings/rights | cached `SchedulerLoadedPreset` (`src/scheduler.ts:1583-1681`) | 写ref，不读ref |
| resume | rerender+session argv | session只选ResumeDecision；prompt仍读loaded preset (`:1588-1590,1660-1681,3128-3193`) | 无 |
| CLI status | vocabulary/queue/current/errors | 每命令直读current source，按dir临时cache (`src/loop.ts:3113-3213,4154-4173`) | tree/events显示identity |
| compile CLI | diagnostics/projection | explicit current source (`:2900-2965,4590-4605`) | 无 |
| legacy migration | hash/phase map | migration时materialize current source (`src/preset-migration-definition.ts:17-31`; `src/sqlite-state.ts:1121-1213`) | 写升级时ref |
| startup recovery | kill/close/event | persisted node/ref identity (`src/daemon.ts:2350-2432`)；后续调度另读current | identity only |
| status/events | attribution | persisted node identity (`src/loop.ts:3170-3175`; `src/observability.ts:232-294`) | display/filter |
| tree/join store | FK/candidate attribution | persisted ref (`src/sqlite-state.ts:2363-2451`) | identity only |
| hook/GUI | 尚无production consumer | hook runtime不存在；GUI未实现/owner未定 | 无路径 |

穷尽检索：

```sh
rg -n 'execution_definitions|definitionRef|definitionContentIdentity|definitionPhases|sourceHash|loadedPresetForItem|presetExecutionContentIdentity' src tests
rg -n 'loadedPresetFor(Item|Chain|ChainOrItems)|loadedPresetFromSpec|loadPreset\(' src
```

第一条baseline有152个命中；全部production behavior load点均归入上表，未发现以definition ref查询content的函数。

## B4. ref创建、write transaction、失败/恢复/GC

schema（`src/sqlite-state.ts:653-672`）：

```sql
CREATE TABLE execution_definitions (
 kind TEXT CHECK(kind IN ('preset','chain')),
 content_identity TEXT,
 semantic_hash TEXT,
 schema_version INTEGER,
 PRIMARY KEY(kind,content_identity));
-- task_nodes(definition_kind,definition_content_identity) FK → execution_definitions
```

唯一helper（`:2359-2360`）：

```sql
INSERT OR IGNORE INTO execution_definitions
(kind,content_identity,semantic_hash,schema_version)
VALUES($kind,$identity,$identity,1);
```

无`DELETE FROM execution_definitions`、无content read、无semantic_hash复核。`chain` variant仅在ADT/fixtures/createTaskTree存在；scheduler固定`definitionKind:"preset"`（`src/scheduler.ts:1621-1626`），无production `ChainDefinitionRef` producer。

时间/事务：

1. chain create/item add不compile、不写ref/tree。
2. first spawn先解析runner/current loaded preset/hash/session，再准备worktree（`src/scheduler.ts:1583-1605`）。
3. `recordRunWithClosureResources`传hash+全部phase leaf ids（`:1607-1637`）。
4. store write由`db.transaction(fn).immediate()`包装（`src/sqlite-state.ts:1605-1612,1915-1918`）；同一事务中`ensureRuntimeClosure` parse packet、insert definition/root/leaf/closure，随后insert run（`:1643-1671,2292-2335`）。失败整体回滚。
5. 已有`(item,phase)` closure时，`ensureRuntimeClosure`在读取packet前return（`:2292-2294`），不比较H2 hash与H1 node ref；新run可携H2 extra却关联H1 leaf。
6. setCurrentRun、item update、prompt render/spawn是后续操作（`src/scheduler.ts:1638-1706`），不在该事务。restart recovery关orphan/清active run，不恢复内容。

`parseExecutionDefinitionPacket`只验证tag/nonempty identity、phase数组唯一性及当前phase存在（`src/sqlite-state.ts:2338-2356`）。无rebind API、definition hold或管理员migration通道。

definition是FK parent；有node引用时不能删。chain删除级联nodes却不级联parent definition；又无显式GC，所以orphan identity rows保留。空row保留≠内容保留。

## B5. H1/H2 timeline

| 时点 | source/cache | persisted | 行为 |
|---|---|---|---|
| t0 create at H1 | create不load/pin | 无definition/tree | 只有source locator |
| t1 first spawn | cold cache materialize/load H1 | 写H1 hash/root/leaf/closure/run | prompt/rights/model/status=H1 |
| t2 edit H2 | daemon cache hit仍H1；CLI direct loader可H2 | node H1 | daemon H1、CLI H2，跨consumer分裂 |
| t3 same-daemon resume | session选resume；cache H1 | existing closure H1 | prompt按cached H1完整重渲染，不按ref |
| t4 kill/restart | cache消失；recovery用ref做attribution；scheduler按path load H2 | old node H1；新packet可H2 | 旧instance行为H2，无rebind/hold |
| t5 new instance | current H2 | 首run写H2 | 新instance H2 |

restart不会按H1 ref寻找H1 materialized目录；`semantic_hash`被改也无reader检测。

## B6. materialized missing/corrupt/GC

| 对象 | 内容/生命周期 | 故障 |
|---|---|---|
| SQLite definition | identity四列；无GC | semantic hash损坏不检测；无内容可恢复 |
| `preset-materialized/<name>-<hash>/` | source copy+marker；publish时prune同name siblings | 不受active ref保护；H1可被H2 prune |

`src/loop.ts:4393-4501`与R7-03证明顺序为hash→copy staging/substitute→marker→rename/publish→prune siblings→调用方随后compile。非法H2可成为marked artifact并删最后good H1；marker只证明copy完成。marked目录内文件损坏/删除后命中仍直接返回，不validate/self-heal；不同hash并发publish可互prune。`prunePresetMaterializedRoot`存在但启动期未接线，eager sibling prune已足以破坏历史retention。

- H1 directory missing、source为H2：重建/读H2，不hold。
- source missing/invalid：daemon抛普通`invalid_request: failed to load preset...`（`src/daemon.ts:4475-4495`），不点名所需definition identity。
- marked corrupt：普通compile failure，不自愈。
- definition row missing：有FK时正常SQL不能删；无引用时packet重插identity shell，不能恢复H1。
- SQLite row无GC；directory prune按basename family，不按chain/item/run ref。

## B7. 外部owner边界

| owner/system | 已核事实 | 边界 |
|---|---|---|
| `mouriya-s-lab/coder-loop` | 唯一当前已知producer owner | 本报告调用图闭合 |
| installed app | local wrapper指向`Ext/app/coder-loop`，可落后code | 部署时另核版本 |
| GUI | repo/owner未裁，无implemented consumer | 未来协议未知 |
| hook | runtime不存在 | carrier≠consumer |
| github-hapi-agent-router / hapi | 不消费definition ref/artifact | 仅代表已知owner |
| hapi-remote-session | 无本地checkout | 保持未知 |

## B8. 测试覆盖、同错与盲区

| 覆盖 | 能证明 | 不能证明 |
|---|---|---|
| compile hash tests | source/template/fragment变化改hash | pin/retention |
| identity helper test | identity=sourceHash | ref可解析content |
| SQLite runtime/tree tests | tagged boundary/FK/roundtrip/local transaction | production chain ref/behavior resolver |
| startup recovery | node identity连续/orphan close | restart仍H1 |
| resume tests | session/argv选择 | rerender输入来自pin |
| status tests | tree显示ref | vocabulary来自同ref |
| materialize tests | 正常hash目录/marker/copy | compile-before-publish、自愈、ref-aware GC、并发安全 |
| migration tests | current source生成packet | 历史H1恢复 |

fixture常直接`createTaskTree`并注入synthetic chain ref，绕过production固定preset packet。绿色hash、FK、cache、resume、recovery测试组合后仍可能制造“有ref即有pin”的同错。run-start atomic只覆盖identity shell/tree/run，不覆盖prompt/spawn/content。没有测试semantic hash校验、ref反解内容、active-ref retention或restart后prompt/status/rights仍H1。

## B9. 事实支持的形态与确定后果（不裁决）

1. **完整compiled preset内容**：覆盖B2全部preset执行语义/bytes-derived inputs；可解释item行为，但不自动涵盖chain baseBranch/tree/join declaration。
2. **preset definition + 独立chain definition**：ADT允许两tag，创建前字段可得；需分别界定创建事务/consumer，当前只有preset producer。
3. **规范投影 + 内容payload**：projection是规范字段资产但丢prompt/fragment bytes等；单独持久projection不足以重渲染同一prompt。
4. **仅hash/ref（当前）**：只能attribution，不能恢复/解析行为；cache/mutable source成为事实resolver。

run结果、session、cursor、evaluation、decision、runtime join binding版本不是创建前definition内容。artifact介质、owner与最终内容边界不由这些事实自动推出。

## B10. 实验、环境限制与证据索引

核实：

```text
pwd=/Users/mouriya/Ext/code/coder-loop/v3-issue/n/547
branch=main
HEAD=699842eba2eefc242d19f8fa9232bc1d9d5c3bdd
```

只执行B3检索与`DELETE/materialized/prune`检索；临时输出位于`/tmp/rfc547-r7-11-*`。未改DB、未启动daemon、未创建worktree、未spawn runner、未调用GitHub。完整spawn必经worktree而被边界禁止；静态cache key、SQL、recovery/resolver调用图直接决定timeline，R7-02/03隔离观察互证。本报告不把未执行timeline称为E2E。

| 证据 | path:line |
|---|---|
| model字段 | `src/loop.ts:660-787` |
| compile/hash/tree | `src/loop.ts:4602-4705` |
| projection | `src/loop.ts:2900-2959` |
| status current resolver | `src/loop.ts:3113-3213,4154-4173` |
| spawn packet/render | `src/scheduler.ts:1565-1706` |
| resume rerender | `src/scheduler.ts:3128-3193` |
| identity=hash | `src/scheduler.ts:3438-3440` |
| daemon cache/consumers | `src/daemon.ts:2058,2453-2491,2754,3022,3133,3305,3364,3681-3710,3908,4291-4299,4403,4422-4495` |
| startup recovery | `src/daemon.ts:2350-2432` |
| schema | `src/sqlite-state.ts:653-672` |
| transaction/run | `src/sqlite-state.ts:1605-1612,1643-1671,1915-1918` |
| lazy definition/tree | `src/sqlite-state.ts:2292-2360` |
| migration | `src/sqlite-state.ts:1121-1213`; `src/preset-migration-definition.ts:17-31` |
| materialize/prune | `src/loop.ts:4393-4505,4554-4580` |
| tagged ref | `src/task-runtime.ts:3-11,61-70` |
| observability | `src/observability.ts:232-294` |
| prior reports | `13-r7-02-preset-cache-coherence.md`; `13-r7-03-materialize-transaction.md`; `13-r7-07-compiled-tree-model.md`; `13-r7-08-runtime-transition-commit.md`; `09-r4-resume-definition-pin.md` |

**R7-11尾部结论：production已有真实全源hash、tagged ref/FK、compiled leaf→run/node attribution与run-start局部原子事务，但execution definition没有内容、chain/item创建不pin、production不产`ChainDefinitionRef`，所有行为resolver仍读当前路径或进程内Promise cache。H1同daemon稳定只是缓存偶然性；restart后旧实例无提示重绑H2，persisted H1 ref只作identity。SQLite空identity row与materialized目录互不关联；后者compile前发布并eager prune、marked corrupt不自愈，缺失/损坏时不会按definition identity恢复或hold。已知外部owner未发现consumer但仍有未checkout边界。故D-21为部分资产/实质不符合，D-22不符合，U-03仅对已知owner收窄；事实输入足够进入R8裁决。**

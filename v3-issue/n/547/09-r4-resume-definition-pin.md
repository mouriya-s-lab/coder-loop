# RFC #547 R4/S5：不可变执行定义与 resume pin 供给深审

> 基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计事实为 `AGGREGATE-547.md` §2、D10、D11 与 `04-r3-supply-slicing.md` S5。本文只审现存供给，不设计 artifact store、migration、rebind 或 hold。

## A. 主 agent 摘要（最多一页）

### A1. 问题、结论与置信

**问题。** instance pin → 定义内容存储 → resume/重启/缺失处理是否已经保证运行实例只消费创建时不可变定义？

**结论：不符合（高置信）。** 现存实现有严格 tagged ref、真实 preset source SHA-256、节点外键和事务化 identity 骨架；但 `execution_definitions` 不存任何定义内容，chain/item 创建不 pin，首次与 resume spawn 都先从当前 preset路径重新装载、再重读当前 prompt。daemon重启会丢内存 cache并读取修改后的源。持久 ref主要用于节点/status/events归因，不是定义 resolver；旧 ref缺失/损坏没有 definition hold，且已有 closure时新 run甚至不核对当前 source hash与节点 pin。

| D10 性质 | 判定 | 核心事实 |
|---|---|---|
| P-D10-1 被保护字段闭集 | **无现存供给** | 无持久定义内容/schema；表仅 identity、同值占位 `semantic_hash`、版本1，无法列出或恢复被保护字段。 |
| P-D10-2 创建前 tagged pin | **部分符合** | ADT/ref/FK真实；但 chain/item创建不写定义，直到首次 run才插入；生产 root沿首个 item preset，未形成独立 `ChainDefinitionRef`。 |
| P-D10-3 全消费者同源、resume按 pin | **不符合** | scheduler每次spawn按 item/chain路径加载当前 preset并从该对象渲染；节点ref不参与resolver。status/events显示ref，hook/prompt行为读当前源。 |
| P-D10-4 源变只影响新实例；缺失hold | **不符合** | 同daemon cache偶然冻结路径；重启后重载当前文件。定义行无内容可损坏检测；删/坏源只报 preset load error，不按旧identity hold；无definition hold状态。 |
| P-D10-5 仅显式新实例/migration演进 | **不符合** | resume隐式重bind当前源；legacy v13→v16 migration也在升级时读取当时磁盘preset，不是历史内容。无显式rebind API反而不能弥补隐式漂移。 |
| P-D10-6 join演化不切定义 | **部分符合** | join binding按 `(par,version)` append式行，节点definitionRef不被更新；但候选ref也只有空 identity行，无内容resolver。 |
| D11当前证据能力 | **部分符合** | ref/FK/migration/restart identity测试可用；无H1→H2 restart、定义产物损坏hold、全consumer同ref测试。 |

### A2. 因果、影响、资产、未知

**因果链。** source bytes确实生成 SHA-256；spawn把 hash和phase列表塞入 run.extra，SQLite据此插 identity行/节点FK。然而 hash对应的源bytes、compiled artifact、prompt/fragments/status词表从未写入 definition表。下次spawn先调用 `loadedPresetForItem`，resume只决定 runner session参数；effectivePrompt仍由刚加载的 preset与磁盘prompt重渲染。已有closure使 `ensureRuntimeClosure`直接返回，连新run hash与旧节点ref都不比对。因此“真实内容hash”没有闭合到“可按hash取内容”。

**当前影响。** 同daemon内 cache让修改源暂时不生效，可能制造假稳定；kill/restart后旧实例可接上H2。若H2移除当前phase，spawn在写入run/closure资源后才可能于prompt/authorization阶段失败；若H2仍含phase，则静默漂移。status/events仍展示H1节点ref，行为却可能来自H2，形成可观测身份与实际定义分裂。

**可保留资产。** `PresetDefinitionRef | ChainDefinitionRef` exact tagged boundary；preset source全目录bytes SHA-256；`task_nodes`复合FK；run/closure/node初次物化同一 IMMEDIATE transaction；migration失败响亮且事务回滚；status/events/recovery可连续携带节点ref；join binding version不改节点ref。

**未知。** GUI API与外树hook执行消费者未在本片代码中可识别，无法证明其读取路径；C7 compiled-node关联能力内容亦不可识别。确定方法是相邻片提供实际producer/consumer path后核对同一ref；不能从RFC反推。chain definition未来内容owner由S1/chain boundary决定，本片只确认当前没有内容。

### A3. 接缝与下一步

- **S1：** S1拥有canonical compiled artifact/当前文件问题；S5需要可按identity恢复的不可变内容。当前 `sourceHash`真实，但 `execution_definitions`不存S1 artifact。
- **S3：** S3证明节点携带ref与identity连续；S5确认ref未控制行为。节点“显示H1”不能证明prompt来自H1。
- **S6：** legacy item null时preset resolver回退chain/default；这会决定重启后读取哪份当前源，进一步放大隐式rebind。
- **D11：** 主agent应把V-R10列为未来冻结SHA验收缺口；本片实验不冒充E2E。

**下一步仅为审计汇总：** 与S1核对hash对象/compiled bytes，与S3核对production root为何是preset ref及join追加路径，与S6核对legacy fallback；不得提前设计artifact store或重拆issue。

---

## B. 证据附录

## B1. 设计对照

锚点：`AGGREGATE-547.md:211-221,292,338-341`；切片：`04-r3-supply-slicing.md:119-136,166,186,213,225,231-235`。

稳定设计区分“该preset现在说什么”与“运行实例创建时pin的事实源”。当前系统只实现前者的hash与后者的ref shape，未实现按ref读取内容。

## B2. definition model、表与全部写入口

### B2.1 ADT与边界

- `PresetDefinitionRef={kind:"preset",contentIdentity}`、`ChainDefinitionRef={kind:"chain",contentIdentity}`组成闭合union；`TaskNodeIdentity`另含runtimeNodeId/definitionNodeId（`src/task-runtime.ts:3-11`）。
- arktype + exact-key检查拒绝无tag、空identity和多余字段（`:60-110`）；join validator候选同样持tagged ref（`:28-38,149-155`）。
- 这证明shape，不证明identity能解析出内容。

### B2.2 内容寻址对象

- canonical loader对preset source目录排序收集文件，以`relative path + NUL + raw bytes + NUL`做完整SHA-256，写 `Preset.sourceHash`（`src/loop.ts:4683-4707`）。
- materialization使用相同输入但只取16 hex命名cache目录，marker存在即复用（`:4417-4445`）。materialized目录是按路径cache，不是SQLite definition内容store；其生命周期不由节点FK保护。
- scheduler的 `presetExecutionContentIdentity`直接返回`loaded.preset.sourceHash`（`src/scheduler.ts:3438-3440`）。因此“hash真实”成立；“内容可由hash恢复”不成立。

### B2.3 SQLite definition/ref表

- `execution_definitions(kind,content_identity,semantic_hash,schema_version)`，PK `(kind,content_identity)`；没有artifact/blob/json/path/content列（`src/sqlite-state.ts:653-660`）。
- `task_nodes`以 `(definition_kind,definition_content_identity)`复合FK引用definition，且存definition_node_id（`:661-672`）。task tree、closure、par/join表持运行态事实（`:673-716`）。
- `insertDefinition`只做 `INSERT OR IGNORE`，把 `semantic_hash=content_identity`、schema_version固定1；不验证hash格式、不验证同identity内容（`:2359-2361`）。
- `createTaskTree`递归先插空definition identity再插node/tree，整次store write事务化（`:1974-1981,2363-2405`）。
- production lazy closure首次物化也从run.extra解析ref/phase列表、插definition和节点（`:2292-2357`）。
- join validator插候选的空definition identity，再写版本行；没有FK从candidate列指向definition表，仅应用代码先insert（schema `:703-716`; writer `:2421-2427`）。

### B2.4 谁拥有内容、谁只持ref

| 面 | 当前持有 | 不持有 |
|---|---|---|
| preset源/loader | 当前文件bytes、compiled `Preset`、sourceHash、prompt路径 | 历史实例内容索引 |
| `execution_definitions` | kind/identity/占位semantic_hash/version | 定义字段、prompt、fragment、词表、chain tree/baseBranch |
| task node/join | tagged ref + definitionNodeId/candidateId | 可执行定义内容 |
| run.extra | 当次sourceHash + phase→node列表 | 完整定义内容 |
| scheduler cache | 当前daemon生命周期加载的materialized Preset | 跨restart保证 |
| status/events | 节点ref投影 | 校验行为确由该ref产生 |

## B3. instance pin生成与事务边界

1. chain create与item add只写chain/item；没有编译定义或definitionRef（`src/daemon.ts:2166-2205,2887-2937`; `src/sqlite-state.ts:1683-1743`）。故“不晚于实例创建成功”不成立。
2. spawn先解析runner和**当前**preset，计算当前sourceHash，再准备worktree；随后 `recordRunWithClosureResources`在一次IMMEDIATE transaction中插definition/node/closure/run（`src/scheduler.ts:1565-1638`; `src/sqlite-state.ts:1605-1612,1643-1671,1917`）。
3. transaction保证单次DB写不出现半个node/ref；但worktree资源已在事务前创建，prompt/runner spawn在事务后，存在资源与DB/行为跨事务窗口。这不等同D10定义MVCC，但会放大H2 phase缺失时的失败残留。
4. 首个run创建seq root时，root definitionRef取该item的`kind:"preset"`（`src/sqlite-state.ts:2305-2310`）；legacy migration root也取第一个item packet的preset ref（`:1128-1134`）。当前没有chain实例独立`ChainDefinitionRef`生产入口。
5. 若tree已有root，代码读取其definition identity但不与新run definitionRef比较（`:2301-2304`）；若该item+phase closure已存在，函数在解析run definition packet前立即return（`:2292-2300`）。这是隐式漂移的直接放大条件。
6. `INSERT OR IGNORE`允许任意调用者用已有identity重用空行，因无内容列而不存在“同hash不同内容”冲突检测。

## B4. spawn、resume、restart、status/events/hook消费者

### B4.1 首次与resume spawn

- 每次`spawnSchedulerRun`都调用`loadedPresetForItem`，然后计算该次sourceHash（`src/scheduler.ts:1583-1589`）。
- resume判定只读持久sessionId，控制runner `--resume`/上下文；不选择definitionRef（`:1588-1590,3068-3071`）。
- raw prompt由daemon resolver读取 `ctx.loadedPreset`里**当前**phase.prompt文件；渲染使用当前preset的phase、bindings、fragments、词表（`src/daemon.ts:4407-4419`; `src/scheduler.ts:1658-1681,3128-3200`）。
- DB中旧node ref从未传入`SchedulerSpawnContext`作为定义resolver key。因此首次与resume的实际消费者都是path/current-loaded preset，而非pin。

### B4.2 daemon cache与restart

- daemon cache key仅为presetDir绝对路径，成功后同进程复用Promise（`src/daemon.ts:4448-4476,4606-4607`）。同进程源修改可能被cache遮蔽。
- restart重建空内存cache；`loadedPresetForItem`按item presetPath/name（缺失时chain fallback）重读当前文件（`:4422-4445,4557-4603`）。没有按task node ref查询definition内容的路径。
- startup recovery只用持久tree identity归因、清理current/orphan run、reconcile closure；不解析definition内容或建立hold（`:2366-2432`）。随后scheduler tick仍走current preset loader。

### B4.3 status/events/hook

- task tree读取从node列还原tagged ref，缺node/kind行时报`invalid_json`（`src/sqlite-state.ts:2477-2527`）。status可投影tree ref，这是identity资产。
- daemon recovery与scheduler observability事件携带节点identity（`src/daemon.ts:2366-2432`; scheduler event conversion相关调用）。这能显示ref，不保证行为同源。
- production hook声明/placeholder路径未发现以definitionRef解析内容；prompt hook输入仍来自loaded current preset。外树GUI API不可识别，判“无法确定”，不是符合。

## B5. 缺失、损坏、源变化、hold/rebind

- 删除/破坏preset源：loader在当前路径失败并记录`daemon.preset_load_failed`后抛`invalid_request`（`src/daemon.ts:4448-4497`）；错误命名path/operation，但不命名旧definition identity，也不置definition hold。
- 删除被引用的definition行：FK在正常连接下拒绝；这只保护identity骨架。直接损坏definition semantic_hash不会被任何read consumer验证，因为没有definition reader。
- 删除materialized cache：下次loader可从当前source重建，不从pin恢复H1。
- 源H1→H2：同daemon可能继续cache H1；restart必按当前path装H2。若H2仍含phase，静默运行H2并可能把run.extra记H2而node仍H1；若phase移除/格式损坏则普通spawn/load失败，不进入专门hold。
- 未发现显式definition rebind API、definition hold状态或管理员确认迁移通道。**无显式rebind**本身可保留；但当前source reload已是隐式rebind，故P-D10-5不成立。
- closure `suspended`是工作树/phase生命周期，不是definition hold（`src/sqlite-state.ts:1985-1994`; `src/scheduler.ts:1766-1773`）。不得把它冒充缺定义处置。

## B6. legacy migration、并发与崩溃恢复

- v13→v16 runtime migration枚举legacy items；通过子Bun进程按item.preset/path加载**升级时当前源**，得到sourceHash+phase列表，再在同一migration transaction物化definitions/tree/closures（`src/sqlite-state.ts:1121-1213`; `src/preset-migration-definition.ts:1-24`）。
- preset缺失、输出坏、phase冲突均响亮失败并回滚；这是好的migration原子性，但无法恢复历史执行时H1，因为旧DB未存H1内容。
- migration root取第一个item definition，而各leaf可取各自item ref；chain ref缺失。mixed preset chain因此root语义不能代表chain immutable definition。
- SQLite启WAL、busy_timeout=5000；migration单transaction，普通writes为IMMEDIATE transaction（`src/sqlite-state.ts:838-853,948-1086,1605-1612`）。并发写不会产生部分definition/node。
- `insertDefinition INSERT OR IGNORE`没有内容冲突，因为根本无内容；并发同identity只收敛到占位行，不能证明相同definition。
- crash在materialization staging有marker/重建清理；但artifact未受DBref保护，跨DB与文件系统没有原子commit（`src/loop.ts:4433-4445+`）。

## B7. 最小隔离实验

登记（均为本地 `/tmp`，未启动daemon、未触碰`~/.coder-loop`）：

- `/tmp/rfc547-s5-db-experiment.ts`：隔离store脚本。
- `/tmp/rfc547-s5-db-experiment.out`：结果。
- `/tmp/rfc547-s5-db-a0438777-807e-44a0-97ae-14ffa7fd7300/`：隔离v16 SQLite fixture。
- 另一次失败创建路径 `/tmp/rfc547-s5-db-46b998fc-9777-4bd9-b604-437b8999610d/`为空/无有效DB，不含生产状态。

实验通过公开store创建chain/item/task tree，传入 `{kind:"preset",contentIdentity:"arbitrary-not-a-hash"}`，再只读查询：

```json
{
  "definitions": [{
    "kind": "preset",
    "content_identity": "arbitrary-not-a-hash",
    "semantic_hash": "arbitrary-not-a-hash",
    "schema_version": 1
  }],
  "nodes": [{
    "runtime_node_id": "leaf",
    "definition_kind": "preset",
    "definition_content_identity": "arbitrary-not-a-hash",
    "definition_node_id": "phase"
  }]
}
```

`PRAGMA table_info(execution_definitions)`仅四列，确认无content列。实验直接证明store shape只要求非空identity、semantic_hash为占位复制；它不试图模拟未来artifact store，也不是D11 E2E。

## B8. 测试同错、盲区与可保留资产

### 测试同错

- 多数task tree tests手工传`sha256:*`字符串；store会插空definition行，绿色只证明FK骨架（`tests/unit/sqlite-state/task-tree.test.ts:172-214`）。
- scheduler harness固定synthetic ref并直接`createTaskTree`（`tests/integration/scheduler/harness.ts:106-110`），绕过production source/pin时点。
- session-resume tests主要断言runner argv携带sessionId与resume上下文（`tests/integration/scheduler/session-resume.integration.ts:92-250`），未修改preset源、未核对prompt bytes/ref。
- phase restart测试证明phase/session继续，不证明重启后定义不漂移（`tests/integration/scheduler/phase-advancement.integration.ts:241-276`）。
- migration tests证明当前源可加载及identity shape，不保存历史H1 artifact。

### 盲区

- 无V-R10 H1→H2 + kill/restart，对旧/新实例分别核对完整effectivePrompt。
- 无V-10b删除/损坏旧定义内容后的identity-named hold；当前无可删的定义内容。
- 无V-10c覆盖scheduler/status/events/hook/GUI的同ref消费；现有只覆盖投影。
- 无chain创建前`ChainDefinitionRef`、item创建前`PresetDefinitionRef`断言。
- 无existing closure + changed source hash冲突测试；代码早退使该情形静默。

### 可保留资产索引

| 资产 | 证据 |
|---|---|
| tagged ref exact boundary | `src/task-runtime.ts:3-11,60-110` |
| 真实source SHA-256 | `src/loop.ts:4683-4707` |
| node复合FK/唯一约束 | `src/sqlite-state.ts:653-716` |
| DB事务与响亮migration失败 | `src/sqlite-state.ts:948-1213,1605-1612` |
| identity在tree/status/events连续 | `src/sqlite-state.ts:2477-2527`; `src/daemon.ts:2366-2432` |
| join version不改node ref | `src/sqlite-state.ts:2421-2452,2519-2527` |

## B9. 证据索引与接缝交换

| 接缝 | 本片事实 | 交给 |
|---|---|---|
| hash vs artifact | hash覆盖真实source bytes；DB无artifact | S1 |
| node ref vs behavior | node ref持久；spawn不按ref解析 | S3 |
| root kind | production/legacy seq root取首个preset ref，无chain ref | S3 |
| fallback放大 | item null→chain preset/path；restart重读当前源 | S6 |
| future验收 | H1/H2、hold、全consumer证据均缺 | D11汇总 |

## B10. 尾部结论

**R4/S5尾部结论：现存不可变执行定义供给整体不符合D10。真实source SHA-256、tagged ref、节点FK与事务化identity是可保留骨架，但definition表没有定义内容，chain/item创建不pin，resume/restart/prompt均按当前路径重载；旧ref缺失/损坏无definition hold，legacy migration也只能pin升级时当前源。节点/status/events的ref连续目前只是归因，不是执行同源。**

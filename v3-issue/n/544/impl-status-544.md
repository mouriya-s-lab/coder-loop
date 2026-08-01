# AGG-#544 已实现部分清单（整文档核对，main @ 699842e，2026-07-29）

> **核对范围与约定**：对同目录 `AGG-544-gui-observability-gateway.md`（下称 AGG）**全文逐节核对**（§1–§8）。默认态是**一切未实现**；本文件只记录在当前代码中已有实现（完整或部分）的条目，每条带 `file:line` 证据。**未出现在本文件中的 AGG 条目 = 未实现**，不再逐条罗列。
> 证据来源：codex 只读调查（session `019facda-3872-7ae1-8800-6f96b7e817c6`）+ 本机补证命令。
> 覆盖说明：AGG §1（裁决）、§2（终态）为决策与目标，不含可实现条目，其底层事实归入下文对应节；§7（开放问题）、§8（编号处置）无实现条目。

---

## §3 设计骨架——已存在的底层供给

| # | AGG 条目 | 已实现内容 | 证据 |
|---|---|---|---|
| 3-1 | §3.1 数据面一：socket RPC | daemon Unix socket 服务（`node:net` createServer）、每行 JSON 请求/单行响应协议、typed daemon command union | `src/daemon.ts:1245-1253`、`src/daemon.ts:1695-1703`、`src/daemon.ts:161-205` |
| 3-2 | §3.1 数据面二：events JSONL 写入面 | 单一流按日界/32MiB 滚动：`OBSERVABILITY_EVENT_SEGMENT_BYTES = 32MB`、`shouldRotateObservabilityEventStream` | `src/observability.ts:872-881`、`src/observability.ts:1274-1277` |
| 3-3 | §3.1 数据面三：SQLite 状态库 | 状态库存在且已远超 v2「四表」基线：19 张表（chains/items/runs/execution_definitions/task_nodes/task_trees/task_closures/task_leaf_nodes/task_seq_nodes/task_par_nodes/task_join_bindings/task_join_evaluation_bindings/closure_reachability_seeds/closure_reachability_edges/closure_sessions/closure_consumption_intents/active_runs/context_entries + migration 辅助） | `src/sqlite-state.ts:638-775`（`grep -n 'CREATE TABLE'` 可复跑） |
| 3-4 | §3.1 daemon-down 三证探针的原料 | 三条证据线的数据源均已存在：① 进程快照（pid/ppid/command/cwd/alive/source）；② status 构建时合并进程扫描与 socket 探测；③ `daemon.status` RPC 应答（字段 pid/socketPath/pidFile/running/shuttingDown/schedulerEnabled/activeRuns/rateLimit/lifecycleEventPersistenceFailure/runnerStatusPersistenceFailure） | ① `src/loop.ts:1064-1077`；② `src/loop.ts:3631-3645`；③ `src/daemon.ts:161-205` + `src/daemon.ts:5611-5623` |
| 3-5 | §3.3 F 档写动作的 RPC 供给 | 清单六项中五项已有 daemon 侧供给：`queue.unblock`、`chain.stop`、`chain.resume`、`item.reorder` 在 typed command union 且有授权类别 + handler，CLI 已经由 RPC 调用；daemon 生命周期 `up/down/status/start/stop/restart` CLI 命令全套存在（operator decision 无供给，默认未实现） | union+handler `src/daemon.ts:161-205`、`src/daemon.ts:1732-1765`；CLI 调用 `src/loop.ts:2233-2238`、`src/loop.ts:2298-2301`、`src/loop.ts:4024-4032`；生命周期 `src/loop.ts:3046-3059` |

## §4 已成立事实层——核对确认与更新

| # | AGG 条目 | 核对结果 | 证据 |
|---|---|---|---|
| 4-1 | §4.3 events 消费契约（AGG 记「已合入」） | **确认已实现，全部要件在场**：`ObservabilityKindBoundary`（五 kind 闭集）、`ObservabilityEventBoundary`（信封含 ts + 可选 chain/item/runId/phase/subject）、`OBSERVABILITY_EVENT_SEGMENT_BYTES`、`shouldRotateObservabilityEventStream`、`parseObservabilityEventSegmentName`（兼容 sequence 新格式与 legacy）、`discoverObservabilityEventSegments`、`orderObservabilityEventSegments`（legacy 等时间戳以 filename 稳定 tie-break）、`activeObservabilityEventBasename`；测试钉住等时间戳 tie、日界与 size 两条翻段路径无丢无重、新格式 sequence 确定性排序 | `src/observability.ts:17-23`、`:280-287`、`:823-827`、`:872-881`、`:1274-1277`、`:1286-1305`、`:1308-1321`、`:1337-1353`、`:1361-1364`；`tests/unit/observability/observability.test.ts:233-250`、`:253-265`、`:267-295` |
| 4-2 | §4.4 事件类型词表 | 存在且已扩充：union 现有 **61** 个事件类型成员（v2 基线记 44；统计法：union 定义区内唯一点分字面量计数，可复跑） | `src/observability.ts:25`（定义起点）；统计命令 `sed -n '25,280p' src/observability.ts \| grep -oE '"[a-z_]+\.[a-z_.]+"' \| sort -u \| wc -l` → 61 |
| 4-3 | §4.1 第 4 条行号锚 | `StatusSnapshotBoundary` 现位于 `src/loop.ts:520-529`（AGG 记载的 490-498 与 504-512 均已再漂移）；顶层现为**八槽**：七个匿名 `"object"`（target/state/queue/runs/current/events/processes）+ 精确化的 `taskTree` | `src/loop.ts:520-529`、`:521-527`（匿名七槽）、`:528`（taskTree） |

## §5 交付物清单层——各交付物中已实现的部分

| # | 交付物 | 已实现部分 | 证据 |
|---|---|---|---|
| 5-1 | D3（boundary 收紧） | 第八槽 `taskTree` 已精确：`TaskTreeSnapshotBoundary.or("null")`，树 boundary 做递归精确 narrow + exact-key 检查；CLI 输出与 builder 返回前均 assert boundary | `src/loop.ts:528`、`src/task-runtime.ts:167-178`、`src/loop.ts:2130-2135`、`:3174-3177` |
| 5-2 | D4（hooks 可见性） | 供给侧基础已在：observer/gate hook 声明 ADT、四层来源（global/chain/preset/item）与带 `source` 的 `EffectiveHook` 类型；四层合成 `buildEffectiveHookView`；daemon 可对指定 item 构造 effective view；四层合成有集成测试（注：hook 当前不执行、不进 status 快照、无 `hook.*` 事件——即 D4 的快照节与 GUI 面无实现） | `src/hook-declarations.ts:29-58`、`:138-145`；`src/daemon.ts:1215-1232`；`tests/integration/daemon/hooks.integration.ts:39-44` |
| 5-3 | D7（活性首屏） | 非 GUI 底料已在：daemon 生命周期 CLI 全套 + 三证原料（见 3-4、3-5） | 引用 3-4、3-5 |
| 5-4 | D8（控制面解卡） | 四个解卡动作的 daemon RPC 供给已在（见 3-5）；现有闭集是 daemon 命令闭集（GUI mutation client 闭集无实现） | 引用 3-5；union `src/daemon.ts:161-205` |
| 5-5 | D9（任务树钻取） | 数据供给面完整就位（= CAP-1，见 6-1）：status 快照含 `taskTree`，builder 从 SQLite 读取返回 | `src/loop.ts:936-945`、`:3156-3175`；其余见 6-1 |
| 5-6 | D11（编译元信息预览） | 数据供给面完整就位（= CAP-7，见 6-5） | 见 6-5 |
| 5-7 | D12（context entries 展示） | 存储与写入面已在：scope ADT（`chain \| item \| group`）与 author ADT（`operator \| agent`）、typed `ContextEntry` envelope（id/chainId/createdAt/scope/author/body）；store 暴露 append/list/delete，内部 `listContextEntries(chainId)` 返回 typed entries；daemon RPC 有 `context.append.begin/chunk/commit` 三段；CLI 注册 `context append`（注：无 read/list 对外命令；group scope 写入仍被拒 `group-unavailable-v2`） | `src/context-entry.ts:4-15`、`:70-85`；`src/sqlite-state.ts:354-356`、`:2056-2061`；`src/daemon.ts:161-205`、`:1870-1873`；`src/loop.ts:1943-1969` |

（D1、D2、D5、D6、D10、D13、D14：无任何已实现部分，按默认态不列。）

## §6 跨树能力依赖层——供给现状

| # | 能力 | 已实现内容 | 证据 |
|---|---|---|---|
| 6-1 | CAP-1 任务树快照 shape | **完整就位**：closure snapshot 含 `active \| suspended \| consumed` 生命周期、worktreePath、branchName、baseCommit、sourceParNodeId、sessions；join evaluation 含 epoch/bindingVersion；task node 为 `leaf \| seq \| par` discriminated union，par 携带 pinCommit/state/reopen/join，tree 携带 activeRuns；boundary 全递归精确验证；SQLite 持久化同一事实源并由 `getTaskTree` 重建；status 面已暴露；不可达 closure 原子转 consumed 并清 sessions；scheduler 真实执行 closure consumption 与 `closure.consumed` 事件 | `src/task-runtime.ts:13-26`、`:34-42`、`:43-58`、`:127-175`；`src/sqlite-state.ts:680-724`、`:2477-2527`、`:2021-2031`；`src/loop.ts:3174`；`src/scheduler.ts:1490-1520` |
| 6-2 | CAP-2 pinned definition | identity 半已在：`ExecutionDefinitionRef` 带 `contentIdentity` 进入 runtime node identity；spawn 时计算 preset source hash 并把 definition/phase identity 写入 run extra；run 恢复时解析并校验持久化 identity；`execution_definitions` 表存 identity/semantic hash/schema version（注：表不存可解引用的完整 definition 内容，prompt 仍从当前 preset 路径读——解引用无实现） | `src/task-runtime.ts:3-11`；`src/scheduler.ts:1586-1626`；`src/sqlite-state.ts:2338-2352`、`:2359-2360`；对照 `src/daemon.ts:4407-4419`、`:4606-4608` |
| 6-3 | CAP-4 operator decision | epoch 基础已在：join evaluation 持久化 `epoch`/`bindingVersion`（evaluating/decided/consumed），SQLite 按 `(par_node_id, epoch)` 存 evaluation binding，快照暴露最新 epoch/state；join binding 存 author/authority/effectiveFromEpoch（注：decision ADT、capability 查询、RPC 命令均无实现） | `src/task-runtime.ts:34-38`；`src/sqlite-state.ts:302`、`:703-716`、`:718-724`、`:2525-2527` |
| 6-4 | CAP-5 hook 运行态 | = 5-2 所列声明/持久化/合成基础 | 引用 5-2 |
| 6-5 | CAP-7 编译产物 | **完整就位**：`PresetCompileProjectionBoundary` schemaVersion 1，覆盖 preset/statuses/stateGraph/phases+taskTree/tools/fragments/findings；public result 为 `compiled \| rejected` ADT；CLI 已注册 `preset compile <name\|path> --json`，成功输出 projection、失败输出 schema 校验过的结构化 rejection；测试覆盖 ADT、roundtrip、确定性、canonical identities、findings 保留（唯一限制：variable type 硬编码 `"string"`——CAP-3 未实现的边界） | `src/loop.ts:533-583`、`:588-597`、`:2900-2958`、`:2962-2971`、`:2990-3005`、`:3030-3032`、`:3059`、`:2945`；`tests/unit/preset/compile.test.ts:18-54`、`:141-145`、`:241-257` |
| 6-6 | CAP-6 context entries 读取边界 | = 5-7 所列 typed 存储 + 内部 read（对外 read 边界无实现） | 引用 5-7 |

（CAP-3：无任何已实现部分；GAP-698/710/712/730/739：仍无定义。均按默认态不列。）

---

## 对 AGG 文档的事实修正点（核对中发现，待回写时用）

1. AGG §6.1 把 CAP-1、CAP-7 记为「跨树等供给」——**实际已完整就位**，GUI 可直接消费。
2. AGG §6.1 的 CAP-2/4/5/6 若读作「当前已供给」则夸大——均只有基础层（identity / epoch / 声明合成 / 存储），缺消费端契约。
3. AGG §4.1 第 4 条行号锚需更新为 `src/loop.ts:520-529`，槽数为八（匿名七 + 精确 taskTree）。
4. AGG §4.4「44 种事件」「SQLite 四表」为 v2 基线旧值，现为 61 种事件、19 张表。

# 代码现状排查:聚合稿标准池 vs 当前 main(中间产物)

调查执行:codex subagent(只读静态排查,未改文件、未跑测试)。
基线:`main` @ `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`,2026-07-29。
对照对象:同目录 `aggregate.md` 的标准池 S01–S45。
"已实现"指当前源码路径与对应测试代码存在,不代表本轮重新跑绿。

## 1 存储与写入面(S01–S13)

结论:**已实现**(S01–S12 实现链完整;S13 部分——shared.md 机制在,本轮未重跑终态回归)。

- SQLite schema version 当前 **16**;`context_entries` 含 `id/chain_id/created_at/scope_kind/scope_key/author/body`,scope CHECK 为 `chain|item|group`,有 `(chain_id, created_at, id)` 索引:`src/sqlite-state.ts:775`、`src/sqlite-state.ts:808`。
- schema 创建与 `PRAGMA user_version = 16` 同一 transaction:`src/sqlite-state.ts:1000`、`src/sqlite-state.ts:1086`。
- scope 三 variant 封闭 ADT、author `operator|agent` 两 variant、穷尽 switch:`src/context-entry.ts:4`、`:12`、`:119`。
- daemon 命令面只有三段 append `context.append.begin|chunk|commit`:`src/daemon.ts:203`、`src/daemon.ts:5731`;spec 为 `mutation-credential-gated`:`src/daemon.ts:1732`、`:1763`。
- CLI 只有 `context append`,begin/chunk/commit 传输,chunk 256 Ki 字符:`src/loop.ts:1943`、`:1969`、`:1971`。
- author 由 daemon 从 operator / 有效 run credential 构造,跨 chain 拒:`src/daemon.ts:1769`;请求显式带 `author` 直接拒:`src/daemon.ts:1848`。
- item scope 查本 chain 真实 item,不存在报 `item-not-found`:`src/daemon.ts:1865`;group 写入一律报 `group-unavailable-v2`:`src/daemon.ts:1870`。
- accept/deny 均 emit `context.write_admission` 审计事件:`src/daemon.ts:1777`;commit 才真正 append:`src/daemon.ts:1909`。
- store API 只有 append、内部 list、按 chain 清理,无 update/单 entry delete:`src/sqlite-state.ts:354`、`:2045`。
- 软删与重复软删路径显式失效 append sessions 并清该 chain entries:`src/daemon.ts:2505`、`:2527`。

## 2 读取面(S14–S22)

结论:**不存在对外读取能力**。仅有 store 内部整 chain 全量读取原语;过滤、分页、boundary、daemon/CLI 读取命令均无实现痕迹。

- store 读取只有 `listContextEntries(chainId)`,无过滤请求类型:`src/sqlite-state.ts:354`。
- SQL 为 `WHERE chain_id=$chainId ORDER BY created_at,id` 全量返回,无 scope/author/after/pageSize、无 LIMIT、无 cursor:`src/sqlite-state.ts:2056`。
- context boundary 文件只定义 append 各段请求/结果,无 read/list/query boundary:`src/context-entry.ts:17`、`:30`。
- daemon 穷尽命令表无 `context.read|list|query`:`src/daemon.ts:5731`;CLI `context` 子命令 map 只有 `append`:`src/loop.ts:1969`;root usage 同:`src/loop.ts:3046`。
- S19 只有"body 不影响 scheduler"测试,无 prompt sentinel 零注入测试,记部分:`tests/integration/scheduler/core.integration.ts:184`。

## 3 group scope 真实化(S23–S28)

结论:**部分实现**——⚠️ 重要新事实:v3 树运行态已在 main 落地(真实 par 容器、稳定 `groupId`、谱系字段),但 context admission 尚未消费;group 写入仍一律拒绝。

- `TaskNodeSnapshot` 是 `leaf|seq|par` 封闭 union;par 节点带 `groupId`、容器状态、join、children:`src/task-runtime.ts:43`。
- boundary 要求 `par.groupId === identity.runtimeNodeId`——稳定 group id 已有运行态定义:`src/task-runtime.ts:127`、`:140`。
- SQLite 已有 `task_nodes`、`task_trees`、`task_closures.source_par_node_id`、`task_par_nodes.container_state`:`src/sqlite-state.ts:653`、`:677`、`:695`。
- 写树时验证 leaf 的 `sourceParNodeId` 等于真实 par parent,穷尽写入:`src/sqlite-state.ts:2363`、`:2376`;读树穷尽恢复,par snapshot `groupId = runtimeNodeId`:`src/sqlite-state.ts:2491`、`:2519`。
- run credential 只绑定 `chainId/itemId/runId/phase`,不携带 runtime node / group id:`src/scheduler.ts:423`。
- context admission 未查询 `getTaskTree` / `sourceParNodeId` / `task_par_nodes`;`scope.kind === "group"` 一律拒:`src/daemon.ts:1865`。
- 测试只断言 group 拒为 `group-unavailable-v2`,无正向 par group 写读:`tests/integration/daemon/context.integration.ts:156`。
- 细项:S23/S24/S27 缺失;S25 部分(拒绝是无条件的,不是"查树后容器不存在");S26 已实现;S28 部分(树 ADT 遍历穷尽,但 context group admission 无容器谱系遍历)。

## 4 执法面(S29–S39)

结论:**部分实现,仅 compile projection 预留空字段**;preset 声明位与运行时求值执法均不存在。

- `PresetPhaseBoundary` 不接受 `toolRequirements`;`PresetTomlBoundary` 不接受顶层 `[[tools]]`:`src/loop.ts:490`、`:508`。
- 运行时 `PresetPhase` 无 `toolRequirements`,`Preset` 无 tools registry:`src/loop.ts:714`、`:739`。
- compile JSON boundary 预留 `phases[].toolRequirements: string[]` 与 `tools[].id`:`src/loop.ts:533`、`:573`;但 projection 无条件输出空数组,不从 preset 解析:`src/loop.ts:2935`、`:2946`、`:2954`。
- run close/finalize 走现有 exit/status/credential 撤销/backoff 流程,无 capability outcome / entry-existence 求值:`src/scheduler.ts:2028`、`:2052`、`:2068`、`:2089`;credential 在 finally 撤销,撤销前无 required/expected 判定:`src/scheduler.ts:2183`。
- doc builders 无 `toolRequirementsDoc`:`src/loop.ts:5824`、`docs/preset-authoring.md:289`。
- 逐项:S29 部分(仅占位);S30–S34、S36–S39 缺失;S35 部分(未声明路径自然维持现状,无显式机制/测试)。

## 5 文档对齐(S40–S43)

结论:**部分实现**。旧 shared.md/handoff 叙述原样存在;无 context 受控中间态定位;CLAUDE.md 命令清单甚至未列已存在的 `context append`。

- 根 `CLAUDE.md` 无"context entries 受控中间态"前提:`CLAUDE.md:5`、`:17`;命令清单未列 `context append`:`CLAUDE.md:29`(实际 root usage 已列:`src/loop.ts:3046`)。
- 无状态前提在 `presets/gh-issue-pr-iteration/DESIGN.md:55`,仅"每次运行无状态,GitHub 是唯一持久层",无例外表述。
- `presets/gh-issue-pr-iteration/templates/shared.md:3` 仍称"only durable cross-issue scratchpad";`common/state-contract.md:18` 仍称 primary append-only handoff。
- `docs/preset-authoring.md:116` 字段表无 `[[tools]]`/`toolRequirements`;`:233/:278/:289` 只定义 `sharedContextPath`。
- `docs/gh-issue-pr-iteration-fragments.md:34/143` 仍把 shared.md 称为主 handoff。
- 逐项:S40、S42 缺失;S41、S43 部分。

## 6 测试现状

覆盖存储/迁移/append admission/CLI 大 body/删除清理/body 不透明;**无**读取、分页、group 正向、required|expected 执法测试。

- `tests/unit/runtime/context-entry.test.ts`:scope/author boundary(:18)、append-only/大 body/chain 隔离清理(:46)、socket 提前关闭拒绝(:63)、migration/幂等/畸形 row(:72, :91)。
- `tests/unit/sqlite-state/migrations.test.ts`:v14→当前升级保留 context entry(:167)。
- `tests/integration/daemon/context.integration.ts`:credential 归因/伪造/跨 chain/失活/session mismatch(:4)、chain 删除清理(:89)、allow/deny audit(:114)、admission 与 group 拒绝(:156)。
- `tests/integration/cli/central-cli.integration.ts`:真实 daemon + CLI 多 MB round-trip 等(:1347)。
- `tests/integration/scheduler/core.integration.ts`:body 不透明(:184)。

## S01–S45 状态总表

| ID | 状态 | 依据 |
|---|---|---|
| S01 | 已实现 | `src/loop.ts:1971`、`src/daemon.ts:1848` |
| S02 | 已实现 | `src/loop.ts:1969`、`src/sqlite-state.ts:354` |
| S03 | 已实现 | `src/daemon.ts:2505` |
| S04 | 已实现 | `src/daemon.ts:1769`、`tests/integration/daemon/context.integration.ts:114` |
| S05 | 已实现 | `src/loop.ts:1979`、`tests/integration/cli/central-cli.integration.ts:1354` |
| S06 | 已实现 | `src/daemon.ts:1865` |
| S07 | 已实现 | `src/daemon.ts:1870` |
| S08 | 已实现 | `tests/integration/scheduler/core.integration.ts:184` |
| S09 | 已实现 | `src/daemon.ts:1777` |
| S10 | 已实现 | `src/context-entry.ts:4`、`:119` |
| S11 | 已实现 | `src/sqlite-state.ts:1000`、`tests/unit/sqlite-state/migrations.test.ts:167` |
| S12 | 已实现 | `tests/unit/runtime/context-entry.test.ts:63` |
| S13 | 部分 | `tests/integration/daemon/startup-recovery.integration.ts:72`(未本轮重跑) |
| S14 | 缺失 | `src/sqlite-state.ts:2056` |
| S15 | 缺失 | `src/daemon.ts:5731` |
| S16 | 缺失 | `src/context-entry.ts:17` |
| S17 | 缺失 | `src/sqlite-state.ts:2056` |
| S18 | 缺失 | `src/sqlite-state.ts:2056` |
| S19 | 部分 | `tests/integration/scheduler/core.integration.ts:184` |
| S20 | 缺失 | `src/context-entry.ts:17` |
| S21 | 缺失 | `src/daemon.ts:5731` |
| S22 | 缺失 | `src/context-entry.ts:17` |
| S23 | 缺失 | `src/task-runtime.ts:140`、`src/daemon.ts:1870` |
| S24 | 缺失 | `src/loop.ts:1969` |
| S25 | 部分 | `src/daemon.ts:1870` |
| S26 | 已实现 | `src/daemon.ts:1870` |
| S27 | 缺失 | `src/sqlite-state.ts:2056` |
| S28 | 部分 | `src/sqlite-state.ts:2376`、`:2495` |
| S29 | 部分 | `src/loop.ts:573`、`:2954` |
| S30 | 缺失 | `src/scheduler.ts:2028` |
| S31 | 缺失 | `src/scheduler.ts:2052` |
| S32 | 缺失 | `src/scheduler.ts:2052` |
| S33 | 缺失 | `src/loop.ts:714` |
| S34 | 缺失 | `src/scheduler.ts:2028` |
| S35 | 部分 | `src/scheduler.ts:2089` |
| S36 | 缺失 | `docs/preset-authoring.md:289` |
| S37 | 缺失 | `src/scheduler.ts:2028` |
| S38 | 缺失 | `src/scheduler.ts:2089` |
| S39 | 缺失 | `src/loop.ts:573` |
| S40 | 缺失 | `CLAUDE.md:5`、`presets/gh-issue-pr-iteration/DESIGN.md:55` |
| S41 | 部分 | `docs/gh-issue-pr-iteration-fragments.md:34`、`presets/gh-issue-pr-iteration/templates/shared.md:3` |
| S42 | 缺失 | `docs/preset-authoring.md:116` |
| S43 | 部分 | `src/loop.ts:3057`、`CLAUDE.md:31` |
| S44 | 无法判定 | 需冻结 SHA 上重跑 R1–R9 综合验收,本轮未执行 |
| S45 | 缺失 | `src/daemon.ts:1870`、`tests/integration/daemon/context.integration.ts:168` |

## 对聚合稿依赖判断的修正输入

1. **CAP-IN-2(树运行态 shape)已在当前 main 部分落地**:`src/task-runtime.ts` 的 `leaf|seq|par` 节点 ADT、par 稳定 `groupId`、SQLite `task_nodes`/`task_par_nodes` 表都存在——聚合稿把它标为纯跨树入向依赖,现状是 shape 已可在本仓直接消费。
2. **CAP-IN-1(工具声明位)只有 compile projection 空占位**:preset TOML boundary 尚不接受 `[[tools]]`/`toolRequirements`,执法面的声明位输入实际仍缺。
3. **run credential 不携带 group/node id**(`src/scheduler.ts:423`)——K4b(scope 标识注入形态)裁决的现状事实。
4. **group 拒绝是无条件分支而非查树后拒绝**——S25"拒绝语义与地基一致"在树运行态已存在的现状下需要重新表述。

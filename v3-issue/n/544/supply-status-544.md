# RFC #544 R4 供给侧调查：status / task-tree / daemon 活性

> 固定事实面：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点为 AGG-544 §1.2/1.3、§3.1/3.2、D1、D3、D7、D9、CAP-1 与操作员裁决 A/F。本文不设计 GUI、不估规模、不裁决重拆。

## A. 主 agent 摘要（最多一页）

### 问题与结论

调查问题：现存 status snapshot、taskTree、SQLite 重建和活性原料，能否直接作为 AGG-544 要求的严格只读、精确 schema 单源、任务树如实、三证独立 GUI 地基？

**结论：不能直接作为地基（高置信）。** CAP-1 的持久化 shape、逐行 ingress boundary、递归 exact task-tree boundary、迁移后 definition 固化和生命周期写约束是可保留资产；但四个阻塞不是“尚无前端”：

1. **D1 不成立。** 所有 status DB 读取仍走同一个 read-write opener：`readwrite:true`，可能切 WAL，必跑 schema migration。daemon-down 也不改变这一事实；旧盘会在“读取”时迁移，schema 不可消费没有类型化 mismatch 结果。
2. **D3 仅 taskTree 槽成立，其余七槽不成立，且 builder/type/boundary/output 不是单源。** 七槽仍是匿名 `"object"`；TS shape 手写平行存在；序列化器在 boundary assert 之后 flatten `extra`，所以真正 CLI JSON 甚至不是被 assert 的对象 shape。
3. **snapshot 不是单一时点。** chain/items/current/runs/taskTree 由多次独立 open + 独立语句读取；taskTree 自身也用多条 SELECT 递归重建而无显式 read transaction。并发 writer 可令 queue/current/runs/tree 彼此跨提交、tree 内 root/children/closure/activeRuns 跨提交，产生撕裂或偶发约束错误。
4. **D7 三证完全没有独立供给。** status 只有 `ps` 扫描与 socket `daemon.status` 混成的 `processes.live[]`；pid 文件不存在于结果；socket connect 与 RPC 应答被同一调用合并；连接失败的 `missing` 还被静默丢弃；同 pid 会去重，来源证据消失。transport 无 timeout，半开/接受但不应答可无限挂。`daemon.status.rateLimit` 有稳定的实际 11 字段投影，却在 `CoderLoopDaemonSnapshot` 中仍声明为宽 `JsonObject`，status snapshot 根本不携带该值。

### 因果与影响分层

- **当前影响：** CLI status 可用于人/既有 supervisor 的宽松观察，但不能证明磁盘中立、契约精确或一致快照；活性数组不能区分 pid 陈尸、进程活/socket 死、socket 可连/RPC 卡死。
- **未来 GUI 影响：** 若直接复用，daemon 死态查询可能改盘/迁移；页面可能显示跨时点混合状态；活性会被迫从折叠结果再推断，违反 A/F 与 D7；未知/错误会被误画成“没有 daemon”。
- **纯证明缺口：** 当前测试证明 taskTree round-trip、迁移、若干生命周期约束和 CLI 读到 taskTree；没有严格只读 opener、byte/metadata 中立、并发 writer 一致性、七槽负例、序列化后 boundary、三证组合/权限/timeout 的证明。

### 可保留资产、未知与下一步

可保留：`TaskTreeSnapshot` ADT 与 `TaskTreeSnapshotBoundary`；SQLite 各 row exact boundaries；normalized v3 tables/FK/check；closure consumed 清 sessions、active run↔closure/run 校验；历史 v13/v14→v16 退化 seq 树迁移；纯函数 `rateLimitStatusFromState` 的实际字段与测试。

未知必须沿确定路径补证：Bun `Database` 真正 read-only flags/URI 和 WAL 下跨语句 snapshot 行为（用隔离 root 的最小并发实验）；无权限 pid/socket/db 的平台错误矩阵；半开 socket timeout（隔离 Unix socket server）；真实历史盘全版本只读拒绝结果。下一步应先由供给侧交付物定义并验证只读 opener/类型化错误、单事务快照、完整精确 boundary 与三证 ADT；在这些事实落定前继续阻塞 R4/R5，禁止进入 GUI 需求设计。

## B. 证据附录

### B1. 逐条设计三态

| 锚点 | 状态 | 可证伪结论 |
|---|---|---|
| D1 严格只读入口 | **缺失** | `openSqliteStateStore` 唯一 opener 为 read-write、WAL、migration；status 的每个 DB helper均调用它。 |
| D3 七槽精确 boundary / 类型单源 | **缺失** | `target/state/queue/runs/current/events/processes` 七槽仍为 `"object"`；TS 类型另写；输出还有 post-assert flatten。 |
| CAP-1 taskTree shape | **部分成立** | ADT/boundary/normalized persistence/迁移/写约束成立；但读取非事务快照、历史退化树由迁移副作用生成，不能满足 D1/一致性。 |
| D9 树如实供给 | **部分成立** | status 暴露 persisted tree，未从 git/worktree/process 推断；但跨语句/跨连接撕裂使“同一时点如实”无保证。 |
| D7 三证独立 | **缺失** | pid file 未输出；socket connect 与 RPC 合并；ps/socket合并去重；missing socket 错误丢弃；无 timeout；rateLimit未进入 status snapshot。 |
| daemon-down 快照 | **部分成立** | socket 失败不会阻止 DB 路径继续，但 DB 路径仍可写/迁移；错误结果把多个失败归为 `missing-state`，无 schema mismatch ADT。 |

### B2. Boundary、builder、输出与全部入口/消费者

1. `src/loop.ts:520-529`：`StatusSnapshotBoundary` 八槽中七槽为匿名 `"object"`，仅 `taskTree` 引用 `TaskTreeSnapshotBoundary.or("null")`。
2. `src/loop.ts:936-1077`：`CoderLoopStatusSnapshot` 及所有七槽 TS 类型是手写平行 shape；不是从 ArkType boundary 推导。`StatusEventsSnapshot.recent/latest` 仍是宽 `JsonValue`; `StatusProcessSnapshot` 只含 `live/scanError`。
3. `src/loop.ts:3113-3177`：唯一生产 builder `buildCoderLoopStatusSnapshot`；组装完成后 assert boundary。失败支路 `3126-3140` 也回退到 unavailable snapshot。
4. `src/loop.ts:2130-2135`：CLI `status --json` 调 builder，再次 assert。
5. `src/loop.ts:3330-3332`：输出经 `flattenExtraReplacer` 序列化；它在 assert 后把任何含 `extra` 的对象改成 `{...extra,...rest}`。因此 boundary 没有验证最终 wire JSON；extra key 与 rest 撞名时 rest 胜出，且 wire shape 与 TS/builder shape不同。
6. 全仓调用检索 `rg "buildCoderLoopStatusSnapshot"`：生产调用只有上述 CLI；其余为测试 harness/测试（daemon hooks、runs-observability、install-commands）。当前没有 HTTP/gateway 消费者。`StatusSnapshotBoundary` 未导出；integration harness 自建了只覆盖 `events.recent` 的同名局部 boundary（`tests/integration/daemon/harness.ts:117`），是同错/平行 shape 线索。

### B3. SQLite 打开、迁移、daemon-down 与失败语义

- `src/sqlite-state.ts:822-856`：`createIfMissing:false` 只阻止创建不存在 DB；实际 `new Database(... { create, readwrite:true, strict:true })`，随后 `foreign_keys`, `busy_timeout`, 读取/可能设置 `journal_mode=WAL`，无条件调用 `migrateStateSchema`。
- `src/sqlite-state.ts:948-1005`：migration 读 schema、按条件关 FK，并在 transaction 内 CREATE/ALTER/rebuild/迁移；`STATE_SCHEMA_VERSION=16`（`:810`）。这直接反证“读取无 migration/journal mutation”。
- `src/loop.ts:4176-4217,4230-4272`：chain 解析、items、taskTree、runs、current 每次各自新开上述 store 并关闭；没有只读专用入口。
- DB 不存在/open/migration/旧 preset 失败最终由 `buildCoderLoopStatusSnapshot` catch 为 `state.kind="missing-state"`, `errorPath="chain"`（`src/loop.ts:3126-3140`）；没有 schema-version mismatch variant，且“missing”混入不可读/迁移失败。
- daemon 是否存活不参与 opener 选择。daemon down 时 DB 能读只是偶然成立，严格磁盘中立不成立。

**副作用/崩溃窗口：** WAL mode 切换在 migration transaction 之前；migration 会临时 `foreign_keys=OFF`（`src/sqlite-state.ts:999`）并做多表 rebuild。transaction 可原子提交其内 DDL/DML，但 journal/header/WAL 元数据及迁移尝试本身已是写副作用；进程在 WAL 切换后、migration前退出可留下模式/sidecar变化。本文未对生产 DB 实验。

### B4. 一致性与并发 writer

- builder 顺序为 items→current→加载 presets→selected/errors/currentSnapshot/events→processes→runs→taskTree（`src/loop.ts:3144-3174`）。每个 DB 片段独立 connection，无包围 transaction，所以任何两个片段间 writer commit 都可被后段看到。
- `rowToTaskTree` 先读 root、递归逐节点/children/closure/sessions/join，最后另读 `active_runs`（`src/sqlite-state.ts:2477-2516`）；没有 `db.transaction`。SQLite autocommit 下每条 SELECT 独立 read transaction，因此可跨 writer commits。
- 具体可证伪撕裂：items 读到 run 前状态，current 读到 run 后状态；runs 读到清理前、taskTree.activeRuns 读到清理后；树 root存在但 writer 删除/替换 child 后递归报 `invalid_json`；closure lifecycle 与最后读取的 activeRuns不属于同一提交。
- 写路径本身有 transaction wrapper（`createSqliteStateStore` 的 `write(...)`，以及 createTaskTree/lifecycle 等），只能保证单次写原子，不能给跨连接 reader 提供统一 snapshot。

### B5. taskTree 从持久化到重建、生命周期与历史

**shape/单源资产：**

- `src/task-runtime.ts:13-58`：closure lifecycle `active|suspended|consumed`，resource/branch/base/sourcePar/sessions；join `drain|validator` 与 evaluation `not-evaluating|evaluating|decided|consumed`（epoch/bindingVersion）；leaf/seq/par union；par pin/state/reopen/join；tree activeRuns。
- `src/task-runtime.ts:60-178`：递归 validator，variant-specific exact key 检查，最终 `TaskTreeSnapshotBoundary`。这部分 TS 仍手写在 boundary 前，但运行时 exactness强于七槽；`assertTaskTreeSnapshot` 是持久层回读出口。
- `src/sqlite-state.ts:653-760`：normalized tables与 FK/CHECK；closure 非 consumed 必有 worktree/branch；active_runs 与 runs/closure FK。
- `src/sqlite-state.ts:1974-1994`：create tree和 lifecycle在 store write transaction中；active run 阻止转非 active；consumed不可复活；consumed清 sessions。
- `src/sqlite-state.ts:2468-2482`：active run写入校验 chain/phase/lifecycle以及 durable run identity；读后对全树再 assert。

**历史语义：**

- `tests/unit/sqlite-state/migrations.test.ts:130-190` 证明 v13/v14盘在 open 时迁移成 seq退化树、sessions/current runs/context保留；这同时证明历史消费依赖“读时写迁移”，不是严格只读兼容。
- `tests/unit/sqlite-state/task-tree.test.ts:397-408` 钉 join binding/evaluation round-trip；`:452-476` 钉 migration 后 definition 不再依赖可变/删除的 preset source。
- scheduler/worktree tests覆盖 consumed清资源/保留历史分支的不同证据语义、reconcile与重启，但没有把 status builder 在并发 writer 下作为单时点读取验证。

**语义边界：** taskTree 展示的是 normalized persisted事实，而非 worktree/git/process推断，符合 CAP-1“同一事实源”方向；但 `taskTree:null` 同时可能表示无树、unavailable fallback、builder前置失败，消费者需等待精确外层 error ADT 才能区分。

### B6. pid / process scan / socket / daemon.status 三证

- pid 文件由 daemon start 写、stop删（`src/daemon.ts:1264,1655`）；`readDaemonPid` 是私有 helper，仅供“socket pathname缺失且 pid/group活”的启动/连接错误诊断（`:6011-6041`）。status snapshot不读取/输出 pid-file evidence。
- process scan：`src/loop.ts:3631-3645,3677-...` 用同步 `ps -axo`按 target过滤；scan失败仅成一个字符串。随后 socket返回的 daemon pid若未重复就 append，若重复则丢掉 socket来源，证据被折叠。
- socket + RPC：`readCentralDaemonProcessInfo` 只调用一次 `sendDaemonRequest(...daemon.status)`（`:3648-3659`）；connect成功与完整应答没有分别建模。socket失败映射 `kind:"missing"`，而 caller只记录 `kind:"invalid"`，故 socket失败不进入 `scanError`（`:3635-3641`）。
- transport：`sendDaemonRequest`（`src/daemon.ts:4652-4689`）只有 connect/data/error/close监听，无 timeout；存在 socket路径但 server不accept/accept后不回换行会无限等待。权限错误、ECONNREFUSED、ENOENT最终同落 missing消息，无法独立呈现。
- `daemon.status` 实际 snapshot 包含 pid/socketPath/pidFile/running/shuttingDown/schedulerEnabled/activeRuns/rateLimit/两类 persistence failure（`src/daemon.ts:312-325,1282-1306`），但类型把 activeRuns与rateLimit写成 `JsonObject[]/JsonObject`。
- `rateLimitStatusFromState` 有实际 11 字段（active/mode/timestamps/type/source ids/nextResume/staggerMs，`src/daemon.ts:376-396`），integration tests逐字段覆盖（`tests/integration/daemon/rate-limit.integration.ts:56-130`）。这可收紧为精确 ADT，但当前 status builder只把 daemon response投影成 `StatusProcessInfo`，丢弃 rateLimit、activeRuns、shuttingDown与failure信息（`src/loop.ts:3662-3674`）。

### B7. 测试覆盖、同错与盲区

**已有证明：**

- CLI daemon-down JSON错误与“pid活/socket pathname缺失”有 integration（`tests/integration/cli/central-cli.integration.ts:934-999`），但这是 daemon CLI error envelope，不是三证 snapshot。
- CLI status taskTree read（`tests/integration/cli/db-main-loop.integration.ts:15-47`）；task tree exact ingress/round-trip/join/history/migration测试；rateLimit纯投影测试。
- daemon connection integration覆盖慢连接之间不互相阻塞、连接关闭不完整响应等 daemon server行为；没有 client timeout。

**同错/盲区：**

1. 无测试断言 status read 前后 DB/main/WAL/SHM/schema byte+metadata不变。
2. 无 read-only opener、旧/新/未来 schema mismatch类型化测试。
3. 无七槽逐槽非法 shape负例；顶级 boundary不导出，测试无法作为消费者单源。
4. 无最终 stringify JSON重新 parse boundary测试，flatten extra漂移未被钉住。
5. 无 concurrent writer + status snapshot一致性测试；绿的 store round-trip不证明跨连接 builder一致。
6. 无三证组合矩阵（pid file absent/stale/malformed/permission；process alive/dead/PID reuse；socket absent/stale/permission/accept-no-response；RPC invalid/timeout）。
7. 无“daemon.status rateLimit/activeRuns 进入 status snapshot”的测试，因为实现未携带。

### B8. 最小实验与限制

本轮没有执行会写产品/生产 loop-data 的实验；仅做静态源码与测试证据审计。固定约束禁止修改产品代码/生产数据库。以下实验仍需在 `/tmp` 隔离 root 执行并清理：

1. 复制/构造 v16 DB，记录 DB/WAL/SHM inode、size、mtime、hash；daemon down下重复 status，证明现状是否发生 metadata变化，并对照未来 readonly opener。
2. writer在两个 builder分段读取间提交 active run/lifecycle变更，循环捕获撕裂；未来实现应以单 connection显式 read transaction消除。
3. Unix socket server分别“不 accept”“accept不回行”“回 invalid JSON”“权限拒绝”，对 client加外部时间界限，确认现状无限挂/错误折叠。
4. stale/malformed pid与活进程PID组合，分别记录三证原始结果，禁止再以 `processes.live`去重数组充当证据。

### B9. 证据索引（命令）

```text
git rev-parse HEAD
rg -n "buildCoderLoopStatusSnapshot|StatusSnapshotBoundary|getTaskTree|taskTree|daemon.status|rateLimitStatusFromState" src tests
nl -ba src/loop.ts | sed -n '520,529p;936,1077p;3113,3177p;3290,3332p;3631,3674p;4176,4272p'
nl -ba src/sqlite-state.ts | sed -n '653,760p;810,856p;948,1005p;1974,1994p;2468,2516p'
nl -ba src/task-runtime.ts | sed -n '13,178p'
nl -ba src/daemon.ts | sed -n '312,396p;1282,1306p;4652,4689p;6011,6041p'
```

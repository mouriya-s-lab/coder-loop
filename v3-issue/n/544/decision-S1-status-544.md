# RFC #544 R8 / S1 — status 读、一致性与 wire 决策档案

> 事实基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本档只使用 AGG 的 D1、D3、CAP-1、D9 稳定条款，以及 R7 I01–I03 与收口核算；不重新调查源码、不提出推荐、不估算工作量或拆分实施单元。

## A. 操作员摘要（≤一页）

现有 status 把三种责任叠在一起：唯一 opener 同时打开、设 WAL、迁移，故 reader 执行 writer 初始化；至少五个连接加 taskTree 多条 autocommit `SELECT` 分段取快照，writer 可在其间提交；builder 的手写 domain 对象只经七个宽 `"object"` 槽检查，assert 后又由 generic replacer 平铺 `extra`。结果是一次读取可改 DB sidecar/schema、拼出从未同 commit 存在的对象，再输出未经精确 boundary 验证的另一种 wire。

稳定条款已定：D1 要求 read-only、零 WAL/journal/migration mutation、类型化 schema mismatch、daemon-down 重读 byte/metadata 中立；D3 要求无匿名槽且 TS 从 boundary 派生；CAP-1/D9 要求 taskTree/closure 持久事实经同一 shape 暴露并被 GUI 穷尽、无平行推断地渲染。因此读路径副作用、错误折叠、SQLite 跨提交撕裂、宽 boundary、平行 TS 和 post-assert 未验证 wire 都是**必须修的已确定偏离**。

稳定设计也已固定契约对象：**最终 CLI `status --json` 与 HTTP response wire 必须通过同一个 engine-owned 精确 boundary，网关/前端类型从该 boundary 派生，不存在平行 wire schema。** 内部 domain 是否另有结构、是否先投影再验证，属于工程布局；不能改变最终 wire 的验证义务。

工程分叉有三轴：独立 strict opener 或穷尽 mode ADT；显式 read transaction 贯穿全部 SQLite 槽，或在同一 transaction 内先取完整持久投影；以及在序列化前形成 canonical wire，或让内部 domain 与 wire 同形。仅文件权限、`createIfMissing:false`、跳过 migration、复用连接、逐 helper transaction或增加宽边界 reparse 测试均被反例淘汰；改走 daemon RPC则违反既定 SQLite 数据面并破坏 daemon-down 读取。

## B. 事实、形态、后果与裁决底稿

### B1. 当前链路与已证偏离

| 层 | 当前事实 | 触发条件 | 可观察后果 | 稳定条款判定 |
|---|---|---|---|---|
| SQLite open | `openSqliteStateStore` 固定 `readwrite:true`，必要时切 WAL，并总调用 migration | 非 WAL 盘、旧 schema、WAL reader、只读权限组合 | v15→v16 主 DB/schema 改写；正常 WAL 重复读改 `-shm`；DELETE+0444 因尝试写失败 | D1 偏离已确定 |
| 错误分类 | store 仅 `db_unavailable/sqlite_error`；初次 load catch-all 变 `missing-state`，CLI exit 0；未来 version 99 可被接受 | 缺盘、损坏、权限、旧/未来 schema、失败发生在初次或后续 helper | 同一底层问题因时点变成正常 missing-state 或 command reject；没有 schema mismatch ADT | D1 偏离已确定 |
| status DB read | chain→items→current→runs→taskTree 至少五连接，无贯穿 read transaction | writer 在 helper 间提交 | queue/current/runs/tree 可分别来自不同 commit，仍过 shape boundary | CAP-1/D9 所需如实持久投影偏离已确定 |
| taskTree read | 单连接、多 statement、深度优先递归，无 read transaction | writer 在 root/children/closure/session/join/activeRuns 查询间提交 | 合法跨提交 tree，或 child/root 消失后 `invalid_json` 整体失败 | CAP-1 exact ADT 不能替代 commit coherence |
| boundary | 七槽为宽 `"object"`，taskTree 才是 exact ADT；TS shape 平行手写 | 缺字段、extra key、Date/function/Map 等进入宽槽 | 非法 shape 可过 assert；某些值 stringify 后越界或崩溃 | D3 偏离已确定 |
| wire | `flattenExtraReplacer` 在 assert 后递归平铺任意 `extra`，冲突 rest-wins | item/current run 的正常 `extra`；任意未来同名字段 | builder 与 wire 已经不等价；wire 无 production final assert | 违反最终 CLI/HTTP wire 必须经同一精确 boundary 的固定要求 |

非 DB 的 events/processes 本来具有独立时钟；本档所称“单提交”只约束来自 SQLite 的持久槽及 CAP-1 taskTree，不把跨系统全局时钟新增为需求。

### B2. 复杂因果与放大条件

| 因果链 | 放大条件 | 消费端结果 |
|---|---|---|
| writer 型 opener → status 重复 reopen → WAL/migration 运行 | 历史盘、DELETE journal、daemon down 后反复刷新、WAL sidecar 存在 | GUI 的“只读观察”改变被观察盘；不可消费与权限故障被误报 |
| 多连接/多 statement → WAL 允许语句间 writer commit → shape-only assert | 活跃 scheduler、树深/节点多、异步 events/process 探测拉长窗口 | D9 可能忠实渲染一个从未整体存在的组合，或刷新偶发失败 |
| 手写 TS + 宽 boundary → post-assert generic rewrite | 新字段、optional 分支、`extra` 冲突、非 JSON 值 | 内部/CLI/GUI各自对不同 shape 自洽，编译器与 runtime 均不能闭合整链 |
| catch 位置决定分类 | 错误发生在 chain resolution 或后四次 reopen | 问题本体相同而 wire/exit 不同，恢复 UI 无可靠判据 |

### B3. 事实支持的实现形态与确定后果

下表列出当前证据能支持的**形态族**；它们可以正交组合，不声称穷尽未来具体 API。任何新增具体机制仍须证明满足表内不可省略性质。

| 维度/形态 | 必须具备的可证性质 | 确定后果 | 不成立或淘汰边界 |
|---|---|---|---|
| **R-A 独立 strict-read opener** | OS/SQLite 层 read-only；不执行 journal PRAGMA/migration；先分类 schema consumability；重复读取全文件 byte/metadata 中立 | writer opener 可保留现有初始化职责；status/gateway只能取得 strict reader 类型 | 若内部仍调用 writer opener，或只靠文件权限阻止写，则不成立 |
| **R-B opener mode ADT** | `runtime-write` 与 `strict-status-read` 穷尽分支；strict 分支在构造期排除 create/WAL/migrate；错误为精确 variant | 可共享连接基础设施，同时让 compiler 暴露 mode 消费点 | boolean flag/可选参数组合若仍允许 strict+迁移非法状态，不满足职责隔离 |
| **R-C 先取得只读持久投影** | 所有 SQLite 槽在一个显式 read transaction 内读取为完整值，再关闭 transaction并组装非 DB 槽 | 持久部分对应一个 commit；缩短持锁/快照生命周期的组装可移出 transaction | 若 taskTree 在 transaction 外继续查 DB，则仍撕裂 |
| **R-D transaction 贯穿 SQLite builders** | 单连接、显式 read transaction覆盖 chain/items/current/runs/taskTree全部 statements | 实验已证明 writer可并发提交而 reader得到 transaction 起点旧整形 | 只复用连接或每个 helper各自 transaction仍跨 commit |
| **W-A 序列化前形成 canonical wire** | domain先经显式投影形成最终JSON shape，再由唯一engine-owned精确boundary parse；TS/GUI类型从它派生 | 可保留内部domain结构差异；CLI/HTTP消费同一个已验证对象 | 另写平行wire schema、assert后继续结构改写或不复parse均不成立 |
| **W-B domain/wire同形** | 移除post-assert结构改写；同一个engine-owned精确boundary验证的对象直接序列化 | 类型与wire单源；内部`.extra`消费形态需迁移 | 静默删除既有平铺字段语义不允许，必须进入D3 shape diff |
| **E-A schema consumability ADT** | 至少区分可消费、缺盘/不可用、明确 old/new mismatch及其他损坏/权限域；分类不受失败发生在哪个helper影响 | daemon-down UI与CLI可给可证伪状态；future version不再静默当current消费 | 把所有异常继续标 `missing-state`，或只新增错误文案，均不成立 |

**因固定基线而淘汰的超范围形态：**

- status 全部改由 daemon RPC：违反既定 SQLite snapshot 数据面，且 daemon down 时无法读取；要成立必须改写 D1/D5 基线，故不进入工程比较。
- 从 git/worktree/process 重建 taskTree：违反 CAP-1/D9 的持久事实源红线。
- 为获得“全球同一时刻”把 events、process、SQLite 纳入新分布式事务：稳定条款没有此要求；这是范围增长，不进入设计。

### B4. 具体触点

| 责任 | 当前模块/函数/表 | 实施时必须触达的证明面 |
|---|---|---|
| opener / migration / error | `src/sqlite-state.ts`：`openSqliteStateStore`、`migrateStateSchema`、`translateSqliteError`、`SqliteStateErrorCode` | strict mode无法走 WAL/migrate；old/future/corrupt/permission/missing 分类矩阵 |
| read transaction | `src/sqlite-state.ts`：store `read`/`write`；`getTaskTree`；递归 task node/closure/session/join/active-run queries | 第二 writer + barrier；transaction 内所有 taskTree statements保持同一 commit |
| status orchestration | `src/loop.ts`：`buildCoderLoopStatusSnapshot`、`loadTargetRuntime`、`readDbItemsForChain`、`readDbCurrentRun`、`readDbRunsForChain`、`readDbTaskTree` | 一个 strict read resource/持久投影贯穿全部 SQLite 槽；分类不依 helper顺序 |
| boundary/type/wire | `src/loop.ts`：`CoderLoopStatusSnapshot`、`StatusSnapshotBoundary`、`stringifyStatusSnapshot`、`flattenExtraReplacer`、两个 CLI入口 | 八槽正反例；顶层 exact；类型从 boundary派生；最终 wire同一边界 parse；`extra`冲突/兼容 golden |
| CAP-1 schema | `src/task-runtime.ts`：`TaskTreeSnapshotBoundary`；SQLite 的 `task_trees/task_nodes/task_*_nodes/task_closures/closure_sessions/task_join_* /active_runs` | 外部 shape逐字段集成，不改写；leaf/seq/par exhaustive；commit coherence另证 |
| 现有测试资产 | `tests/unit/sqlite-state/migrations.test.ts`、`crud.test.ts`、`task-tree.test.ts`；`tests/integration/cli/db-main-loop.integration.ts`、daemon harness/runs-observability | migration测试保留为 writer资产，不冒充read证明；新增 readonly metadata、并发barrier、完整wire边界链 |
| 最终消费 | CLI status/daemon status、doctor、daemon-start、未来 gateway HTTP与D9 GUI | CLI/HTTP最终wire通过同一个engine-owned boundary；真实活chain与daemon-down生产route验证 |

### B5. 仍未知，但不阻止当前决策

| 未知 | 当前允许的最窄主张 | 获取方式/何时需要 |
|---|---|---|
| 真实历代生产盘全集、历史 `extra` 冲突全集 | 已有代表性 v15/v16/future/corrupt 反例足以证明当前偏离 | 实施兼容矩阵时对只读副本盘统计 |
| 特殊/网络文件系统、断电与 migration `SIGKILL` | 不能声称所有 FS/durability 行为；不影响已证本机副作用与职责错误 | 若交付声明覆盖这些环境，另做定向实验 |
| 生产 writer 频率、最大树深/节点数 | 不能量化发生频率；可达性已证 | 性能/事务寿命验证时采样真实只读副本 |
| 仓外消费者是否把 response 当单时点、全部 optional wire 分支 | 不用于降低 D1/D3/CAP-1/D9；可能影响兼容 diff | D3 shape diff与消费清单核对 |
| 哪个 Bun/SQLite 只读打开配置能同时读取 live WAL 且 byte/metadata 中立 | 需求性质已定，具体配置尚无本组运行证据 | R9实施前最小技术 spike；失败则比较仍符合D1的数据获取机制，不放宽D1 |

### B6. 固定需求与工程问题分离

| ID | 类别 | 问题 | 本档状态 |
|---|---|---|---|
| F1 | 已确定偏离 | strict read、schema mismatch、byte/metadata中立当前未成立 | 必须修，不再裁是否需要 |
| F2 | 已确定偏离 | SQLite持久槽/taskTree不属于同一 commit | 必须修，不以shape收紧替代 |
| F3 | 已确定偏离 | 七槽不精确、TS平行手写、assert后wire改写 | 必须修；最终CLI/HTTP wire由同一engine-owned精确boundary验证 |
| E1 | 工程分叉 | R-A/R-B、R-C/R-D及其组合如何落到API | R9比较；不得加强基线或越层 |
| E2 | 工程分叉 | W-A/W-B的具体domain/projection/serializer布局 | R9比较；必须保留可审shape diff且不得产生平行schema |

### B7. 证据索引

- 稳定条款：`AGG-544-gui-observability-gateway.md:177-187`（D1）、`:212-232`（D3）、`:364-383`（D9）、`:492-498`（CAP-1）。
- strict-read、副作用、错误分类与消费者：`detail-I01-544.md` B1–B7。
- domain/boundary/wire阶段、八槽反例与历史：`detail-I02-544.md` B1–B7。
- 多连接、多 statement、并发 barrier 与 transaction对照：`detail-I03-544.md` B1–B7。
- R7 gate、偏离/裁决/工程分叉分类：`detail-investigation-audit-544.md` B1、B3–B5。

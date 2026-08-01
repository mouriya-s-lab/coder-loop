# RFC #544 R7 / I01 — SQLite 严格只读与失败分类

> 基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。设计锚点仅取 AGG D1、D5；既有事实线索取 R5 L01/L02/L09/L10 与 R6 I01。调查环境：macOS，Bun `1.3.14`，Bun 内嵌 SQLite `3.43.2`（系统 `sqlite3` 同为 `3.43.2`）。实验只使用 `/tmp/coder-loop-544-I01-*`，已清理；未接触 `~/.coder-loop`。

## A. 一页结论

### 问题与结论

问题：当前 status opener→snapshot 在缺盘、正常盘、旧 schema、权限只读和带 WAL 历史盘上实际做什么；错误在哪层被分类/折叠；这些事实给 D1 严格只读和 D5 daemon-down 消费留下什么边界？

**高置信结论：当前路径不是只读路径，也没有 schema-version mismatch 语义。** 唯一 opener 总以 `readwrite:true` 打开，先设置连接 PRAGMA，必要时永久切换 WAL，再无条件调用 migration。snapshot 首次打开该 store 解析 chain，随后 items/current/runs/taskTree 又分别重开；daemon 是否存活从不参与选择。由此产生四类已实测后果：

1. 缺盘在 `createIfMissing:false` 的存在性检查处停止，目录不变；store 给 `db_unavailable`，但 snapshot 把它变成 `state.kind="missing-state"`，CLI 输出 JSON 且退出 `0`。
2. 当前 v16 WAL 盘重复 snapshot 不改主 DB hash/mtime，却每次改 `db.sqlite-shm` 的 hash/mtime/ctime；这已反证 D1 的“DB/WAL/journal byte/metadata 中立”，即使业务数据没有变化。
3. v15 历史盘在一次“open/read”中升级为 v16：`runs` schema 增列，主 DB hash、mtime 和 schema 改变。未来版本号 `user_version=99` 不会得到 mismatch；只要结构满足当前探测条件就被接受并保持 99。
4. 同一 v16 schema 在 `DELETE` journal + 文件 `0444`/目录 `0555` 时因尝试 `PRAGMA journal_mode=WAL` 报 `sqlite_error: attempt to write a readonly database`；同盘预先为 WAL 时 opener 成功，但仍改 `-shm`，且把零长 `-wal` mode 从 `0644` 改为 `0444`。因此“能在只读权限下打开”与“严格磁盘中立”不是同一性质。

### 简明因果链

历史 schema 兼容、WAL 正常运行和业务读写共用一个 store opener → opener 同时承担“打开 + journal 配置 + 原地迁移” → status 所有 DB 读取复用该 opener且多次重开 → SQLite 为 WAL reader 更新共享内存/锁元数据，旧盘直接 DDL/DML 升级 → 初次 load 的任意异常又被 snapshot catch-all 标成 `missing-state` → D5 若直接复用 builder，daemon-down 页面既可能改盘，也无法区分缺盘、损坏、权限、迁移失败、chain 选择失败或未来 schema。

### 当前/未来消费者影响

- 当前消费者：`coder-loop status`、`coder-loop daemon status`、daemon start 的“已有进程”探测、doctor、install commands；测试也直接 import builder。它们共享上述副作用和错误折叠。
- D5 未来 gateway 若照 AGG 所述直接消费当前 builder，会继承 read-write 打开、迁移、WAL/SHM metadata 写和错误折叠；daemon-down 只表示 writer 进程不在，不会改变这些代码或 SQLite reader 的 sidecar 行为。
- “修正错误标签”而仍复用现 opener，会保留磁盘副作用；“只禁止 migration”而仍以 read-write/WAL opener 重复打开，会保留 journal 切换和 SHM/sidecar metadata；“只设 `createIfMissing:false`”只防新建主 DB，不能证明严格只读。

### 可保留资产、证明缺口、未知

- 可保留资产：缺盘前置检查与 `db_unavailable` store code；migration 主体置于单个 `BEGIN IMMEDIATE` transaction；历史 v13–v16 fixture/结构与幂等 migration 测试；snapshot 最终精确 boundary assert；正常 WAL reader能读未 checkpoint 的 commit。
- 纯证明缺口：现有测试没有 readonly opener、byte/metadata 中立、未来/旧 schema mismatch、权限/journal 组合、reader sidecar、status CLI 错误退出语义、迁移进程崩溃恢复。migration 单元测试恰以同一会迁移的 opener 作为 reader，不能发现读路径副作用。
- 未知：真实历代生产盘全集、网络/特殊文件系统锁语义、进程在 migration transaction 中被 `SIGKILL` 后的恢复尚未运行。可确定方式见 B7 的隔离 crash recipe；在完成前只能声称 SQLite transaction 包住 migration SQL，不能声称所有进程崩溃点均 byte/metadata 中立。

**R8 材料状态：具备。** 根因集合、放大条件、消费者边界与纯证明缺口已能进入 R8；无需为 I01 继续猜测方案。

## B. 完整调查

### B1. 调用链与错误边界穷尽

1. `buildCoderLoopStatusSnapshot` 首先 `loadTargetRuntime`（`src/loop.ts:3113-3125`）；其 DB chain resolution 调 `openSqliteStateStore({createIfMissing:false})`（`:4176-4179`）。
2. chain 解析成功后，items、current、runs、taskTree 各自通过 helper 再开独立 store（`:3142-3175,4230-4272`）。因此一个空队列 snapshot 至少触发 chain/items/current/runs/taskTree 五次 open/close；本报告只调查 I01 的副作用，跨连接单时点一致性归 I03。
3. store 唯一生产 opener 是 `src/sqlite-state.ts:822-856`：存在性检查 → `new Database(...,{create,readwrite:true,strict:true})` → `foreign_keys`/`busy_timeout` → 查询/必要时设置 WAL → `migrateStateSchema`。
4. migration 先用 version+结构探针决定是否 early return（`:948-998`）；否则可能在 transaction 外关闭 foreign keys，主体以 `.immediate()` transaction 做 DDL/DML/`user_version=16`，最后恢复 foreign keys（`:999-1089`）。
5. opener 层分类只有：不存在/无法 open 为 `db_unavailable`；其余初始化和 SQL 错误经 `translateSqliteError` 成 `sqlite_error`（`:826-853,2798-2801`）。没有 schema mismatch code。
6. snapshot **只 catch 初次 `loadTargetRuntime`**；捕获任何 error 后固定构造 `missing-state`（`src/loop.ts:3126-3140`）。chain 不存在/歧义、preset 解析失败、损坏 DB、权限与 migration 错误因此同槽。初次 load 之后的 helper/read/preset 错误不在此 catch 内，会 reject 到 CLI 顶层。
7. 生产消费者穷尽：status CLI（`:2130-2135`）、daemon status（`:2872-2880`）、daemon start preflight（`:3875` 起）、doctor（`src/install-commands.ts:272-282`）；仓外未来 D5 gateway 尚不存在。直接 store 的 daemon writer（`src/daemon.ts:1252`）不是 snapshot consumer，但解释了为何 opener 历史上同时做运行初始化。

### B2. 代表性运行矩阵

所有前后比较均记录目录成员、mode、size、mtime/ctime、SHA-256，并用只读 `bun:sqlite` 连接查询 `user_version`、`journal_mode`、`sqlite_master`。

| 场景 | opener / snapshot 结果 | 文件/schema 副作用 | 错误/输出语义 |
|---|---|---|---|
| 缺 `db.sqlite`，目录存在 | opener `db_unavailable`; snapshot 返回 | 前后目录均空 | snapshot `missing-state`; CLI JSON stdout、stderr 空、exit `0` |
| 正常 v16 WAL + chain；连续两次 snapshot | 两次均成功构造 `loaded:true`（fixture runtime dirs 缺失故 `invalid-runtime`，与 DB 打开正交） | 主 DB `217088` bytes、hash/mtime 不变；`-wal` 0 bytes 不变；`-shm` 首读 hash改变，且每次 mtime/ctime推进 | 无 DB error |
| 真实测试同形 v15（`runs` 缺 `closure_id/runtime_node_id`） | opener 成功 | `user_version 15→16`；主 DB hash `adf7…→2a7b…`、mtime推进；runs schema被重建/增列 | 不是 mismatch；“读取”完成迁移 |
| 当前结构但 `user_version=99` | opener 成功；snapshot因无 chain返回 | version 保持 99；主 DB hash/mtime不变；`-shm`变化 | 未来 schema 没有 mismatch；无 chain又被标 `missing-state` |
| v16，journal=DELETE，DB `0444`、目录 `0555` | opener失败；snapshot返回 | 主 DB/hash不变 | store `sqlite_error` / readonly；snapshot `missing-state`；无法区分 schema/权限 |
| v16，已为 WAL，DB `0444`、目录 `0555` | opener成功 | 主 DB不变；`-shm` hash/mtime变化；零长 `-wal` ctime/mode变化（`0644→0444`） | 权限可开不代表 metadata 中立 |
| live WAL，有未 checkpoint 的 chain commit（WAL 12392 bytes） | opener和 snapshot成功，读到 chain | reader前后主 DB/WAL hash、mtime不变；`-shm` hash变化；显式 writer checkpoint 才改主 DB hash/mtime | 证明 WAL history 可消费，也反证 sidecar metadata 中立 |
| 9-byte 损坏文件 | opener初始化报 `file is not a database`; CLI snapshot返回 | 未创建新主 DB | 与缺盘相同 `missing-state`，exit `0` |

注意：实验中的“正常盘主 DB hash不变”不能升级为严格只读证明；同一实验已经观察到 SHM metadata 写，而且 journal/schema 条件一变会写主 DB。

### B3. 直接机制与上游来源

**直接机制 A：opener 职责耦合。** `readwrite:true` 是固定值，不由 caller 或 daemon 活性决定；`createIfMissing:false` 只影响 `create` 与提前 exists check。WAL 是持久数据库属性，`PRAGMA journal_mode=WAL` 在非 WAL 盘需要写。migration 每次调用，early return 依赖“version 至少 16且整套结构探针满足”，不是读取模式。

**直接机制 B：WAL reader 的 sidecar 协作。** 正常盘和 live-WAL 实验均显示主 DB/WAL payload可保持，但 `-shm` 的 hash/mtime改变。只读权限的 WAL 盘也出现 SHM/零长 WAL metadata变化。因此严格只读若把 DB/WAL/journal/schema 的 byte/metadata 全纳入，不能以“只有 SELECT”或“主 DB hash不变”代替证明。

**上游/历史来源：** migration 注释记录 schema 演进：v9 item preset、v11 umbrella 字段退役、v12 GitHub 物理列退役、v13 runner CHECK、v14 context/runtime 两条历史分叉、v15汇合、当前 v16（`src/sqlite-state.ts:805-815,952-975`）。运行 daemon 与所有读者共用 store，使“打开即保证最新 schema/WAL”成为方便的兼容策略；但 D1/D5 新增的是不同信任边界，不能从旧策略推出只读性质。

### B4. 错误分类和折叠的因果影响

store 的 `SqliteStateErrorCode` 有 `db_unavailable` 与通用 `sqlite_error`，但没有 old/new schema、permission、corruption、migration-failed variants（`src/sqlite-state.ts:34-51`）。snapshot catch 更进一步丢弃 code/details，只保留 `errorMessage` 并固定 `stateKind:"missing-state"`。

放大条件：

- 失败发生在首次 chain resolution：被折叠并以正常 JSON/exit 0返回。
- 相同 DB 问题若发生在后续四次 reopen/read：绕过 catch，CLI可能直接失败。分类取决于失败时点，而非问题本体。
- future `user_version` 但当前结构兼容：被静默接受；future version且结构不兼容：可能进入当前 migration或普通 SQL错误，仍无“producer newer than consumer”证据。
- daemon down：没有 daemon 提供额外诊断，D5 只能看到该折叠结果；“missing-state”无法支持可证伪的恢复/兼容声明。

### B5. 根因集合（允许多因）

1. **模式根因：** store API 只有运行型 read-write opener，没有表达“只读且不迁移”的 opening mode。
2. **职责根因：** journal 配置、schema compatibility/migration 与连接打开绑定，所有 reader被迫执行 writer 初始化职责。
3. **编排根因：** snapshot 的每个 DB helper都重新使用该 opener；不存在一次打开后贯穿 snapshot 的只读资源边界。
4. **协议根因：** schema version 仅作为 migration触发事实，没有 consumability/mismatch ADT；`>=16 + shape` 甚至允许 99。
5. **错误根因：** snapshot 把首次 runtime load 的多域异常 catch-all 成 `missing-state`，且丢 store error code/details。

只改任一症状会保留其余根因：例如 label 修正不消除写盘；跳过 DDL 不消除 WAL/SHM；只读文件权限不形成类型化 schema boundary；仅减少 reopen 次数也不改变 opener 的写职责。

### B6. 测试同错、盲区与资产

- `tests/unit/sqlite-state/migrations.test.ts:107-127` 明确用生产 opener把 v15迁到 v16，再用 `Database(...,{readonly:true})` 只做事后 schema检查；它证明 migration结果，不证明 status reader只读。
- 同文件 `:194-224` 证明重复 opener migration幂等；幂等不是 byte/metadata中立。
- `tests/unit/sqlite-state/crud.test.ts:494-501` 的“db unavailable”调用默认 `createIfMissing:true` 且父目录缺失，只覆盖 open失败 code；没有覆盖 status的 `createIfMissing:false`、CLI exit 或折叠。
- migration fixtures、历史数据保留断言、schema exact检查可保留为未来兼容证明资产；不能改名充当 D1 验证。
- 缺失矩阵：readonly flag的真实 opener、missing/old/future/corrupt/permission/journal组合、DB/WAL/SHM前后 bytes+metadata、daemon-down重复读取、CLI分类/exit，以及中断 migration恢复。

### B7. migration transaction 崩溃边界

已证静态事实：migration DDL/DML 与 `user_version=16` 位于同一 `.immediate()` transaction（`:1001-1087`）；`foreign_keys=OFF/ON` 位于 transaction 外（`:999,1088-1089`）；journal 切 WAL 又在 migration 之前（`:841-850`）。因此即使 SQLite 对 transaction 内崩溃恢复保持原子，journal模式/sidecar/锁 metadata 也不属于“整个 opener无副作用”的同一原子承诺。

本轮未把未执行的 `SIGKILL` 推断成运行保证。可复现实验为：在隔离 root 构造含大量历史 rows 的 v13/v15盘；父进程持续采样 `user_version/schema/integrity_check`，子进程调用生产 opener；分别在 WAL切换后、DDL中、`user_version`前发送 `SIGKILL`；重开前先复制 DB/WAL/SHM证据，再用当前 SQLite恢复并断言只出现完整旧形或完整v16形，同时记录journal/sidecar差异。现有仓库没有该 crash injection 测试，这是纯证明缺口，不改变本报告已实测的只读失败。

### B8. 证据索引与实验命令

- opener/migration：`src/sqlite-state.ts:822-856,948-1089`
- store错误类型/翻译：`src/sqlite-state.ts:34-51,2798-2801`
- snapshot catch与五次 DB读取：`src/loop.ts:3113-3177,4176-4272`
- CLI消费者：`src/loop.ts:2130-2135,2872-2880,3875-3890`
- doctor消费者：`src/install-commands.ts:272-282`
- migration历史/测试：`tests/unit/sqlite-state/migrations.test.ts:107-150,194-320`
- 缺盘 store测试：`tests/unit/sqlite-state/crud.test.ts:494-501`

版本命令：

```sh
bun --version
bun -e 'import {Database} from "bun:sqlite"; const d=new Database(":memory:"); console.log(d.query("select sqlite_version() version").get()); d.close()'
sqlite3 --version
```

CLI折叠复现（必须使用隔离 root）：

```sh
ROOT=/tmp/coder-loop-544-I01-missing-$$
mkdir -p "$ROOT"
bun src/loop.ts status /Users/mouriya/Ext/code/coder-loop --json --loop-data-root "$ROOT"
echo "$?"   # 本基线实测 0
```

运行矩阵脚本逐案以 `bun:sqlite` 构造/读取隔离 DB，前后对目录逐文件执行 `stat` 与 SHA-256；结果数字已抄入 B2。实验根目录与脚本/输出均已清理。


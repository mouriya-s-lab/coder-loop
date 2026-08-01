# RFC #544 R4 供给侧只读 API 调查

调查基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一裁决锚为 AGG §1.2/1.3、D1/D2/D10/D11/D12、CAP-2/3/6/7。本报告只描述当前实现，不决定未来 API 形态或工作量。

## A. 主 agent 摘要（最多一页）

### 问题与结论

问题：现有 attempt prompt/bindings、pinned definition、preset compile projection、context entries 读取供给，能否直接支撑 D1/D2/D10/D11/D12 与 CAP-2/3/6/7 的稳定语义？

结论：**CAP-7 已有接近目标的公开、精确、版本化 CLI 投影，可作为 D11 的真实基础资产；其余均不足以称为目标 read API/快照契约。** CAP-2 只有 identity 与短期 materialized/cache 资产，没有按 identity 解引用的 definition repository；D2/D10 所需 prompt/bindings attempt 快照不存在；CAP-3 当前变量值统一字符串化且没有 per-key 快照；CAP-6 只有 store 内部的全 chain 无分页读取，不是 daemon/operator read boundary；D1 严格只读 status 入口不存在，现有 builder 会走 read-write open、WAL 与 migration。

### 简明因果

- scheduler 每次 spawn 先按 item 当前 preset 路径加载/缓存 materialized preset、计算 source hash 并把 hash 写进 run identity；但 `execution_definitions` 只存 `(kind, hash, semantic_hash=hash, schema_version=1)`，不存 definition 内容或其可解引用位置。daemon 活着时 path-keyed Promise cache 会稳定到首次 materialization；daemon restart 后 cache 清空，并按当前源路径重新 materialize。旧 materialized sibling又会被清理。因此 identity 能验“是哪一版”，不能取回“那一版是什么”。
- scheduler 的真实 runner prompt 是 `raw prompt -> renderSchedulerSpawnPrompt -> + phaseExitsEpilogue -> buildRunnerInvocation`；fresh/resume 都走此路径，resume identity 来自持久 session ID。最终 prompt 只进入 argv；run phase 目录仅写 runner authorization/status/streams，没有 `prompt.md` 或 `bindings.json`。因此事后无法证明变量值或 argv prompt。
- compile CLI 与 daemon load 共用 `compilePreset`；公开结果经精确 arktype boundary、`schemaVersion:1`、确定性排序/映射输出六类数据。它是定义态当前源 projection，不是 attempt-pinned projection；variables 只有 `type:"string"` 与 `sourceKind`，没有完整 source/value typed flow，tools 目前恒空，task tree 当前是每 phase 单 leaf 的 seq 投影。
- context entry 有精确 scope/author ADT 与持久 row parse；store 只提供 `listContextEntries(chainId)` 全量按 `(created_at,id)` 升序读取。daemon command union 只有三段 append，没有 list/read；group 写被显式拒绝。故 D12 不能消费它。

### 当前/未来影响与纯证明缺口

- **当前影响**：D10 无数据源；D12 无协议读取面；D11 可以消费 CAP-7 CLI/函数投影，但不能把它解释成 pinned attempt definition；D1 不能复用现 status builder 来满足严格只读。
- **未来影响（不定形态）**：CAP-2 必须先让 identity 可解引用且覆盖 retry/restart/source mutation；D2 才能从同一 effective prompt 值及 binding resolution 产出快照。CAP-6 必须由拥有方落定 read boundary 的分页/过滤/权限语义，GUI 不应包装内部 store 方法冒充契约。
- **纯证明缺口**：compile 已有大量 schema/CLI/determinism 单测，但没有 GUI 同源消费证明；prompt tests 证明 render 与 runner args 的局部函数行为，不证明落盘/恢复；context tests 证明写入、鉴权、迁移与内部 list，不证明任何外部 read。

### 可保留资产

1. `ExecutionDefinitionRef`/task identity ADT、run extra 对 exact identity/phase 的校验。
2. content-hash materialization 的 staging+marker+rename 并发收口（但 sibling pruning 与永久解引用目标冲突，不能原样当 CAP-2）。
3. compile 的单一计算路径、精确 versioned boundary、typed rejection/findings。
4. context scope/author ADT、row boundary、chain cursor index、daemon-derived author 和 append admission audit。
5. prompt renderer与 binding source parser；它们是生成快照的基础，不是快照本身。

### 未知与下一步

未知：AGG 未定义 CAP-2 repository 的保留/GC、CAP-6 分页/过滤最终 shape；D11 对 CAP-2 的消费语义在 AGG 本身悬空。确定方式：由对应能力所有者的设计裁决/实现边界给出，不能从当前内部方法反推。下一步：R4/R5 以本报告把 CAP-7 标“已供给但语义有限”，其余标“基础资产/目标契约未供给”；不要把 `listContextEntries`、`execution_definitions` 或 materialized 目录列成可复用 read API。

## B. 证据与逐条三态

三态：**符合**＝当前已满足锚点契约；**基础资产/偏离**＝有相关实现但不满足稳定语义；**静态未知**＝当前仓库证据不能裁决。

### B1. D1 严格只读 status snapshot

**状态：基础资产/偏离。** `buildCoderLoopStatusSnapshot` 存在且是只读业务操作，但底层不是严格只读连接。唯一 open 函数 `openSqliteStateStore` 会以可写方式打开、检查/设置 WAL，并调用 migration；不存在 read-only store/builder variant。AGG 已准确指出这一矛盾。

- 调用面：`src/loop.ts:3113` builder；CLI/status 与 daemon status 路径调用，其他 store callers 见 `src/loop.ts:4179,4231,4240,4249,4258,4267`。
- 打开/副作用：`src/sqlite-state.ts:822-850`；WAL mutation `:841-849`；migration `:850`、实现入口 `:948`。
- typed boundary：当前 `StatusSnapshotBoundary` 七个顶层槽仍是匿名 `object`，只有 `taskTree` 精确（`src/loop.ts:520-529`），亦不满足 D3（虽非本调查主轴）。
- 错误/迁移/daemon-down：`createIfMissing:false` 能避免新 DB，但不能避免 WAL/migration；schema mismatch 被迁移或普通 store error处理，不是 D1 要求的显式只读 schema-version result。
- 测试盲区：现 status tests 即使绿，也会共享这条可写 open 路径；没有重复读取后 DB/WAL/journal/schema byte/metadata 中立证明。

### B2. attempt identity、prompt、bindings（D2/D10；CAP-2/3）

#### B2.1 真实 scheduler spawn 链

**状态：基础资产/偏离。** 每次 scheduler spawn 生成独立 `runId`，从 item+phase+runner 的持久 session 决定 `{fresh|resume}`，并记录 execution definition identity。真实 prompt 链为：

1. load item preset并算 identity：`src/scheduler.ts:1586-1589`；
2. record run extra（definition kind/hash/phases + item start snapshot）：`:1607-1637`；
3. daemon prompt resolver从该次 `loadedPreset` 的 materialized phase prompt读取：`src/daemon.ts:4407-4419`；
4. scheduler构造 runtime context并渲染：`src/scheduler.ts:1658-1673`、`:3128-3143`；
5. 追加 phase exits epilogue后将同一 `finalPrompt` 传入 invocation builder：`:1673-1681`；
6. runner-specific args把 prompt放入 CLI argv：`src/loop.ts:6703-6713`（Claude）及统一选择 `:6844-6880`。

fresh/resume 标识与值来源：`getItemSessionId` 决定 resume（`src/scheduler.ts:1588-1590`）；context中 `runIdGeneration`, `resumedFromPhase`, `resumedSessionId` 从这一 decision生成（`:3155-3193`）。bindings 值来自当次 chain/item records、runId/worktree/runtime paths、preset business values；解析最终统一返回 string（`src/loop.ts:5778-5822`）。当前没有“每 KEY 的 source+value”对象在渲染时被保留。

`spawnOneAttempt` 是另一条通用/特例路径：resume 会把 effective prompt替换为固定“继续”（`src/loop.ts:6355-6363`）。不能把它外推为普通 scheduler resume；普通 scheduler明确重渲完整 prompt。这与 AGG D2 对两者的区分一致。

#### B2.2 落盘、retry/recovery与崩溃窗口

**状态：不符合 D2/D10。** scheduler 只创建 run artifacts、写 `runner-authorization.json`、status与 stdout/stderr；`finalPrompt` 和 per-key bindings均无写入调用（`src/scheduler.ts:1682-1705`）。全树搜索无 `prompt.md`/`bindings.json` 生产者。`status.json` 只能描述 run状态，不能恢复 argv prompt。

- 多 attempt/retry：每次新 spawn重做上述读取与渲染；attempt counter只在 first phase + fresh 时增长（`src/scheduler.ts:1590,1647-1652`），所以 UI 不能把 item `attempts` 当全部 phase/run 的唯一 attempt identity；应以 run/phase事实读取，但目标 read shape尚未定义。
- daemon restart：持久 session ID使下一次可判 resume；但 prompt/binding值会基于restart后的 loaded preset和当时 item/chain状态重新生成，没有先前快照。
- spawn崩溃窗口：run/closure/current-run与item已先持久，再render/build/write artifacts/spawn（`:1607-1685`）。render或artifact失败会走 preparation cleanup/error containment（`:1740-1751`）；无 prompt artifact，故不存在“写失败发 diagnostic但继续”的D2语义。
- argv同源：当前构造点局部同源成立（`finalPrompt`直接传 builder），但事后没有持久证据；shell/process argv也不是稳定read API。
- tests同错/盲区：`tests/unit/loop/prompt-bindings.test.ts`和`runtime-bindings.test.ts`覆盖renderer；runner parser tests覆盖argv；scheduler tests覆盖resume与runner selection。它们没有断言 attempt目录 prompt/bindings，更没有 source mutation + restart/retry 的pinned读取。

#### B2.3 pinned definition（CAP-2）

**状态：基础资产/关键偏离。** 

- identity产生：compile对 source directory中文件名+字节排序hash（`src/loop.ts:4683-4707`）；scheduler写run extra（上引 `1586-1626`）。
- identity持久：`execution_definitions`只有 kind/content_identity/semantic_hash/schema_version（`src/sqlite-state.ts:653-660`）；insert把semantic hash等同identity（`:2359-2360`）；run extra parser精确校验kind/hash/nonempty phase映射（`:2338-2356`）。
- **无解引用内容**：表无blob/path；store无 `getExecutionDefinition`；没有按 `{kind,contentIdentity}`取得CompiledTaskModel/prompt的API。
- materialization短期稳定：source内容hash命名，staging+marker+rename处理并发（`src/loop.ts:4417-4476`）。daemon cache按原始preset path键住Promise（`src/daemon.ts:4448-4466`），所以同一daemon生命周期内源文件变化通常仍使用首次加载对象。
- restart/source变化偏离：restart清空内存cache并从item当前path加载；新内容得到新hash。更严重的是 materializer会删除同名旧hash sibling（`src/loop.ts:4478-4502`），daemon start也有 stale materialized prune（`:4548-4569`）。因此旧run的identity在restart后通常不可解引用，不能满足CAP-2“spawn/retry/restart不重读当前path”。
- 并发：同hash materialization race有marker收口；不同hash时 sibling pruning在 singleton daemon假设下运行。该机制保证当前load原子性，不保证历史definition retention。

#### B2.4 typed binding values（CAP-3）

**状态：基础资产/偏离。** TOML item field schema有 string/number/boolean/json类型声明，但 phase variable compile projection强制 `type:"string"`（`src/loop.ts:458-460,568-572,2945`）；renderer `resolveBinding`把值转换为字符串供模板。没有携带原始typed value的 per-attempt structure，也无 additive typed位可被D2消费。静态未知：未来 additive shape应如何表达，AGG只给能力目标，当前代码不能裁决。

### B3. preset compile projection（CAP-7 / D11）

**状态：核心符合 CAP-7 基础契约；对 pinned/typed 完整语义仍偏离。**

- 单一计算路径：`compilePreset` -> `compilePresetOrThrow`（`src/loop.ts:4590-4696`）；daemon load通过同一compile/load路径，CLI再project（`:2962-3001`）。
- schema：公开精确 arktype boundary且reject额外/错误variant，由 `schemaVersion:1`钉住（`:531-592`）。成功CLI stdout直接输出projection；失败stderr输出versioned public rejection并exit 1（`:2990-3001`）。
- 六块：preset metadata、statuses/stateGraph、phases/taskTree/variables、tools、fragments、findings（boundary `:533-583`；projection `:2900-2956`）。
- 确定性：source file collection排序、hash稳定（`:4507-4535,4699-4707`）；statuses/phases/exits维持声明顺序，state graph按固定拼接；projection最后自parse（`:2958`）。绝对 `preset.dir` 随调用路径/机器不同，因此“同内容跨目录字节完全相同”并非契约。
- 数据与类型流限制：variables只有key/固定string/sourceKind，不给完整source路径、required/default或运行值；tools恒 `[]`（`:2945-2955`）；task tree是当前每phase单节点seq模型（types `:780-786`），不是未来任意task tree能力；findings只有warn，errors走rejected variant。
- preset变化：每次CLI compile读取当前source；输出sourceHash能区分版本，但CLI无按历史identity compile/read。D11作为“选择当前preset预览”可消费；若要求attempt pinned definition则CAP-2仍阻塞，且AGG自己说D11对CAP-2消费语义未定义。
- 错误：结构、TOML、DAG、placeholder、source读取转typed rejection；unexpected/callback infrastructure errors会throw，测试明确钉住（`tests/unit/preset/compile.test.ts:300-365`）。
- 消费者：CLI `preset compile`; daemon `loadPreset`消费model而非public projection；测试直接消费 projection/boundary。当前无GUI消费者。
- 测试盲区：`tests/unit/preset/compile.test.ts`覆盖bundled/invalid/warn/materialize/CLI/确定性与typed errors；但没有跨daemon restart、identity解引用或GUI/CLI同源E2E，因此不能证明D11全链路。

### B4. context entries（CAP-6 / D12）

**状态：typed存储资产存在；外部read boundary不存在。**

#### ADT与表

- scope ADT：chain | item(itemId) | group(groupId)；author ADT：operator | agent(chainId,itemId,runId,phase)（`src/context-entry.ts:4-15`）。
- envelope `ContextEntry`：id/chainId/createdAt/scope/author/body（`:70-85`）；持久row为严格union并parse（`:87-117`）。body只要求string，存储不解释。
- SQL表与 `(chain_id,created_at,id)` index：`src/sqlite-state.ts:775-784`；FK chain cascade。

#### 全入口/消费者

写入口：
1. store `appendContextEntry`（内部API，immediate transaction包装）：`src/sqlite-state.ts:1605-1619,2045-2054`；
2. daemon三段 `context.append.begin/chunk/commit` command，仅这些命令在union/dispatch（`src/daemon.ts:161-205,1763-1765`）；
3. CLI `context append`逐chunk调用三命令（`src/loop.ts:1977-1985`）。
删除入口：chain delete两分支显式 `deleteContextEntriesForChain`（`src/daemon.ts:2505-2537`）；FK也会随物理chain delete cascade；store method `src/sqlite-state.ts:2063`。
读取入口/消费者：只有 store内部 `listContextEntries(chainId)`，产品src中无调用者；调用者全是tests与migration/integration scripts（全树 `rg 'listContextEntries('` 结果）。scheduler integration仅用其断言fixture，不是生产prompt/context消费。

#### 内部list精确边界

- filter：仅 `chain_id=$chainId`；无scope/item/group/body/author/time filter。
- pagination/cursor/limit：无；一次 `.all()`全量载入。
- sort：`ORDER BY created_at,id`升序，与index匹配（`src/sqlite-state.ts:2056-2061`）。createdAt可由内部input覆盖，id UUID作为tie-break。
- parse：每row strict scope union + author JSON parse/ADT；任一坏row使整个list throw，无partial result。
- permission/auth/audit：store list没有；daemon根本没有read command，因此也无operator/agent read auth class或read audit。
- transaction/locking：read helper不显式开transaction，只执行单SELECT（`src/sqlite-state.ts:1614-1619`），单statement snapshot由SQLite保证；append/delete各在`BEGIN IMMEDIATE`包装。没有跨页一致性问题，因为无分页。

#### group/history/restart/crash

- group在ADT/table/migration parser中允许，历史/fixture row可读；但daemon begin对任何group无条件拒绝 `group-unavailable-v2`（`src/daemon.ts:1865-1873`）。因此D12三scope真实写读验收当前不成立。
- append session只存daemon内存Map（begin `:1874-1881`，chunk `:1886-1906`）。daemon restart/crash会丢未commit chunks；commit先从Map删除session，再做DB insert（`:1909-1917`）：若insert失败，session/body不可重试；若insert成功而admission event写失败，RPC可能失败但entry已存在，重试原session为unknown。当前没有idempotency key。
- begin/chunk/commit各自先/后写admission event，不与DB同一事务；审计与entry存在崩溃分裂窗口。
- chain delete会invalidate内存session并删除entries，但状态更新、runtime cleanup、entry delete不是单一SQLite事务，失败可留可重试中间态；tests覆盖soft delete清理，而非任意崩溃注入。
- migration：schema version冲突有专门迁移保护与historical fixtures；strict row tests覆盖malformed scope/author。它证明存储兼容，不证明read协议。

#### tests同错/盲区

`tests/unit/runtime/context-entry.test.ts`覆盖ADT、chain隔离、delete、migration、malformed row；`tests/integration/daemon/context.integration.ts`覆盖write鉴权、group拒绝、session owner、chain delete与audit；CLI integration覆盖append。全部通过内部store list核对结果，恰好绕过了缺失的daemon read boundary，因此绿测不能作为CAP-6证据。没有分页、scope filtering、operator read权限、read audit、restart中途append、commit/event崩溃注入测试。

### B5. 设计三态矩阵

| 锚点 | 三态 | 当前真实保证 | 关键缺口 |
|---|---|---|---|
| D1 | 基础资产/偏离 | status builder可构造快照 | DB open会WAL/migrate；无严格只读/schema mismatch ADT |
| D2 | 不符合 | finalPrompt在构造点直接进runner builder | 无prompt/bindings落盘、失败diagnostic、pinned解引用 |
| D10 | 不符合 | run/phase目录和status/streams存在 | 没有可展示prompt/bindings/fresh-resume artifact |
| D11 | 部分符合 | versioned精确compile projection与CLI | 不是historical/pinned；typed flow有限；无GUI E2E |
| D12 | 不符合 | typed context store与内部chain list | 无daemon/operator read；无分页/filter；group不可写 |
| CAP-2 | 基础资产/偏离 | exact hash identity被持久/校验；短期materialization | 无definition blob/repository/resolver；restart重读当前path；旧hash被prune |
| CAP-3 | 基础资产/偏离 | typed item source parser；最终string render | 无typed value携带或snapshot |
| CAP-6 | 不符合 | strict ADT/table/internal list | 无外部read boundary/权限/分页/filter |
| CAP-7 | 符合核心，有限 | CLI + schemaVersion 1 + six-block projection/findings | 当前定义态；不替代CAP-2；variables/tools/tree能力有限 |

### B6. 证据索引与调查限制

关键命令：

```text
git rev-parse HEAD
rg -n "ExecutionDefinitionRef|contentIdentity|renderSchedulerSpawnPrompt|buildRunnerInvocation|ContextEntry|listContextEntries|compilePreset|projectCompiledPreset" src tests scripts
nl -ba <上述文件> | sed -n <上述行段>
```

运行观察：本调查遵守只读约束，未启动daemon、未改生产loop-data、未修改preset或产品文件。结论主要来自完整调用方/写入口静态枚举；没有用“测试绿/commit存在”替代设计证据。未做会改源preset或materialized root的restart实验，因为代码已直接显示cache key、hash、prune与无resolver；若未来需要证实OS/SQLite崩溃时序，应在隔离loop-data做专门故障注入，当前报告不把未实验部分升级为保证。

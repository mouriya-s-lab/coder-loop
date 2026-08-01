# RFC #545 R4：context 读取/查询供给侧深审

基线：`main` / `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只以 `aggregate.md` 的 D2/D3/D7/D8/D10/D14/D15、S14–S22 为设计锚点；未修改产品代码、测试、配置或生产数据库，未运行会产生状态的实验。

## A. 主 agent 摘要

### 问题与结论

当前 main **没有公开 context read/query 能力**：没有 CLI 子命令、daemon command、请求/响应 boundary，也没有 GUI 可消费 JSON shape。唯一读取原语是 store 内部的 `listContextEntries(chainId)`，它一次性按 chain 取全量，消费者仅为测试、迁移验证和 debug 式内部断言。因而 S14–S22 均未实现，不能把“表、索引、全量 list”称为可复用的读取机制。

现存底料可分为：

1. **可保留资产（结构地基，不是已实现语义）**
   - `ContextScope`、`ContextAuthor`、`ContextEntry` 的封闭 ADT 和 persisted-row arktype parser；
   - `(chain_id, created_at, id)` 索引及同序 `ORDER BY`；
   - daemon command 名称闭集 + `Record` 穷尽鉴权分类；
   - run credential 从 scheduler mint → env 注入 → CLI 自动附带 → daemon registry 解析出的 `(chainId,item rowId,runId,phase)`；
   - socket 单请求/单换行响应客户端，以及提前关闭的确定性错误；
   - runtime input doc-binding 生成先例。
2. **必须新增而不能宣称复用**
   - scope/author/phase/after/pageSize 查询、keyset SQL、cursor ADT；
   - agent chain-bound read auth class/handler（现有 `read-no-auth` 会放行跨 chain，不能直接采用）；
   - read 请求与响应 arktype boundary、GUI shape、`nextCursor | exhausted`；
   - context 用法 doc-binding。
3. **负资产/同错风险**
   - 当前秒级 `created_at` + random UUID 次键虽给出全序，但若翻页间同秒新 UUID 排在 cursor 之前，会被常规 `>` keyset 永久漏掉；`createdAt?` 还是内部可回填字段。
   - `listContextEntries` 无 limit，可能形成超大单响应；协议只限制请求 1 MiB，不限制响应。
   - `read-no-auth` 明确对 agent/operator 都开放，无法实现 D3 的 agent chain 隔离。
   - CLI credential 注入依靠显式 `AGENT_ATTRIBUTED_COMMANDS` 清单；新增 read 若漏列，agent 会被误判 operator，是已知旁路形状。

### 因果简释与影响

表结构已经能按 chain 和稳定复合序读取，但“稳定排序”不等于“并发分页稳定”。秒级时间戳允许并发新行落在已发 cursor 之前；逐页 SELECT 又没有跨页 snapshot。要满足 S18，必须明确并实现不会倒插 cursor 前方的稳定 key（或等价 snapshot 上界），而不能只把现有 SQL 加 `LIMIT`。

授权方面，daemon 已有 B 域 `logs.query` 对 agent hard-deny 的先例，也有 mutation credential-gated 的 agent 身份解析；但缺少“agent 可读且自动限定 credential chain、operator 可指定任意 chain”的专用读取判定。现有分类中没有这个语义。

prompt 当前仅从 prompt 模板和声明变量渲染值；context store 没有任何 prompt 消费者，所以未发现 entry body 注入路径。此结论是静态的“当前无调用边”，不是 S19 的对抗证明；未来接入 read/doc-binding 后仍需 sentinel runtime test。

### 置信边界、未知与下一步

- 高置信：不存在公开 read；全部 `listContextEntries` 调用点已全仓枚举；没有响应大小限制；没有 entry-body prompt 调用边。
- 中置信：单响应 transport 可承载任意 OS/Node 可写大小，因为源码无 cap，但未做大响应 runtime 实验；S10 要求真实限制才引用，因此目前只能说“未发现引擎限制”。
- 待实现时必须先裁定具体 cursor 生成/并发语义，并用隔离 daemon + 两连接插入实验验证同秒倒插、跨页无重复/无遗漏及 oversized response 的实际失败边界。

建议下一步触点：`src/context-entry.ts` 增 read request/response/cursor ADT；`src/sqlite-state.ts` 墍精确过滤 keyset query；`src/daemon.ts` 墍 command/auth/chain enforcement/handler；`src/loop.ts` 墍 CLI、credential 注入、响应 parse、doc-binding。不要改用现有全量 list 作为公开 API。

## B. 证据附录

### B1. 逐条设计三态对照

| 设计/标准 | 状态 | 当前事实与缺口 |
|---|---|---|
| D2 / S14 | **缺失** | store 只能 `chainId` 全量读；无 scope filter、item 谱系公开读、group read、跨-chain daemon enforcement。 |
| D3 / S15 | **有地基但缺失能力** | credential registry 能解析 agent chain；context write 已拒跨 chain，但没有 read handler。`read-no-auth` 不做约束。 |
| D3/D15 / S16 | **缺失** | operator 可直接调用内部 store，但无 socket read、无 read response boundary/GUI contract。 |
| D10 / S17 | **缺失** | 无 scope/author subject/phase/after parser 或 SQL；当前唯一参数是 `chainId`。 |
| D10 / S18 | **不符合** | 全量 ORDER BY 有全序，但无 pageSize/cursor/exhaustion；秒级时间戳 + UUID 会发生 cursor 前倒插风险。 |
| D8 / S19 | **当前无泄漏调用边；证明缺口** | prompt renderer 不访问 store；无 entry body 注入。尚无 sentinel 对抗测试。 |
| D14 / S20 | **写侧地基存在；读侧缺失** | context envelope/persisted row 有 arktype/ADT；read request/response 完全不存在。 |
| D7 / S21 | **分类地基存在；读侧缺失** | command 名称/dispatch/auth class 编译期闭合；没有 context read command，且现有类无 chain-bound agent-read 语义。 |
| D15 / S22 | **缺失** | 无首次 read boundary，故无 GUI shape 或 shape-change discipline 的代码锚点。 |

### B2. 全部 context 读取原语与消费者

唯一产品原语：

- `SqliteStateStore.listContextEntries(chainId)` 声明：`src/sqlite-state.ts:354-355`。
- 实现：`src/sqlite-state.ts:2056-2061`，SQL 为  
  `SELECT * FROM context_entries WHERE chain_id=$chainId ORDER BY created_at,id`。
- 每行经 `PersistedContextEntryRowBoundary`、`persistedContextScope`、`parseContextAuthor(JSON.parse(...))` 恢复精确 `ContextEntry`，不是 raw JSON 直出。

全仓消费者（无生产 CLI/daemon/prompt/GUI consumer）：

- `tests/integration/daemon/context.integration.ts:23,109,151`
- `tests/integration/cli/central-cli.integration.ts:1377,1394,1406`
- `tests/integration/scheduler/core.integration.ts:204`
- `tests/unit/sqlite-state/migrations.test.ts:190`
- `tests/unit/runtime/context-entry.test.ts:55,57,58,106`
- `scripts/issue-558-integration.ts:256`

这些消费者只验证 append attribution、删除、迁移、body 不影响 scheduler、malformed row 拒绝；没有过滤、分页、并发读取或 public boundary。

### B3. SQL 顺序、键、索引、事务与并发

- 表：`src/sqlite-state.ts:775-783`；PK `id TEXT`，`created_at REAL`，chain FK，scope/author/body。
- 索引：`src/sqlite-state.ts:784` 的 `(chain_id, created_at, id)`，与现有读的排序前缀完全一致；这是可复用索引地基。
- append：`src/sqlite-state.ts:2045-2054`，id=`crypto.randomUUID()`，createdAt 默认 `unixSeconds()`。
- 时间精度：`src/sqlite-state.ts:2794-2796` 使用 `Math.floor(Date.now()/1000)`；同秒碰撞是常态而非理论边缘。
- write helper：`src/sqlite-state.ts:1606-1612` 每次写走 `db.transaction(fn).immediate()`；单 entry insert 原子。
- read helper：`src/sqlite-state.ts:1614-1619` 只是单次函数调用，不显式开启长事务。未来多页请求是多个独立 snapshot，不具跨页 snapshot isolation。

若未来直接使用 `(created_at,id) > (?,?)`：

- 已存在行有确定全序，不会因 SQL 自身重复；
- 翻页后插入且 key 大于 cursor 的行可在后页出现；
- 同秒新 UUID 小于已发 cursor 时会落在 cursor 前而永久漏读；
- 内部 `AppendContextEntryInput.createdAt?`（`src/context-entry.ts:70-76`）还能显式制造任意倒插；
- 因此现状不能证明 S18。需要单调序列键、数据库分配 ordinal，或固定 snapshot 上界等具体机制；本报告不裁决选择。

scope/author filtering 现无针对性索引。现索引只能高效支持 chain + cursor；scope/author/phase 可能过滤后再 limit，触点仍是表/索引定义与 `listContextEntries` 邻近 store API。

错误恢复：单 query parse 任一 malformed persisted row 会让整个 list 抛错（`tests/unit/runtime/context-entry.test.ts:91-108`）；没有逐行跳过或 cursor recovery 语义。

### B4. daemon 鉴权、身份地基与旁路

闭合分类：

- `DaemonCommandAuthClass` 四类在 `src/daemon.ts:132-159`。
- `DaemonCommandName`、`Record<DaemonCommandName,DaemonCommandSpec>` dispatch 在 `src/daemon.ts:1725-1766`。
- 名称 tuple 双向覆盖与 exhaustive switch 在 `src/daemon.ts:5731-5766,5782-5817`。

现存先例：

- A 域 mutation：context append 三命令为 `mutation-credential-gated`（`src/daemon.ts:1763-1765`），handler 自行解析 caller。
- B 域事件/日志：`logs.query` 为 `hard-deny-for-agent`（`src/daemon.ts:1761`）；gate 在 handler 前拒绝（`src/daemon.ts:1934-2001`）。
- 无鉴权 read：chain/item/status 等是 `read-no-auth`（`src/daemon.ts:1735-1748`），gate 直接 return（`src/daemon.ts:1943-1947`）。这不是 D3 可复用 verdict。

身份链：

- scheduler mint context 为 `(chainId,item rowId,runId,phase)`：`src/scheduler.ts:416-432,1683-1694`；
- CLI 从 `CODER_LOOP_RUN_CRED` 自动附带：`src/loop.ts:2487-2505,2549-2555`；
- daemon registry 校验 active run并构造 agent subject/caller：`src/daemon.ts:3949-3994`；
- context write 将 rowId resolve 为稳定 `item.itemId` 并构造 author：`src/daemon.ts:1769-1775`。

可执法地基因此足够让未来 read handler对 agent忽略/拒绝请求自报 chain，并以 caller.chainId 查询；operator 无 credential 时仍可显式选 chain。

旁路风险：

- operator/agent 分层以 `agentCredential` 字段是否存在为入口；未附 credential 就走 operator（`src/daemon.ts:3953-3957`）。
- 自动附带依靠 `AGENT_ATTRIBUTED_COMMANDS` 显式 tuple（`src/loop.ts:2507-2546`）。新增 context read 必须同时进入该清单，否则 agent CLI 调用会省略 credential 并被 daemon 当 operator。
- direct socket 客户端若掌握 socket 且故意省 credential，协议本身仍表现为 operator；现有信任模型把“无 credential socket caller”定义为 operator。D3 没有要求新增第三类，但测试必须覆盖 agent CLI 实际注入路径。

### B5. arktype boundary、GUI shape 与 exact ADT

可复用：

- `ContextScopeBoundary` 三 variant：`src/context-entry.ts:4-10`；
- `ContextAuthorBoundary` 两 variant：`src/context-entry.ts:12-15`；
- `ContextEntry` 命名 product：`src/context-entry.ts:78-85`；
- persisted row union + parser：`src/context-entry.ts:87-117`；
- scope exhaustive switches：`src/context-entry.ts:119-145`。

不可冒充：

- 以上都是写侧/存储边界，没有 `ContextReadRequest`、filter、cursor、page response、`nextCursor | exhausted` schema；
- generic daemon `JsonObject` response 不是 GUI contract；
- 所以 GUI 目前没有任何 context read shape 可消费。

具体新增触点：`src/context-entry.ts` 的 boundary/parse 集合；`src/daemon.ts` handler 返回前与 `src/loop.ts` CLI 收到后都应 parse 同一精确 response boundary，避免只在 TS 内部声明匿名 object。

### B6. prompt/doc-binding 与内容泄漏

- scheduler prompt 唯一路径为 `renderSchedulerSpawnPrompt` → `renderPrompt`：`src/scheduler.ts:3128-3142`。
- renderer 只替换 phase 声明 binding：`src/loop.ts:5778-5803`。
- runtime doc-binding 先例 `renderRuntimeInputsDoc` 只把声明变量解析值形成 markdown：`src/loop.ts:5824-5835`。
- runner authorization 可暴露 daemon socket，并仅在 phase 声明时暴露 `shared.md`：`src/loop.ts:6767-6785`。
- context store 没有到上述函数的调用边；全仓 `listContextEntries` 消费者清单也无 prompt path。

因此当前不存在 entry body 自动注入。`shared.md` 是独立 writable file surface，不从 context table 同步。风险在未来 doc-binding 若错误调用 list/query 并拼 body；S19 仍需把唯一 sentinel 写入隔离 store后渲染所有 phase prompt的 runtime test。

### B7. transport 单响应与边界

- server 每 request line 写一个 JSON newline response：`src/daemon.ts:1695-1703`。
- client读取第一个 newline、parse、立即 destroy socket：`src/daemon.ts:4652-4689`。所以当前 transport 是严格单响应，不支持 streaming/multi-frame page。
- request 有 1 MiB cap：`src/daemon.ts:410,4964-4970`。
- response 发送路径没有 byte cap；`socket.write(JSON.stringify(response))` 后 end 的另一错误响应路径亦见 `src/daemon.ts:4958-4961`。静态只能确认“引擎未设 response cap”，不能确认 OS/runtime 极限。
- 提前 close 已有隔离测试：`tests/unit/runtime/context-entry.test.ts:63-69`。

最小后续实验：隔离 Unix socket daemon，构造逐级增大的 read response，记录成功阈值/错误类型/RSS；在真实 boundary 不明前不得发明 limit，也不得静默缩 page。

### B8. pageSize / after / filter 的具体触点

1. `src/context-entry.ts`：命名 filter union（scope、author subject/phase）、positive integer pageSize、stable cursor、page outcome ADT及 arktype parsers。
2. `src/sqlite-state.ts:354-355,775-784,2045-2061`：替换/并存精确 query API；SQL 必须 chain predicate + filter + keyset + `LIMIT`；按真实 query plan补索引。
3. `src/daemon.ts:161-... ,1725-1766,1934-2120`：command union/spec/auth；handler先解析 caller再绑定有效 chain；返回 boundary。
4. `src/loop.ts:1943-1985,2487-2555`：新增 read CLI、请求/响应 parse、将命令加入 credential injector。
5. prompt docs：沿 `renderRuntimeInputsDoc` 的声明式路径注入“CLI 用法+scope标识”，不得读取 entry body。

### B9. 测试覆盖、盲区、可保留资产与负资产

现存覆盖：

- scope/author malformed boundary：`tests/unit/runtime/context-entry.test.ts:18-44`
- append-only/delete/migration/malformed persisted row/socket premature close：同文件 `46-110`
- agent attribution、伪造、跨 chain write、inactive credential、audit、scope admission、delete race：`tests/integration/daemon/context.integration.ts:4-175`
- real daemon CLI append与 multi-MB body：`tests/integration/cli/central-cli.integration.ts:1347-1406`
- body 不驱动 scheduler：`tests/integration/scheduler/core.integration.ts:191-204`

读取盲区：

- 无 public read happy path；
- 无 S14 三 scope visibility、S15 adversarial chain selector、S16 operator JSON boundary；
- 无每个 filter 的命中/不命中及 extra key拒绝；
- 无并发插入分页、同秒 collision、backdated insert、exhaustion；
- 无 prompt sentinel；
- 无 response-size boundary；
- 无 read command classification/injector drift test；
- 无 malformed read response在 CLI boundary被拒。

同错风险：若测试直接调用 store并手工过滤，会与错误 daemon/CLI 实现共同绕开鉴权和 wire boundary；若 fixture 为每条 row 使用不同 createdAt，会掩盖秒级并发倒插；若只检查“无重复”不检查完整 expected-id set，会漏报丢失。

## 证据索引

- ADT/boundary：`src/context-entry.ts:4-145`
- store interface/table/query：`src/sqlite-state.ts:354-355,775-784,1605-1619,2045-2063,2794-2796`
- command/auth：`src/daemon.ts:132-175,1725-1775,1934-2120,3949-3994,5731-5817`
- transport：`src/daemon.ts:410,1695-1712,4652-4689,4958-4975`
- CLI credential：`src/loop.ts:1943-1985,2487-2555`
- scheduler identity：`src/scheduler.ts:416-432,1683-1694`
- prompt/doc-binding：`src/scheduler.ts:3128-3142`; `src/loop.ts:5778-5835,6767-6785`
- tests：见 B9。

**完整交付声明：** 已覆盖统一任务书要求的全部现存读取原语/消费者、SQL顺序与并发局限、daemon 鉴权与旁路、identity 执法地基、arktype/ADT/GUI shape、prompt泄漏路径、transport 单响应、具体实现触点、事务/恢复及测试同错风险；没有把缺失机制称为可复用能力。

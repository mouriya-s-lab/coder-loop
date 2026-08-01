# RFC #545 R4：context 存储、identity 与生命周期供给审计

## A. 主 agent 摘要

### 问题

审计 HEAD `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` 的现存 context entry 存储、author/envelope、append、迁移及 chain 生命周期，判断它们是否真正符合 `aggregate.md` 的 D3/D5/D6/D7/D9/D11/D14 与 S01–S12，并能否成为后续 read、group、执法能力的供给地基。

### 结论与置信边界

**不能把“存储与写入面已全部落地”整体视为符合。** 现状包含可保留的类型化 socket admission、SQLite 表和单次 INSERT 原子性，但至少有四类设计偏离：

1. **store API 是 author 自报及 append/delete 旁路。** `SqliteStateStore.appendContextEntry` 的调用者直接传 `author`，`deleteContextEntriesForChain` 可对仍 active 的 chain 清空 entries；生产导出的 store 接口没有把这两类能力收紧为凭证解析或 chain-delete commit。S01/S02 与 D3/D6/D7 因而只在 CLI/daemon 外围成立，并非全实现成立。
2. **软删状态与 entries 清除不是同一事务。** 正常 `chain.delete` 先把 chain 更新为 `deleted`，再单独清 entries；两次独立 SQLite IMMEDIATE transaction 之间崩溃会留下 deleted chain + entries。重试 delete 会清理，但“同生共死”在崩溃瞬间不成立。force recreate 的物理删可依赖 FK cascade，但它是另一条路径。
3. **commit、审计、响应不是一个确定性提交协议。** commit 先从内存删除 session，再 INSERT，之后才追加审计并回复。INSERT 或审计失败都会让 session 不可重试；INSERT 后进程/连接失败会造成“entry 已存在但调用方收到失败/无响应”，重跑生成重复 entry。S09 的“每次写入判定”没有与存储原子闭合。
4. **多段 CLI 没有按序列化后的请求字节数分块。** CLI 固定按 256 Ki 个 JS code units 分块，而 socket 每行按 UTF-8 字节限制 1 MiB；例如合法正文中的 NUL 等控制字符经 `JSON.stringify` 会膨胀为六字节转义，一个 chunk 可超过 1 MiB 并被 `request_too_large` 拒绝。现有“大 UTF-8 body”测试没有覆盖该边界，故 S05 不是对所有字符串 body 的证明。

另外，item scope 只在 begin 时校验；表中没有 `(chain_id,item_id)` 外键，内部 `deleteItem` 后可留下指向虚空的历史 entry。当前没有 daemon item-delete 命令，所以这是**内部生命周期/未来 group/read 地基缺口**，不是已证实的普通 CLI 现时故障。group 当前一律拒绝，尚不能成为真实 group 地基。

高置信静态结论来自生产调用链和事务边界；未执行故障注入，因此“精确在哪个机器指令崩溃”仅作为由顺序直接推出的窗口，不声称发生过生产事故。已运行相关 unit 与 daemon integration：分别 6/6、5/5 通过；它们同时说明现有测试未覆盖上述跨事务、失败注入和 UTF-8 最坏膨胀。

### 当前影响 / 未来影响 / 纯证明缺口

- **当前影响：** operator/agent 经正常 CLI 时 author 确由 daemon 推导；普通大 body、item admission、group 拒绝、软删重试路径可工作。但内部 store 使用者可绕开这些保证；commit 结果在传输/审计失败时不具备可安全重试语义。
- **未来影响：** read/group/required 执法若直接依赖现表，会继承可自报 author、可被独立清空、deleted-chain residue、悬空 item scope、重复/不确定 commit 等事实。尤其 required outcome 若按 author/run 查询，旁路 author 会污染证明基础。
- **纯证明缺口：** 当前 body 不透明在所有生产消费者中基本是“尚无读取消费者”而成立；scheduler 对抗测试只证明一个 schedulerTick 场景。并发 delete/commit、审计文件写失败、daemon 重启中断多段提交、最坏 UTF-8 的完整 CLI 实验均无现成测试。

### 可保留资产

- `ContextScope` / `ContextAuthor` 封闭 ADT、arktype 边界、scope switch 的穷尽消费；
- daemon 凭证 registry 到 agent author 的派生链，以及 begin 时拒绝自报 author、跨 chain、失活凭证；
- 三条 socket command 的穷尽 command/auth 分类；
- SQLite `context_entries` 表、chain FK cascade、cursor index、单条 INSERT 的 IMMEDIATE transaction；
- begin/chunk sequence 与 session owner 绑定；group-v2 明确拒绝；
- 迁移外层 IMMEDIATE transaction、WAL、busy timeout，以及 v14 context 数据保留 fixture；
- body 落库/读回不解析、不截断的存储层行为。

### 未知与下一步

- 审计文件 append 失败在具体部署文件系统上的可触发条件、以及进程被杀时 WAL/响应的精确观察，需隔离故障注入。
- 并发 socket handler 与 chain delete 的所有可达交错应以 barrier fixture 枚举；静态上已确认 handler 会跨 `await recordContextAdmission` 让出执行。
- 历史生产 DB 是否已有 deleted-chain residue、悬空 item scope 或异常 author JSON 未检查（禁止触碰生产数据库）。

**需要继续调查而非直接裁决实现方案。** 主账应至少登记：store 旁路、软删跨事务、commit/audit/response 不确定性、UTF-8 分块边界、scope 悬空与 session 无超时/无恢复。它们是多层接缝，不宜直接归纳为单一修补。

---

## B. 证据附录

### B1. 逐条设计三态对照

| 条款 | 三态 | 实现事实与判断 |
|---|---|---|
| D3 / S01 | **偏离** | daemon 正常路径符合：agent author 来自 credential registry，operator 是无 credential 分支，自报 `author` 被拒；但导出的 store append 输入公开携带 `author`，生产 store 边界可直接构造 operator/agent author。故“仅由凭证解析路径构造”不成立。 |
| D3 / S04 | **符合（socket 路径）** | 无 credential 的 daemon caller 被解析为 operator，可写任意非 deleted chain；author 固定 `{kind:"operator"}`。store 旁路不否定 operator 能力，但削弱 identity 唯一来源。 |
| D5 / S08 | **符合现状，未来消费者证明不足** | append/store/scheduler 生产代码没有读取 body 语义；唯一生产 `listContextEntries` 逐字返回 body，当前无产品消费者。scheduler 对抗测试对状态词与 marker 做基线比较。没有 read/GUI/required 消费者可供审计。 |
| D6 / S02 | **偏离** | 无 update API/SQL；但 `deleteContextEntriesForChain(chainId)` 是公开 store 方法，调用时不要求 chain deleted，unit test即对 active chain调用。它不是被封装为唯一 chain cascade commit。 |
| D6 / S03 | **偏离（正常成功态符合）** | 成功软删后 entries 清空且他 chain 无损；但 `updateChain(status=deleted)` 与清 entries 是两事务，存在崩溃 residue。重复 delete 会补清。物理 `deleteChain` 走 FK cascade。 |
| D7 / S09 | **偏离** | socket commands 和 auth classification 符合；allow/deny 通常 emit audit。但 store append/delete 是直写旁路；commit INSERT 与 allow audit 分离，审计失败/崩溃可出现 entry 无 allow event。 |
| D9 / S05 | **偏离** | DB body 无 hard cap、单次 append不截断；socket 真实边界为 1 MiB 且显式报错，符合“显式拒绝”部分。但 CLI 用 256 Ki code-unit chunks，最坏 UTF-8 chunk连 envelope 超过边界，不能普遍 round-trip 多 MB UTF-8。 |
| D11 / S06 | **部分符合** | begin 对 item scope 做本 chain `getItemById` 校验并点名拒绝；但校验与 commit 分离，schema 无 scope FK，内部 item 删除可留下悬空 entry。当前 daemon 无 item delete，现时 CLI 路径未发现该竞态入口。 |
| D11 / S07 | **符合现状** | 所有 group begin 无条件以 `group-unavailable-v2` 拒绝，不落库；因此不是 future group 实现地基，仅是正确的 v2 拒绝分支。 |
| D14 / S10 | **部分符合/部分偏离** | envelope、scope、author、请求/结果、session 均有命名类型和 arktype parse；scope switch 穷尽；未发现真 `as` cast。偏离在 author 构造能力没有类型隔离：`AppendContextEntryInput.author` 接受普通 `ContextAuthor`，store 无 credential-derived branded/opaque proof。 |
| S11 | **符合已测范围，历史异常行未知** | schema migration 包在 IMMEDIATE transaction 中，v14 fixture保留 context；重复 open 有覆盖。迁移只保留 author JSON，未逐行验证；异常历史 author/scope 会在未来 list 时使整次读取抛错。生产存量未知。 |
| S12 | **部分符合，标准命名过宽** | client 在响应未完整而 socket close 时 reject；测试只造了 partial response peer。CLI 在 begin/chunk 后自身中断会在 daemon 留无期限内存 session；daemon 重启直接丢 session/chunks，无恢复也无 entry。commit 已落库但响应提前关闭则 client reject，结果不确定。 |

### B2. 类型、构造与解析边界

1. `src/context-entry.ts:4-15`
   - `ContextScope = chain | item(itemId) | group(groupId)`；
   - `ContextAuthor = operator | agent(chainId,itemId,runId,phase)`。
2. `src/context-entry.ts:17-40`：begin/session/chunk 和三类 result 都由 arktype boundary 生成命名类型。
3. `src/context-entry.ts:62-85`：session、append input、persisted result 都是命名 product type。
4. `src/context-entry.ts:87-117`：persisted row 先 parse；author 列再 `JSON.parse` 后过 `parseContextAuthor`。
5. `src/context-entry.ts:119-145`：scope 到 key、CLI scope、persisted scope 均穷尽 switch。
6. `src/daemon.ts:3949-3996`：credential 字段解析为 operator 或 registry-bound agent；run 还须位于 active scheduler state。
7. `src/daemon.ts:1769-1775`：agent author 的 chain/item/run/phase 来自 admitted caller 与 store item；operator 固定构造。
8. `src/daemon.ts:1848-1850`：socket begin 显式带 `author` 一律拒绝。
9. **旁路：** `src/sqlite-state.ts:354-356,2045-2063` 的公开 store API接收普通 `AppendContextEntryInput`，任意调用者直接给 author、createdAt、scope；测试与 scheduler fixture均实际使用该旁路（`tests/unit/runtime/context-entry.test.ts:46-58`、`tests/integration/scheduler/core.integration.ts:184-204`）。

未发现 context 链路内的真 `as` cast或 `any`。`BoundaryValue=unknown` 只出现在 parse 入口（`src/boundary-types.ts:1`）。不过 daemon 通用 request handler 使用 `JsonObject` 是既有协议边界；context 子请求立即 parse 为精确类型。

### B3. 全部写入口、删除入口与消费者

#### 写入口

- 用户 CLI：`src/loop.ts:1943-1986`，读取 `--body` 或整个 `--body-file`，依次 begin/chunk/commit。
- daemon socket：`src/daemon.ts:1763-1765,1830-1917`。
- store：`src/sqlite-state.ts:2045-2054`，直接 INSERT。
- 生产源码无其他 append 调用；测试/fixture通过 store直写。

#### 删除/清理入口

- store 独立清除：`src/sqlite-state.ts:2063`。
- store 物理删 chain：`src/sqlite-state.ts:1736-1737`，由 FK `ON DELETE CASCADE` 清 entries。
- daemon 软删首次路径：`src/daemon.ts:2517-2538`。
- daemon 对 already-deleted chain 的补清路径：`src/daemon.ts:2505-2515`。
- force recreate 对 deleted chain 物理删除：`src/daemon.ts:2200-2209`。
- 没有 context entry update API、socket command或 UPDATE SQL。

#### 消费者

- `listContextEntries`：`src/sqlite-state.ts:2056-2061`；仅 tests/fixture 调用，当前无 daemon read command、scheduler/GUI/required 产品消费者。
- scheduler 不消费 body；`tests/integration/scheduler/core.integration.ts:184-204` 是对抗证明。
- CLI root usage 当前只有 append（`src/loop.ts:3046-3058`）。

### B4. 事务、锁、并发与崩溃窗口

#### SQLite 基线

- open 时启用 FK、5 秒 busy timeout、WAL：`src/sqlite-state.ts:839-845`。
- 所有 store write 各自包一层 `db.transaction(fn).immediate()`：`src/sqlite-state.ts:1605-1611`。
- append 的 UUID、timestamp、INSERT 是单个 IMMEDIATE transaction：`src/sqlite-state.ts:2045-2054`。
- migration 是单个 IMMEDIATE transaction，最终设 `user_version=16`：`src/sqlite-state.ts:948-1089`。

#### 多段 session

- sessions 是 daemon 进程内 `Map`，不持久化：`src/daemon.ts:1191-1196`。
- begin 校验 chain/scope/author 后建 session；chunk按 sequence append到内存数组；commit `join("")` 后一次 INSERT：`src/daemon.ts:1830-1917`。
- 每个 socket 内请求串行化，但不同 socket 没有全局 request mutex：`src/daemon.ts:1660-1689`。CLI 每段新建连接，因此阶段间存在其他 handler交错。
- session owner 对 agent只比较 runId+phase，对 operator只比较 operator；任一 operator socket都能继续另一 operator建的 session（`src/daemon.ts:1819-1825`）。D3只定义 operator单一主体，因此这不违反现有主体模型，但意味着 operator session不是连接绑定。
- session 无 TTL、总字节计数或 disconnect cleanup；CLI 在 begin/chunk 后退出会留内存至 chain delete或 daemon退出。
- daemon重启丢全部未 commit chunks；这是“未产生 entry”的原子结果，但无 resume。

#### commit 不确定性

`src/daemon.ts:1909-1917` 顺序为：

1. admission（其中会 await audit）；
2. 从 Map 删除 session；
3. SQLite append；
4. await allow audit；
5. 返回响应。

由此直接得到三个窗口：

- INSERT失败：session已删，不能重试 commit；
- INSERT成功、audit失败/进程退出：entry存在但调用失败；
- INSERT和audit成功、响应前连接断开：client收到 incomplete response，但entry存在；重新跑整条CLI会追加第二条。

没有 idempotency key、session→entry durable mapping或 commit result recovery。

#### chain delete 不确定性与并发

- 首次软删先 runtime cleanup，再 `updateChain(status=deleted)`，再 invalidate sessions，最后独立清 entries（`src/daemon.ts:2517-2530`）。后三步之间没有共同 DB transaction。
- 崩溃在 status update 后、delete entries 前，会留下 deleted chain entries；重启后再次 `chain.delete` 可走 alreadyDeleted 分支补清。
- commit admission每次重读 chain status（`src/daemon.ts:1808-1817`），可阻止已删除 chain继续 commit；delete也主动清内存 sessions。
- 但 begin/chunk/commit和 delete都含 await audit，多个 socket handler可交错。静态上未发现能在 delete 完成后新 INSERT 的顺序：commit在真正 append前 admission重读 chain；若 commit已越过 admission，delete可能先清0条、随后 commit append的可能性取决于 delete能否在同步 append之前插入。admission返回后到 Map delete/append没有 await，因此同一 JS turn 内不会让 delete插入。反向是 append先发生再由delete清除。仍建议用 barrier fixture锁死这一结论。

### B5. scope key 供给能力

- item scope begin使用 `(chain.id, scope.itemId)` 查现存 item：`src/daemon.ts:1865-1869`。
- group scope全部拒绝：`src/daemon.ts:1870-1873`。
- 表只约束 `scope_kind` 词表，不约束 kind/key组合，也无 item/group FK：`src/sqlite-state.ts:775-783`。kind/key组合只在应用读取 boundary强制。
- store append可绕过 item存在性；虽然 TypeScript scope要求非空形状，但无法证明 key属于 chain。
- store `deleteItem` 不处理 context entries（`src/sqlite-state.ts:1849-1877`）。因此历史 entry可在 item物理删除后悬空。

**对下游的保证：** 正常 daemon begin 当下的 item存在性和chain归属可用；不能保证读时仍存在，也不能把 store中所有历史行视为已 admission。group没有任何真实 key供给。

### B6. body 与 socket 大内容

- body只在 CLI读文件、chunk传送、数组join、SQLite TEXT insert、list返回路径出现；无正则、marker或状态解析。
- daemon每条 request真实限制 1,048,576 UTF-8 bytes并显式返回 `request_too_large`：`src/daemon.ts:410,1660-1685,4946-4971`。
- CLI chunk算法按 `body.length`/`slice` 的 JS UTF-16 code units，每块262,144：`src/loop.ts:1979-1983`。
- 对 BMP 三字节字符，正文最大约786,432 bytes，通常可过；对 astral字符，每个字符占2 code units/4 UTF-8 bytes，262,144 code units正文恰为524,288 bytes，不是1 MiB。**修正计算：** 单个 astral code point占2 code units，因此一块最多131,072个完整astral字符，即524,288 bytes；若 surrogate切边，JSON会转义孤立surrogate但仍远低于1 MiB。故静态复算后，原摘要中的“全 astral必超限”不成立。
- 真正未证明的边界是 JSON escaping：一块由控制字符（如 U+0000）组成时，`JSON.stringify` 每个 code unit编码成6 ASCII bytes，约1,572,864 bytes，必超1 MiB。正文可以合法包含此类UTF-8文本，故S05仍偏离，但根因是JSON转义膨胀而非astral UTF-8膨胀。
- 可复现而不触碰产品的计算：

```bash
bun -e 'const chunk=\"\\u0000\".repeat(256*1024); console.log(Buffer.byteLength(JSON.stringify({id:\"x\",command:\"context.append.chunk\",args:{sessionId:\"s\",sequence:0,chunk}}),\"utf8\"))'
```

预期大于 `1048576`，daemon将以已实现的boundary error拒绝。现有大 body integration使用 `"多字节-context\n"` 重复，未覆盖JSON escaping最坏情况（`tests/integration/cli/central-cli.integration.ts:1354-1377`）。

### B7. 迁移与历史数据语义

- `CREATE TABLE IF NOT EXISTS context_entries` 在总 schema中；迁移先执行当前 schema，再进行其他 rebuild，全部包在 IMMEDIATE transaction（`src/sqlite-state.ts:1001-1087`）。
- v14兼容的专门注释与 schema version冲突处理位于 `src/sqlite-state.ts:808-810`。
- `tests/unit/sqlite-state/migrations.test.ts:167-191` 证明 v14 context body在normalized runtime迁移后仍在。
- `tests/unit/runtime/context-entry.test.ts:72-88` 证明缺表v13创建及重复打开。
- 历史 `author` 是裸JSON TEXT；migration不扫描/规范化它。读取时任何一行 malformed JSON或未来variant会使整个 `listContextEntries(chain)` 抛错。scope表级CHECK只限制kind，不限制key搭配；读取boundary会拒绝异常组合。

### B8. 测试覆盖、同错与盲区

#### 已运行

- `bun test tests/unit/runtime/context-entry.test.ts`：6 pass / 0 fail。
- `bun test ./tests/integration/daemon/context.integration.ts`：5 pass / 0 fail。
- 日志：`/tmp/rfc545-r4-storage-identity/unit.log`、`/tmp/rfc545-r4-storage-identity/integration.log`。只写隔离测试运行目录；未改产品代码、配置或生产DB。

#### 覆盖

- malformed ADT、scope parse、store round-trip、独立清除、缺表迁移、partial response；
- agent凭证派生、自报/跨chain/失活拒绝、allow/deny event存在；
- soft delete session失效与再次delete清residue；
- item不存在、group拒绝；
- CLI真实daemon多MB普通Unicode body；
- scheduler对状态词/marker不透明。

#### 测试与实现共同偏离/盲区

1. append-only unit test直接调用独立 delete API清active chain，并把它当作正确行为（`tests/unit/runtime/context-entry.test.ts:46-58`）；这与D6“唯一删除通道是chain级联清除”存在同错。
2. daemon lifecycle test故意通过 store向deleted chain追加 residue，再证明第二次delete可补清（`tests/integration/daemon/context.integration.ts:89-110`）；它证明恢复能力，但也正常化store旁路和非同事务生命周期。
3. author测试只证明socket外围，未禁止其他产品代码调用store自报。
4. audit测试只查询最终事件存在，不注入event append失败，不证明entry与allow audit一一原子对应。
5. socket-close测试模拟“响应半行后关闭”，不覆盖真实commit落库后断连、begin/chunk客户端退出、重启恢复。
6. 大body测试不覆盖JSON escaping最坏内容，也不覆盖并发大sessions内存压力。
7. scheduler opacity只覆盖一个tick和三类观察；未来read/GUI/required尚不存在，不能由此外推。
8. migration测试只覆盖合法operator历史author与合法chain scope，不覆盖malformed author JSON、deleted-chain residue、悬空item key。

### B9. 可保留资产与负资产清单

#### 可保留

- Context ADT与parse函数；
- credential registry派生author和cross-chain/active-run gate；
- classified command table与agent env credential injection；
- begin/chunk sequence/session owner机制；
- SQLite表、FK chain cascade、cursor index、WAL/IMMEDIATE write；
- migration transaction和v14 fixture；
- body无语义处理的存储路径；
- explicit group-unavailable拒绝。

#### 负资产/不能直接供下游依赖

- `AppendContextEntryInput.author` + 公共store append；
- 公共 `deleteContextEntriesForChain` 不带deleted-chain proof；
- 软删status与entries清除分离；
- commit先丢session、后写DB/审计/响应；
- 无commit idempotency/recovery；
- 内存session无TTL、无总量边界、无重启恢复；
- scope schema无item/group referential integrity；
- 读取一行异常author可毒化整链list；
- CLI按code-unit固定分块，未按serialized request bytes适配；
- tests以直接store写删作为大量fixture捷径，使D3/D6/D7的旁路不易被发现。

### B10. 证据索引

| 主题 | 主要证据 |
|---|---|
| Envelope/author ADT | `src/context-entry.ts:4-15,62-85,103-145` |
| Credential identity | `src/daemon.ts:1769-1775,3949-3996` |
| Socket self-report拒绝 | `src/daemon.ts:1848-1850` |
| Command/auth穷尽 | `src/daemon.ts:161-205,1725-1766` |
| CLI多段协议 | `src/loop.ts:1943-1986,2526-2557` |
| Session admission/commit | `src/daemon.ts:1789-1917` |
| Socket并发/大小边界 | `src/daemon.ts:1660-1697,4946-4971` |
| Store API/SQL | `src/sqlite-state.ts:354-356,775-784,2045-2063` |
| Write transaction/WAL | `src/sqlite-state.ts:839-845,1605-1611` |
| Migration transaction | `src/sqlite-state.ts:948-1089` |
| Soft/physical chain delete | `src/daemon.ts:2200-2209,2505-2551`; `src/sqlite-state.ts:1736-1737` |
| Item delete悬空风险 | `src/sqlite-state.ts:1849-1877` |
| Opacity test | `tests/integration/scheduler/core.integration.ts:184-204` |
| Lifecycle/audit tests | `tests/integration/daemon/context.integration.ts:4-145` |
| CLI大body test | `tests/integration/cli/central-cli.integration.ts:1347-1410` |
| Migration preservation | `tests/unit/sqlite-state/migrations.test.ts:167-191` |

---

**文件已完整交付。**

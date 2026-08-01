# RFC #545 R7 D-04：稳定分页、页间并发写入与 response boundary 事实调查

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`（调查前以 `git rev-parse HEAD` 核实）。本报告只调查 D9/D10/D15、S16/S18/S20 与 L014/L015/L035 所需的 key、transaction 和 transport 事实；未实现或设计 read/cursor，未改产品、测试、配置、生产 DB 或 `WORKFLOW.md`，未创建 worktree。

## A. 主 agent 摘要

### A1. 结论

1. **必须先把 S18 的集合说精确。** 本报告把“第一页时已存在 entries”定义为：第一页 `SELECT` 建立 SQLite read snapshot 时，目标 chain 中已经 committed 且被该 snapshot 可见的行，记为 `E0`。在只发生 append、现有行的 `(created_at,id)` 不变、每页用严格复合键 `>` 的等价实验中，页间合法写入没有让 `E0` 漏读或重复：四条同秒 `E0` 最终各出现一次。现有产品没有分页 SQL/read API，因此这是对**当前可生产键与事务语义**的隔离等价实验，不是产品通过 S18。
2. **页间新行的可见性并不稳定。** `created_at` 默认是秒级整数，`id` 是随机 UUID；同秒页间 append 可按 UUID 落在 cursor 前或后。`AppendContextEntryInput.createdAt?` 还允许 store caller 回填任意时间。实验中 cursor 前的同秒新行和回填新行不出现在后页，cursor 后的新行出现在后页。它们不属于 `E0`，所以不能写成“第一页已有行漏了”；但任何更强的“从第一页开始期间所有新行也必须最终出现”主张，当前键序与跨页独立 snapshot 都不能保证。
3. **SQLite 只给单 statement/显式 transaction snapshot，不给现有多页 snapshot。** store 写是 `BEGIN IMMEDIATE` 单 INSERT；read wrapper没有显式 transaction。WAL 双连接实验中，持有 read transaction 时另一连接能 commit，新行在该 transaction 内不可见、commit 后可见。未来每个 page 若各自执行一次 query，会看到不同 snapshot；当前没有跨请求 transaction/cursor state。
4. **response 到 64 MiB payload 的安全本地范围内没有截断、挂起或解析失败。** 真实 daemon `chain.list`、真实 `sendDaemonRequest` 与 raw Unix-socket probe 在 1 KiB、1 MiB、8 MiB、32 MiB、64 MiB 均返回完整单行 JSON；raw probe每次恰有一个 LF且在末尾，官方 client解析出的字段长度与输入一致。64 MiB wire 为 67,109,103 bytes、8193 个 data chunks；首 chunk约 77 ms，总 raw 收齐约 32,994 ms，官方 client约 38,142 ms。
5. **这不等于存在显式 response boundary。** server无 response byte cap，忽略 `socket.write` 的 boolean/backpressure信号；client用 `buffer += chunk` 累积到首个 LF、无 timeout，再整体 `JSON.parse`。同进程 daemon+probe+client 的有限实验峰值 RSS 约 1.894 GB；该数字受前序 raw buffer和 GC影响，不能当单独 client 的精确成本，但确定说明大响应会在 server/client进程内形成完整 JSON/string/object驻留，而不是流式消费。未达到 OS、Bun、V8 string 或可用内存极限，不能声称“64 MiB 是上限”或“无限可用”。
6. **越界失败没有专用合同。** 当前只有 request 的 1,048,576-byte `request_too_large`；response无 `response_too_large`。peer在完整 LF 前 close时 client报 `incomplete_response`；peer不 close又不发 LF时 client无限等待（复用 D-02 已证 transport事实）。若 `JSON.stringify(response)` 自身因资源/值失败，它发生在 `responseForLine` 的 try/catch之外，源码没有把它转换为 boundary error；实际资源极限未安全触发，所以具体极限症状仍未知，不能猜成固定错误码。
7. **当前没有公开 context read，也没有现存用户分页故障。** store 只有全 chain `listContextEntries`；daemon/CLI/GUI 没有 context read command/request/response boundary。D-05确认 operator 是“Unix socket 请求不带 `agentCredential`”，agent主体来自 daemon registry内 live credential，而不是自报字段；这些构造事实只能供未来真实 read 实验使用。本轮 response probe使用现有 operator `chain.list`，没有伪造 context read。
8. **malformed row 与分页风险是两类失败。** D-03 已证当前 `listContextEntries` 先全量取行再逐行 fail-fast parse，单条 malformed 使同 chain 整次 list失败；这是 persisted parser 接受集差异。页间倒插则是合法 row 的 key/snapshot 可见性问题。未来分页若逐页复用 parser，含 malformed 的请求会失败到其真实 boundary；在 read shape不存在时，不能推定“跳过、整页失败或 cursor推进”。

### A2. 根因与修补边界事实（不裁决机制）

- key事实边界在 `context_entries(id,created_at)`、`appendContextEntry` 的 UUID/秒级默认/可选回填，以及现有 `(chain_id,created_at,id)` 索引；现有生产 daemon不接受 caller-supplied `createdAt`，导出 store API接受。
- snapshot事实边界在每次 store read与 SQLite transaction生命周期；当前 read API只做一次无显式 transaction的全量 query，公开 page request更不存在。
- parser事实边界在 persisted row arktype/author JSON parser；它与合法 key的页间可见性不能共用一个错误结论。
- response事实边界横跨 handler生成完整 `JsonObject`、server `JSON.stringify`+单次逻辑 `socket.write`、Unix socket，以及 client完整 string累积+parse；单改 SQL/pageSize不能证明或暴露 transport极限。
- 公开消费边界必须等真实 context read request/result arktype、daemon command与 CLI parser出现后才能测试；D-05 的主体构造与 credential injection必须走真实 seam。以上只定位事实接缝，不选择 cursor、snapshot、limit、stream或错误设计。

## B. 证据附录

### B1. key 的全部生产、旁路与回填路径

| 路径 | `id` | `created_at` | 事务/约束 | 可达边界 |
|---|---|---|---|---|
| daemon `context.append.commit` | store内 `crypto.randomUUID()` | store内默认 `Math.floor(Date.now()/1000)` | 单 `BEGIN IMMEDIATE` INSERT；PK/FK | 当前正式 socket/CLI append；request不能传id/createdAt |
| exported `SqliteStateStore.appendContextEntry` | 同上 | `input.createdAt ?? unixSeconds()` | 同上 | 仓内生产 caller只有 daemon；tests/fixture与外部JS caller可回填 |
| migration/historical fixture | SQL显式字符串 | SQL显式数值 | migration transaction/fixture SQL | 合法历史验证；没有逐行重写现有 context key |
| direct SQL | caller自定 | caller自定 | schema只要求TEXT PK、REAL NOT NULL | 人工/外部旁路；真实生产发生未知 |

证据：`src/context-entry.ts:70-76`；`src/sqlite-state.ts:775-784,1605-1619,2045-2054,2794-2796`；`src/daemon.ts:1913-1917`；`src/issue-558-historical-fixture.ts:203-209`。`git blame` 显示 schema、索引、append/list 均由 `d381d06` 一次引入，此后当前行未改变。

`crypto.randomUUID()` 在当前 Bun/Node runtime生成 RFC 4122 v4 风格随机 UUID；数据库 `id TEXT` 没有显式 COLLATE，当前 UUID全为相同长度小写 ASCII hex+hyphen，SQLite默认 BINARY顺序给同 `created_at` 行确定全序。随机生成不提供与提交时间相同的单调性；PK collision会使该 INSERT transaction失败而不是产生并列键。

产品没有 update context key API或 `UPDATE context_entries SET id/created_at`。因此 append-only场景下 `E0` key固定；chain delete会删除整批 entry（D-01单独覆盖），不属于本轮“页间 append”实验假设，不能把 append结论外推到删除/任意 direct SQL update。

### B2. schema、index、order 与 transaction snapshot

- 表：`id TEXT PRIMARY KEY`、`chain_id` FK、`created_at REAL NOT NULL`；cursor index为 `(chain_id,created_at,id)`（`src/sqlite-state.ts:775-784`）。
- 唯一现存读为 `WHERE chain_id=$chainId ORDER BY created_at,id`，无 limit/filter/cursor（`src/sqlite-state.ts:2056-2061`）。
- open 设置 `foreign_keys=ON`、`busy_timeout=5000` 并要求 WAL（`src/sqlite-state.ts:822-850`）。
- write helper把每项写包入 `.transaction(fn).immediate()`；read helper仅调用函数（`src/sqlite-state.ts:1605-1619`）。
- 单个 SQLite SELECT读取一个一致 snapshot；跨独立 SELECT没有自动共享 snapshot。隔离实验显式持有 read transaction时，writer连接仍在 WAL下 commit：reader count在 transaction内保持8，commit后变9。

### B3. “第一页时已存在”集合与最小 keyset 等价实验

定义：令第一页 query 的 SQLite read snapshot 为 `S0`，`E0` 是目标 chain 在 `S0` 中已 committed且满足查询谓词的所有 rows。该定义不把“请求刚到 daemon但 SELECT尚未建立snapshot期间提交”的行倒算进 `E0`，也不把第一页返回后才提交的行算进 `E0`。

隔离脚本 `/tmp/rfc545-d04/keyset-experiment.ts` 使用两个真实 Bun SQLite连接、WAL、生产相同的 `(chain_id,created_at,id)` index/order与每次独立 SELECT。它不是产品read实现。初始 `E0` 为同秒 `created_at=100` 的四条 UUID，page size=2；第一页后由独立writer以 immediate transaction依次提交：

1. 同秒且 UUID `< cursor`；
2. 同秒且 UUID `> cursor`；
3. 回填 `created_at=99`；
4. `created_at=101`。

随后用等价谓词 `(created_at,id) > ($t,$id)` 翻至空页。原始结果 `/tmp/rfc545-d04/keyset-output.json`：

| 观察 | 结果 |
|---|---|
| `E0` missing | `[]` |
| `E0` duplicates | `[]` |
| cursor后新行 | 同秒-after与future出现 |
| cursor前新行 | 同秒-before与backfilled不出现 |
| held read transaction内并发commit | reader 8→8，不见新行 |
| commit reader transaction后 | reader 9，见新行 |

确定后果：在上述append-only假设下，严格全序 keyset足以让有限 `E0`逐个前进，不会因新行挤占页大小而永久漏掉 `E0`；但跨页视图是混合snapshot，哪些页间新行被纳入取决于它们相对已发cursor的key。连续写入还会推迟“空页”出现；本轮有限写入不能证明持续写负载下的exhaustion时延。

这修正了早期 R4 “倒插会漏”表述的集合歧义：倒插**会漏掉该页间新行**，不会倒过来使已经属于 `E0` 且key未变的行消失。是否需求要覆盖新行不是本报告裁决。

### B4. malformed parser 失败与 pagination 风险的隔离

D-03的确定事实：schema接受集大于 persisted ADT parser接受集；`listContextEntries` `.all().map(parse...)` 任一 row失败就不给 caller任何同 chain结果，其他chain可读，startup/migration不主动parse。证据见 `r7-d03-historical-data.md:9-24,82-125`。

区别：

| 类别 | row合法性 | 触发点 | 当前粒度 | 重试 |
|---|---|---|---|---|
| key/snapshot可见性 | 合法 | 页间不同snapshot + key相对cursor | 仅隔离等价实验；产品无分页 | DB不变时确定；新写改变后页集合 |
| malformed parser | DB可存但ADT拒绝 | row parse/author JSON parse | 当前整chain list失败 | DB不变时同错复现 |
| response boundary | handler已产出大JSON后/传输中 | stringify、write、buffer、LF、parse | 现有命令单response | 依赖资源/socket状态 |

未来 read若没有出现，不能声称现有用户遇到分页或 malformed page故障，也不能预先决定 malformed 时 cursor是否推进。

### B5. response 从小到大的真实 daemon/client 实验

脚本 `/tmp/rfc545-d04/transport-experiment.ts`：在隔离 loop-data创建一条 chain，通过隔离 DB把 `repository` 扩到各级长度；启动真实 `startCoderLoopDaemon`，用现有 operator `chain.list` 同时走 raw socket与 exported `sendDaemonRequest`。这只借现有命令制造可控单response，不冒充 context read。原始输出 `/tmp/rfc545-d04/transport-output.json`。

| payload chars | wire bytes | raw chunks | LF | raw total | official total | sampled max RSS |
|---:|---:|---:|---|---:|---:|---:|
| 1,024 | 1,263 | 1 | 1，末尾 | 5 ms | 1 ms | 384,024,576 |
| 1,048,576 | 1,048,815 | 129 | 1，末尾 | 13 ms | 13 ms | 446,070,784 |
| 8,388,608 | 8,388,847 | 1,025 | 1，末尾 | 515 ms | 460 ms | 854,638,592 |
| 33,554,432 | 33,554,671 | 4,097 | 1，末尾 | 7,347 ms | 7,673 ms | 1,622,097,920 |
| 67,108,864 | 67,109,103 | 8,193 | 1，末尾 | 32,994 ms | 38,142 ms | 1,894,465,536 |

每档raw与official解出的 `repository.length`都精确等于payload chars，无截断/parse失败。RSS为同一 Bun进程同时承载daemon、此前raw string、official client与SQLite的轮询值；不是独立server/client峰值，也受GC影响，只能证明资源随完整buffer显著增长。测试停在64 MiB安全范围，未尝试内存耗尽、最大string、socket buffer或OS极限。

LF行为与D-02五条transport事实一致：response是一个JSON object加LF，不分帧；large write在OS层拆成8193个data events，client仍等最终LF才parse。不存在“静默缩页”，因为现有命令根本没有page；也不存在显式response boundary error。

### B6. transport静态错误路径与未知极限

复用 `r7-d02-append-transport.md` 尾部五条事实：request是newline UTF-8 JSON且有1 MiB cap；response无cap；完整前close不证明handler未执行；JSON wire bytes才是request边界；CLI阶段独立连接；response无流式/分页/backpressure应用协议。

补充源码后果：

- server `handleLine`先 `await responseForLine`，再在其外执行 `JSON.stringify(response)` 与 `socket.write(...)`（`src/daemon.ts:1695-1703`）。command handler错误可被 `responseForLine`转成typed daemon error，但response stringify/write自身没有同级typed boundary包装。
- server不检查 `socket.write`返回值，也不等`drain`；runtime仍会buffer发送，但应用层没有显式流控状态。
- client每个chunk执行`buffer += chunk`，找首LF后一次性slice/parse；无长度判断、无timeout（`src/daemon.ts:4652-4689`）。64 MiB实验的8193 chunks与长耗时是此实现的真实表现。
- JSON坏/shape坏会在client parse boundary reject；完整LF前close为`incomplete_response`；保持连接但不发LF会一直pending。资源极限究竟是process termination、throw、socket error还是长期stall，本轮未达到，必须用受控子进程+资源上限/timeout逐级探测并记录双方exit/socket状态，不能在主进程内冒险或猜错误码。

### B7. 主体构造、consumer与测试/资产清单

D-05 usable construction facts（`r7-d05-read-auth.md:7-24,194-214`）：

- operator是Unix socket上没有`agentCredential`字段的请求；当前不是OS peer-credential证明。
- agent是daemon registry中的live opaque credential，绑定`chainId,item rowId,runId,phase`；handler必须使用registry结果，不信caller自报。
- CLI credential injection是独立显式清单，存在漏项先例；未来read只有真实CLI+socket handler都存在后才能验证主体。
- 当前context read命令、CLI、GUI shape均不存在。

全部现有 context read consumer：

- store原语：`SqliteStateStore.listContextEntries(chainId)`。
- tests：`tests/integration/daemon/context.integration.ts`、`tests/integration/cli/central-cli.integration.ts`、`tests/integration/scheduler/core.integration.ts`、`tests/unit/runtime/context-entry.test.ts`、`tests/unit/sqlite-state/migrations.test.ts`。
- script：`scripts/issue-558-integration.ts`。
- 当前无产品 daemon/CLI/prompt/GUI context reader；外部consumer调查 `r7-p02-external-consumers.md` 在可访问范围也未发现，但不能外推未访问系统。

现存资产：精确 scope/author/persisted row parsers；chain+key索引；WAL与单写事务；generic daemon response parser；`incomplete_response`；真实大body append测试。它们分别证明局部性质，不证明 future read、page result boundary或稳定分页。

测试盲区/同错：

1. 没有context read happy path、request/result arktype、operator/agent wire实验。
2. 没有同秒全部fixture、页间writer、回填时间、`E0` expected-id集合与duplicate同时断言。
3. 只断言“无重复”会漏掉missing；只断言最终count会混入页间新行；不预先定义`E0`会把新倒插与旧行漏读混为一谈。
4. 没有response-size逐级测试、server/client分别的内存与timeout、资源极限typed error。
5. 现有 premature-close test只证明client错误分类，不证明大response handler终态。
6. malformed tests证明整chain list throw，不证明未来分页的页粒度/错误shape。
7. generic `parseDaemonResponse`只断言envelope/result是JsonObject；未来S20所需精确context result arktype不存在。

### B8. 历史与证据索引

- aggregate锚点：`aggregate.md:25-26,31,74-78`。
- ledger/detail：`r5-supply-ledger.md:38-39,59,75,188-194,215-217`；`r6-detail-index.md:103-105,254-255,275`。
- append/transport复用：`r7-d02-append-transport.md` B2/B4/B6及尾部五条事实。
- malformed：`r7-d03-historical-data.md:9-24,82-125,153-161`。
- 主体：`r7-d05-read-auth.md:7-24,194-214`。
- key/schema/事务：`src/context-entry.ts:70-85`；`src/sqlite-state.ts:775-784,822-850,1605-1619,2045-2061,2794-2796`。
- response server/client：`src/daemon.ts:1695-1722,4652-4689,4946-4975,4986-5013`。
- consumer枚举：仓库根 `rg -n "listContextEntries|context_entries|ContextEntry|context read|context\\.list|context query" . --glob '!v3-issue/**' --glob '!node_modules/**'`。
- 隔离实验：`/tmp/rfc545-d04/keyset-experiment.ts`、`keyset-output.json`、`transport-experiment.ts`、`transport-output.json`。

---

**完整交付：** 已核固定SHA；枚举createdAt/ID全部正常、store回填、fixture/direct-SQL路径；建立schema/index/order/WAL/单写与跨页snapshot事实；严格定义`E0`并以隔离双连接DB覆盖同秒、cursor前后UUID、回填createdAt、页间writer与held snapshot；区分D-03 malformed parser失败；复用D-02全部transport事实并经真实daemon/raw/official client完成1 KiB至64 MiB完整性、LF、等待、内存与错误表现调查；登记D-05主体构造、全部consumer、测试盲区、资产、根因与事实接缝。未达到OS/runtime极限并给出确定方法；未裁决cursor/limit/stream/error方案，未声称不存在的公开read或现有用户分页bug。

# RFC #545 R7 D-03：历史持久数据与公开读取毒化边界

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本调查只写本报告与 `/tmp/rfc545-d03/`；未访问或修改生产数据库，未修改产品、测试、配置或 `WORKFLOW.md`，未创建 worktree。

## A. 主 agent 摘要

### 问题、结论与置信边界

**存在 DB 可接受而 persisted ADT parser 拒绝的 context row；一条会使当前同 chain 的全量 `listContextEntries` 整体失败，但不会阻止 daemon 启动、当前 schema migration 或其他 chain 的 list。** 高置信边界如下：

- 表只 CHECK `scope_kind` 词表；没有约束 `chain => NULL`、`item/group => 非空 key`，也不验证 `author` JSON/variant。表不是 SQLite `STRICT` table，声明的 TEXT/REAL 只是 affinity，不排斥不可转换的其他 storage class。因此 `item + ''`、`chain + 非 NULL`、非 ADT author，以及 `created_at/body/id/scope_key` 的不匹配 storage class 均有 DB 可接受而 parser 拒绝的形态。
- 当前正常 CLI/daemon 写路径不能制造这些 row：scope 请求先过 arktype，author 由 daemon 凭证解析构造。导出的 store API 则只靠 TypeScript 类型、写前不做 runtime parse；从 JS/runtime-invalid caller 可写入 `future` author 或空 item key。仓内当前生产 caller只有 daemon，未发现其传 malformed 值；raw SQL/人工写库也能制造。故“可合成/旁路可达”成立，**生产存量存在与否未知**，不能写成生产事故事实。
- `listContextEntries(chainId)` 先取整链全部 rows，再在一次 `.map` 中逐行 parse；任一异常抛错，caller得不到部分合法结果。隔离实验中“合法前 + malformed + 合法后”整次失败，同 DB 另一 chain 正常。当前没有公开 read CLI/daemon/GUI；未来公开 boundary 只有在复用该 list（或在同页逐行 parse）时才继承相应整链/整页毒化，不能把尚不存在的 read 说成当前故障。
- context schema/ADT 自引入提交 `d381d06`（2026-07-13）以来相关 shape 未改变。迁移只创建/保留表，不扫描、规范化或解析 rows。隔离 DB 强制 v15→v16 migration 后异常 row 原样保留且 list 仍失败；真实 daemon 在含异常 row 的 DB 上成功启动并响应 `daemon.status`。

### 复杂因果、影响与根因集合

直接机制是 **DB constraint 集合弱于 persisted parser 集合**，再叠加 **store 写边界无 runtime parser** 与 **list 采用 fail-fast 整批映射**。历史来源可分三类：正常 CLI/daemon（未发现来源）、导出 store 的类型失守/JS caller（当前可达但仓内无 malformed 生产 caller）、直接 SQL/旧人工数据（schema允许，真实发生未知）。迁移既不制造也不消除该差异。

当前影响限于内部 store list 消费者；当前产品没有公开 read。未来影响取决于实际 read query 的取行范围与错误合同：复用整链 list即整链阻断，分页后至少是含异常 row 的请求失败；跨 chain 不放大。读失败无写事务、无恢复动作，也不删除/修复 row，重试确定性复现。

### 可保留资产、未知与下一步

可保留事实资产：scope/author ADT parser、chain FK、scope kind CHECK、稳定 query order、迁移事务及合法 v14 fixture。未知只有生产/部署 DB 是否含异常 row，以及仓外是否有 direct-SQL/store caller；本报告给出**严格只读、逐行使用同一生产 parser**的审计脚本与命令格式，未对生产路径执行。该未知需先取只读审计结果；本 Detail 不裁决容错、清洗、constraint 或 future read 方案。

## B. 证据附录

### B1. 唯一设计锚点对照

| 锚点 | 观察事实 | 本调查边界 |
|---|---|---|
| D10 / S17 | 公开过滤/page read 不存在；当前唯一 list 按 chain 全量取并 fail-fast parse。 | 只能确定 future read 的真实输入集合与继承条件，不定义 query 方案。 |
| D14 / S10 | author/scope 有 ADT parser，但 DB 与 store runtime 写边界没有同等约束。 | parser 拒绝集合由当前实现和实验给出；不以类型存在冒充持久层保证。 |
| S11 | migration事务保表、重开幂等；不逐行 parse/规范化 context。 | malformed row 不使当前 migration/startup 崩溃，亦不被修复。 |
| S20 | public request/response schema尚不存在。 | 不能声称当前 public boundary 已被毒化；只登记复用现 list 的确定后果。 |
| L010/L038/L035 | 合法 fixture成立；malformed整链失败；生产存量未知。 | 本报告补齐来源、粒度、startup/migration实验与只读审计方法，仍保留生产未知。 |

### B2. schema 与 parser 的真实接受集合

#### schema 历史

`git log --follow -- src/context-entry.ts` 只有引入提交：

```text
d381d06c0a55385fb211283adcfb05ffade94f88 2026-07-13 feat: 落地 context entry 写入基座 (#677)
```

引入时 `STATE_SCHEMA_VERSION=14`，表 shape 与当前一致：`id TEXT PK`、chain FK cascade、`created_at REAL NOT NULL`、`scope_kind IN ('chain','item','group')`、nullable `scope_key`、`author TEXT NOT NULL`、`body TEXT NOT NULL`，且 CREATE TABLE 没有 `STRICT` 后缀（引入提交 `src/sqlite-state.ts:470-479`；当前 `src/sqlite-state.ts:775-784`）。当前注释说明 main 的 context v14 与另一 v14 runtime shape发生过版本碰撞，v15首次要求两者并存（`src/sqlite-state.ts:808-810`）；canonical v14 historical fixture仍复制同一弱约束（`src/issue-558-historical-fixture.ts:123-134`）。

没有历次 context row rewrite：open 时 migration执行 current schema DDL和其他表 rebuild，最后升至16（`src/sqlite-state.ts:948-1089`），没有 SELECT/UPDATE/parse `context_entries`。合法 v14 fixture只写 `chain/NULL/operator`（`src/issue-558-historical-fixture.ts:203-209`），所以它证明合法行保留，不覆盖异常行。

#### DB 接受、parser 拒绝的确定集合

persisted row boundary要求（`src/context-entry.ts:87-101`）：

- `chain` 必须 `scope_key IS NULL`；
- `item/group` 必须 `scope_key` 为非空 string；
- `author` 列先为 string，随后 `JSON.parse` 并过 `ContextAuthorBoundary`（`src/context-entry.ts:12-15,103-111`）。

表却允许以下 INSERT，无需关闭 CHECK：

1. `scope_kind='chain' AND scope_key IS NOT NULL`；
2. `scope_kind IN ('item','group') AND (scope_key IS NULL OR scope_key='')`；
3. `author` 为 invalid JSON，或 JSON 不是 object，或 object kind非 `operator/agent`，或 agent缺字段/`chainId`非整数/其他字段非string。
4. 利用非 STRICT table 的 storage-class宽松：`created_at` 为不可数值化 TEXT/BLOB、`id/body/author` 为 BLOB、`scope_key` 为 BLOB等。声明 affinity不会把不可转换值变成声明类型，而 persisted parser分别要求string/number。

parser matrix还确认：operator/agent额外字段目前被接受；agent 的空 `itemId/runId/phase` 也被接受。因此它们**不属于**当前 parser 拒绝集合，审计不能把它们误报为 malformed。表 CHECK 会正常拒绝未知 `scope_kind`；旧单测通过 `PRAGMA ignore_check_constraints=ON` 制造 `future` kind，不代表普通 DB 写入可达。

`Database(...,{strict:true})` 是 Bun query/binding模式，并不会把既有 CREATE TABLE 变为 SQLite STRICT table。补充矩阵 `/tmp/rfc545-d03/storage-class-matrix.ts` 在该连接模式下实际写入并观察到：`created_at='abc'` 保持 `typeof=text`、`created_at=Uint8Array` 保持 `blob`、`body=Uint8Array` 保持 `blob`，三者均 INSERT成功。`id` 空字符串虽可接受且 parser也接受，不构成差异。正常store/daemon的声明类型不会产生这些storage-class形态；direct SQL或runtime-invalid store caller可以。

### B3. 全部当前写入口、author/scope 来源与直写旁路

| 入口 | scope来源 | author来源 | malformed可达事实 |
|---|---|---|---|
| CLI `context append` | CLI args 经 `parseContextAppendCliScopeArgs` 后构造封闭 scope（`src/loop.ts:1943-1986`；`src/context-entry.ts:7-10,109,130-137`） | CLI不提交author | 未发现可制造上述异常。 |
| daemon begin/chunk/commit | begin request过 `ContextScopeBoundary`，item再检查存在，group硬拒绝（`src/daemon.ts:1830-1917`） | operator固定；agent由active credential派生（`src/daemon.ts:1769-1775,3949-3996`） | 未发现可制造上述异常。 |
| exported `SqliteStateStore.appendContextEntry` | 直接读取 `input.scope.kind` 和 `contextScopeKey` | 直接 `JSON.stringify(input.author)` | 声明类型合法时不会异常，但无runtime parse（`src/sqlite-state.ts:354,2045-2053`）。实验用JS `Function` caller写入 `{kind:'future'}` author及空item key，DB接受、list拒绝。全仓生产调用仅daemon commit；其余均tests/fixture。 |
| direct SQLite/admin/仓外代码 | 任意满足表约束/affinity值 | 任意非NULL SQLite值 | schema明确允许上述scope、author与storage-class差异；是否真实使用、是否已有存量未知。 |

全仓 `appendContextEntry` 生产调用枚举只有 `src/daemon.ts:1914`；测试直写位于 daemon/scheduler fixtures。不存在早于引入提交的 context表历史版本，因此“更老 parser曾合法写未来 variant”没有代码证据。

### B4. list/query/parser 的失败隔离、事务与恢复

唯一读取原语 `listContextEntries(chainId)`（声明 `src/sqlite-state.ts:355`；实现 `src/sqlite-state.ts:2056-2061`）执行：

```sql
SELECT * FROM context_entries
WHERE chain_id=$chainId
ORDER BY created_at,id
```

`.all()` 先取该 chain 全部 rows，随后 `.map` 对每 row依次执行 persisted-row parser、scope转换、`JSON.parse(author)`、author parser。任一阶段抛错由 read wrapper统一翻译为 `SqliteStateError`（`src/sqlite-state.ts:1614-1619`）。即使异常前的合法 row已在内存完成转换，函数仍无返回值；异常后的 row不转换。失败粒度因此是**一次 chain list调用**，不是“返回合法子集”。query只限定一个chain，其他chain不受影响。

这是只读路径，无显式transaction、无row mutation、无自动隔离/跳过/修复。相同DB状态重试会在相同order处再次失败。当前消费者全是测试或脚本：`tests/integration/{daemon,cli,scheduler}`、`tests/unit/{runtime/context-entry,sqlite-state/migrations}`、`scripts/issue-558-integration.ts`；没有产品 CLI/daemon/prompt/GUI reader。future consumer若调用现list，异常传播至其boundary；若另写分页SQL，失败至少局限于包含异常row的请求，具体整页/逐row合同尚不存在，不能从现代码外推。

### B5. 隔离 DB 实验：单 malformed + 多合法 row

实验脚本：`/tmp/rfc545-d03/experiment.ts`；完整输出：`/tmp/rfc545-d03/experiment.log`。环境：Bun 1.3.14、macOS arm64、隔离 root `/tmp/rfc545-d03/db`。关键构造未关闭constraints：

```sql
INSERT INTO context_entries
(id,chain_id,created_at,scope_kind,scope_key,author,body)
VALUES ('bad', ?, 2, 'item', '', '{"kind":"operator"}', 'malformed');
```

同 chain在created_at 1/3各有合法 row，另一chain有合法 row。观察：

```text
PRAGMA integrity_check => ok
poisoned list error => ... persisted context entry row: scope_key must be non-empty
clean list => ["other-chain"]
```

这证明单异常位于合法row之间时，caller仍得不到任何同chain list结果，且不跨chain放大。

#### migration与startup

实验将同一 DB `PRAGMA user_version=15` 后调用真实 `openSqliteStateStore`：version升至16、4 rows均保留；异常chain list仍以同错失败。随后以真实 `startCoderLoopDaemon({loopDataRoot})` 启动，观察：

```text
daemon snapshot running true
daemon.status => ok: true, daemon.running: true
```

机制与观察一致：daemon start先open/migrate store，但startup/recovery不调用 `listContextEntries`（`src/daemon.ts:1235-1278`）；migration也不解析context rows。故当前异常row不会造成启动/迁移崩溃。它留存到某个consumer读取时才失败。

#### current store bypass

第二隔离 DB通过导出store runtime函数写：

```ts
appendRuntime({scope:{kind:"chain"}, author:{kind:"future"}, ...})
appendRuntime({scope:{kind:"item",itemId:""}, author:{kind:"operator"}, ...})
```

raw rows分别落为 `{"kind":"future"}` 与空 `scope_key`；list先在future author处失败。这证明无runtime guard，不证明合法TypeScript caller或现有daemon会这样调用。

### B6. 生产存量的精确未知与只读审计

**未知：** 任何真实 deployed/production DB 中，异常row数量、variant、chain分布均未访问；仓内也没有生产DB路径可据此推断。canonical fixture全合法不能代替存量审计。

精确确定方法是对目标 DB 执行 `/tmp/rfc545-d03/read-only-audit.ts`。脚本以 Bun SQLite `readonly:true` 打开并设置 `PRAGMA query_only=ON`，只 SELECT context rows，然后调用与生产相同的 `parsePersistedContextEntryRow`、`persistedContextScope`、`JSON.parse`、`parseContextAuthor`；输出只含chainId、entry id、error和计数，不输出author/body。命令格式（**本调查未执行目标路径**）：

```bash
cd /Users/mouriya/Ext/code/coder-loop
bun /tmp/rfc545-d03/read-only-audit.ts /absolute/path/to/copied-or-production-state.sqlite
```

为避免任何运行中WAL快照歧义，应优先由运维层产生一致只读副本后审计该副本；若必须对live DB读，仍只用readonly/query_only脚本，并记录DB/WAL可见时点。退出码0表示全通过，2表示发现parser拒绝row；连接/表错误为非零异常。这个结果只回答存量分布，不推断仓外写入来源。

### B7. 测试同错、盲区与可保留资产

现有 `tests/unit/runtime/context-entry.test.ts:91-108` 有两个malformed scope case：

- `future` scope kind借助 `PRAGMA ignore_check_constraints=ON`，不是正常constraint下可达；
- `item + NULL` 本来就能通过schema，测试却同样关闭CHECK，掩盖了真正constraint差异；
- 断言只要求 `list` throw，未证明合法前后row、跨chain隔离、错误位置、startup/migration影响；
- 没有 invalid JSON/unknown author/incomplete agent、store runtime bypass、只读存量审计；
- migration tests只用合法 `chain/NULL/operator` row（`tests/unit/sqlite-state/migrations.test.ts:167-191`）。

可保留资产：已有 parser unit cases、合法 store round-trip、chain cursor index/ordering、FK cascade、migration事务与v14保全fixture。它们分别证明局部性质，不能证明 DB接受集合等于parser集合或生产存量清洁。

### B8. 证据索引

| 主题 | 证据 |
|---|---|
| 固定SHA | `git rev-parse HEAD` → `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` |
| 引入历史 | `git log --follow -- src/context-entry.ts`; commit `d381d06` |
| 当前表约束 | `src/sqlite-state.ts:775-784` |
| schema迁移 | `src/sqlite-state.ts:948-1089` |
| canonical v14 shape | `src/issue-558-historical-fixture.ts:123-134,203-209` |
| parser接受集合 | `src/context-entry.ts:12-15,87-111,139-145`; `/tmp/rfc545-d03/parser-matrix.log` |
| store写/读 | `src/sqlite-state.ts:354-356,2045-2063` |
| daemon startup | `src/daemon.ts:1235-1278` |
| 全部consumers | 全仓 `rg 'listContextEntries\\('` 结果；B4枚举 |
| 隔离观察 | `/tmp/rfc545-d03/experiment.ts`, `experiment.log`; `storage-class-matrix.ts`, `storage-class-matrix.log` |
| 只读审计 | `/tmp/rfc545-d03/read-only-audit.ts`（未执行生产路径） |

**完整交付：** 已核对固定 SHA；建立 schema/parser差异、全部当前写入口与旁路、异常来源边界、整链失败粒度、startup/migration/跨chain/恢复后果；完成隔离 DB 实验；明确生产存量未知并交付精确只读审计；登记测试同错/盲区与资产。未作方案、推荐、issue拆分或需求裁决，未修改 `WORKFLOW.md`、产品、测试或配置，未创建worktree，未访问生产数据库。

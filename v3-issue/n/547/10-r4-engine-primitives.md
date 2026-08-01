# RFC #547 R4/S6：通用入口与持久化退原语供给深审

> 审计基线：`main` / `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。设计事实只取 `AGGREGATE-547.md` §2、D7、D9、D11 与 `04-r3-supply-slicing.md` S6。本文只报告现存供给，不设计补齐、不估规模、不实施。

## A. 主 agent 摘要（最多一页）

### A1. 问题、结论与置信

**问题。** 现存 CLI/wire/create admission → chain/item SQLite → status/recovery 是否已经退役 GitHub/repository/preset fallback 原语，并只保留 §2.5 允许的一等 `chain.baseBranch`？

**结论：不符合（高置信）。** D7、D9 与 §2 H 的终态均未形成；仅 opaque item wire、部分 GitHub-shaped item 列退役、per-item preset、显式 nullable `chains.preset`、事务化 SQLite 和 `baseBranch` 的真实消费可保留。

| 稳定保证 | 判定 | 核心事实 |
|---|---|---|
| P-D7-1 opaque id / GitHub 记法退役 | **部分符合** | `item_id TEXT` 与多数 daemon item wire 已 opaque；但所有 item CLI 仍叫 `--issue`，batch 仍回填 `issue`/`issueNumber`，`queue.unblock` wire 仍是 `issue` 且会剥 `owner/repo#`，`--umbrella`/`parseUmbrellaRef` 尚存。 |
| P-D7-2 repository 迁 bindings、物理列退役 | **不符合** | v16 仍有 `chains.repository TEXT NOT NULL`；CLI 强制提供，daemon 强制 `owner/repo`；写读/status/target identity 均以物理列为权威；不存在 repository→bindings migration 与冲突响亮失败。 |
| P-D7-3 CLI `--issue`→`--item` | **不符合** | add/update/reorder/exits/exit-action/queue unblock 与 usage、脚本仍用 `--issue`，且刻意保留兼容别名语义。 |
| P-D7-4 清零 | **不符合** | `REPOSITORY_REF_PATTERN`、`normalizeQueueIssueId`、`inferRepositoryFromGit`、`parseUmbrellaRef` 均在生产源码。 |
| P-D9-1 无 preset 名兜底、缺省为 null | **不符合** | loop 与 daemon 各有 `DEFAULT_PRESET_NAME`；CLI 不传 preset 时省略 wire 字段，daemon seed `gh-issue-pr-iteration`；target status 的 null resolver又静默落同一默认。 |
| P-D9-2 单一外部 typed chain boundary | **无现存供给** | 当前 chain create 由 CLI flat bindings 与 daemon metadata validator各自执法；未见稳定条款所需外部 declaration typed boundary，故无法证明“删除 seed 前后等价”。 |
| P-D9-3 item recovery 用 per-item preset | **部分符合** | 新 item admission 强制 `preset XOR presetPath`，spawn/status 优先 item；历史 null item仍回退 chain preset，而 target status最终还能回退默认名。 |
| §2.5 `baseBranch` 唯一例外 | **部分符合** | 一等列、create validation、scheduler/worktree/closure 消费真实存在；但 repository 也被保留为一等身份/格式原语，破坏“唯一例外”。 |
| D11 当前证据能力 | **部分符合** | 有 daemon/CLI/SQLite migration与 opaque-id测试资产；没有 v16 repository退列、冲突、无默认 seed、全入口 presetless、清零终态证据。 |

### A2. 因果、影响、资产与证明缺口

根因不是单个旧符号，而是三条仍闭合的生产链：① CLI `config-json.repository` → daemon forge格式 admission → `chains.repository NOT NULL` → target repository identity/status；② CLI省略 preset → daemon默认 seed → chain-wide status/recovery，再叠加 loop resolver自己的默认；③ `--issue`/batch legacy/queue wire 的兼容路径仍主动解析 GitHub 记法。因此绿测只能证明旧语义自洽，不能证明退役。

**当前影响：** 非 `owner/repo` chain 无法创建；不传 preset 不可得到 null chain；`owner/repo#id` 在 queue unblock 被改写而非 opaque；同一 null/presetless 状态在 socket `chain.status` 与 target `status` 可走不同语义。**未来影响：** S1/S2 若读取 chain bindings，当前 repository列优先级会形成双权威；S3/S5 若假设唯一保留的是 baseBranch，会把仍存在的 repository/preset fallback 带入 tree、definition或recovery。

**可保留资产：** `item_id TEXT`/opaque daemon selector；`branch/pr` 已入 `extra`；item preset/path精确互斥；WAL、busy timeout、IMMEDIATE write transaction、batch原子写；migration单事务；`baseBranch` 一等消费；socket `chain.status` 对真正 null+无 item 能显示空 vocabulary。

**未知：** 外部 chain declaration typed boundary（C2/S8）尚无可识别生产实现，无法确定其最终 schema/parse owner；本片也不能确定 S3 closure 对 repository 的未来替代身份。确定方法是由相邻片给出实际 producer/consumer path，而非从 RFC 反推。

### A3. 接缝与下一步

- **S1/S2：** `buildEffectiveBindings` 当前先放 repository/baseBranch、后展开 metadata bindings，后者可覆盖同名值；而 status/target identity仍直接读物理列，交换的是一个已存在的双读语义。
- **S3：** `baseBranch` 是真实 scheduler/closure/worktree输入，可保留；repository作为 target identity 的现存消费不等于设计允许保留。
- **S5：** legacy v16 migration会为旧 item解析/固化 preset execution definition；item null时仍可能依赖 chain fallback，需与 definition pin 的恢复报告交叉核对。
- **D11：** R4只能登记现有证据缺口；冻结 SHA 综合验收仍属后续，不可用本次局部实验替代。

**下一步（仅审计动作）：** 主 agent将本片“不符合/部分符合/无现存供给”与 S1/S2/S3/S5 报告交叉核对，尤其核对 repository双权威、null item recovery 与 baseBranch identity 接缝；不得据此提前设计或实施。

---

## B. 证据附录

## B1. 设计对照

设计锚点：`AGGREGATE-547.md:169-179`（D7）、`:198-207`（D9）、`:55-57`（§2.5）、`:274-338`（验收）；切片要求 `04-r3-supply-slicing.md:138-154,167,183-187,217-219,231-235`。

| 设计性质 | 现存 production boundary | 消费/放大条件 | 判定 |
|---|---|---|---|
| item id只做非空/无空白 | CLI `parseRequiredItemId`; daemon string selector; SQLite `item_id TEXT` | item CRUD/status | 符合这一子项 |
| 不解析引用记法 | queue CLI/daemon仍解析 `#`/跨 repo；umbrella parser仍在 | unblock/chain create | 不符合 |
| repository仅业务 binding | CLI/daemon/SQLite/target identity均一等 | 任一chain create/status | 不符合 |
| baseBranch保留一等 | create→column→scheduler/worktree | scheduler selection/closure cleanup | 符合例外本身 |
| 不传 preset显式 null | CLI省略字段；daemon seed默认 | 任一chain create无`--preset` | 不符合 |
| 需要 preset 时点名失败 | daemon chain-only resolver会点名；loop resolver静默默认 | socket与target入口不同 | 部分符合 |
| recovery用 per-item preset | item-first，legacy null回退chain | 历史行/null行 | 部分符合 |

## B2. 全部入口与消费者清单

### B2.1 CLI 与 wire

1. `chain create`：CLI定义 `--preset`、`--umbrella`、强制 `--config-json`（`src/loop.ts:1536-1559`）；运行时从 config强制取 repository，默认 baseBranch=`main`，剥离二者后把其余键写 `metadata.bindings`，不传 preset则**不放 wire字段**（`:2185-2218`）。
2. `--umbrella`：解析 `owner/repo#123|#123` 为 `umbrellaRepo/umbrellaIssue`（`:2423-2436`），违反 D7 要求的物理移除。
3. item add/update/reorder/exits/exit-action：均暴露 `--issue` 并映射成 opaque `itemId`（`:1704-1754,1796-1927`）；底层 opaque，但词表未退役。
4. batch-add：仍兼容 JSON `issue`/`issueNumber` 并回填 `itemId`（`:2400-2419`），恰是 P-D7-1 明令清理面。
5. queue unblock：root usage仍是 `--issue <issue>`（`:3056`）；CLI `normalizeQueueIssueId` 剥 cross-repo前缀与`#`（`:4010-4034,4371-4379`），wire发送 `{issue}`。
6. daemon wire：`CHAIN_CREATE_ARG_KEYS`含 preset/repository/baseBranch（`src/daemon.ts:430-437`）；item add以`itemId`为 opaque（`:438-473`）；queue unblock known key仍是 `issue`（`:528-532`）。

### B2.2 create/update admission

- chain create缺 preset字段时 seed默认名；显式 JSON null才保留 null（`src/daemon.ts:2166-2187`）。但 operator CLI对“未传”不发送字段，没有显式 null入口。
- repository为 required string并经 `REPOSITORY_REF_PATTERN`/长度/控制字符/保留段校验（`:2166-2185,4735-4758`）。
- baseBranch缺省 `main`，经 git branch安全检查（`:2185,4761+`）；这是允许的一等字段。
- item add/batch add在 daemon边界要求 `preset XOR presetPath`，且先加载 item preset做 rights/idField/status admission（`:2887-2937,2940+,3010-3069`）。
- update不暴露 preset修改；store层却允许更新 preset/preset_path，属于内部旁路能力（`src/sqlite-state.ts:1785-1789`）。

### B2.3 持久化、读优先级与 status

- v16 `chains`仍为 `preset TEXT`, `repository TEXT NOT NULL`, `base_branch TEXT NOT NULL`（`src/sqlite-state.ts:603-618,810`）。`CreateChainInput/ChainRecord` repository均非空 string（`:72-95,367-368`）。
- create/update直接读写物理列（`:1683-1733`）；`rowToChain`直接投影（`:2161-2175`）。没有 repository binding migration或冲突检测。
- bindings渲染优先级：`{repository: column, baseBranch: column, ...metadata.bindings}`，因此 metadata同名键**覆盖**渲染值（`src/loop.ts:4330-4337`）；但 target lookup/status JSON仍读 `chain.repository` 物理列（`:4176-4214`; `src/daemon.ts:5820+`）。这是实际双权威，不是响亮失败。
- target lookup在未显式 repository时调用 GitHub-only `inferRepositoryFromGit`，只识别 github SSH/HTTPS origin，并用物理列过滤chain（`src/loop.ts:4176-4214,4348-4368`）。
- socket `chain.status`在 chain null且无 item preset时返回空 vocabulary，不加载默认（`src/daemon.ts:2453-2503`）；target `coder-loop status`则 `chainResolvedFromChain`传 null给 `resolvePresetDir`，后者用 `DEFAULT_PRESET_NAME`（`src/loop.ts:4154-4173,4306-4327,5561-5577`）。两入口不一致。
- status item优先 item preset/path；历史 null item回退 `options.preset`，其来源仍可能是默认（`:3180-3218,3421-3435`）。

### B2.4 recovery 与 scheduler消费者

- daemon item loader优先 item preset/path，缺失时回退 chain resolver（`src/daemon.ts:4422-4445,4557-4603`）；chain resolver顺序是 metadata presetPath → chain.preset → 点名错误。
- chain status/complete等无 item路径会取代表 item，否则回退 legacy chain seed（`:2485-2503`）。
- schema v9给 items增 preset/preset_path并从 chains.preset回填旧行（`src/sqlite-state.ts:1034-1049`）；这保存历史语义但不是 D9终态退役。
- v16旧 runtime迁移通过独立 preset loader解析 item preset/path以形成 execution definition（`:1121-1190`）。null item的可恢复性仍受 chain seed/历史形状影响；与 S5 pin 报告交叉核对。
- scheduler构造运行绑定与工作树输入仍携带 `repository: chain.repository`、`baseBranch: chain.baseBranch`（`src/scheduler.ts:2825,3205`）；只有 baseBranch是稳定设计允许的一等例外。

## B3. migration、事务、并发、崩溃恢复与旁路

1. 当前 schema版本16（`src/sqlite-state.ts:810`）；open启用 FK、5秒 busy timeout、WAL后执行 migration（`:824-856`）。
2. migration在一个 SQLite transaction中运行，必要时关FK，完成后统一写 `PRAGMA user_version=16`（`:948-1086`）。普通写走 `db.transaction(fn).immediate()`（`:1605-1612`）；batch `createItems`在同一 write transaction，冲突不部分写（`:1742-1743`及 `tests/integration/daemon/item-crud.integration.ts:119-148`）。
3. 已有 GitHub shape migration只覆盖：umbrella列→bindings（v10→v11）和 item `issue_number/branch/pr`→`item_id/extra`（v11→v12）；repository从未纳入迁移（`src/sqlite-state.ts:789-810,954-966,1007-1015,1229-1365,1397-1440`）。
4. umbrella冲突策略是已有 binding存在即不覆盖；注释却称旧列赢，代码实际 `=== undefined` 才写（`:1397-1439`）。这不是本片 repository冲突，但表明现有相似迁移不能作为 D7“冲突响亮失败”先例。
5. schema shape检测即使 `user_version>=16`仍会重建缺表/旧列形状，具备部分崩溃后重入能力（`:977-998`）；但 repository退列没有 shape检测、迁移、恢复路径，故无从验证中断安全。
6. 内部 store API能直接 create/update chain并绕过 daemon repository/preset admission；测试大量使用此旁路。生产 CLI/socket则受 daemon强校验。不能用 store fixture成功证明入口执法符合。
7. daemon创建chain的 DB写是事务性的，但 DB提交与后续 runtime目录/observability并非一个跨资源事务；本片未发现这会改变 D7/D9结论。未来若迁 bindings，仍需由实现阶段证明崩溃后不产生列/binding双权威；此处不设计方案。

## B4. 最小隔离实验

所有实验均在本地 `/tmp`，未触碰 `~/.coder-loop`、中央 daemon或生产DB；实验daemon已用自己的 `daemon down`停止。

**登记：**

- `/tmp/rfc547-s6-live-e689cbb3-c72c-4593-be22-aaf57e54c220/`：隔离 loop-data root（含 `db.sqlite`、fixture daemon socket/log/materialized preset）。
- `/tmp/rfc547-s6-root.txt`：上述root路径。
- `/tmp/rfc547-s6-cli-experiment.txt`：CLI输出。
- `/tmp/rfc547-s6-db-inspect.txt`：只读 PRAGMA/row输出。
- `/tmp/rfc547-s6-loop.txt`、`-daemon.txt`、`-sqlite.txt`：带行号的只读源码摘录。

命令（在 repo root）：

```sh
bun src/loop.ts daemon up --loop-data-root "$root" --json
bun src/loop.ts chain create s6-no-repo --loop-data-root "$root" --json
bun src/loop.ts chain create s6-nonforge --config-json '{"repository":"opaque business value","baseBranch":"main"}' --loop-data-root "$root" --json
bun src/loop.ts chain create s6-default --config-json '{"repository":"owner/repo","baseBranch":"main"}' --loop-data-root "$root" --json
bun src/loop.ts chain list --loop-data-root "$root" --json
# bun:sqlite只读 PRAGMA user_version/table_info(chains)/SELECT
bun src/loop.ts daemon down --loop-data-root "$root" --json
```

观察：

- 缺 config/repository：CLI在到达daemon前失败 `No value provided for --config-json`。
- 非forge repository：daemon失败 `invalid_request: repository must use owner/repo format`。
- 不传 `--preset`：创建成功，但 status/list显示 `preset: "gh-issue-pr-iteration"`，不是 null。
- DB：`user_version=16`、journal WAL；`chains.repository` notnull=1；创建行 preset/default、repository/base_branch均物理存储，metadata仅 `{"bindings":{}}`。

该实验直接证伪 V-7d、V-9a，并确认 R2关于 v16 shape/default seed 的线索；它不是冻结 SHA E2E。

## B5. 测试同错与盲区

### 同错（测试主动固化旧语义）

- `tests/unit/loop/parsers.test.ts:438-440`期望 `normalizeQueueIssueId("owner/repo#333") === "333"`，与 opaque原样存取相反。
- CLI integration普遍调用 `--issue`（如 `tests/integration/cli/central-cli.integration.ts:281,305,575,1028`；`smoke.integration.ts:152,186`），所以绿测证明旧词表可用。
- daemon/scheduler fixtures普遍要求 repository `owner/repo`并直接写物理字段；无法证明无 repository也能创建。
- migration tests在各版本fixture中继续声明 repository，且当前列清单期望 repository（`tests/unit/sqlite-state/migrations.test.ts:33-62`）；没有 repository→binding/冲突测试。
- `tests/unit/sqlite-state/task-tree.test.ts:324`等 store级 preset:null fixture绕过 CLI/daemon seed，不能证明 operator入口可创建 presetless chain。

### 盲区

- 无 V-7d：无 repository chain + opaque arbitrary id + status。
- 无 V-7f：v13/v16 repository迁 bindings、items/runs无损、binding冲突响亮失败。
- 无 V-9a：CLI缺 preset得到 null，并在“需要 preset”路径点名失败。
- 无 V-9b：外部 typed chain declaration boundary与 socket结果等价。
- 无生产清零 grep gate；`scripts/engine-integration-stub-runner.ts:85`自身仍调用 `--issue`。
- 无 socket `chain.status`与target `status`对同一 presetless/null历史行的差异测试。

## B6. 证据索引与接缝交换

| 主题 | 主要证据 | 交给 |
|---|---|---|
| repository物理权威/格式 | `src/daemon.ts:2166-2187,4735-4758`; `src/sqlite-state.ts:603-618,1683-1733`; 实验 | S1/S2/S3 |
| bindings覆盖与读面分裂 | `src/loop.ts:4176-4214,4330-4337`; `src/daemon.ts:5820+` | S2 |
| baseBranch真实例外 | `src/daemon.ts:2185,4761+`; `src/scheduler.ts:2825,3205` | S3 |
| 默认 seed双实现 | `src/loop.ts:79,5561-5577`; `src/daemon.ts:408,2166-2180` | S5 |
| item-first/legacy fallback | `src/daemon.ts:2485-2503,4422-4445,4557-4603`; `src/loop.ts:3180-3218` | S5 |
| opaque资产与GitHub残留 | `src/loop.ts:1704-1927,2400-2436,4010-4034,4371-4379`; `src/daemon.ts:438-532` | S1/D11汇总 |
| migration事务与缺口 | `src/sqlite-state.ts:948-1086,1605-1612`; migration tests | D11汇总 |

## B7. 尾部结论

**R4/S6尾部结论：现存供给整体不符合稳定 RFC D7/D9 与 §2 H；`baseBranch` 的一等保留本身有真实消费，但并非唯一残留。可保留 opaque item存储/wire主体、per-item preset、事务化v16迁移框架和 baseBranch机制；repository物理列/forge admission、`--issue`及 GitHub解析、两处默认 preset fallback仍组成生产闭环，且 repository迁移/冲突与全入口 presetless/null验收无现存供给。**

# RFC #548 R8 follow-up：历史 opaque `extra` 与迁移边界

**固定基线：** `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点为 `AGG-548.md` T2 / P-747 与 `operator-decisions.md` D1–D4，尤其 D3“所有改变 `extra` 的写入口共同守住持久态 schema 不变量”。本报告只调查；未写生产 DB、未启动 daemon、未修改产品或测试。

## A. 摘要（≤1 页）

### 真实数据结论

只读打开 `~/.coder-loop/loop-data/db.sqlite`：它是 `user_version=14`，含 58 个 item；另两个候选 DB 是 0-byte 空库。13 个 chain 中 10 个为 `deleted`、3 个为 `stopped`，没有 `active` chain。58 行 `extra` 都是合法 JSON object。

- 54 行声明 bundled `gh-issue-pr-iteration`；按 **当前 checkout 的 preset** 与 D2（旧字符串字段默认 required）重判，**0/54 合格**。54 行均缺至少一个 required 字段，54 行的 `issue` 均为 string 而当前声明为 number；若把整份 `extra` 直接施加 `additionalProperties:false`，35 行还含 preset 未声明键。7 个当前 terminal-status 行与 47 个 nonterminal-status 行同样都是 0 合格。
- 4 行声明 `moat-experiment-loop`，当前 bundled presets 中不存在该名字，因而无法取得当前 schema；它们都在 stopped chain。
- `extra` 不是纯业务 payload：真实行中有 `dependsOn` 24、`schedulerBackoff` 8、`presetMigration` 7；前两者至少是当前 engine 识别/写回的 control-plane shape，`presetMigration` 是历史迁移 remainder。当前 `ItemExtra` codec明确把若干 engine keys 与任意 remainder 合存在同一 JSON object。因此，“unknown field”若直接对整份 `extra` 判断，会把 engine-owned 与历史 engine-owned 数据一并判错；D3 尚未说明 schema 校验域如何与 engine namespace 合成。

数据说明了 D3 不能只靠“从现在开始校验 add/update”就立即得到全库不变量：当前真实库在新解释下已有 58/58 无法证明合格（54 明确违规，4 缺 schema）。同时，按名字/路径定位的 preset 是 live filesystem 内容，不是 item 创建时冻结的 schema；字段声明变化会对历史行产生追溯性新结论。

### 裁决准备度

事实足以裁决以下兼容边界，但不替操作员选择：

1. **校验域：** preset schema只约束 business remainder，还是一个合成 schema 同时声明 engine-owned keys；整份 `extra` 直接 strict 校验与当前 multiplexed 存储冲突。
2. **历史行时点：** schema 启用时对全库 startup migration/scan、首次 read/use、首次任何 update、仅触碰 business `extra` 的 update，或只约束新行。各形态的确定后果见 B.6。
3. **不可定位/漂移 schema：** missing preset 与同名 preset 变更时，历史行是阻止 startup/调度/写入，还是进入显式 legacy/quarantine 状态；当前 item 没有持久化 schema version/hash 可重建创建时解释。
4. **deleted/terminal 范围：** `deleted` 是 chain status，不会删除 item row；是否仍纳入“持久化 item 始终符合”的量词必须明确。真实库中 deleted-chain 29 个 gh item 全部违规。
5. **转换权限：** `issue` string→number、为缺失 branch/pr/lastRunId 造值、移除/保留历史 keys 都不是现有 schema 可无损推出的转换；自动 rewrite 需要额外语义裁决。

## B. 证据附录

### B.1 数据模型、写入口与 shape

| 入口 | 当前行为 | 证据 |
|---|---|---|
| CLI/daemon add、batch-add | 先按 item preset load，回填 `extra[idField]`，只过通用 `ItemExtra` codec，再 insert；batch复用同一 input | `src/daemon.ts:3001-3057`; `src/sqlite-state.ts:2185-2223` |
| daemon item.update | `extra` replace 或 `extraPatch` merge；dependsOn/branch/pr作局部 shape检查；最终 `store.updateItem` | `src/daemon.ts:3120-3197`, `5260-5291` |
| store低层 update | `input.extra ?? current.extra` 后整行 UPDATE；store可同时变更 preset/presetPath，未加载 schema | `src/sqlite-state.ts:1762-1803` |
| scheduler writes | 清/写 backoff、spawn error，清 dependsOn，并经 `store.updateItem` 改同一个 `extra` | `src/scheduler.ts:780-822,1647-1656,1896-1904,2635-2649` |
| migration | v11→v12把旧 identity/branch/pr salvage 进 `extra`，临时 sentinel 后重建表；没有按 preset字段重判 | `src/sqlite-state.ts:1254-1317,1344-1367` |

`ItemExtra` typed engine keys包括 hooks、dependsOn、schedulerBackoff、schedulerSpawnError、slot/run process facts；未知 remainder被保留并在序列化时与 typed keys合并：`src/runtime-data.ts:159-194,231-245,409-435,557-584`。status 仅隐藏 hooks，其他 `extra` 被透明 flatten：`src/runtime-data.ts:438-443`; `src/loop.ts:3420-3471`。

### B.2 preset 定位与版本漂移

新 item API要求 exactly one of `preset` / absolute `presetPath`；row持久化两列，但没有 schema version/hash：`src/sqlite-state.ts:129-160`; `src/daemon.ts:3060-3084`。运行时 per-item resolution顺序为 item path、bundled name、legacy chain fallback；随后从当前目录 load并按路径 cache：`src/daemon.ts:4429-4466,4586-4604`。status也逐 item从当前目录 load，load失败使 snapshot失败而非静默 fallback：`src/loop.ts:3186-3220`。

因此：bundled 同名内容升级、presetPath内容原地变化、路径删除都会改变或消灭历史行的可重判 schema。v16 migration会为 execution definition materialize/hash task definition，但 legacy resolver仍先依赖 item当前 preset declaration可加载；这不是 item field schema snapshot：`src/sqlite-state.ts:1118-1209`。

### B.3 真实 DB 脱敏统计

只读 SQL（URI `mode=ro`）及本地 JSON shape统计；未输出 repo path、title、payload值或 secret：

```sql
PRAGMA user_version;
SELECT status, count(*) FROM chains GROUP BY status;
SELECT c.status, i.status, i.preset, i.preset_path, count(*)
FROM items i JOIN chains c ON c.id=i.chain_id GROUP BY 1,2,3,4;
SELECT json_valid(extra), count(*) FROM items GROUP BY 1;
```

| 范围 | 行数 | 合格 | missing-required | type-mismatch | unknown（整份 extra strict 时） |
|---|---:|---:|---:|---:|---:|
| gh preset 全部 | 54 | 0 | 54 | 54 | 35 |
| deleted chain | 29 | 0 | 29 | 29 | 10 |
| stopped chain | 25 | 0 | 25 | 25 | 25 |
| current terminal status | 7 | 0 | 7 | 7 | 4 |
| current nonterminal status | 47 | 0 | 47 | 47 | 31 |

分类可重叠。current gh schema是 `issue:number, branch:string, pr:number, lastRunId:string`；D2使四者均 required：`presets/gh-issue-pr-iteration/preset.toml:21-35`; terminal vocabulary见同文件 `:56-57`。真实 key/type计数：`issue:string` 58、`dependsOn:array` 24、`pr:number` 10、`branch:string` 9、`schedulerBackoff:object` 8、`presetMigration:object` 7。shape signature仅保存 SHA-256 前12位于调查日志，报告不含值。

### B.4 read/startup/scheduler 消费与失败传播

DB row read会 JSON parse并立即过 `storedItemExtra`; typed engine key shape坏会使 row read失败，remainder则继续保留：`src/sqlite-state.ts:2247-2255`; `src/runtime-data.ts:557-584`。scheduler对每个 item解析其 preset，按其 status vocabulary选取，并读取 dependsOn/backoff等 control keys；binding读取则直接从 `extra[field]`，缺失/null过去可变空字符串、复合值失败：`src/scheduler.ts:3230-3240,2631-2679`; `src/loop.ts:6007-6036`。status路径在构建 queue前加载所有 item preset，所以 stopped/deleted chain是否被某具体命令读取取决于调用链，但一旦目标 chain被读，missing preset可令整次 status失败。

### B.5 migration、事务、锁与 crash

当前 schema migration在 open 时执行，整体包在一个 SQLite transaction 的 `.immediate()`；`busy_timeout=5000`，并要求 WAL：`src/sqlite-state.ts:822-850,978-1087`。普通 store write也统一 `.immediate()`：`src/sqlite-state.ts:1598-1610`。由此，放进既有 migration transaction 的 scan/rewrite具备 commit/rollback原子性；任一 preset缺失、转换失败或 lock超时会阻止 open，不会留下半次 transaction。代价是 preset load目前有 async loader，而 migration transaction是同步；现有 v16 legacy migration通过 child Bun同步解析 preset，并在任何 item失败时抛错阻止整个 migration：`src/sqlite-state.ts:1183-1209`。

若scan/rewrite不放在同一 transaction（例如 startup后逐行、lazy read/update），现有代码没有 migration progress表或每行 schema-version marker；crash后只能重新扫描当前值，且 preset在两次启动间变化会改变判定。当前 WAL允许并发读，但 IMMEDIATE writer会取得写保留锁；中央 daemon单实例约束不等于离线工具天然互斥。

### B.6 事实支持的兼容形态及确定后果（非推荐）

| 形态 | 事实上的触点 | 确定后果 |
|---|---|---|
| open-time全库 strict scan/rewrite | `openSqliteStateStore` migration transaction | 能在 daemon可服务前建立全库断言；当前真实库会因54违规+4 missing preset整体拒绝启动，除非同时定义转换/豁免。长scan持有IMMEDIATE写事务。 |
| open-time只scan并记录，不rewrite | 同上或新增durable结果 | 不改变历史行，不能让“所有持久化 item”字面成立；若仅日志，crash后无版本证据。 |
| lazy read/use gate | `rowToItem`之后、per-item preset loader之前/之后 | 不相关行不阻塞startup；首次status/scheduler可能因历史行失败，且同一 DB中合规/不合规并存。 |
| first-write full-row gate | daemon/store `updateItem` | 历史行可读；任何 scheduler仅改 backoff/dependsOn也可能因业务旧值而失败，影响恢复与重试。若只gate外部update，则内部写入口不满足D3。 |
| business-remainder-only gate | codec拆分出的 remainder + preset fields | 能保留engine keys；必须先权威划分 engine keys与业务 keys。历史 `presetMigration` 属 remainder还是退休engine key，当前代码没有标签。 |
| legacy schema/version marker | item新增持久化 schema identity | 可避免按live preset追溯解释，但当前58行没有该identity，无法事后知道创建时精确 schema。 |
| 排除deleted/terminal历史行 | chain/status过滤 | 缩小量词；这些行仍物理持久化、仍能被list/status读取，所以不能再声称无条件“持久化 item 始终符合”。 |

### B.7 测试盲区与待裁问题

现有测试覆盖 opaque migration、通用 codec、add/batch/update，但没有用D2 required语义扫描真实/历史行，也没有覆盖：missing preset、同名schema变化、engine-key与unknown policy组合、deleted/terminal量词、migration中途preset load失败、startup scan lock/crash、scheduler内部extra写遇到legacy业务值。定位：`tests/integration/daemon/item-crud.integration.ts:219-286`; `tests/unit/loop/runtime-bindings.test.ts`; `tests/unit/sqlite-state*`; `src/issue-558-historical-fixture.ts`。

必须由操作员裁决、事实不能推出：B.6选哪一种时点/量词；engine/business namespace；对54行的转换或豁免；4个missing-preset行的命运；是否冻结schema identity；字段schema变更是否允许追溯影响旧item。

### B.8 证据索引与核对

- D3/D2：`operator-decisions.md:24-53`
- T2/P-747：`AGG-548.md:95-104`
- preset字段：`presets/gh-issue-pr-iteration/preset.toml:21-35`
- item schema/store：`src/sqlite-state.ts:129-171,822-850,978-1087,1598-1610,1762-1803,2185-2255`
- API/load/update：`src/daemon.ts:3001-3197,4429-4466,4586-4604`
- codec/消费者：`src/runtime-data.ts:159-194,231-245,409-486,557-584`; `src/scheduler.ts:780-822,1896-1904,2631-2679`; `src/loop.ts:3186-3220,3420-3471,6007-6036`


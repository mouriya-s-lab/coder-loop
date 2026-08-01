# R8/I-20 — 无内容历史 execution instance 只读分布调查

> 固定代码基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 真实数据只读面：`~/.coder-loop/loop-data/db.sqlite`、中央 events、chain run目录、`preset-materialized/`；SQLite以URI `mode=ro`打开。  
> 范围：只统计definition恢复证据与活跃性，不输出repository、item title、prompt、bindings、session、路径内容或其他敏感值；不修改产品/测试/WORKFLOW/真实DB，不创建worktree。

## A. 摘要（≤1页）

当前中央真实数据库不是R7-11所述已有`execution_definitions/task_nodes`的schema 16，而是 **user_version 14**。它只有`chains/items/runs/current_runs/context_entries`，没有execution definition、task node、closure或definition ref列。由此首先修正I-20的对象分类：

- **只有ref/hash壳的真实历史instance：0**。不是因为内容完整，而是当前真实DB尚未产生ref/hash壳。
- **完全没有definition identity/content的legacy数据：15 chains、69 items、932 runs**。
- chain状态为12 deleted、3 stopped；当前active chain=0、current run=0、unfinished run=0。
- 3个stopped chain包含29 items、652 runs，是唯一仍可能经operator resume进入调度的当前数据集合；其中25 items仍为queued。它们全部有显式item preset locator，但locator只会解析当前source，不能证明历史bytes。
- 12个deleted chain包含40 items、280 runs；中央run目录中没有这280个run的目录。

definition恢复证据为零：

1. 932个run的`extra`均没有`definitionContentIdentity/sourceHash/definitionPhases`。
2. 34,503条中央event没有任何definition hash/ref key。925/932个DB run能关联至少一条event，event中的`presetDir`只是两个可变source目录之一；current source不能作为历史定义证据。
3. events曾提到43个不同materialized artifact目录，目前只剩2个。两者有`.materialized-complete` marker，但R7-03已证明marker只表示copy完成、不证明compile verdict或内容完整。更关键的是，DB/event没有definition hash把这2个目录关联到某个历史chain/item/run。
4. 19个event run id曾在错误/退出事件中带materialized路径，其中12个仍在DB；这些12个所指目录现在全部缺失。它们也只是错误上下文，不是“该run使用了此definition”的内容证明。
5. 3个stopped chain的652个run目录仍在，并各有status artifact；没有完整prompt/definition artifact。run status只能证明执行结果，不能重建template/fragments/status graph/rights/runner defaults等定义闭集。

因此 **可验证匹配原历史definition的chain/item/run均为0**。现存source locator、event source path、marker目录、run status与当前source都只能作为弱线索，不能提高为历史内容证明。R7-02的path-only cache在进程退出后消失；R7-03的eager prune解释了43→2的artifact流失；R7-11的“ref仅作attribution”在真实中央DB上还未发生，现状更早：连attribution ref都没有。

另有一份2026-07-15只读backup（schema 14：9 chains、10 items、103 runs，6 active/3 stopped）。它是历史快照，不是当前可resume状态；同样0 definition hash/ref，不能补齐当前15 chains的内容。worktree内大量schema16/17 test/evidence DB是测试产物，不是中央真实instance，已从分布统计排除。

**I-20事实已经足够排除“按现存hash/ref自动恢复旧内容”：真实数据没有hash/ref，0个instance能证明原内容。migration必须把pre-ref legacy与未来shell-ref分开；任何把当前source重新compile后写成“历史definition”的动作都会制造隐式rebind，而不是恢复。**

## B. 证据附录

### B1. 实际路径与只读边界

#### B1.1 路径核验

发现的顶层候选：

| 路径 | 大小/角色 | 采用 |
|---|---|---|
| `~/.coder-loop/loop-data/db.sqlite` | 802,816 bytes，中央运行DB | 是，`mode=ro` |
| `~/.coder-loop/loop-data/state.sqlite` | 0 bytes | 否 |
| `~/.coder-loop/db.sqlite` | 0 bytes | 否 |
| `~/.coder-loop/backups/preset-migration-20260715-123342/db.sqlite` | 历史migration backup | 单独统计，不并入current |
| `~/.coder-loop/loop-data/chains/**/.coder-loop/runtime/evidence/**/db.sqlite` | 测试/证据fixture DB | 排除，不是真实中央instance |

`db.sqlite-wal`为0 bytes；调查没有checkpoint、copy、vacuum或写PRAGMA。

#### B1.2 SQLite只读命令

```sh
sqlite3 'file:/Users/mouriya/.coder-loop/loop-data/db.sqlite?mode=ro'
```

仅执行：

```sql
PRAGMA user_version;
PRAGMA schema_version;
SELECT name,type FROM sqlite_master ...;
SELECT count(*) ...;
SELECT ... GROUP BY status;
SELECT json_type(extra,'$.definitionContentIdentity') ...;
```

没有读取或输出JSON value正文；只统计key是否存在。

### B2. Schema/version

| 项 | 真实中央值 |
|---|---:|
| `PRAGMA user_version` | 14 |
| `PRAGMA schema_version` | 10 |
| domain tables | `chains,items,runs,current_runs,context_entries` |
| `execution_definitions` | 不存在 |
| `task_nodes/task_trees/task_closures` | 不存在 |
| definition ref/hash columns | 不存在 |

中央运行DB与代码基线的schema能力存在版本差；本报告只描述磁盘实然，不把测试/evidence DB冒充已迁移生产数据。

### B3. 当前实体分布

#### B3.1 总量

| 实体 | 数量 |
|---|---:|
| chains | 15 |
| items | 69 |
| runs | 932 |
| current_runs | 0 |
| unfinished runs (`ended_at IS NULL`) | 0 |

#### B3.2 按chain状态

| chain状态 | chains | items | runs | 当前调度含义 |
|---|---:|---:|---:|---|
| deleted | 12 | 40 | 280 | 非active；正常状态下不resume |
| stopped | 3 | 29 | 652 | 非active；可能由operator显式resume |
| active | 0 | 0 | 0 | 当前无活跃实例 |
| completed | 0 | 0 | 0 | — |

#### B3.3 Item状态

| chain状态 | item状态 | 数量 |
|---|---|---:|
| stopped | queued | 25 |
| stopped | done | 2 |
| stopped | retry_export | 1 |
| stopped | changes_requested | 1 |
| deleted | queued | 30 |
| deleted | done | 6 |
| deleted | changes_requested | 2 |
| deleted | exhausted | 1 |
| deleted | contract_invalid | 1 |

“queued”不等于当前active；25个queued item受其3个stopped chain阻断，但在chain resume后可能重新进入resolver。

### B4. Definition identity/ref分布

| 证据对象 | 查询结果 |
|---|---:|
| execution definition rows | 0（table不存在） |
| task nodes with definition ref | 0（table不存在） |
| runs with `definitionContentIdentity` | 0/932 |
| runs with `sourceHash` | 0/932 |
| runs with `definitionPhases` | 0/932 |
| central events with definition/hash/ref key | 0/34,503 |

结论分类：

| 分类 | chains | items | runs |
|---|---:|---:|---:|
| 有完整definition内容 | 0 | 0 | 0 |
| 只有ref/hash壳 | 0 | 0 | 0 |
| pre-ref legacy（既无内容也无identity） | 15 | 69 | 932 |

### B5. Preset locator不等于历史definition

| Locator事实 | 数量 |
|---|---:|
| chain有named preset | 15/15 |
| chain有metadata presetPath | 0/15 |
| chain无任何source locator | 0/15 |
| item有preset或presetPath | 69/69 |
| item两者皆null | 0/69 |
| item带`presetMigration`记录 | 7/69 |

这些locator只说明当前resolver“会去哪里找”。它们不包含历史source bytes、source hash、compile schema version或content manifest。

R7-02已经证明：

- 同一path的成功Promise只在daemon进程寿命内偶然冻结；
- restart后旧instance会重新读取当前source；
- current-source consumer与daemon cache可同时看到不同版本。

当前DB没有保存该进程内H1对象；因此不能从locator推回H1。

### B6. Event证据

#### B6.1 总体

| Event统计 | 数量 |
|---|---:|
| event JSON lines | 34,503 |
| distinct event run ids | 1,054 |
| event run ids仍在DB | 925 |
| event run ids已不在DB | 129 |
| DB runs有event | 925/932 |
| DB runs无event | 7/932 |
| events with definition hash/ref key | 0 |

#### B6.2 Source path

1,054个event run id都能看到一个`presetDir`，但只落在2个source目录。该字段没有source hash，且路径内容可变。按任务约束，**current source不作为历史证据**。

#### B6.3 Materialized path

| Materialized事件事实 | 数量 |
|---|---:|
| events含`preset-materialized`字符串 | 5,426 |
| distinct artifact目录 | 43 |
| 目前仍存在 | 2 |
| 目前缺失 | 41 |
| 仍存在且有marker | 2 |
| 带materialized上下文的event run ids | 19 |
| 其中仍在DB | 12 |
| 这12个仍有其event所指目录 | 0 |

5,404条来自placeholder-check类事件，另外是agent-exit/timeout/spawn-aborted错误上下文。这些事件证明某次检查/错误提到某个路径，不证明某个instance完整执行定义等于该目录。

### B7. Artifact/hash匹配

#### B7.1 当前两份materialized目录

两份目录：

- 都有`.materialized-complete`；
- 都有`preset.toml`；
- 都没有可与DB row连接的definition identity；
- event中的run source path也不是这些materialized路径。

R7-03已经证明marker只代表copy完成：

- marker写于compile前；
- invalid/incomplete source也可得到marker；
- marker hit不复核内容；
- 新hash会eager prune同basename旧artifact。

因此“目录名含hash前缀 + marker存在”最高只能证明artifact locator形状，不能证明compile verdict，更不能证明它是某chain/item/run创建时的原内容。

#### B7.2 匹配结论

| 匹配强度 | chain/item/run数量 |
|---|---:|
| exact definition identity → artifact content | 0 |
| persisted hash → artifact hash prefix | 0 |
| run event明确指向仍存在artifact | 0 |
| current locator → current source（非历史证据） | 15/69/925个有相关locator/event，但不得计为匹配 |

### B8. Run目录与可恢复内容

中央chain run目录统计：

| chain状态 | DB runs | exact run目录仍在 | status.json存在 | 完整definition/prompt artifact |
|---|---:|---:|---:|---:|
| stopped | 652 | 652 | 652 | 0 |
| deleted | 280 | 0 | 0 | 0 |

status artifact可证明某次run的进程/结果观察，但不能恢复：

- prompt template bytes；
- fragment bytes与roles；
-完整status vocabulary/exits；
- variables、rights、triggers；
- phase runner/model defaults；
-完整compiled task model。

因此run目录不提高definition证据等级。

### B9. 活跃性与resume风险

#### B9.1 当前

- active chain：0；
- current run：0；
- unfinished run：0；
- stopped chain：3；
- stopped items：29，其中queued 25；
- stopped-chain run history：652。

“可resume”在本报告中只指chain状态允许operator显式恢复的潜力，不声称resume命令已执行。3个stopped chain是migration时唯一必须按“可能继续运行”对待的current cohort。

#### B9.2 风险

这29个item有locator但无历史definition。若migration或resume直接按locator加载当前source：

```mermaid
flowchart LR
  L[legacy item locator] --> C[current source]
  C --> H[new hash/content]
  H --> R[resume old item]
```

该路径是R7-11定义的隐式rebind，不是历史恢复。DB/event/run artifact都无法证明current content等于原run content。

### B10. Backup与测试DB边界

#### B10.1 历史backup

`~/.coder-loop/backups/preset-migration-20260715-123342/db.sqlite`：

| 项 | 数量 |
|---|---:|
| schema user_version | 14 |
| chains | 9 |
| items | 10 |
| runs | 103 |
| snapshot chain status | 6 active / 3 stopped |
| definition hash/ref | 0 |

这是旧时点snapshot，不能证明其中“active”仍active，也不能与current DB简单相加。它能互证：pre-ref数据形状在migration前已存在，且backup同样不保存definition content。

#### B10.2 排除的test/evidence DB

chain worktree的`.coder-loop/runtime/evidence/**`包含大量schema16/17 DB和synthetic execution definition rows。它们由tests/fixtures产生，不是中央daemon的真实chain/item历史；把它们计入会虚增“可恢复ref”。本报告完全排除。

### B11. 证据等级

| 等级 | 定义 | 当前数量/结论 |
|---|---|---|
| E4 | content-addressed definition artifact，ref/hash验证完整内容 | 0 |
| E3 | persisted hash/ref可关联现存artifact，但内容未完整验证 | 0 |
| E2 | run/event明确关联immutable artifact locator | 0 |
| E1 | mutable source locator、marker或run status线索 | 15 chains、69 items、925 event-linked DB runs；不可作历史证明 |
| E0 | 无definition线索 | 全部932 runs在identity/content意义上为E0；7个连event也无 |

E1不会因current source恰好存在而升级。没有creation-time hash就无法证明相等。

### B12. 不可恢复集合

“不可恢复”在此严格指“无法从可访问证据重建并验证原完整definition”，不表示业务数据必须删除。

| 集合 | chains | items | runs | 运行状态 |
|---|---:|---:|---:|---|
| current pre-ref legacy总集 | 15 | 69 | 932 | 12 deleted、3 stopped |
| 可能resume子集 | 3 | 29 | 652 | stopped；25 items queued |
| 非active deleted子集 | 12 | 40 | 280 | deleted |
| 有可验证historical definition | 0 | 0 | 0 | — |

所有current legacy instance在definition层均不可恢复；区别只在是否仍可能继续运行。

### B13. Migration约束与确定后果

这些是事实约束，不选择migration方案：

1. migration必须识别 **pre-ref legacy**，不能把它标作“已有shell ref但content missing”。
2. 不能从current source编译H2并把其hash写成历史H1的definition identity；那是隐式rebind。
3. locator、event source path、marker目录、run status均不足以证明原内容。
4. 3个stopped chain/29 items是可能继续运行集合；任何自动继续路径都会在无历史证明下选择current definition。
5. 12个deleted chain/40 items/280 runs没有active/current run，但其审计历史同样不能伪造definition ref。
6. 2个现存materialized目录不能按basename或当前locator自动分配给15个chain。
7. 41个历史materialized目录已缺失；eager prune使“以后再找旧目录”没有事实基础。
8. backup不能作为current row的definition source：它没有hash/content，且snapshot身份/状态已过时。
9. migration结果必须能区分“历史内容已验证”“仅locator可用”“完全不可恢复”，否则status会把猜测伪装成pin。
10. migration验证不能以“restart后能跑”作为历史正确性证据；能跑可能只证明current-source rebind。

### B14. 仍未知

- 3个stopped chain是否还需要业务上继续；这是operator运行意图，不是definition内容事实。
- 真实旧source是否存在于git历史或其他备份；当前DB/event没有commit/ref把实例绑定到某个repository revision，不能安全关联。
- 旧app在各run时刻的exact commit与preset source bytes；event没有producer binary/version identity。
- 7个无event DB run是否有外部日志副本；当前可访问中央路径未找到。
- 非macOS/其他运行节点是否有另一个未同步loop-data-root；本次仅核验本机权威路径。

这些未知不改变“当前可访问证据无法验证原definition”的结论。

### B15. 只读命令与SQL索引

```sh
find ~/.coder-loop -maxdepth 4 -type f \
  \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \)

sqlite3 'file:/Users/mouriya/.coder-loop/loop-data/db.sqlite?mode=ro'
```

核心SQL：

```sql
PRAGMA user_version;
PRAGMA schema_version;

SELECT name,type
FROM sqlite_master
WHERE type IN ('table','view');

SELECT c.status,
       count(DISTINCT c.id),
       count(DISTINCT i.id),
       count(DISTINCT r.id)
FROM chains c
LEFT JOIN items i ON i.chain_id=c.id
LEFT JOIN runs r ON r.chain_id=c.id
GROUP BY c.status;

SELECT count(*)
FROM runs
WHERE json_type(extra,'$.definitionContentIdentity') IS NOT NULL
   OR json_type(extra,'$.sourceHash') IS NOT NULL
   OR json_type(extra,'$.definitionPhases') IS NOT NULL;
```

Events通过只读Python逐行parse，只输出计数、key存在性与文件存在性；没有输出payload值。run目录只比较DB `run_id`与目录basename并统计artifact文件名，不读取内容。

### B16. 与R7结论互证

| R7报告 | 本次真实数据互证 |
|---|---|
| R7-02 cache coherence | event只存mutable source path，无进程cache快照；restart后无法证明旧H1 |
| R7-03 materialize transaction | 43个历史artifact locator只剩2个；marker不能证明compile成功；eager prune后无旧版保留 |
| R7-11 definition pin | 中央DB甚至早于shell-ref schema：create/run历史无content、无hash、无resolver；current source不能恢复历史 |

## 尾结论

本机权威中央DB为schema 14：15 chains、69 items、932 finished runs全部属于pre-ref legacy；只有ref/hash壳为0，完整definition为0，可验证关联历史artifact也为0。当前无active/current run；3个stopped chain、29 items、652 runs仍是潜在resume集合，直接恢复会按current locator隐式rebind。Events没有definition hash/ref，43个曾出现的materialized目录只剩2个且无法关联instance；12个仍在DB、曾带materialized错误上下文的run所指目录全部缺失。Backup同样无ref/content，test/evidence DB已排除。迁移不能从current source、marker、path或run status伪造历史definition；必须把pre-ref不可恢复集合与未来shell-ref缺content集合分开。

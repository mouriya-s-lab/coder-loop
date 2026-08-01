# R8/I-14 — Binding 存量分布与历史 definition 归属

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 调查锚点：AGGREGATE D2、`13-r7-05-binding-type-authority.md`、`13-r7-06-binding-admission.md`。  
> 本报告只调查事实。所有SQLite访问均使用URI `mode=ro`并先执行`PRAGMA query_only=ON`；未修改真实DB、产品、测试或WORKFLOW，未创建worktree。敏感binding值不落报告，只记录JSON类型、可逆分类和计数。

## A. 主 agent 摘要（≤一页）

### A1. 真实可访问存量

本机找到四个候选SQLite文件：

- `~/.coder-loop/loop-data/db.sqlite`：真实有表的当前可访问库，schema `user_version=14`，15 chains、69 items、932 runs；
- `~/.coder-loop/backups/preset-migration-20260715-123342/db.sqlite`：历史备份快照，schema v14，9 chains、10 items；与当前库有时间继承关系，不能加总成独立人口；
- `~/.coder-loop/db.sqlite`、`~/.coder-loop/loop-data/state.sqlite`：`user_version=0`且无业务表，不是binding人口。

当前69 items全部显式选择preset name、无`preset_path`：65条`gh-issue-pr-iteration`，4条`moat-experiment-loop`。15 chains为14条gh、1条moat。main基线只有gh preset；installed app同时有gh与moat，且gh的phase/source引用数已与main不同。因此“现在能找到一个同名preset”不证明item创建时的definition。

### A2. 已确定的类型/缺值事实

两个实际preset都声明相同item字段：`issue:number`、`branch:string`、`pr:number`、`lastRunId:string`。

当前人口：

| source | 符合/存在 | 不符合或缺失 |
|---|---:|---:|
| `item.issue:number` | 0条存为JSON number | 69条全部存为JSON text |
| issue text的纯数据可逆子集 | 63条是canonical、非负、JS-safe integer文本 | 6条含非数字，不能无损转number |
| `item.branch:string` | 10条text | 59条missing |
| `item.pr:number` | 11条integer | 58条missing |
| `item.lastRunId:string` | 26条物理字段text | 43条null |
| `chain.repository/baseBranch` | 15/15均由NOT NULL text列提供 | 尚未迁入稳定D2 business source schema |
| `chain.requireBrowserEvidence` | 0条显式binding | 15条missing，但preset有boolean default `false` |
| `chain.umbrellaRepo` | 6条text | 9条missing，以string default解析 |
| `chain.umbrellaIssue` | 6条integer | 9条missing；preset default却是string `""` |

所以存量不是“全部只需string→number转换”。63条issue文本在值层可精确变成整数；6条无法转。branch/pr/lastRunId的大量缺失又与稳定D2“binding默认required、缺失策略显式”直接相撞，不能从当前空串行为推断应填什么。`umbrellaIssue`更是同一source的实际integer与string default并存，问题在definition证据而非仅数据行。

28条`dependsOn`数组、7条`presetMigration`对象以及scheduler内部对象是generic JSON存量，但当前preset没有把它们作为phase binding source；不能把所有结构值一律判成D2违规或迁移掉。

### A3. 历史definition证据与migration结论

当前v14库和备份都没有`execution_definitions/task_nodes/task_trees`表；932个run extra也没有definition hash/source hash。7条item有`presetMigration`对象，但其中commit字段属于目标/workflow迁移上下文，不是preset内容identity；其余62条连该对象也没有。现有DB无法证明每条item创建时使用的preset bytes、field schema、required/default或projection。

因此：

- **足以自主确定**：真实类型分布、missing集合、63条值级无损整数转换候选、6条不可转换行、当前definition自身的`umbrellaIssue` default类型冲突、以及哪些structured values不属于preset binding source。
- **不足以自主完成全量migration**：无法证明历史schema归属；无法决定6条非数字issue应改schema还是hold；无法把59/58/43条missing自动填值；无法从历史证据决定branch/pr/lastRunId究竟required、nullable还是有default。
- **无需让操作员猜数据**：migration可先按证据形成“可证明转换 / 明确不兼容 / definition未定 / 非binding数据”四类。只有目标稳定schema仍有真实语义分叉时才进入裁决；当前不能以零样本、current source或旧空串行为自动选边。

结论置信度：当前可访问v14 DB及已安装/main preset为高置信；“全生产历史人口”只为中等置信，因为没有读取其他机器、未授权系统或删除的旧DB。

---

## B. 证据附录

## B1. 数据库发现、身份与只读纪律

发现命令：

```sh
find "$HOME/.coder-loop" -maxdepth 4 -type f \
  \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print
```

每库核验使用：

```sh
sqlite3 "file:<absolute-path>?mode=ro" \
  "PRAGMA query_only=ON;
   PRAGMA user_version;
   SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

| path | version | 业务表 | 角色 |
|---|---:|---|---|
| `~/.coder-loop/loop-data/db.sqlite` | 14 | chains/items/runs/current_runs/context_entries | 当前可访问有数据DB |
| `~/.coder-loop/backups/preset-migration-20260715-123342/db.sqlite` | 14 | 同上 | 历史备份 |
| `~/.coder-loop/db.sqlite` | 0 | 无 | 空候选 |
| `~/.coder-loop/loop-data/state.sqlite` | 0 | 无 | 空候选 |

真实库schema关键事实：

- `chains.repository TEXT NOT NULL`、`base_branch TEXT NOT NULL`、`metadata TEXT NOT NULL`；
- `items.preset/preset_path`可null，`extra TEXT NOT NULL`；
- schema v14尚无当前main v16的execution definition/runtime tree表。

报告未输出repository、branch、issue或其他binding的实际文本。

## B2. 当前人口与preset来源

只读计数：

```sql
SELECT 'chains',count(*) FROM chains
UNION ALL SELECT 'items',count(*) FROM items
UNION ALL SELECT 'runs',count(*) FROM runs;

SELECT COALESCE(preset,'<null>'),count(*)
FROM chains GROUP BY preset;

SELECT CASE
  WHEN preset_path IS NOT NULL THEN '<path>'
  WHEN preset IS NOT NULL THEN preset
  ELSE '<none>'
END AS source, count(*)
FROM items GROUP BY source;
```

结果：

| population | count |
|---|---:|
| chains | 15 |
| items | 69 |
| runs | 932 |
| gh chains/items | 14 / 65 |
| moat chains/items | 1 / 4 |
| item preset_path | 0 |
| item无preset source | 0 |

历史备份为9 chains、10 items，全部gh、全部preset name。它是迁移前快照，不与当前69条相加。

## B3. 可访问preset声明

读取：

- main：`/Users/mouriya/Ext/code/coder-loop/presets/gh-issue-pr-iteration/preset.toml`；
- installed app：`/Users/mouriya/Ext/app/coder-loop/presets/gh-issue-pr-iteration/preset.toml`；
- installed app：`/Users/mouriya/Ext/app/coder-loop/presets/moat-experiment-loop/preset.toml`。

清单脚本与无敏感输出：

- `/tmp/rfc547-i14-preset-inventory.py`
- `/tmp/rfc547-i14-preset-inventory.jsonl`

三者item schema均为：

| field | declared type |
|---|---|
| issue | number |
| branch | string |
| pr | number |
| lastRunId | string |

main基线gh有4个phase对这些source的引用；installed app gh/moat各有10个phase引用。main没有moat preset。这至少证明同名/current lookup不能作为历史definition identity。

chain source：

- gh：repository/baseBranch无default；requireBrowserEvidence为boolean default；umbrellaRepo与umbrellaIssue都使用string default `""`；
- moat：仅repository/baseBranch，无default。

## B4. Item值类型与可逆分类

只读SQL核心：

```sql
SELECT json_type(extra,'$.issue'),count(*) FROM items GROUP BY 1;
SELECT json_type(extra,'$.branch'),count(*) FROM items GROUP BY 1;
SELECT json_type(extra,'$.pr'),count(*) FROM items GROUP BY 1;
SELECT CASE WHEN last_run_id IS NULL THEN '<null>' ELSE 'text' END,count(*)
FROM items GROUP BY 1;
```

`issue`文本的可逆分类没有输出值：

```sql
SELECT
  sum(
    json_type(extra,'$.issue')='text'
    AND CAST(CAST(json_extract(extra,'$.issue') AS INTEGER) AS TEXT)
        = json_extract(extra,'$.issue')
    AND CAST(json_extract(extra,'$.issue') AS INTEGER)
        BETWEEN 0 AND 9007199254740991
  ) AS canonical_nonnegative_safe_int_text
FROM items;
```

结果矩阵：

| preset人口 | total | issue text | canonical safe integer text | non-digit text | branch text | pr integer |
|---|---:|---:|---:|---:|---:|---:|
| gh | 65 | 65 | 59 | 6 | 10 | 11 |
| moat | 4 | 4 | 4 | 0 | 0 | 0 |
| **总计** | **69** | **69** | **63** | **6** | **10** | **11** |

缺失计数：

| source | missing/null |
|---|---:|
| branch | 59 |
| pr | 58 |
| physical lastRunId | 43 |

稳定D2要求source schema唯一、required/default显式，且缺失不得静默变空串。当前数据无法单独回答这些missing应被修成值还是definition应声明optional/default。

## B5. Chain binding类型与default

当前15条chain metadata全部是valid JSON object。`metadata.bindings`分布：

| key | present type/count | missing |
|---|---|---:|
| umbrellaRepo | text × 6 | 9 |
| umbrellaIssue | integer × 6 | 9 |
| requireBrowserEvidence | 0 | 15 |

物理列：

| source | text/non-null |
|---|---:|
| repository | 15 |
| baseBranch | 15 |

解释边界：

- requireBrowserEvidence缺失可由当前boolean default解释；
- umbrellaRepo实际text与string default同型；
- umbrellaIssue实际integer、缺失时default却是string，无法形成唯一source type；
- repository/baseBranch当前值完整，但位于D7要求退役的物理列，不是未来typed chain binding已落地的证据。

## B6. Structured JSON与binding边界

当前item extra顶层类型：

| key | JSON type/count | 是否当前preset binding source |
|---|---|---|
| issue | text × 69 | 是 |
| branch | text × 10 | 是 |
| pr | integer × 11 | 是 |
| dependsOn | array × 28 | 否，engine dependency数据 |
| presetMigration | object × 7 | 否，migration metadata |
| schedulerBackoff | object × 17 | 否 |
| schedulerSpawnError | object × 6 | 否 |

`dependsOn`中27条为单元素数组、1条空数组；报告不输出元素值。稳定D2约束phase binding source，不允许因为generic storage能保存结构就把所有engine metadata迁为ValueType，也不允许把它们当成“现存json binding consumer证据”。

## B7. 历史definition证据

只读schema/extra inventory：

```sql
SELECT count(*)
FROM sqlite_master
WHERE type='table'
  AND name IN ('execution_definitions','task_nodes','task_trees');

SELECT j.key,j.type,count(*)
FROM runs r,json_each(r.extra) j
GROUP BY j.key,j.type;
```

结果：

- execution definition/runtime tree tables：0；
- 932 runs的extra keys含repo/worktree/session/start/IO/recovery事实，不含definition content identity、sourceHash或preset manifest；
- 7 items有presetMigration对象，62没有；
- presetMigration对象含迁移过程和目标源码commit类字段，但没有preset content hash/manifest；
- v14备份同样无definition表，10条issue也全为text，只能证明旧形态已经存在。

因此无法按row证明：

- 创建时究竟使用main、installed app或更早worktree中的哪份preset；
- 当时item field schema是否完全相同；
- 当时branch/pr/lastRunId是否意图required、optional或default；
- 运行时空串是定义语义还是旧renderer降级。

当前source只能说明“若现在按该声明解释会怎样”，不能冒充历史definition。

## B8. 由数据确定的migration约束

这些约束不推荐产品语义，只限定后续可声称的转换：

1. **63条issue是值级可逆候选**：canonical、非负、safe integer文本可逐字证明与JSON整数等价；真正自动转换仍以目标schema继续声明number为前提。
2. **6条issue不可转number**：不能截断、parse前缀或默认为0；必须进入不兼容/hold，或由稳定业务schema另行解释。
3. **missing不能自动填充**：59 branch、58 pr、43 lastRunId没有历史值证据；旧renderer空串不构成default证据。
4. **definition冲突先于数据填补**：umbrellaIssue的integer实值与string default必须先形成唯一source type，不能分别“保留两种都合法”。
5. **non-binding structured data不动**：dependsOn、migration和scheduler对象不因D2 migration被改写。
6. **历史归属必须显式为unknown**：不能使用current同名preset给旧row补造definition identity。
7. **backup不重复计数**：历史快照只证明形态延续，不增加当前受影响行数。
8. **无损与语义兼容分开**：string `"123"`→number `123`在值层可逆，不自动证明业务identity、外部consumer或历史definition兼容。

## B9. 是否足以自主收敛

| migration子问题 | 当前事实是否足够 | 原因 |
|---|---|---|
| 识别当前JSON类型与missing | 是 | readonly DB全量计数 |
| 识别安全整数文本子集 | 是 | 可逆lexical判据 |
| 自动转换63条issue | 条件式 | 需目标schema确认number不变 |
| 处理6条非数字issue | 否 | 数据与当前number声明冲突，无历史definition |
| 处理branch/pr/lastRunId missing | 否 | required/default/nullable目标语义未闭合 |
| 处理umbrellaIssue | 否 | current definition自身default异型 |
| 判定历史definition | 否 | v14 DB无content/hash/manifest |
| 保留内部structured JSON | 是 | 不属于当前phase binding source |

全量migration因此**不能自主一次完成**；但已经不需要向操作员询问“库里大概有什么”。下一gate应先冻结目标D2 schema，再机械应用可证明转换，其余行进入明确hold/repair集合。若目标schema仍存在业务语义分叉，操作员只裁该语义，不猜存量分布。

## B10. 置信边界与未调查面

- 高置信：列出的本机当前/备份DB、schema、JSON类型、preset文件。
- 中置信：这些文件代表全部生产历史；未调查其他机器、已删除数据库或无本地checkout owner。
- 未读取真实值内容到报告；SQL只对内存值做类型、数字语法和范围分类。
- 未打开central daemon或写DB；没有使用copy后修改实验，因为readonly SQL已足够。
- 没有推断6条非数字文本的业务含义。
- 没有把installed app current preset当作历史definition。

## B11. 证据索引

| 事实 | 证据 |
|---|---|
| 稳定D2合同 | `AGGREGATE-547.md` D2 |
| 现存类型权威断裂 | `13-r7-05-binding-type-authority.md` A、B1–B6 |
| create/update/migration不做typed admission | `13-r7-06-binding-admission.md` A、B2–B10 |
| 当前DB | `~/.coder-loop/loop-data/db.sqlite`，URI `mode=ro` |
| 历史备份 | `~/.coder-loop/backups/preset-migration-20260715-123342/db.sqlite`，URI `mode=ro` |
| preset inventory | `/tmp/rfc547-i14-preset-inventory.py`、`/tmp/rfc547-i14-preset-inventory.jsonl` |
| main gh preset | `/Users/mouriya/Ext/code/coder-loop/presets/gh-issue-pr-iteration/preset.toml` |
| installed gh/moat presets | `/Users/mouriya/Ext/app/coder-loop/presets/*/preset.toml` |

## 尾部结论

**当前可访问人口为15 chains/69 items；69个`item.issue`全部以text存储而preset声明number，其中63个是可证明值级无损的canonical safe integer文本，6个不能转number。branch/pr/lastRunId分别缺59/58/43条；15条chain中umbrellaIssue有6个integer实值、9个missing却配string default，definition自身尚未形成唯一类型。v14当前库与备份都没有definition内容/hash证据，932个run也不能归属创建时preset；current source不得补造历史事实。因此数据盘点足以形成可逆、不可兼容、definition未定、非binding四类，但不足以自主完成全量migration；应先冻结目标D2 schema，再自动处理可证明子集，其余显式hold/repair，而不是让操作员猜存量。**

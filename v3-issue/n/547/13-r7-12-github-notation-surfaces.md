# RFC #547 R7-12：GitHub 记法与 opaque item ID 的入口全景

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一设计锚点：`AGGREGATE-547.md` §2 H、P-D7-1/3/4；R5 `D-23,A-12,T-07`；`10-r4-engine-primitives.md` S6。  
> 调查边界：只调查 item identity 的 CLI/help/wire/daemon/batch/preset/migration/脚本依赖与失败语义；repository权威、存储迁移和closure身份归R7-13，不在本报告裁决或设计。

## A. 主 agent 摘要（最多一页）

### A1. 问题与结论

**问题。** opaque `item_id` 主体已经存在，但哪些入口仍使用或解析 GitHub issue 记法；每条路径怎样转换到 opaque id；现有脚本、preset与migration依赖什么兼容语义；未知或冲突输入怎样失败？

**结论（高置信）。** 当前不是“一个遗留 flag”，而是四层不同语义并存：

1. **一般 item CLI**：add/update/reorder/exits/exit-action都叫 `--issue`，但只验证非空、无空白，然后原样变成 wire `itemId:string`。`owner/repo#42`、`#raw`、`opaque:id/alpha`都可以成为彼此不同的真实opaque id。
2. **queue unblock CLI**：同名 `--issue` 先调用 `normalizeQueueIssueId`，把 `owner/repo#42`与`#42`都改成`42`，把`#raw`改成`raw`；它不是opaque透传。
3. **daemon wire**：item CRUD已只接受`itemId`，不接受`issueNumber`；但`queue.unblock` wire仍叫`issue`，daemon只剥**开头**一个`#`，不会剥cross-repo前缀。故同一个daemon operation经CLI和直接wire可以选择不同item。
4. **batch CLI compatibility**：`--items-json`在`itemId`缺失时把legacy `issue` string/number或`issueNumber` number转成string `itemId`并删除被消费字段；direct daemon batch wire不接受legacy键。若已给`itemId`又给legacy键，CLI不比较值也不删除legacy键，daemon以unsupported field拒绝，而不是“冲突值”诊断。

SQLite v12以后是`item_id TEXT`与chain内unique，daemon统一施加非空、无空白、最长256字符；item创建还把id回填到preset `idField`。这些是可保留opaque资产。v11→v12 migration则按`extra.id → extra.issue → issue_number`优先级推导新id，并把历史issue/branch/pr写入extra；它是一次历史GitHub形状兼容，不是当前入口的GitHub解析。

隔离daemon实验确认：一般wire可同时存`owner/repo#42`、`42`、`#raw`、`opaque:id/alpha`；direct `queue.unblock(issue="owner/repo#42")`命中完整literal id，而`issue="#42"`命中`42`。独立normalize探针则将前者压成`42`。CLI batch legacy输入成功创建`legacy-a`与`77`；direct legacy wire和`itemId+issue`混合均被拒。

### A2. 复杂根因与影响

- **词表兼容与值转换耦合不一致。** 一般item命令仅保留旧flag名字；queue unblock同时保留名字与GitHub normalization；batch又保留JSON字段级backfill。
- **CLI与wire不是同构边界。** item CRUD wire已breaking rename；queue wire没有rename且daemon自带第二套较窄`#`转换；batch legacy只存在CLI。
- **历史数据兼容是第三套规则。** migration会优先`extra.id`，其次`extra.issue`，最后旧integer列；它不调用当前CLI parser或daemon validator。
- **文档与运行资产主动依赖旧语法。** root usage、README、operator/preset authoring docs、bundled prompt完成协议、engine integration、filesystem grants、issue-560、real E2E都发出`--issue`。这不是只改parser即可消失的symbol。
- **命名碰撞。** `gh-issue-pr-iteration`的业务字段也叫`issue`，但属于preset extra；它与CLI flag、queue wire和legacy migration字段是不同层。只按字符串清零会混淆业务合法字段与引擎GitHub记法。

**当前影响。** `queue unblock`无法透明选择以`#`开头或形如`owner/repo#x`的合法opaque id；CLI与direct socket selector不同。其他item命令虽可用opaque id，公开词表仍将其称为issue。batch调用者可继续提交legacy对象，wire调用者不可以。

**可保留资产。** SQLite TEXT identity/unique、daemon `itemId` wire、`validateItemId`、idField回填/冲突检查、generic context `--item-id`、item JSON/status投影与migration transaction均不要求GitHub记法。

### A3. 未知与资格

外部仓库或已安装operator脚本不在本repo，无法全枚举；本报告只证明仓内依赖。R7-13仍需独立处理repository。R7-12事实已足以形成决策档案，但不决定兼容期、alias或migration策略。

---

## B. 证据附录

## B1. 稳定条款与总账对照

| 条款/总账 | 地面事实 | 判定边界 |
|---|---|---|
| P-D7-1 / D-23 | storage/wire主体opaque；queue normalize、batch legacy、umbrella parser尚存 | 部分符合，不是单点残留 |
| P-D7-3 | 五个item命令与queue仍公开`--issue` | 不符合clean rename |
| P-D7-4 | `normalizeQueueIssueId`、`parseUmbrellaRef`等production symbol存在 | 清零未成立；repository symbols交R7-13 |
| §2 H | item identity机制可通用，参数/词表仍含GitHub形状 | 主体与兼容层分开登记 |
| A-12 | `item_id TEXT`、opaque wire、transaction/migration框架真实 | 可保留资产 |
| T-07 | tests/scripts/docs主动使用旧词表及normalize结果 | 绿色证明旧契约，不证明退役 |

## B2. 全CLI grammar、help与调用者

### B2.1 一般item命令

| command | CLI输入 | parser输出 | wire selector |
|---|---|---|---|
| `item add` | `--issue` | `parseRequiredItemId`原样string | `itemId` |
| `item update` | `--issue` | 同上 | `itemId`+chain |
| `item reorder` | `--issue` | 同上 | `itemId`+chain |
| `item exits` | `--issue` | 同上 | `itemId`+chain |
| `item exit-action` | `--issue` | 同上 | `itemId`+chain |

定义与handler位于`src/loop.ts:1704-1927`。`parseRequiredItemId`只拒空串和任意whitespace，不解析数字、`#`、slash、colon或GitHub ref（`:2051-2060`）。CLI union内部字段已叫`itemId`，注释明确“不存在`--id` flag”（`:274-285`）。

### B2.2 Batch-add

`item batch-add`没有per-item flag，而是`--items-json`（`src/loop.ts:1765-1790`）。`parseBatchItemsJson`规则（`:2390-2421`）：

1. entry必须object；
2. 若`itemId`不存在：
   - `issue:number` → `String(issue)`并删`issue`；
   - 非空`issue:string` → 原样并删`issue`；
   - `issueNumber:number` → string并删`issueNumber`；
3. 若`itemId`已存在，不消费或比较legacy键；
4. `repoCwd` string被resolve；其余交daemon。

它没有对legacy string做whitespace/length检查，最终由daemon统一validate；number只要求JS number，不在此处要求正整数。

### B2.3 Queue unblock

`queue unblock <target> --issue` grammar在`src/loop.ts:1988-2012`，root usage也只展示该形式（`:3048-3061`）。它先经`normalizeQueueIssueId`（`:4371-4379`），再经`parseRequiredItemId`，然后发送wire `{issue: normalized}`（`:3990-4034`）。

转换：

| raw | CLI normalized |
|---|---|
| `owner/repo#42` | `42` |
| `#42` | `42` |
| `#raw` | `raw` |
| `opaque:id/alpha` | 原样 |
| whitespace/empty | CLI fail |

cross-repo regex接受`#`后的任意非空文本，不要求数字。因此它既是GitHub兼容parser，又会改写合法opaque id。

### B2.4 其他中性item入口

- `context append --scope item --item-id`使用中性`itemId`词表，不走issue normalize（`src/loop.ts:1950-2020`）。
- logs query的`--item`是SQLite rowid筛选，不是opaque identity（`src/daemon.ts:516+`注释）。
- daemon status/item list输出`itemId`与preset透明extra；这部分没有GitHub selector转换。

## B3. Daemon wire与失败语义

### B3.1 Item wire

`ITEM_ADD_ARG_KEYS`、update/reorder/exits/exit-action selector均使用`itemId`（`src/daemon.ts:438-523`）。legacy `issueNumber`无wire alias；unknown键由`validateKnownKeys`报`invalid_request unsupported field`（`:5140-5175`）。

`validateItemId`（`:4801-4813`）统一要求：

- string非空；
- 不含whitespace；
- length≤256；
- SQLite chain内unique，duplicate转换为结构化冲突；
- 不限制`#`、`/`、`:`或Unicode非空白。

item create把该string回填到loaded preset的`idField`。若caller extra已含同字段，只允许相同string或finite number的等价string；其他/不等值报`extra.<idField> conflicts with itemId`（`:3010-3055`）。

### B3.2 Queue wire

`QUEUE_UNBLOCK_ARG_KEYS`仍是`issue`（`src/daemon.ts:528-532`）。handler（`:2735-2760`）：

- trim；空/whitespace报`invalid_request`；
- 只在整个string以`#`开头时剥一字符；
- `owner/repo#42`不做cross-repo转换；
- lookup使用所得`itemId`；not found报结构化`not_found`。

因此CLI和direct wire对同raw不是同构：CLI先把cross-repo压成suffix，direct wire保留完整literal。

### B3.3 Batch wire

`item.batchAdd` child key集合来自`ITEM_ADD_ARG_KEYS`，只允许`itemId`（`:456-465,2945-2990`）。direct `{issue:...}`立即unsupported。CLI `itemId+issue`混合因parser看见canonical id便不删除issue，最终同样unsupported；没有比较两者是否相等的冲突分支。

## B4. 转换矩阵

| 入口 | 输入例 | 输出opaque id | 是否lossy | 冲突/未知语义 |
|---|---|---|---:|---|
| item CLI | `owner/repo#42` | 同原文 | 否 | whitespace CLI拒绝 |
| item direct wire | 同上 | 同原文 | 否 | unknown legacy key拒绝 |
| queue CLI | `owner/repo#42` | `42` | 是 | 可撞已有`42` |
| queue CLI | `#raw` | `raw` | 是 | 无法选择literal `#raw` |
| queue direct wire | `owner/repo#42` | 同原文 | 否 | handler只剥leading `#` |
| queue direct wire | `#42` | `42` | 是 | leading `#`固定剥除 |
| batch CLI | `{issue:"x"}` | `x` | 字段名丢失 | 仅itemId absent时转换 |
| batch CLI | `{issueNumber:77}` | `"77"` | number→string | 任意number先String |
| batch CLI | `{itemId:"a",issue:"b"}` | 无创建 | — | daemon unsupported `issue`，不比较 |
| batch direct wire | `{issue:"x"}` | 无创建 | — | unsupported field |
| v11→v12 migration | extra.id/extra.issue/column | 首个可用值string | 有优先级 | 无值响亮失败 |

## B5. Preset、prompt与文档依赖

### B5.1 Engine-generated completion protocol

`phaseExitsEpilogue`由engine追加到每个daemon-spawn prompt，三条命令硬写`--issue <ISSUE>`：item exits、item update、item exit-action（`src/loop.ts:5972-6002`）。即使非GitHub preset、id变量不叫ISSUE，该engine prose仍用issue词表。

### B5.2 Bundled preset fragments

仓内直接命令依赖包括：

- `presets/gh-issue-pr-iteration/review/actions/{state-write,stop,accept-pr}.md`；
- `presets/real-e2e-minimal/review-entry.md`；
- gh preset本身的业务`item.issue`字段和`{{ISSUE}}`是preset语义，可合法保留，与engine flag不是同一层。

### B5.3 User/operator docs

README、`docs/operator-quickstart.md`、`docs/operations.md`、`docs/preset-authoring.md`均教`--issue`；operations明确记录wire为`itemId`但CLI保留旧名。rootUsage同样暴露queue `--issue`。这些是当前公开契约consumer，不是历史注释。

### B5.4 `--umbrella`

chain create仍接受`--umbrella owner/repo#123|#123`，`parseUmbrellaRef`把它变成metadata bindings（`src/loop.ts:1536-1559,2205,2423-2436`）。值已不是engine物理列，但parser仍是GitHub notation入口。其repository归属交R7-13；本片只登记语法依赖与invalid form失败。

## B6. 外部脚本/自动化依赖（仓内可证明部分）

| consumer | 依赖 |
|---|---|
| `scripts/engine-integration-stub-runner.ts:85` | item update `--issue` |
| `scripts/engine-integration.ts:491` | item add `--issue` |
| `scripts/runner-filesystem-grants-integration.ts:241-247,356` | exits/update/add `--issue` |
| `scripts/issue-560-integration.ts:175-236` | update/add `--issue` |
| `scripts/real-e2e.ts:648-654` | GitHub issue number→item add `--issue` |
| supervisor/preset docs | operator和agent复制旧命令 |

real E2E的GitHub issue number是该preset业务值，本身不违反opaque storage；依赖点是engine CLI flag spelling。外部repo/本机自定义脚本不在仓内，保持未知。

## B7. Migration与历史数据

v11→v12 `migrateItemsToOpaqueItemId`（`src/sqlite-state.ts:1229-1318`）执行：

1. parse legacy extra；坏JSON变空object；
2. 若不存在则把`issue_number` string写`extra.issue`，branch/pr写extra；
3. 新`item_id`优先：nonempty string/finite number `extra.id` → `extra.issue` → stringified `issue_number`；
4. 无可用值报`invalid_json cannot derive opaque item id`；
5. temp sentinel协助重建v12表，最终是TEXT+chain unique。

该函数注释承认它不能知道preset，只覆盖当时shipped preset的`id|issue`。它不调用`validateItemId`，所以历史值的whitespace/256上限不由当前daemon重新执法。migration在SQLite transaction内，shape已是v12时跳过。当前schema v16仍保留该升级路径。

## B8. 隔离parse/request实验

### B8.1 环境

- 脚本：`/tmp/rfc547-r7-12-experiment.ts`
- stdout：`/tmp/rfc547-r7-12-experiment.jsonl`
- stderr：`/tmp/rfc547-r7-12-experiment.err`
- loop-data：每轮`/tmp/rfc547-r7-12-loop-<uuid>`
- daemon：in-process，`scheduler.enabled=false`，结束调用`daemon.stop()`；无GitHub网络、无中央daemon。

```sh
bun /tmp/rfc547-r7-12-experiment.ts \
  > /tmp/rfc547-r7-12-experiment.jsonl \
  2> /tmp/rfc547-r7-12-experiment.err
```

最终有效轮退出0。

### B8.2 观察

1. direct item wire成功并存四个id：`owner/repo#42`、`42`、`#raw`、`opaque:id/alpha`；extra.issue回填完全相同string。
2. normalize函数：`owner/repo#42→42`、`#42→42`、`#raw→raw`、opaque colon/slash原样；空/whitespace拒绝。
3. direct queue wire：`issue=owner/repo#42`命中完整literal；`issue=#42`命中`42`。两者从blocked恢复queued。
4. direct batch legacy `{issue:...}`被unsupported拒绝。
5. CLI batch legacy `{issue:"legacy-a"}`与`{issueNumber:77}`成功建`legacy-a`和`77`。
6. CLI batch混合`itemId+issue`被daemon以unsupported issue拒绝。
7. CLI item add whitespace在连接daemon前失败。

早期一次实验误向direct `item.add`发送CLI-only `status`字段，daemon正确以unsupported拒绝；该失败轮不作为id结论，最终轮改用独立operator update设置blocked并完整跑通。

## B9. 测试覆盖、同错与盲区

### B9.1 同错

- `tests/unit/loop/parsers.test.ts:438-440`明确断言cross-repo与`#`normalize为suffix；
- CLI integrations全面使用`--issue`，绿色只证明旧grammar稳定；
- daemon harness仍有`issueNumber`测试fixture字段并把itemId转number供fake runner；
- migration tests预期`issue_number`→extra.issue/item_id兼容；
- store-level opaque fixture绕过CLI normalize，不能证明所有operator入口opaque。

### B9.2 已覆盖资产

existing tests覆盖opaque string item CRUD、duplicate、idField回填冲突、batch atomicity、v11→v12 migration、daemon unknown-key rejection。它们可保留，但没有形成退役清零证明。

### B9.3 盲区

- 无表驱动跨入口同raw identity一致性测试；
- 无literal `#raw`或`owner/repo#42`经queue CLI选择自身的测试；当前机制做不到；
- 无batch canonical+legacy同值/异值的明确冲突契约，只测unsupported结果；
- 无256字符、Unicode、control/whitespace对CLI/batch/migration全矩阵；
- 无root usage、engine epilogue、bundled fragments、scripts/docs的统一清零gate；
- 无外部脚本consumer inventory；
- repository相关GitHub symbols与item notation尚未分层验收，需R7-13。

## B10. 事实支持的所有形态约束及确定后果（不作推荐）

1. 后续语义必须分别说明一般item CLI、queue CLI、daemon item wire、queue wire、batch CLI与migration；它们当前不是同一parser。
2. `issue`作为gh preset业务字段与engine CLI/wire legacy词表必须分层；全仓字符串删除会误伤合法preset语义。
3. opaque id允许`#`、slash、colon；任何保留的GitHub normalization都会改变可寻址集合并产生`owner/repo#42`与`42`碰撞。
4. CLI与direct wire若继续可独立调用，selector转换必须有明确同构或明确差异；当前queue两层规则不同。
5. batch legacy是CLI-only compatibility；wire consumers已经必须用itemId，二者不能以同一迁移状态描述。
6. canonical+legacy batch混合目前不是值冲突检测，而是unknown-key失败；后续口径必须保留这一事实以判断兼容调用者后果。
7. v11→v12 migration是持久历史路径，不等于runtime alias；其`id|issue|column`优先级与当前idField回填不同。
8. migration未复用当前length/whitespace validator；历史可读值与新请求可写值可能不完全同域。
9. engine-generated epilogue是所有preset consumer，故CLI词表影响不限于GitHub bundled preset。
10. scripts与docs是可执行/复制consumer；parser变化而不同步会直接破坏engine integration、real E2E与agent完成协议。
11. context `--item-id`与daemon `itemId`证明仓内已有中性命名资产，但不决定其他入口如何演进。
12. R7-13的repository符号清理不能替代本片item入口验收；`--umbrella`同时跨两域，只能按其实际parser/bindings消费者分层。

## B11. 证据索引

| 主题 | 证据 |
|---|---|
| CLI union/grammar | `src/loop.ts:274-285,1704-1927,1988-2012` |
| opaque parser | `src/loop.ts:2051-2060` |
| batch backfill | `src/loop.ts:2390-2421` |
| umbrella parser | `src/loop.ts:2423-2436` |
| queue CLI normalize/send | `src/loop.ts:3990-4034,4371-4379` |
| root usage | `src/loop.ts:3048-3061` |
| engine completion epilogue | `src/loop.ts:5972-6002` |
| daemon keysets | `src/daemon.ts:438-532` |
| item id validation/backfill | `src/daemon.ts:3010-3055,4801-4813` |
| queue daemon transform | `src/daemon.ts:2735-2760` |
| batch daemon validation | `src/daemon.ts:2945-2990,5140-5175` |
| v11→v12 migration | `src/sqlite-state.ts:1229-1318` |
| external dependency inventory | `/tmp/rfc547-r7-12-dependencies.txt` |
| full search inventory | `/tmp/rfc547-r7-12-rg.txt` |
| experiment | `/tmp/rfc547-r7-12-experiment.ts`; `/tmp/rfc547-r7-12-experiment.jsonl`; `/tmp/rfc547-r7-12-experiment.err` |

## B12. 尾部结论

**R7-12 尾部结论：opaque `item_id TEXT`、daemon `itemId` wire与统一shape validator已经真实存在，但GitHub记法残留不是一个alias：一般item CLI仅把旧`--issue`名字映射为opaque原文；queue CLI额外把cross-repo/leading-#记法压成suffix；queue daemon wire仍叫`issue`且只剥leading `#`；batch CLI又单独把legacy `issue|issueNumber`回填成itemId，而direct wire拒绝它们。migration还有`extra.id→extra.issue→issue_number`第四套历史优先级。实验确认这些入口对同一字符串可选择不同item，且仓内engine epilogue、bundled fragments、integration与real E2E主动依赖旧词表。故D7退役必须以分层入口/consumer事实核算，不能把opaque存储主体、GitHub业务preset字段和兼容parser混成同一清理动作；repository域仍由R7-13独立调查。**

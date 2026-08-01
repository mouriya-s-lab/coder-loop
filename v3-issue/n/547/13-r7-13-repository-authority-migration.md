# R7-13 · Repository 权威、SQLite migration 与 closure 身份接缝

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一设计锚点：`AGGREGATE-547.md` P-D7-2、§2.5 baseBranch例外。  
> 总账输入：`D-23,U-04,A-07,A-10,A-12,J-06,T-07`。  
> 范围：repository列/metadata双读面、迁移、closure/worktree/recovery身份与外部chain owner；不裁决最终载体，不实施。

## A. 主 agent 摘要

### A1. 问题

稳定设计要求repository退出引擎物理原语，成为chain business binding；`chains.repository`、forge格式 admission 与双权威必须退役，冲突不能静默。`baseBranch`因worktree机制真实消费而是明确例外。R7-13要查清现有列/metadata全部读写者、存量冲突/非GitHub数据、迁移先例与closure恢复究竟依赖哪个身份。

### A2. 结论与置信边界

**P-D7-2、D-23 不符合；repository列仍是存储、target选择、status与部分业务指纹的物理权威，同时metadata binding可覆盖prompt值，形成真实双权威。closure/worktree身份却不依赖repository字符串：它依赖chain id/name、item.repoCwd、baseBranch及持久化closure资源。**

1. schema v16仍要求`chains.repository TEXT NOT NULL`；`ChainRecord/CreateChainInput`均要求string。store create/update/read完整保留该列。
2. CLI从`--config-json.repository`强制取值并刻意从bindings剥离；daemon再要求`owner/repo`格式。public operator路径无法创建无repository或非forge repository。
3. 同时，render bindings按`{repository: column, baseBranch: column, ...metadata.bindings}`构造；metadata中的同名`repository`静默覆盖列值。target lookup、chain list/status、observability JSON与chain-completion fingerprint仍直接读列。没有冲突检测或统一优先级。
4. 隔离当前schema DB证实三类存量可共存（store旁路）：列/binding一致、二者冲突、非GitHub列值。close/reopen后全部原样保留；冲突不会在row decode或recovery时报错。
5. 当前migration框架是单个SQLite `IMMEDIATE` transaction并具schema-shape重入检查；已有umbrella列→bindings与item GitHub列→extra的退列先例。但repository从未有migration/version/shape detector；当前`STATE_SCHEMA_VERSION=16`已被runtime/context/reachability演进占用。
6. umbrella迁移是最接近先例，但代码实际“binding已存在则保留binding”，与注释“旧列赢”不一致，且从不响亮拒绝冲突；不能作为repository冲突语义已解决的证明。
7. scheduler/worktree选择按item.repoCwd分slot和Git仓；first-open base由`chain.baseBranch`解析；worktree path/branch ownership由loop root、chain name、repoCwd、closureId决定。repository列不参与这些资源identity。
8. closure持久化保存closureId、leaf/item/phase、worktreePath、branchName、baseCommit；restart/reconcile从item.repoCwd与这些字段恢复。实验在冲突chain上创建closure/run，close/reopen后完整恢复；随后只改repository列，tree/run不变。
9. repository列仍进入chain-completion fingerprint与target过滤，因此修改列虽然不改变已有closure身份，却会改变chain选择与trigger fingerprint。它是旁路业务影响，不是worktree必需身份。
10. 本仓与本机已知code目录未找到独立typed chain declaration producer；只有coder-loop自身CLI/socket flat boundary及其worktree副本。外部owner保持`U-04`未知，不能改写为全系统不存在。

### A3. 因果、影响与资产

历史上repository兼任GitHub target标签、operator创建必填项和status选择键；后来`metadata.bindings`成为业务binding容器，但CLI仍把repository/baseBranch从容器剥离，renderer又允许同名binding覆盖。资源层实际以本地repoCwd/baseBranch工作，因此repository物理列的“资源必需性”并不存在；但target lookup/fingerprint/status仍让它留在生产闭环。

**当前影响**：同一chain可向agent渲染`binding/repo`，却在status/lookup显示和匹配`column/repo`；非GitHub target在daemon入口被拒，即使本地repoCwd足够驱动worktree；冲突跨restart长期存在。

**未来放大**：外部typed chain producer若只写binding，将与NOT NULL列/lookup冲突；migration若静默选一边可能改变prompt或target identity；closure恢复若被错误地改绑repository字符串，可能破坏当前稳定的repoCwd/closure资源链。

**可保留资产**：SQLite migration transaction与shape检测；generic JSON/metadata保真；umbrella/item退列的table-rebuild技术；baseBranch create→worktree消费；closure资源/identity SQL约束、run+closure局部原子写、restart round-trip；item.repoCwd驱动的Git协调与reconcile。

### A4. 未知与下一步

- 外部typed chain declaration的owner/schema/version仍未知；R7-14可继续查preset fallback与无item chain判定，但不得假定repository是future identity。
- repository最终binding名称、缺值策略、冲突/非GitHub存量处置、schema版本与兼容读面均需R8裁决；本报告不推荐迁移策略。
- crash注入未执行；迁移框架的事务性由生产代码确定，但尚不存在repository migration可做crash实验。

事实已足够进入R8档案；B12候选形态非完备且不推荐。

---

## B. 证据附录

### B1. 设计对照

| 条款/总账 | 判定 | 事实 |
|---|---|---|
| P-D7-2 | 不符合 | repository仍是NOT NULL列、forge admission、target/status权威；binding同名又可覆盖render。 |
| §2.5 baseBranch | 符合例外本身 | baseBranch为一等列且first-open/reconcile真实消费。 |
| D-23 | 不符合 | repository生产闭环未退役。 |
| U-04 | 仍未知 | 没有找到外部typed chain boundary owner；不证明全系统不存在。 |
| A-07 | 可保留 | metadata JSON保真、migration/write事务。 |
| A-10 | 可保留 | closure branch/worktree、reachability、reconcile与局部run-start事务。 |
| A-12 | 局部可保留 | flat CLI/socket/store主体存在，但repository形状仍GitHub-specific。 |
| J-06 | 边界确认 | baseBranch/repoCwd是资源输入；repository物理列不是closure身份必要条件。 |
| T-07 | 同错 | tests/fixtures普遍写owner/repo列，不能证明退列或非GitHub入口。 |

### B2. 数据模型与写入矩阵

#### B2.1 物理schema

`src/sqlite-state.ts:603-618`：

- `preset TEXT`；
- `repository TEXT NOT NULL`；
- `base_branch TEXT NOT NULL`；
- `metadata TEXT NOT NULL`。

`CreateChainInput`、`UpdateChainInput`、`ChainRecord`的repository类型均为string（`src/sqlite-state.ts:72-95,367-368`）。row decode直接取`row.repository`（`:2161-2176`）。

#### B2.2 写入口

| 写入口 | repository来源 | metadata binding行为 | admission/事务 |
|---|---|---|---|
| CLI chain create | `configJson.repository`必填 | `normalizeChainCreateBindings`把repository/baseBranch剥离 | CLI缺失先失败；随后socket。 |
| daemon chain.create | required string | metadata独立generic validation | `owner/repo` forge validator；store前。 |
| store.createChain | input.repository | input.metadata原样 | 无forge格式校验；单IMMEDIATE transaction。 |
| store.updateChain | optional repository替换列 | optional metadata整包替换 | 可分别改变两边；无冲突检测；单transaction。 |
| schema migration | 历史row列 | generic metadata迁移可重写 | 当前无repository迁移。 |

CLI证据：`src/loop.ts:2185-2218,5538-5558`。daemon证据：`src/daemon.ts:2166-2198,4735-4758`。store证据：`src/sqlite-state.ts:1683-1733,2563-2573`。

### B3. 全部读取者与权威矩阵

| consumer | 读取列 | 读取binding | 实际优先级/后果 |
|---|---:|---:|---|
| chain list/text formatting | 是 | 否 | 显示列。`src/loop.ts:2681,2694` |
| daemon chain JSON/status | 是 | metadata另行整包输出 | 两值可同时可见，无冲突。`src/daemon.ts:5820-5832` |
| target lookup/status selection | 是 | 否 | requested/inferred repo与列比较、过滤。`src/loop.ts:4176-4214` |
| Git origin inference | 生成requested repo | 否 | 仅GitHub SSH/HTTPS URL。`:4348-4368` |
| loop prompt/render bindings | 是 | 是 | metadata bindings后展开，binding覆盖列。`:4330-4337` |
| scheduler prompt bindings | 是 | 是 | 同样binding覆盖列。`src/scheduler.ts:3203-3208` |
| chain completion fingerprint | 是 | metadata整体也入hash | 冲突两边都影响fingerprint。`src/scheduler.ts:2819-2850` |
| worktree first-open | 否 | 否 | 使用item.repoCwd、chain.baseBranch。`src/scheduler.ts:884-966` |
| slot identity | 否 | 否 | `chainId + NUL + repoCwd`。`:872-873` |
| reconcile/git contract | 否 | 否 | 使用item.repoCwd、chain.name、baseBranch、persisted closure。`:1020-1255` |
| SQLite closure/run | 否 | 否 | closure/run通过chain/item/FK、resource fields关联。`src/sqlite-state.ts:620-760` |

所以不存在单一repository权威：prompt把binding当最后写入者，target/status把列当权威，fingerprint同时吸收两者。

### B4. 存量形态与隔离实验

#### B4.1 环境登记

- 脚本：`/tmp/rfc547-r7-13-experiment.ts`
- 输出：`/tmp/rfc547-r7-13-experiment.out`
- 隔离loop-data：`/tmp/rfc547-r7-13-a6832ebf-01a3-4dc2-b563-e332ba90c6ea`
- 无daemon、无worktree、无远端repo、无真实DB；仅store API与新建SQLite。

#### B4.2 三种chain形态

| chain | 物理列 | metadata.bindings.repository | reopen结果 |
|---|---|---|---|
| consistent | `owner/repo` | `owner/repo` | 两者原样。 |
| conflict | `column/repo` | `binding/repo` | 冲突原样，无错误。 |
| nongithub | `opaque local identity` | 缺失 | store接受并原样恢复。 |

这证明SQLite/schema本身只要求non-null text；forge限制属于daemon admission。它也证明当前disk可承载非GitHub值，但public operator路径不允许创建。

实验中的“effective”仅模拟生产renderer的后展开顺序：conflict得到`binding/repo`；row/status仍返回`column/repo`。

### B5. closure/run身份与repository变更实验

在conflict chain上创建item：

- `itemId=x`；
- `repoCwd=/workspace/repo`；
- phase=`run`。

再用`recordRunWithClosureResources`原子写：

- closureId=`closure:1:run`；
- runtimeNodeId=`closure-node:1:run`；
- definitionNodeId=`task:run`；
- worktreePath=`/workspace/repo`；
- branchName=`coder-loop/closures/x`；
- baseCommit=`0123456789abcdef`。

close/reopen后tree/run/closure逐字段相同。随后只把物理repository列从`column/repo`更新为`changed/column`，binding仍是`binding/repo`；tree/run仍逐字段不变。

**确定结论**：persisted closure恢复不以repository字符串作FK或resource identity。它由chain/item row id、closure/runtime node id、phase、worktree/branch/base commit恢复。

**边界**：本实验没有真实Git目录，因此不证明Git命令成功；生产代码已明确Git操作以item.repoCwd和baseBranch执行。实验只证明DB identity/reopen与repository解耦。

### B6. worktree/recovery真实依赖

#### B6.1 创建

`src/scheduler.ts:872-966`：

- slot key=`chainId + repoCwd`；
- worktree期望路径由loopDataRoot、chain.name、repoCwd、closureId派生；
- first-open调用`resolveClosureBase(repoCwd, chain.baseBranch)`；
- Git worktree list/show-ref/add全部在repoCwd执行；
- branch名由chain name/closureId派生。

repository列没有参与。

#### B6.2 持久化

`src/sqlite-state.ts:620-760`的runs/task_nodes/task_closures/active_runs保存：chain/item FK、closureId、runtimeNodeId、definition ref/node、phase、worktreePath、branchName、baseCommit、lifecycle。没有repository字段。

`recordRunWithClosureResources`把run与closure resource准备写在同一store transaction（S3/S6已确认）；它不读取chain.repository。

#### B6.3 restart/reconcile

`src/scheduler.ts:1020-1255`：

- 从tree closure找到item，再用item.repoCwd扫描branch/worktree；
- ownership classification输入loop root、chainName、repoCwd、closureId、persisted path/branch；
- orphan branch的publication判断会参考`chain.baseBranch`；
- Git contract文件按chainName+repoCwd hash定位。

所以baseBranch是一等例外有事实基础，repository列没有同类资源消费依据。

### B7. repository仍有非资源消费者

“worktree不依赖repository”不等于当前可以无观察地删列：

1. target status默认从Git origin推requested repository，再按列筛chain；
2. chain list/status对外显示列；
3. prompt若无同名binding则回落列；
4. chain completion fingerprint含列与metadata；列变化会使keep-active decision fingerprint失效/重算；
5. daemon create validation与operator文档仍把它当chain identity。

这些都是迁移时必须被明确归属的消费者，但不说明最终应该保留列。

### B8. migration版本、事务与先例

#### B8.1 当前框架

- `STATE_SCHEMA_VERSION=16`：`src/sqlite-state.ts:789-816`；
- open后检查表shape，不只看user_version：`:948-998`；
- migration body包在`db.transaction(...).immediate()`，最后写user_version：`:999-1089`；
-必要时暂关FK，finally恢复。

崩溃发生在SQLite transaction commit前时，数据库事务提供回滚；shape detectors允许某些版本号/表shape不一致时重入。跨文件副作用不属于该transaction，但repository迁移目前没有文件副作用实现。

#### B8.2 已有退列先例

1. v10→v11：`chains.umbrella_issue/repo`→`metadata.bindings`，rebuild chains；
2. v11→v12：items `issue_number/branch/pr`→`item_id/extra`，rebuild items；
3. v12→v13：runner CHECK widen，rebuild items；
4. v14-v16：runtime/context/reachability schema演进。

这些证明table rebuild、JSON搬运、shape detection技术存在；不证明repository迁移语义。

#### B8.3 冲突先例的反证

`migrateChainsUmbrellaToBindings`在binding key已存在时不覆盖，只在`=== undefined`时复制旧列（`src/sqlite-state.ts:1397-1440`）。注释却写“column values win”。不论哪边是预期，它都不对冲突响亮失败。

因此不能复制历史先例的口径来宣称P-D7-2已确定；repository冲突的事实是“当前两边可长期共存”。

#### B8.4 版本占用

当前schema已为16；报告只登记下一次migration必须与现有version/shape序列协调。具体用哪个版本、是否多阶段，属于实施设计，本文不裁决。

### B9. 并发与崩溃窗口

- chain单次create/update与migration各自受IMMEDIATE transaction保护；不会在一次SQL transaction内只改半个JSON/row。
- 列与binding不是由一个domain operation强制共同更新：`updateChain`允许只换repository或只换metadata。两个顺序操作之间以及任一操作后都可形成durable conflict。
- daemon/CLI当前create同一request同时提供列和metadata，但CLI主动从bindings剥repository，正常public create通常只写列；store/历史/未来producer可写冲突。
- renderer、status、lookup都是后续独立读取，没有读时一致性检查；并发更新后各consumer可在不同tick看到不同权威。
- 当前没有repository migration，故无法实测其crash恢复；只可确认通用SQLite transaction框架。不得把框架资产写成尚不存在迁移的通过证明。

### B10. 外部chain owner调查

只读检索：

- 本仓`src/`、`scripts/`、docs/templates中的chain producer；
- `/Users/mouriya/Ext/code`下、排除当前coder-loop repo的TS/MD/JSON对`coder-loop chain create|chain.create`命中。

结果文件：`/tmp/rfc547-r7-13-external-hits.txt`。6个命中全部是`coder-loop-worktrees/*/README.md`副本；没有识别出独立外部typed chain declaration实现。

现存正式owner只有：

- CLI flat `--config-json` → socket request；
- daemon `CHAIN_CREATE_ARG_KEYS`/generic metadata validator；
- store record shape。

这不足以满足`U-04`所问的外部typed boundary。检索范围不含所有可能未checkout/未安装系统，所以结论保持“本机已知code目录无实存实现”，不是“全系统不存在”。

### B11. 测试同错与盲区

#### 同错

- daemon/CLI integration chain fixtures普遍使用`owner/repo`，主动满足forge validator；绿测固化列必填。
- migration tests期望current chains列仍含repository；未构造列→binding退役。
- store task-tree tests直接用`repository:"mouriya-s-lab/coder-loop"`，closure成功不能证明repository是资源必需，只证明fixture字段满足type。
- prompt binding tests可验证metadata覆盖顺序，却不把冲突当error。
- target status tests依赖repository匹配/ Git origin inference，固化物理列作为选择键。

#### 盲区

- 无repository migration data-loss/conflict/nonGitHub test；
- 无public daemon创建nonGitHub/无repository chain的成功路径；
- 无列与binding冲突时报错测试；
- 无迁移crash injection；
- 无外部typed declaration→socket等价测试；
- 无专门测试证明repository列变更不影响closure reconcile；本次隔离实验只补DB reopen，不执行Git reconcile。

### B12. 多根因与修补边界

#### 根因集合

1. schema/domain type把repository设为required物理字段；
2. CLI与daemon将其当GitHub forge identity并从bindings剥离；
3. renderer后来加入metadata binding展开，允许同名覆盖；
4. target lookup/status/fingerprint未迁到同一authority；
5. closure资源模型实际发展为repoCwd/baseBranch/closure ids，却没有反向消除旧repository identity；
6. migration体系已有退列技术，但缺repository-specific conflict/consumer合同；
7. 外部typed chain producer尚无可识别owner，无法替代当前入口。

#### 修补边界

- 只删daemon格式validator会允许非GitHub列值，却保留NOT NULL列和双权威；
- 只把列复制到binding会保留status/lookup对旧列读取；
- 只改renderer无助于target identity/fingerprint；
- 只drop列而不处理target lookup/status/create domain type会破坏消费者；
- 把closure改为读repository字符串反而会把当前解耦资源identity重新耦合；
- 直接照搬umbrella冲突行为会继承“静默选边+注释/代码不一致”。

### B13. 事实支持的候选形态（非完备、不推荐）

以下仅为事实能区分的形态，**候选非完备且不推荐任何一项**：

1. **binding单权威、物理列一次性迁除**：确定后果是所有column consumers必须在同一兼容边界内改读/退役，历史冲突需显式分类。
2. **过渡双写+读时一致性门**：确定后果是迁移期可保留旧consumer，但任何单边writer会被拒或暴露；双事实源持续时间更长。
3. **列降为legacy cache、binding权威**：确定后果是schema仍携旧字段，必须定义cache重建与何时drop；status不得继续无条件显示cache。
4. **repository从chain业务模型完全移除，只保留item.repoCwd/baseBranch资源身份**：确定后果是target lookup需另有选择键；prompt若需要repository必须由业务binding显式提供。
5. **外部typed declaration先成为owner，再迁存量**：确定后果是入口/schema依赖先落地；当前`U-04`未知使其尚不能当既定路径。

### B14. 证据索引

| 主题 | 证据 |
|---|---|
| 稳定条款 | `AGGREGATE-547.md` P-D7-2、§2.5 |
| chain schema/domain | `src/sqlite-state.ts:72-95,367-368,603-618` |
| create/update/read | `src/sqlite-state.ts:1683-1733,2161-2176,2563-2573` |
| CLI拆列/binding | `src/loop.ts:2185-2218,5538-5558` |
| daemon admission | `src/daemon.ts:2166-2198,4735-4758` |
| target lookup/infer | `src/loop.ts:4176-4214,4348-4368` |
| render双权威 | `src/loop.ts:4330-4337`; `src/scheduler.ts:3203-3208` |
| fingerprint | `src/scheduler.ts:2819-2850` |
| worktree/baseBranch | `src/scheduler.ts:872-966` |
| reconcile/recovery | `src/scheduler.ts:1020-1255` |
| closure SQL identity | `src/sqlite-state.ts:620-760` |
| migration框架 | `src/sqlite-state.ts:789-816,948-1089` |
| umbrella先例 | `src/sqlite-state.ts:1397-1440` |
| 读写inventory | `/tmp/rfc547-r7-13-inventory.txt` |
| DB/closure实验 | `/tmp/rfc547-r7-13-experiment.ts`, `/tmp/rfc547-r7-13-experiment.out` |
| 外部检索 | `/tmp/rfc547-r7-13-external-hits.txt` |
| R4/R5互证 | `10-r4-engine-primitives.md`; `07-r4-runtime-tree-identity.md`; `11-r5-supply-ledger.md:65,96,106,119,130,144` |

## 尾部结论

R7-13确认repository当前不是单一权威：物理列支配create admission、target选择、status和部分fingerprint，metadata同名binding却静默覆盖prompt值；一致、冲突和非GitHub存量都能在SQLite中持久并跨restart保留。现有migration框架与退列技术可保留，但没有repository migration，最接近的umbrella先例还存在静默冲突与注释/代码不一致。closure/worktree的真实身份链是chain/item id与name、item.repoCwd、baseBranch及持久化closure资源，不依赖repository字符串；实验中改列不改变既有tree/run。故baseBranch例外有资源事实，repository列没有同类正当化。外部typed chain owner仍未知。报告不裁决最终载体、冲突政策或版本安排；候选形态非完备且不推荐。

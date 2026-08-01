# RFC #545 R7 D-01：store 权威入口、引用完整性与 chain 生命周期事实报告

## A. 主 agent 摘要（不超过一页）

### 结论与置信

**可证伪问题的答案为“是”，且存在两条不同强度的真实路径。**

1. **当前生产 soft-delete 崩溃路径（高置信，隔离重启等价实验已复现）：** `chain.delete` 将 `chains.status='deleted'` 与 `DELETE context_entries` 分成两个独立 `BEGIN IMMEDIATE` 事务。第一个事务提交后、第二个事务开始/提交前进程退出，deleted chain 与 entries 同时持久存在。daemon 启动恢复显式跳过 deleted chain，`doctor`、`status`、scheduler recovery、closure reconciliation 均不对账 context；因此没有新 operator 请求时不会自动收敛。只有人工/外部再次执行 `chain.delete`，或 `chain.create --force` 触发物理 chain delete，才会清除。
2. **item 引用路径（高置信存储事实；当前 operator 可达性有限）：** item-scope 仅在 socket `begin` 时查 `(chain_id,item_id)`；`context_entries` 没有 item FK，commit 也不复查 item。store 的物理 `deleteItem` 不清 context。隔离 DB 已复现 item 不可寻址而 `listContextEntries(chainId)` 仍返回该 entry。当前 daemon/CLI 没有 item-delete 命令，生产源码也没有 `deleteItem` 调用者；所以这不是普通 operator CLI 的当前竞态，但它是现存 store/migration/未来 lifecycle 的确定引用缺口。未来 read 尚未实现；若直接按现有 chain/scope 列查询而不做生命周期 join，它会返回该 entry。该未来行为必须用最终 read SQL/handler 的 deleted-chain 与 item-existence 对抗测试确定，不能从接口名推断。

正常 socket append 与正常 soft delete 的**无故障交错不会在 delete 成功响应后留下 entry**：delete 在 status 变为 deleted 之前完成异步 runtime cleanup；其后的 status update、session invalidation、entry delete 全部同步连续执行。commit 成功 admission 后的 session delete与 INSERT亦同步连续执行。SQLite WAL + IMMEDIATE 使不同连接写事务串行。可留下 residue 的当前生产序列是两个 soft-delete 事务之间的 crash，不是普通并发写穿透。物理 chain delete 则由 FK `ON DELETE CASCADE` 在同一事务内清除 entries，隔离实验结果为空。

### 复杂因果、后果与边界

- **直接机制：** context 只 FK 到 chain；soft lifecycle 用 status tombstone但清理另发一笔事务；startup把 deleted chain当作不再处理的对象；内部 list 只按 `chain_id`，不看 chain status/item存在性。
- **上游来源/历史原因：** context 基座在 `d381d06` 一次引入表、公开 append/list/delete API与 soft-delete补清；表沿用了已有 soft chain tombstone语义，同时只为物理 parent delete声明 cascade。`deleteItem` 更早来自 `71596a2`，新增 context 表时未把 item 引用纳入其级联图。HEAD 的 closure cleanup（`699842e`）把 runtime cleanup前置并可重试，但没有改变 status/context 两事务或 startup context 对账。
- **确定后果：** crash residue跨 daemon restart持久；当前 store list可返回 deleted-chain、悬空 item、甚至 store旁路写出的 cross-chain scope key；现有运维读面不会报告这些状态。正常 socket begin拒绝 deleted chain/不存在 item，但这不净化存量。
- **当前/未来/证明缺口：** 当前确定的是残留与内部读取；当前没有公开 context read socket/GUI。未来公开读取是否过滤存量只能在其实现出现后验证。未读取生产 DB，故不能声称生产已有多少异常行。
- **可保留资产：** chain FK cascade、FK启用、WAL/5s busy timeout、每次 store write 的 IMMEDIATE transaction、socket begin 的 chain/item归属校验、commit前 deleted-chain复查、delete session invalidation、already-deleted显式补清、typed scope parser。
- **未知：** 真实部署是否发生过该 crash窗口；未来是否出现 daemon item-delete；未来 read会否 join chain/items；进程 kill在 WAL fsync/响应各机器指令的外观未做破坏性 kill注入，但两个已提交事务之间的持久状态及重启行为已用最小等价实验确认。

### 是否具备决策档案输入

**已具备。** 已确定真实执行序列、事务/锁边界、自动恢复缺口、普通并发终态、item可达性边界、物理/软删除差异、全部现存生产消费者与测试盲区。事实并不只支持“加 FK”或“合并事务”两种形态：至少还存在**读取时按 tombstone/引用存在性排除**与**启动/运维自动对账**这两类不同机制表面；本报告仅证明它们是不同可落点，不裁决任一形态、组合或必要性。

---

## B. 证据附录

### B1. 调查边界与基线

- repo：`/Users/mouriya/Ext/code/coder-loop`
- 报告目录：`/Users/mouriya/Ext/code/coder-loop/v3-issue/n/545`
- 核对 SHA：`699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`
- 唯一设计锚点：`aggregate.md` D3/D6/D7/D11、S01–S03/S06；`r6-detail-index.md` D-01；`r5-supply-ledger.md` L003/L006/L035。
- 未读取/写入生产 DB；实验仅写 `/tmp/rfc545-d01/loop-data`，启动一个 scheduler-disabled隔离 daemon并停止。

### B2. 完整写入口、删除入口与调用者

#### B2.1 context append/store 写入口

| 层 | 入口 | 调用者/可达性 | 引用校验 |
|---|---|---|---|
| CLI | `src/loop.ts:1943-1986` context append | operator/agent CLI，经 socket begin/chunk/commit | CLI自身不决定author或引用 |
| daemon | `src/daemon.ts:1830-1917` 三段handler | classified socket command | begin读chain；item scope查同chain item；group硬拒；commit再查chain非deleted，但不复查item |
| store | `src/sqlite-state.ts:2045-2054` `appendContextEntry` | daemon commit；测试/fixture直接调用；生产 `src/` 无其他调用 | 只靠chain FK；author/scope_key由调用者直接提供 |
| 历史fixture | `src/issue-558-historical-fixture.ts:205` raw INSERT | 迁移验收fixture，不是daemon生产请求 | fixture schema边界 |

`rg` 对 `src/` 的完整结果显示 context entry产品读写符号仅在 `sqlite-state.ts`、`daemon.ts`、`loop.ts` 与历史fixture中出现。没有第二个隐蔽生产 append handler。

#### B2.2 chain 删除入口

| 入口 | 语义 | context结果 |
|---|---|---|
| `daemon.handleChainDelete` 首次删除 `src/daemon.ts:2505-2542` | runtime cleanup完成后，先 `updateChain(status=deleted)`，再 invalidate sessions，再独立 `deleteContextEntriesForChain` | 成功态清空；status提交后崩溃可残留 |
| 同handler already-deleted分支 `2507-2515` | 再做runtime cleanup，再清sessions/entries | 显式重试可补清；不是startup自动执行 |
| force recreate `src/daemon.ts:2200-2209` | 对deleted chain调用store物理 delete，再create同名新chain | FK cascade同事务清旧entries |
| store `deleteChain` `src/sqlite-state.ts:1736-1737` | 物理 `DELETE chains` | FK cascade |
| store `deleteContextEntriesForChain` `2063` | 独立按chain清表 | 不要求chain已deleted；测试会对active chain直接调用 |

CLI/operator产品面只有 `chain delete` 和 force recreate会触发上述daemon路径。脚本里的 `deleteChain` helper均通过daemon命令；没有后台周期性重发删除。

#### B2.3 item 删除入口

- store唯一入口：`src/sqlite-state.ts:1849-1888` `deleteItem(id)`；它依次清 active runs、runs、task tree/leaf/node，最后删 item，**没有触碰 `context_entries`**。
- `rg -n 'deleteItem' src/daemon.ts src/loop.ts src/scheduler.ts` 无命中；即 daemon、CLI、scheduler没有普通 item delete。
- 当前调用者仅测试与 `scripts/issue-558-integration.ts:237` 的迁移fixture验证。故“当前普通daemon item-delete竞态”被证伪；“store生命周期可制造悬空”被证实。

### B3. schema、FK、事务与提交点

1. `context_entries`：`src/sqlite-state.ts:775-784`
   - `chain_id REFERENCES chains(id) ON DELETE CASCADE`；
   - `scope_kind`只有词表CHECK；
   - `scope_key`是可空TEXT；没有 `(chain_id,scope_key)`→items 的复合FK，也没有 kind/key组合表级CHECK。
2. SQLite open：`839-845` 明确 `foreign_keys=ON`、`busy_timeout=5000`、WAL。
3. store write wrapper：`1605-1611` 每次方法调用各自 `db.transaction(fn).immediate()`。因此一次 `updateChain`、一次 append、一次 context delete、一次物理 delete各有独立提交。
4. 首次 soft delete的关键同步序列：
   - `updateChain(status=deleted)`：事务T1提交；
   - session map invalidation：内存；
   - `deleteContextEntriesForChain`：事务T2提交。
   T1/T2没有共同外层transaction或durable intent。
5. 物理 `deleteChain` 的 parent delete和FK cascade在单一write transaction内；不存在“parent物理消失但child已提交残留”的成功终态。

### B4. soft delete、重试、restart 与恢复

#### B4.1 无故障成功

首次delete先暂停scheduler、终止run、将active chain变stopped、等待runtime cleanup；cleanup完整后才写deleted。随后status update、session invalidation、entry delete之间没有`await`。响应返回前entries已清。

#### B4.2 crash窗口

可达序列：

1. chain已有entry；
2. operator请求`chain.delete`；
3. runtime cleanup成功；
4. T1提交`status=deleted`；
5. daemon在T2提交前退出/被杀；
6. WAL恢复保留已提交T1与此前entries；
7. daemon restart。

这不是假设SQLite违反原子性，而是两个正确原子事务之间缺少共同原子边界。

#### B4.3 restart为何不收敛

- `ensureRuntimeLayoutForExistingChains`：`src/daemon.ts:2247-2249` 对deleted chain `continue`；
- `quarantineOrphanChainDirectories`：`2262` 只把非deleted name列为known，处理文件目录而非DB context；
- `recoverStaleSchedulerState`：`2358-2360` 对deleted chain `continue`；
- context delete符号在daemon中仅有两处，均位于显式`handleChainDelete`；
- `doctor/status`无`context_entries`查询，operations文档将其定义为runtime health读取，不是数据修复。

所以 restart后若没有新的delete/force-recreate请求，状态永久保持。already-deleted retry会补清，但这是人工/外部动作，不满足“无需人工介入”。

### B5. append/delete 并发与各时序终态

#### B5.1 正常socket路径

- begin可能与delete的异步cleanup交错：若begin先建session，delete最终invalidate；commit失败。
- commit admission在 `admitContextSessionRequest` 中同步重读chain；若已deleted则删session并拒绝。
- admission成功返回后，commit handler删session并同步调用store INSERT；中间没有I/O await。JS microtask continuation与同步SQLite INSERT使另一socket handler不能插进这段。
- delete变更status后的session invalidation和context DELETE也同步连续，无await。

因此普通可枚举顺序只有：

| 顺序 | 终态 |
|---|---|
| commit INSERT先于delete T1/T2 | T2清掉entry |
| delete先变deleted | commit admission拒绝，不INSERT |
| begin/chunk在cleanup期间，delete后commit | session被invalidate或chain-deleted拒绝 |

没有发现“chain.delete成功返回后，已admit socket commit再INSERT”的当前真实序列。

#### B5.2 多store连接/旁路

IMMEDIATE事务会串行，不会产生半行，但store append不查chain status：

| 串行化顺序 | 终态 |
|---|---|
| append → soft context clear | 空 |
| soft clear → store append（chain行仍存在且FK满足） | residue |
| physical delete → append | append因chain FK失败 |
| append → physical delete | cascade后空 |

当前产品`src/`没有daemon之外的store append生产调用者，故“soft clear后旁路append”是权威边界缺口与测试可达状态，不冒充普通operator现时事故。crash residue不依赖此旁路。

### B6. item不可寻址、cross-key 与读取行为

1. socket begin对item scope执行 `getItemById(chain.id, scope.itemId)`；写入时刻可证明存在且同chain。
2. begin创建内存session后，commit只复查chain与caller，不复查item。当前没有并发item delete产品入口，因此普通CLI暂时不会触发这个窗口。
3. store/schema不保引用：
   - `deleteItem`后entry仍在；
   - store可向chain A写入`itemId`实际只存在于chain B的entry；
   - 甚至不存在的key也可写。
4. 当前内部读取 `listContextEntries(chainId)` 的SQL仅为 `WHERE chain_id=$chainId ORDER BY created_at,id`，会返回上述三类行；它不join `chains` status或`items`。
5. 当前没有socket read/GUI context consumer（`src/`全量符号搜索确认）。因此公开“当前用户看到”尚不成立；内部store消费者/测试可看到成立。
6. 未来 read静态不可判定的确定方法：对最终read handler分别seed（a）deleted chain residue，（b）同chain已删item，（c）cross-chain key，（d）正常item，逐scope/chain查询，并同时核对 boundary response与GUI消费；不能用正常append happy path代替。

### B7. 隔离实验

#### B7.1 文件与命令

- 脚本：`/tmp/rfc545-d01/experiment.ts`
- DB/root：`/tmp/rfc545-d01/loop-data`
- 输出：`/tmp/rfc545-d01/experiment-output.json`
- 命令：`bun /tmp/rfc545-d01/experiment.ts`

脚本执行：创建两chain与两item；写正常chain entry、待删item entry、跨chain key；物理删item；只提交soft delete的status事务模拟两事务之间进程死亡；关闭store；启动并停止真实scheduler-disabled daemon；重开查询；另建chain验证物理cascade。

#### B7.2 观察

restart前后完全相同：

- chain status：`deleted`；
- `getItemById(...,"gone")`：`null`；
- `listContextEntries`仍返回3条：chain residue、`itemId=gone`悬空、`itemId=foreign`跨chain key；
- 物理delete chain后entries为`[]`。

这是T1已提交/T2未执行的最小等价故障注入。没有在产品代码加hook，也没有触碰生产DB。精确SIGKILL落在两行之间未做，因为无需修改产品即可复现同一durable边界；若后续必须验证进程级时间窗口，可在隔离daemon对T1提交点加外部SQLite轮询后kill，但这只会重复已确认的持久终态。

### B8. 运维与所有消费者

| 消费者 | 是否发现/修复 residue | 证据 |
|---|---|---|
| store `listContextEntries` | 返回，不修复 | `sqlite-state.ts:2056-2061` |
| daemon startup layout | 跳过deleted | `daemon.ts:2247-2249` |
| daemon stale scheduler recovery | 跳过deleted | `daemon.ts:2358-2360` |
| closure reconciliation | 处理worktree/branch/closure资源，不查询context | `rg context_entries src`无调用 |
| `chain.list/status` | 可显示deleted chain/items，不查询context | `daemon.ts:2450-2490` |
| `doctor` | 无context对账/修复 | `rg context_entries src/loop.ts src/daemon.ts` |
| scheduler | 不消费entry | `src/`符号搜索；仅测试fixture直写 |
| GUI/public read | 尚不存在 | daemon command table只有append begin/chunk/commit |
| 显式再次`chain.delete` | 修复 | alreadyDeleted分支 |
| force recreate | 物理cascade修复 | `handleChainCreate(force)` |

### B9. 测试同错、盲区与资产

#### B9.1 现有覆盖

- `tests/unit/runtime/context-entry.test.ts:46-58`：append/list及按chain独立清除、他chain无损；
- `tests/integration/daemon/context.integration.ts:89-110`：正常delete invalidates session；测试主动向deleted chain旁路append，再次delete补清；
- 同文件scope admission：不存在item拒绝、group拒绝；
- `tests/unit/sqlite-state/crud.test.ts`：物理item/chain delete；
- migration test：合法context row保留。

#### B9.2 同错/盲区

1. unit把active chain上的独立context delete当作append-only清理测试，未约束“唯一chain生命周期通道”。
2. daemon test证明“人工第二次delete可修”，但没有restart后静默等待断言，因此把手动可重试误当自动恢复的风险未显式暴露。
3. 无T1/T2之间crash或等价restart fixture。
4. 无item delete后list断言、无cross-chain scope key fixture。
5. scope admission只证明begin时存在，不证明commit/read时存在。
6. 无公开read，所以也无deleted/orphan/cross-key过滤测试。
7. 无doctor/status对账异常行测试，因为产品面根本没有该检查。

#### B9.3 可保留资产

- 表对chain的FK cascade和启用的foreign_keys；
- WAL、busy timeout、IMMEDIATE单写事务；
- socket chain deleted/item exists admission；
- commit前chain状态复查与delete session invalidation；
- already-deleted补清语义；
- typed `ContextScope`、persisted parser和scope kind穷尽；
- 正常delete后他chain无损测试。

### B10. 因果链与根因集合

#### 观察事实

隔离daemon restart后deleted chain residue、悬空item entry、cross-chain key均仍由当前store list返回；物理cascade不残留。

#### 直接机制

soft tombstone与context delete分事务；scope key无引用约束；item delete不清entry；startup/read不对账生命周期。

#### 上游来源

- chain是持久parent，soft delete保留parent行；
- context基座只把物理parent cascade编码进schema；
- item scope把引用有效性放在begin的瞬时application check；
- recovery以active scheduler/runtime资源为对象，deleted chain被跳过。

#### 历史原因

`d381d06` 在既有soft chain与既有`deleteItem`上叠加context表/API：实现了成功路径补清和物理cascade，但未把软状态转移、item生命周期和startup reconciliation合成同一持久不变量。`699842e`后来加强closure/runtime cleanup，将其放到deleted status之前并提供incomplete retry；context两事务保持不变。

#### 放大条件

- T1/T2之间进程退出；
- 未来新增item删除但沿用当前store；
- 未来read直接使用现有chain-only list/filter；
- 任何store旁路写入不存在/他chain item key；
- 长期不再对deleted chain发delete/force recreate。

#### 消费者影响

当前内部读可返回；运维面不可见；未来read/GUI/required outcome若不重新验证引用，将继承存量。正常socket append主体在deleted chain上被拒绝，故不会自行修复也不会普通追加。

#### 根因集合（彼此独立，不能压成单一“缺FK”）

1. soft lifecycle commit边界与entry lifecycle commit边界分离；
2. startup/运维恢复域排除了deleted chain context；
3. item/group scope以非关系TEXT存储，引用有效性仅是写前瞬时检查；
4. store API允许绕过daemon identity/lifecycle admission；
5. 当前read primitive不做owner/reference lifecycle join。

#### 修补边界事实（不作方案裁决）

事实显示可能落点跨 schema/store transaction、daemon chain delete、startup reconciliation、item lifecycle、read query与运维诊断。仅改其中任一层所能覆盖的故障集合不同：物理FK覆盖physical chain，不覆盖soft tombstone；begin校验覆盖新socket写，不净化存量；retry覆盖再次请求，不覆盖无人介入；read过滤可阻断曝光但不消除residue。这里登记机制边界，不推荐或排序。

### B11. 证据索引

| 主题 | 权威证据 |
|---|---|
| SHA | `git rev-parse HEAD` → `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` |
| context schema/FK | `src/sqlite-state.ts:775-784` |
| WAL/FK/busy | `src/sqlite-state.ts:839-845` |
| write transaction | `src/sqlite-state.ts:1605-1611` |
| store chain/item delete | `src/sqlite-state.ts:1736-1737,1849-1888` |
| append/list/clear | `src/sqlite-state.ts:2045-2063` |
| socket admission/commit | `src/daemon.ts:1769-1917` |
| force physical recreate | `src/daemon.ts:2200-2209` |
| startup skip deleted | `src/daemon.ts:2247-2249,2358-2360` |
| soft/retry delete | `src/daemon.ts:2505-2542` |
| 历史引入 | `git log -S context_entries` / blame → `d381d06` |
| item delete历史 | `git log -S 'deleteItem: (id)'` → `71596a2` |
| HEAD cleanup变更 | blame `daemon.ts:2505-2532` → `699842e` |
| 实验 | `/tmp/rfc545-d01/experiment.ts`, `experiment-output.json`, 隔离DB |
| 测试同错 | `tests/unit/runtime/context-entry.test.ts:46-58`; `tests/integration/daemon/context.integration.ts:89-110` |

---

**文件已完整交付。**

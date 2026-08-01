# RFC #548 R8 — replay / verdict 决策档案

事实基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。输入仅为 R7-02、R7-03、`AGG-548.md` 稳定条款与 `investigation-index.md` 的 R7-02/03。本文不裁决、不推荐、不估规模；候选形态不是完备枚举。

## A. 操作员决策页（3 个可立即裁决问题）

### 1. item 已存在时，谁提供 `consumed` 所需的“属于本次意图”证据？

固定事实：`(chain,itemId)` 只保证最多一行；duplicate 不比较 payload，同 payload与不同 payload得到同形 conflict。socket 有 identity details，PATH CLI 只投影为 exit 1 + 扁平错误。因此，“已在队”与“另一请求占用了相同 identity”目前不能从 PATH CLI 区分。

事实支持的形态（可组合，不是完备清单）：

1. **消费 daemon 的 durable delivery 记录为权威**：先绑定 delivery、映射结果和 item identity，再以现有 engine uniqueness 兜底。
2. **PATH CLI 保留 daemon 的结构化 error/details**：调用方可稳定区分 conflict 类别和 existing identity；现有 details 仍不证明 payload/delivery 相同。
3. **engine 返回 typed already-existing/success variant**：重放可直接得到 caller-visible `consumed` 候选；若不增加关联证据，identity 碰撞仍与同意图重放同形。
4. **duplicate 增加稳定 operation identity 或请求/既存 payload 对照**：engine 可区分同意图与 identity 碰撞；会改变 persistence、请求和 duplicate contract。
5. **把相同 `(chain,itemId)` 规范为同一工作身份**：消费端无需比较 payload即可把 already-existing 解释为已接管；确定后果是 itemId 映射正确性成为该 verdict 的前提。

### 2. `chain.create` 成功而 `item.add` 未确认/失败时，空 active chain 归谁处置？

固定事实：两步各自 durable、没有跨步事务；任何前缀可留下 `∅`、空 chain、chain+item。chain replay按实然等价规则复用，item replay则 conflict。空 chain 不足以证明 delivery 已 consumed；startup recovery 不会合成第二步。

事实支持的形态：

1. **消费端保留并重放第二步**：空 chain 是可恢复部分状态；确定后果是恢复策略必须能区分待补种与不再需要。
2. **消费端判定放弃后显式 `chain.delete`**：复用现有删除入口；确定后果是会删除该 chain 的 durable 资源，调用方必须先排除合法共享/接管。
3. **把空 chain 作为长期合法状态，不自动归属某 delivery**：不新增恢复/清理语义；确定后果是逐 delivery verdict 必须由别处给出。

### 3. LOG-746 中“既有 engine 事件已覆盖入队审计”的主张保留到什么强度？

固定事实：消费 daemon 的逐决策 JSON 义务与 engine 事件是两种义务。`item.created`、rights admission、`chain.layout` 只证明局部 engine fact；它们无 delivery/verdict identity、best-effort、在 DB 事务外，且 append 失败可与成功 reply并存。预校验拒绝不触达 engine。

事实支持的形态：

1. **消费 daemon 日志独立承担逐 delivery 决策账本；engine 事件只作窄互证**：LOG-746/747 所列 delivery、mapping、CLI args、verdict/blocker 全由消费端持久记录。
2. **新增 engine durable、可关联的逐请求事件/记录**：若仍要求 engine 覆盖该审计强度，必须补 delivery/request identity、duplicate/no-op verdict与 mutation/record durability 关系。
3. **联合当前态查询、CLI reply和既有事件作运行时观察，不称逐决策账本**：可以判断查询时是否在队；不能重建每次 delivery 的历史 verdict。

---

## B. 证据、触点与未知

### B1. 已确定的执行语义

| 主题 | 已确定事实 | 对决策的确定约束 |
|---|---|---|
| 两步 durable 非原子 | `chain.create` 与 `item.add` 是两个独立 SQLite mutation；无共享 transaction、operation/delivery row、自动补偿 | 不能承诺 all-or-nothing；恢复必须面对正式可见的空 chain |
| chain 等价 | 精确比较 preset/repository/baseBranch/status；request metadata 是 existing metadata 的同值子集即可，existing 多余键不冲突 | “同字段幂等”不是完整对象相等；冲突声明不能复用 |
| chain 并发 | 单一生产 daemon 的 lookup→insert/compare 同步区间无 await；20 路并发均 exit 0、复用同一行 | 旧“败者 `sqlite_error`”假设已被实然与实验纠正，**不得继续作为选项前提**；DB UNIQUE只保留为异常拓扑兜底 |
| item duplicate | 唯一键为 `(chain_id,item_id)`；duplicate details 只有 identity，不比较 repo/preset/extra 等 payload | storage uniqueness 不能单独证明 delivery/意图等价 |
| PATH CLI 投影 | socket conflict/details 被 CLI 压成 exit 1 和 `code: message` | 稳定调用面无法忠实携带当前 socket ADT |
| commit 后无确认 | DB commit 后才 event/layout/tick/reply；断连或崩溃可使 durable state 已存在而 caller 未收到确认 | “无 reply”不能推出未创建；WAL不解决 caller acknowledgement |
| 空 chain | item 校验/insert 前失败留下 active chain；可重放补 item或显式删除；startup不补第二步 | 空 chain 本身既不等于 consumed，也不唯一绑定某 delivery |

### B2. consumer 与 engine 的不同义务

| 边界 | 必须/能够保存的事实 | 不能由另一边界替代的原因 |
|---|---|---|
| 消费 daemon 决策日志 | LOG-746/747 的 deliveryId、repository/issue、映射、CLI 参数、verdict/blocker；包括不触达 engine 的预校验拒绝 | engine 不知道外部 delivery/mapping，且预校验拒绝根本没有 engine 调用 |
| engine 事件 | `item.created` 证明一次 insert 后 emitter 读到的 identity/status；rights event证明 gate outcome；layout证明 handler完成 layout阶段 | 无 delivery/verdict identity；create/replay layout同形；duplicate只有额外 rights allow；写入 best-effort且非事务 |
| list/status/SQLite | 查询时的 durable 当前态、最多一行 | 不是逐决策历史，也不证明谁造成该行 |
| CLI/socket reply | 本次 handler 的即时结果；socket比PATH CLI保留更多细节 | reply可能在 commit后丢失，且不是 durable acknowledgement |

### B3. 具体触点与确定后果

| 形态 | 具体触点 | 确定后果 |
|---|---|---|
| consumer delivery 权威记录 | 树外 consumer persistence、verdict ADT、recovery；现有两条 PATH CLI | 可绑定外部 delivery；仍需定义 commit后 conflict如何与记录/当前态对账 |
| CLI 结构化错误 | `requestDaemonResult`、CLI error serializer/exit contract、CLI integration tests | details跨稳定边界保留；现有 item details仍无 payload/operation identity |
| engine typed already-existing | item handler response ADT、CLI formatter、socket/CLI tests | 可改变 replay 的 exit/verdict；不自动消除 identity碰撞 |
| operation/payload identity | item request/persistence/lookup、duplicate details、migration、consumer mapping | 可比较意图；改变现有只按 identity 唯一的合同 |
| consumer保留或删除空 chain | consumer recovery policy；删除时使用 `chain.delete` | 保留可补第二步；删除有资源清理与误删风险 |
| engine durable逐请求审计 | mutation/event durability边界、event schema/query、delivery关联、duplicate/no-op producer | 才可能承担强审计主张；现有 best-effort JSONL不能渐进解释成该保证 |

### B4. 未知与纯证明缺口

**真正需要操作员裁决：** A1 的意图证据权威边界；A2 的空 chain 归属/处置；A3 的审计主张强度。

**纯证明缺口，不应冒充产品分叉：**

- 尚未用故障注入逐个命中 commit→event→reply 的所有指令级 kill point；源码顺序和断连实验已经确定“durable但未确认”窗口存在。
- JSONL 并发 append/rotate 在目标文件系统上的精确结果、malformed tail 与各 kill point尚无完整 runtime 覆盖；这不会让现有事件获得 delivery identity或事务性。
- 尚未发现 repo 内正式外部 JSONL 消费者，只能证明仓内没有，不能证明部署环境不存在。
- scheduler 异步执行的完成时序不属于“已入队”verdict；item成功 reply前触发 queue tick，但执行完成另有生命周期。

### B5. 对稳定条款的事实校准

- §2.1 C 的“两步调用、不加组合命令”与当前实然一致，但它必然产生可见部分状态。
- P-746-3 的**最终存储收敛**有地基；其“already-exists 按 consumed”尚缺 caller-visible、意图可关联的 verdict。
- P-746-4 的“consumed iff 入队或已在队”不能由当前 PATH CLI或engine JSONL单独证明。
- LOG-746 的消费 daemon逐决策日志义务仍完整成立；“engine既有事件覆盖入队审计”只能弱化为局部互证，除非另行选择更强 engine 记录形态。
- R7-02 index 中并发 chain 可能败为 `sqlite_error` 的旧观察已失效；后续方案比较不得引用它。

自检：A 共 **3** 个可立即裁决问题；本文未把候选宣称为完备集合，未推荐、未估规模、未实现、未重拆 issue；已区分操作员裁决与纯证明缺口。

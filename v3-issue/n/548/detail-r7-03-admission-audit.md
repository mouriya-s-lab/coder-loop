# R7-03 · 入队决策审计的实际证明力

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点为 AGG-548 的 LOG-746/LOG-747、T3/T5 及稳定审计边界。本报告只调查审计与 observability 的证明力；不裁决或推荐重放方案。

## A. 主 agent 摘要

### 问题与结论

LOG-746 同时包含两项不同义务：消费 daemon 必须为**每个决策**写一行带 `deliveryId`、repository/issue、映射结果、CLI 参数、verdict/blocker 的结构化 JSON；引擎被主张为无需新增事件，因为既有 `chain.create` / `item.add` 审计已经覆盖入队审计。固定基线只支持前一项仍由消费 daemon 独立承担，**不支持后一项的“覆盖”强度**。

引擎既有事件能证明的最强事实是：

- `item.created` 存在时，证明某个 `(chain, rowId, itemId)` 曾成功插入且 emitter 当时读到该初始 status；它不带 delivery/request identity，也不证明消费 daemon 对哪个外部投递给出了何种 verdict。
- `item.add.rights_admission` 只证明某次请求通过或未通过 create-rights gate。allow 在 item lookup/insert 之前，duplicate 调用同样留下 allow，故不能证明 item 被该调用创建或该调用已消费。
- `chain.layout` 证明 handler 完成了 runtime layout 并尝试记录事件；首次创建和同字段 replay 的 payload 相同，均不标 `created|already-existing`，不能区分两类决策。
- CLI reply、`chain.list` / `item.list` / `status` 可证明回复时或查询时的当前态，但不是逐决策 durable record；通用 CLI 又把 daemon error details 压成 stderr。

事件写在 SQLite mutation 之外、回复之前，并由吞错 writer best-effort append。最小隔离实验实际观察到：把 active `events.jsonl` 设为不可写后，同字段 `chain.create` 仍 exit 0 并返回原 chain，事件数不变；daemon 只向 stderr 打两条 write-failed 警告。因而“成功回复 ⇒ 有审计事件”和“DB 中存在 ⇒ 有对应事件”都不成立。

重复调用实验进一步确认：两次同字段 `chain.create` 产生两个形状相同的 `chain.layout`；首次 `item.add` 产生 rights-allow + `item.created`，重复 add 产生另一条 rights-allow 后返回 conflict，但没有第二条 `item.created` 或 already-existing event。该序列允许事后推测“有一次创建、另一次只过 gate”，不能把任一 rights event 绑定到具体 delivery，也不能从事件流忠实重建两次消费 verdict。

### 影响、资产与边界

- **当前影响：** 引擎 JSONL 不能独立履行 LOG-746 的逐 delivery 决策日志，也不能单独证明 T5 的 `consumed iff item实际入队或已在队`。LOG-747 的预校验拒绝发生在不触达引擎的消费端，更不可能由引擎事件证明。
- **未来/故障影响：** mutation commit 后、event append 前崩溃会留下 durable state 无事件；event 后、reply 前崩溃会留下 state+event 但调用方未确认。不可写被吞掉；损坏/半行会使查询 parser 抛错。轮转与 append 没有共同事务或显式锁。
- **纯证明缺口：** 正常 append、过滤、轮转顺序均有测试资产；没有覆盖 append 不可写、duplicate 的完整事件差异、mutation/event/reply kill-point、并发 append/rotate 或损坏尾行。
- **可保留资产：** typed `ObservabilityEvent` 边界、subject/run identity（agent 路径）、operator-only `logs.query`、SQLite 唯一约束以及当前态 list/status 都是窄事实源；它们不能被提升为 delivery 决策账本。
- **尚未确定：** 单一 daemon 内并发 `appendFile` 在目标文件系统上是否永不交错、并发触发 rotate 是否会丢段；静态代码无锁，现有测试未覆盖。也未发现仓库内正式外部消费者；这只能证明 repo 内没有消费者，不能证明部署环境不存在直接读文件者。
- **下一步：** 本项已建立 LOG-746 声称前所缺的 runtime/audit proof；不产生重放裁决点。任何后续事实形态都必须继续区分消费 daemon 的业务日志义务与引擎事件的窄证明力。

## B. 证据附录

### B1. 设计逐条对照

| 锚点 | 固定基线事实 | 能证明 / 不能证明 |
|---|---|---|
| LOG-746 消费 daemon 每决策一行 JSON | 当前调查对象是 coder-loop；没有 deliveryId/repository/issue/mapping/verdict/blocker 合一事件 | 引擎事件不能代替消费 daemon 业务日志 |
| LOG-746 引擎既有事件覆盖入队审计 | created/layout 是 best-effort、无 delivery identity；duplicate/no-op 语义不完整 | 只能证明局部 engine fact，不能覆盖逐决策 audit |
| LOG-747 预校验拒绝 | 稳定条款明确预校验不触达引擎 | 引擎事件对该拒绝无证明力；义务完全在消费 daemon |
| T3 重放 | chain replay 与 create 发相同 layout；item replay只有额外 rights allow + conflict reply | 可证明存储最终唯一，不能从日志绑定/分类每次 replay |
| T5 verdict 忠实 | DB/event/reply 三段分离，事件无消费 verdict | 事件存在与否都不足以推出 caller 收到的 verdict |

### B2. 生产入口、顺序与 payload identity

#### chain.create

1. handler 先在 SQLite 外读 existing；不存在则 `store.createChain`，存在且字段相同则复用 existing：`src/daemon.ts:2197-2220`。
2. 随后确保 runtime layout：`src/daemon.ts:2221`。
3. 再发 `chain.layout`：`src/daemon.ts:2222-2229`。
4. 最后返回 chain：`src/daemon.ts:2230`。

`chain.layout` payload 只有 `chainId/state`，可选 `updatedKinds` 是另一 mutation 面使用；无 request/delivery id、created/already-existing、repository、issue、CLI args 或 verdict：`src/observability.ts:304-313`。create 与同字段 replay 因此不可区分。

#### item.add / item.batchAdd

1. rights gate 在 build input、existing lookup 和 insert 之前：`src/daemon.ts:2898-2911`。
2. gate 的 allow/deny 事件由 `recordItemAddRightsAdmissionEvent` 写出，payload 为 claimedPhase/preset/outcome/reason，subject 为 operator 或 agent：`src/daemon.ts:4227-4248`；schema 在 `src/observability.ts:750-771`。
3. 单项 duplicate 在 insert 前返回 conflict；竞争 duplicate 由 insert error 再查询归一：`src/daemon.ts:2912-2919`。
4. 成功 SQLite insert 后才发 `item.created`，然后 queue tick，再 reply：`src/daemon.ts:2920-2939`。
5. batch 在整批 transaction 成功后逐 item best-effort emit；中途某个 append 失败不会阻止后续循环，因为 writer吞错：`src/daemon.ts:2974-2998`。

`item.created` payload 为 `rowId/itemId/status`，base 可有 chain、numeric row item、subject；agent caller 额外有 runId/phase/task identity，operator没有这些：`src/observability.ts:320-325`、`src/daemon.ts:2920-2937`。它没有 deliveryId、request id、repository、外部 issue 语义、already-existing 或 verdict。numeric event `item` 是 DB row id，opaque业务 itemId 在 payload，不能与外部 delivery 等同。

### B3. 写入、事务、并发、crash 与不可写

- 通用 producer 走 `recordObservabilityEvent` → `appendObservabilityEvent`：`src/daemon.ts:2285-2289`。后者 catch 全部 mkdir/rotate/append 异常，仅写 stderr并正常 resolve：`src/observability.ts:923-935`。
- SQLite mutation、JSONL append、socket reply不在同一事务。确定窗口：
  - commit 后、event 前退出：state 有，event/reply 无；
  - event 后、reply 前退出：state/event 有，caller 无确认；
  - event append 失败：state与成功 reply可同时存在，JSONL无事件。
- 每条 event 以一次 `appendFile` 写一行；轮转先 stat/discover 后 rename，再 append：`src/observability.ts:931-935,1246-1258`。代码没有 mutex、file lock、fsync 或 outbox。单 daemon 虽是唯一正常 writer，socket handlers可异步交错；并发 append/rotate 的精确文件系统结果静态不可判定，现有测试未证明。
- active segment 按日期或 32 MiB 轮转，历史段被发现并排序；代码不删除历史段，注释声明“rotated, never truncated”：`src/observability.ts:869-874,1274-1283,1308-1358`。这是文件保留行为，不是 delivery-level retention/ack。
- query 逐行 `JSON.parse` 再 boundary parse，没有跳过 malformed 非空行：`src/observability.ts:953-964`。崩溃留下半行或外部损坏会使整个 query 失败，不会返回“截至坏行”的显式 partial result。
- fatal path有同步 best-effort append，但失败仍只退到 stderr；它不修复此前 mutation 的缺失业务事件：`src/daemon.ts:2296-2321`。

### B4. 最小隔离实验

环境：本机、固定 SHA、独立 `/tmp/rfc548-r7-03-daemon-*` loop-data；未触碰中央 daemon/生产 DB。实验后停止隔离 daemon，移除实验意外触发的隔离 closure worktree/branch并删除临时目录。未保留 runtime artifact。

调用序列与观察：

1. 同字段 `chain.create` 两次：两次 exit 0、返回相同 chain id；JSONL 有 **2** 条 payload 相同的 `chain.layout`。
2. `item.add audit-item`：exit 0；增加一条 operator rights allow 和一条 `item.created`。
3. 同一 item 再 add：exit 1，stderr `conflict: item with id audit-item already exists...`；事件增加第二条 operator rights allow，`item.created` 仍只有 **1** 条。
4. 将 active `events.jsonl` chmod `0400`，第三次同字段 chain create：exit 0、返回原 chain；前后 JSONL 都为 **11** 行，没有新事件。daemon stderr记录 `EACCES` 的 privileged-op admission 与 `chain.layout` 两条 write-failed 警告，且仍渲染事件文本。
5. `chain list --json` 仍显示唯一 active chain。

这证明不可写的真实处置是“stderr告警 + 业务请求继续”，而非 request failure；也证明 duplicate/no-op 的事件差异不足以重建逐调用 verdict。stderr 是 launcher 捕获面而非 typed JSONL query 面，且同样没有 delivery identity，不能补成 LOG-746 账本。

实验限制：scheduler 在 item 成功后启动了隔离 runner，产生了与本结论无关的 lifecycle rows；计数时只比较目标 audit types。该副作用已清理，且没有用 lifecycle rows支持结论。

### B5. 消费者与其他读面

#### 仓库内正式消费者

- operator CLI `coder-loop logs` 通过 daemon `logs.query`，不直接读文件；agent credential被 hard-deny：`src/loop.ts:2138-2163`。
- daemon query 合并 main events、lifecycle persistence failures、runner persistence failures并按 timestamp 排序返回：`src/daemon.ts:2679-2732`。
- repo 内 `queryObservabilityEvents(main eventsFile)` 的生产用读入口仅上述 `logs.query`；其余命中是 failure-file恢复、run-local诊断或测试。未发现把 `chain.layout/item.created/rights_admission` 转为 consumed verdict 的生产消费者。
- hook declarations只复用 event type vocabulary，并非当前这些 JSONL 行的 delivery审计消费者：`src/hook-declarations.ts:5,114`。

#### 非事件读面

| 读面 | 可靠事实 | 不能证明 |
|---|---|---|
| socket success reply | handler执行到 reply；chain/item对象来自当前操作 | reply是否到达外部消费 daemon之后仍无 durable engine acknowledgement |
| socket structured conflict | daemon查询时 item已存在，并带 details | 通用 CLI丢 details；不是 durable逐决策记录 |
| CLI stderr/exit | 当前进程观察到成功或扁平错误 | 无 typed already-existing、无持久 delivery关联 |
| chain/item list、status JSON | 查询时当前 SQLite 状态 | 谁/哪次 delivery造成它、每次判定、已删除历史 |
| SQLite UNIQUE | 最多一个 `(chain,itemId)` | 每次调用 verdict与外部 delivery identity |
| daemon stderr rendered event | append失败时可能由 launcher保存文本 | 不受 JSONL schema/query/retention保证，且无 delivery identity |

因此存在可靠的**当前入队状态读面**，不存在已发现的可靠**逐 delivery 决策读面**。

### B6. 测试资产、同错与盲区

- query过滤和正常 append：`tests/unit/observability/observability.test.ts:153-204`。
- 正常日期/size轮转、历史段顺序与精确字节连续：同文件 `:206-295`。均为串行、可写文件。
- chain create串行 idempotency测试只断言相同 id/list唯一，没有对 event区分力作断言：`tests/integration/daemon/chain-crud.integration.ts:38-89`。
- rights admission测试断言正常 allow/deny事件并用 item.list交叉检查：`tests/integration/daemon/admission.integration.ts:630-669,802-867`。这验证 gate audit schema，不验证 allow 与实际 insert/duplicate的绑定。
- 未找到 append不可写仍成功、duplicate完整事件delta、kill-point、malformed tail、并发 append/rotate 测试。由此 S1-T07 的“正常文件事件测试与实现共同把存在性当覆盖”风险成立。

### B7. 事实支持形态与确定后果（不作推荐）

| 事实形态 | 已有触点 | 确定后果 |
|---|---|---|
| 消费 daemon独立业务决策行 | LOG-746/747规定的消费端边界；本 repo无实现 | 唯一能自然携带 deliveryId、mapping、CLI args、verdict/blocker；引擎事件不能替代 |
| 引擎 created/layout/rights事件保持窄 engine fact | `handleChainCreate`、`handleItemAdd/BatchAdd`、typed boundary | 可作局部互证；必须按 best-effort、非事务、无 delivery identity解释 |
| 当前态查询与调用回复联合观察 | socket response + list/status/SQLite | 可判断查询时“已在队”，仍不形成历史逐决策账本 |
| 仅依赖 JSONL 作为 T5 verdict依据 | append吞错、duplicate/no-op payload现状 | 存在 false absence、ambiguous presence 与 caller-confirmation窗口，无法得到 iff |

### B8. 证据索引与自检

- 设计：`AGG-548.md:114-140,277-278`；`investigation-index.md:43-51`；`supply-findings-ledger.md:45,57,67`。
- event schema/IO/query/rotation：`src/observability.ts:304-325,750-771,899-964,1246-1358`。
- chain producer：`src/daemon.ts:2197-2230`。
- item producers：`src/daemon.ts:2898-2939,2940-2998,4120-4248`。
- writer与query consumer：`src/daemon.ts:2285-2321,2679-2732`；`src/loop.ts:2138-2163,2488-2504`。
- tests：`tests/unit/observability/observability.test.ts:153-295`；`tests/integration/daemon/chain-crud.integration.ts:38-89`；`tests/integration/daemon/admission.integration.ts:630-669,802-867`。

自检：报告没有裁决重放方案、没有新增需求、没有规模估算；明确分开消费 daemon 的业务日志义务与引擎事件证明力。固定 SHA 已核对；唯一持久写入是本报告。

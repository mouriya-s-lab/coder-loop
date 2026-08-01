# #599 feat(engine): gate 评估代次与幂等协议——mutation 重放安全与 decision 消费原子性

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-10T04:50:26Z  | updated: 2026-07-17T20:41:13Z
- closed: 2026-07-17T20:41:13Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/599
- comments: 2  | timeline events: 22

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）与 #589（script gate 执行与 stdout decision 协议）是本 child 的已存在输入；#561（par join 的 validator leaf 与 CLI decision 协议）是下游消费者。统一判定契约的唯一权威文本仍是 #546 body「join 策略与验证者判定」节——本 child 不触词表，先以 script ingress 落共享 evaluation epoch、journal 与 consumer，再由 #561 把 validator CLI ingress 接入同一协议，禁止复制第二套状态机。

#543 继承条款逐字快照：

> "hook 操作队列 = 在脚本内调 `coder-loop` CLI（socket 命令面），以 operator 身份。不引入「hook stdout 返回结构化 mutation 指令由引擎代执行」的第二套协议——mutation 全部走现有命令面，自动获得既有校验与审计事件。gate hook 的 stdout 只承载 decision，不承载 mutation。" — #543 能力契约

> "gate hold 后的重问需幂等防抖——chain-complete trigger 的 fingerprint 机制（`chain.metadata` 持久化 keep-active 指纹）是既有先例，具体形态归实现 child。" — #543 执行模型

#589 继承条款逐字快照：

> "**hold 语义（RFC 行 2）**：该 chain 的 post-exit 决策扣住——不选下一个 item；其他 chain 调度不受影响；退避重问时脚本重新执行、可改判" — #589 预期结果 4

## 设计裁决（操作员，2026-07-10，边界 4 设计审查子会话）

#561 下游接入条款：validator 是普通 leaf，mutation 与 decision 均经 CLI；它必须消费本 child 已落地的 evaluation epoch、CLI mutation 幂等确认、decision journal 与原子 consumer，只在 decision ingress 和执行主体重放方式上扩展，不另建第二套协议。validator 真实路径的集成验收归 #561。

两种判定主体都有 mutation 与 decision 之间的崩溃窗口：script gate 的 mutation 经 CLI、decision 经 stdout；validator leaf 的 mutation 与 decision 虽都经 CLI，却是两个独立请求。任一主体在 mutation 成功后、decision 被准入前崩溃/超时，重问都会重放副作用——审查核实该问题真实：既有 fingerprint 只覆盖「同一队列布局不重复问」的 decision 防抖（且仅在 decision 成功返回时持久化），而 mutation 本身改变布局、必然击穿防抖；CLI mutation 面无任何重放安全语义（`(chain, itemId)` 唯一性是拒绝式 conflict，非确认式 ack）。裁决：

1. **方向 A**：评估代次（epoch）身份 + CLI 幂等确认 + decision journal。staged 两阶段提交（撞 #543 裁决 3、命令面语义分裂）与纯脚本自幂等（幂等负担全压 hook 作者且缺可靠锚点）两方向废弃。
2. **概念分离**：#590 的防抖指纹回答「要不要发起新一轮评估」，评估代次回答「重放是否算同一次评估」——两个正交概念，不合一。
3. **I4 残留边界接受**：协议不承诺「评估恰好一次」——非确定性脚本同代次重放走不同分支产生的孤儿 corrections 引擎不撤销（append-only，与 #546 reopen 零状态重置同哲学），以审计可追溯 + 队列可见性交给 operator。

## 目标

gate 评估获得持久化的代次身份与消费状态机；CLI mutation 面在 gate 评估语境下获得确认式幂等（重放返回首次结果，零副作用）；script decision 自 stdout parse 成功起进入共享 journal，消费与其全部引擎侧效果原子；daemon 重启恢复不重复消费、不丢已判定的 decision。journal/consumer 必须保留精确的 typed ingress 扩展边界，使 #561 只能把 validator CLI admission 接入同一协议，而不能复制状态机。

## 使用场景

- gate 脚本经 CLI 插入 correction items 后崩溃/超时/输出非法：重问时脚本重跑，其重复的 CLI 调用被幂等确认吸收，队列不出现重复 correction items。
- daemon 在收到合法 decision 后、消费中途崩溃：重启后直接重消费已持久化的 decision，不重问对应判定主体——杜绝「corrections 已插入、reopen 判定丢失、判定主体改判 advance」的悬空路径。
- hook 作者写 gate 脚本时无需自造幂等：评估代次经环境变量注入、CLI 自动附加，脚本按直觉写「查状态 → 插队 → 返回 decision」即可安全重放。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-10 核实；行号实施前自行 grep 核对）。

- 防抖先例：`chainCompletionFingerprint` / `keepActiveTriggerStateApplies`（`src/scheduler.ts:1813-1919`）——指纹仅在 decision 成功返回 keep-active 时持久化（`:1837-1839`），崩溃走 catch（`:1842-1851`）不写状态；指纹输入含全量 items 布局，gate mutation 必然使其失配。
- CLI mutation 幂等现状：`item.add` 唯一防线是 `(chain, itemId)` 查重 → `duplicate_item` conflict（`src/daemon.ts:2224-2225`）；无 idempotency key / requestId 机制（全仓核实）。
- 事务面：状态存储每 op 一个 immediate transaction（`write()`，`src/sqlite-state.ts:1091-1097`）；`createItems` 是既有的「单事务内多写」先例（`src/sqlite-state.ts:1184-1185`）。
- evaluation scope 传递先例：script 子进程沿 `CODER_LOOP_RUN_CRED` 的 env→CLI 自动附加形态传递；validator leaf 则由 scheduler 在其 run 环境中注入同一 evaluation scope，validator 调用 mutation/decision CLI 时自动附加。scope 不是凭证，不改变 caller 主体与授权：script 仍是 operator，validator decision 仍走 #561 的 agent run 凭证与 default-deny admission；scope 只确定 `(决策点, epoch)` 幂等域。
- 重放保留语义：重问/retry 保留上一次 run 的全部 CLI 写入，无回滚 API——与 #546「副作用 append-only、零状态重置」一致。

## 问题

#589 的 script gate 与 #561 的 validator 都允许 hold 后重新执行、改判，但没有共同机制承接「重复执行 ⇒ 重复副作用」：判定主体在 mutation 落地后、decision ingress 成功前死亡时，重问会重放 mutation；decision 已准入后消费中途 daemon 崩溃时，判定可能丢失且评估状态无从恢复。script/stdout 与 validator/CLI 若各自补洞又会形成两套可靠性协议——mutation+decision 原子性必须收敛为 kind-specific ingress + shared journal/consumer。

## 预期结果

性质表述。四条可重放不变量是本 child 的核心契约：

1. **评估代次状态机**：每个 gate 决策点评估有持久化身份 `(决策点身份, epoch)`（决策点身份 = 决策点类型 × 宿主 chain/container/item/run id）；生命周期 `evaluating`（spawn 前 write-ahead 落状态）→ `decided`（kind-specific ingress 准入成功，decision 单事务持久化；script = stdout parse，validator = CLI default-deny admission）→ `consumed`（decision 效果落地，与效果同一事务）。崩溃/超时/非法或未授权 decision 停留在 `evaluating`；epoch 仅在 `consumed` 时递增。持久化不进 `chain.metadata`。
2. **I1 mutation 幂等**：evaluation scope 注入判定主体的执行环境；本 child 先覆盖 script，CLI mutation 自动附加为请求字段，#561 对 validator 复用同一字段与幂等域；幂等 key 从 `(evaluation scope, command, 规范化 args)` 派生。daemon admission 层 key 命中即返回首次 response 快照、零副作用；miss 时 mutation 与 key 记录同一事务。同一 epoch 内任一判定主体重放多次，每个逻辑 mutation 至多生效一次。
3. **I2 decision 消费原子**：每个 epoch 至多一个 decision 被准入并消费；typed ingress 只负责校验并写 journal，后续消费走同一实现。消费与全部引擎侧效果在单个状态存储事务内；重启时 `decided` 未消费则直接重消费、不重启对应判定主体，`evaluating` 残留则同 epoch 重问对应主体；滞后 mutation 被同 key 吸收，滞后 decision 被 epoch 与当前执行身份拒绝。
4. **I3 epoch 单调 + 与防抖指纹正交**：epoch 只在消费完成时递增，同 epoch 重放永不跨入下一代次的 key scope；hold consumed → epoch+1 + 记防抖指纹（下一 tick 指纹同则不问、变则新评估）；`evaluating` 残留的重问不查指纹、无条件重问。指纹本体形态归 #590，本 child 只钉两概念分离。
5. **I4 边界诚实与可追溯**：协议不承诺「评估恰好一次」；同 epoch 重放中非确定性脚本产生的不同 mutation 各自首次生效、可能残留孤儿 corrections，引擎不撤销、不判定「悬空」（业务语义，违反引擎零策略红线）；gate 评估语境下创建的 item 其 `item.created` 审计事件携带评估 scope 标识，operator 可追溯来源。
6. **普通 operator 路径零影响**：不携带评估 scope 的请求不进幂等分支，既有语义（含 `duplicate_item` conflict）逐字不变。

### 显式决策项（落地时裁，裁决留本 thread）

- 评估状态与 key→response 快照的存储 shape（同表带 kind 还是分表）与快照序列化边界——落地时按状态存储既有形态裁。
- 决策点闭集中无宿主 id 的点（daemon startup/shutdown、tick）的决策点身份构成——与 #590 的无上下文 payload 决策项对称，协调登记。

## 不应残留

- 本 child 范围内：拒绝式 conflict 冒充幂等确认（key 命中必须回放首次结果，不是报错）；mutation 执行与 key 记录分事务的任何窗口；decision 消费效果跨多个独立事务；epoch 在非 consumed 路径递增；按 decision kind 复制两套 journal/consumer；validator CLI decision 绕过 shared journal 直接推进容器。
- 本 issue 范围之外不应改动：decision 词表归 #546；script stdout parse 归 #589；validator CLI 准入门归 #561；防抖指纹本体与决策点闭集接线归 #590；reopen 执行三步本体归 #562；join script 派发归 #592；stdin payload shape 归 #587。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 统一判定契约文本以 #546 body 为唯一权威——本 child 不触词表。
- 评估 scope 注入值不构成凭证或新主体（#543 裁决 3 不动）。
- hook 执行不阻塞 daemon 主线程（#543 约束）。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | I1 崩溃重放 mutation 至多一次（预期结果 1+2） | fixture gate 脚本：`item add` 后立即自杀（不输出 decision）；观察退避重问后的第二次执行 | local | 第二次执行的同一 add 得首次 response 回放（key 命中事件可见）；items 无重复；epoch 未递增（同代次） |
| function | key 与 mutation 同事务（预期结果 2） | gate 脚本 `item add` 成功后，直接查状态存储 | local | item 行与幂等 key 记录同时在场；不存在只有其一的中间态 |
| function | I2 decided 重启恢复不重问（预期结果 3） | fixture 脚本返回 decision 后 daemon 被 kill -9（脚本 sleep 控制时机）；重启 daemon | local | decision 直接被消费，脚本不被重新 spawn；事件序列可证 |
| function | I2 evaluating 重启恢复同代次重问（预期结果 3） | 脚本执行中 kill -9 daemon；重启 | local | 同 epoch 重问；脚本重放的 mutation 被 key 吸收 |
| integration | 下游 ingress 扩展边界唯一 | 对 shared journal/consumer 的 typed ingress seam 做 contract test，再由 #561 的真实 validator CLI 验收继承该 seam | local | 本 child 只有一个 journal/consumer；新增 ingress 只能提交同一 decision ADT，不存在复制 consumer 的入口 |
| function | I3 hold 后 epoch 递增与指纹正交（预期结果 4） | 脚本首答 hold；下一 tick 上下文未变；随后改变上下文 | local | 上下文未变不重问（指纹命中）；变化后重问且为新 epoch（新 key scope，脚本新插入生效） |
| function | I4 审计可追溯（预期结果 5） | gate 脚本 `item add` 后 advance；查 `item.created` 审计事件 | local | 事件含评估 scope 标识字段 |
| function | operator 路径零影响（预期结果 6） | 无注入 env 的普通 `coder-loop item add` 同 itemId 两次 | local | 第二次仍 `duplicate_item` conflict，既有语义不变 |
| type | 评估状态机 ADT 穷尽 | `bun run typecheck`；临时向状态 union 加 variant 观察编译错误面 | local | 全部处置点报错，无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #589（script stdout ingress 与首个真实决策点宿主；本 child 以该路径落 shared journal/consumer）。
- Blocks: #561（validator CLI ingress 必须接入本 child 的 shared journal/consumer）、#593（hook 作者文档须含重放语义与幂等边界）、#592（join script 与 validator 汇入同一 consumer 后再做 script join 派发）。
- 下游接入边：#561 负责 validator run 注入 evaluation scope、CLI decision admission 写 shared journal，以及 validator 真实崩溃恢复验收；不得复制 consumer。协调边：#590（防抖指纹与评估代次两概念分离；chain-complete 先例的 `chain.metadata` 指纹存法收编迁移时与本 child 的评估状态持久化协调；无宿主决策点的身份构成对称登记）；#592/#562（script kind 的 reopen 派发三步与 `consumed` 标记的同事务性——#562 侧验收行已对应增补）；#587（评估代次走环境变量注入，不动 stdin payload shape，仅登记不冲突）。


---

## Comments (2)

### comment #4932102648 by `RiriAgent` — 2026-07-10T04:51:13Z


## 架构切片

1. **系统定位**：gate 执行器的可靠性层——#589 立起 decision 协议的语义面（parse/onFailure/合成），本 child 给同一执行器补齐故障半边：评估身份、mutation 重放安全、decision 持久化与消费原子、daemon 重启恢复。统一判定契约两 kind 中先落 script kind；agent-phase kind 的对称窗口（#561 通道下 agent 在 corrections 与 decision 写回之间崩溃）同根因，落地后由该侧按本协议形态收编，本 child 不越界。
2. **全局坐标**：hook 子进程域（不可信、可崩溃、可重放）→ CLI admission 域（幂等确认新增于此）→ 状态存储域（评估状态机 + key 快照 + 单事务消费）。零新增域边界——评估 scope 经既有 env 注入形态（`CODER_LOOP_RUN_CRED` 先例）进入既有 socket 命令面。
3. **类型↔值不漂移**：防值漂移——评估状态机若散落为 boolean/时间戳组合即无法穷尽恢复路径；`evaluating | decided | consumed` ADT 单一定义封死。防类型泄露——幂等 key 与快照是 admission 层内部事实，不泄进调度类型；防抖指纹与评估代次两概念不合一（操作员裁决 2026-07-10）。
4. **消除的错误类别**：「脚本崩溃重问导致重复 correction items」不可表达（同 epoch key 吸收）；「decision 已返回但 daemon 崩溃后凭空蒸发、脚本改判造成悬空」不可表达（decided write-ahead + 重消费）；「消费效果落地一半」不可表达（单事务）；「重放跨入新代次的 key scope」不可表达（epoch 仅 consumed 递增）。I4 明确不消除：非确定性脚本的孤儿 corrections 是接受的残留边界，以审计可追溯兜底。

## log/观测义务

- key 命中（重放吸收）事件：含评估 scope、命中的 command、首次记录时间——排障「脚本为什么没插进去」的第一入口。
- 评估状态转移（`evaluating`/`decided`/`consumed`）与重启恢复动作（重消费/同代次重问）经事件可见。
- gate 评估语境创建的 item 其 `item.created` 审计事件携带评估 scope 标识（I4 可追溯）。
- 新增事件类型经 `ObservabilityEventTypeBoundary` 编译期 union 扩张（#543 观测义务总表惯例）。



### comment #5007299620 by `RiriAgent` — 2026-07-17T20:41:12Z

重新拆分后与 #589/#590 一并由 #712 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (22)

- 2026-07-10T04:50:27Z `assigned` @RiriAgent
- 2026-07-10T04:50:50Z `parent_issue_added` @RiriAgent
- 2026-07-10T04:51:13Z `commented` @RiriAgent
- 2026-07-10T04:52:01Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-10T04:52:02Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-10T04:52:03Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-10T04:52:05Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-10T05:27:31Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-10T11:51:49Z `cross-referenced` @RiriAgentsrc=606
- 2026-07-10T17:21:26Z `cross-referenced` @RiriAgentsrc=564
- 2026-07-10T17:26:12Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-10T17:26:55Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-11T01:08:34Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-11T08:33:36Z `referenced` @RiriAgentcommit=6bad6fcea488533dd230d4a26548957ddf0eec69
- 2026-07-15T17:12:01Z `cross-referenced` @RiriAgentsrc=675
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:13:21Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:13:27Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:41:12Z `commented` @RiriAgent
- 2026-07-17T20:41:13Z `closed` @RiriAgentcommit=None
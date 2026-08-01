# #712 feat(engine): 共享 gate evaluation、script decision 与指纹协议

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:20Z  | updated: 2026-07-27T04:27:01Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/712
- comments: 0  | timeline events: 17

---

## Body

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

把 script gate 执行与 decision 协议、gate 决策点闭集接线、gate 评估代次与幂等协议这三个原先互相消费的面合并为一个 owner，交付 post-exit hold→重评估→advance 的可达路径；inspection/correction subtree 在 hold 下运行的综合场景后置到最终验收并依赖 #546 runtime。

script gate 在第一个决策点（run post-exit，下一次选择前）端到端成立：spawn（复用 hook 执行层）→ stdout decision JSON 边界 parse（三词 ADT + 可选 reason）→ onFailure 折叠 → 决策点消费（advance 放行 / hold 扣住退避重问）。

gate 决策点从单点（post-exit）扩到闭集全点：run pre-spawn、item 状态转移、daemon startup/shutdown、tick（带节流声明）；hold 幂等指纹从 chain-complete 先例泛化为通用机制并收编既有复用点；四层合成在全部决策点走同一代码路径。（容器推进/par join 与 chain-complete 两点经 #714（join script） 通道，分工见「不应残留」。）

gate 评估获得持久化的代次身份与消费状态机；CLI mutation 面在 gate 评估语境下获得确认式幂等（重放返回首次结果，零副作用）；script decision 自 stdout parse 成功起进入共享 journal，消费与其全部引擎侧效果原子；daemon 重启恢复不重复消费、不丢已判定的 decision。journal/consumer 必须保留精确的 typed ingress 扩展边界，使 #700 只能把 validator CLI admission 接入同一协议，而不能复制状态机。

## 问题

gate 类 hook 的全部语义（hold 调度决策、stdout decision 协议、onFailure）无任何机制——#543 关闭验证行 2（gate hold）与行 4（onFailure 两语义）无处成立。决策点闭集全量接线体量配不上单 PR：先在操作员验收场景所在的一个决策点把协议端到端立起来，其余点由闭集 child 按同一路径扩展。

post-exit 单点落地后，闭集其余决策点仍无 gate 能力——裁决 1「挂点清单以齐全为设计目标」未兑现；hold 指纹仍是 chain-complete 专用形态，两处复用点（本 issue 的 gate 执行、#700 的 validator）各自贴先例走，无通用机制；RFC 关闭验证行 5 的合成语义只在单点成立。

本 issue 的 script gate 与 #700 的 validator 都允许 hold 后重新执行、改判，但没有共同机制承接「重复执行 ⇒ 重复副作用」：判定主体在 mutation 落地后、decision ingress 成功前死亡时，重问会重放 mutation；decision 已准入后消费中途 daemon 崩溃时，判定可能丢失且评估状态无从恢复。script/stdout 与 validator/CLI 若各自补洞又会形成两套可靠性协议——mutation+decision 原子性必须收敛为 kind-specific ingress + shared journal/consumer。

## 预期结果

性质表述：

1. **决策点评估**：post-exit 决策点上，生效视图命中的 gate 逐层逐个执行（顺序 全局→chain→preset→item）；合成 = AND 放行——本决策点词表是 `advance | hold` 二词子集（非容器推进点无 seq 游标可退），任一 hold 即整点 hold，全 advance 才放行。
2. **decision 边界 parse**：脚本 stdout 输出 decision JSON（统一判定契约三词 + 可选 reason），arktype 边界 parse 为穷尽 union；非法输出（非 JSON、词表外值、本决策点收到 reopen）按该 hook 的 `onFailure` 处置并记 diagnostic + 审计事件，无静默放行、无 default 兜底。stdout 不承载 mutation。
3. **onFailure 语义（RFC 行 4）**：超时/崩溃/协议违规 → `hold`（决策点扣住、退避重问、事件可见）或 `advance`（记 diagnostic 后放行）。
4. **hold 语义（RFC 行 2）**：该 chain 的 post-exit 决策扣住——不选下一个 item；其他 chain 调度不受影响；退避重问时脚本重新执行、可改判；幂等防抖先复用 chain-complete fingerprint 先例形态（泛化机制即本 issue 的决策点闭集，落地后收编该复用点）。
5. **gate decision 可观测**：每次 decision 有 `hook.*` decision 事件（判定词 + reason）。
6. **引擎零策略语义**：放行/扣住的理由判断全在脚本内；引擎只执行协议。

### 非容器 reopen 裁决

声明只能约束挂点，不能证明任意脚本未来 stdout 不会输出 reopen，因此不伪造“装载期可证明脚本输出”的保证。非容器决策点的允许 decision boundary 是 `advance | hold`；若脚本实际输出 reopen，stdout boundary 将其判为 `decision_not_allowed_at_point`，记录 diagnostic，并严格按该 hook 已声明的 `onFailure = hold | advance` 处理。compile 仍负责拒绝把显式声明为 container-only 的 gate 绑定到非容器点；runtime boundary 负责不可信脚本输出。

性质表述：

1. **闭集全点物化**：#543 挂点清单中除容器推进/par join、chain-complete（归 #714（join script））外的全部决策点可挂 gate；每点评估走本 issue gate 执行面落地的同一协议路径（同一 parse/onFailure/合成代码），不存在每点一套的私有评估逻辑。
2. **闭集是穷尽类型**：gate 决策点为引擎内禀闭集 union；新增决策点由编译器暴露全部处置点（声明校验、评估接线、payload 触发上下文、事件字段）。
3. **tick 节流**：tick gate 必须显式声明正整数 `minIntervalMs`，无默认值；无该字段或非正值 compile 拒绝。每个有效声明独立记录上次 evaluation 完成时刻，达到间隔才可发起下一 epoch；不使用引擎魔法频率。
4. **hold 指纹泛化**：任一决策点的 hold 退避重问带幂等指纹防抖（同一决策上下文不重复问、上下文变化后重问）；chain-complete 先例被泛化机制收编——本 issue gate 执行面与 #700 的先例复用点迁移到通用机制，先例专用形态不残留。
5. **四层合成全点一致**：全局→chain→preset→item 顺序与 AND 放行在全部决策点由同一合成实现保证（RFC 行 5 的合成半边；preset 层份额随#713（具名 gate） 补全）。

### 决策点行为裁决

- **指纹**：每个 point variant 定义类型化 `FingerprintInput`，由决策点 identity、宿主稳定 identity、该点会影响的 canonical 状态投影、effective hook declaration hash 构成；不得 hash 全库偶然字段。canonical JSON hash 与最近 hold 一并存入本 issue 的 per-point evaluation store，不再写 `chain.metadata`。hold consumed 后，仅 fingerprint 改变才开新 epoch；崩溃残留 `evaluating` 同 epoch 重放不查 fingerprint。
- **item 状态转移**：同步 RPC 不悬挂。gate hold 时请求返回结构化 `gate_held`（含 point identity/reason/retry hint），mutation 零落地；调用方重试形成下一次候选评估。advance 才在同一请求继续 admission。
- **daemon startup**：socket/status 面先进入 `starting-held`，scheduler 不开始；按 backoff 重评，advance 后进入 ready。**shutdown** hold 时 daemon 进入 `shutdown-held`，停止接收新调度但保留 socket/status 与现有进程回收能力，重评至 advance；operator 的 OS hard kill 不经过 gate。**tick** hold 只跳过该 tick 的调度推进，daemon 继续存活；达到声明的 `minIntervalMs` 且 fingerprint 变化后才重评。
- **无 chain/item 上下文 payload**：使用 #710 同一 payload envelope，host variant 为 daemon，携带 daemon lifecycle facts、tick identity、effective declarations 与当次 status snapshot；不存在伪造的 chain/item id，也不另建匿名 payload shape。

性质表述。四条可重放不变量是本 child 的核心契约：

1. **评估代次状态机**：每个 gate 决策点评估有持久化身份 `(决策点身份, epoch)`（决策点身份 = 决策点类型 × 宿主 chain/container/item/run id）；生命周期 `evaluating`（spawn 前 write-ahead 落状态）→ `decided`（kind-specific ingress 准入成功，decision 单事务持久化；script = stdout parse，validator = CLI default-deny admission）→ `consumed`（decision 效果落地，与效果同一事务）。崩溃/超时/非法或未授权 decision 停留在 `evaluating`；epoch 仅在 `consumed` 时递增。持久化不进 `chain.metadata`。
2. **I1 mutation 幂等**：evaluation scope 注入判定主体的执行环境；本 child 先覆盖 script，CLI mutation 自动附加为请求字段，#700 对 validator 复用同一字段与幂等域；幂等 key 从 `(evaluation scope, command, 规范化 args)` 派生。daemon admission 层 key 命中即返回首次 response 快照、零副作用；miss 时 mutation 与 key 记录同一事务。同一 epoch 内任一判定主体重放多次，每个逻辑 mutation 至多生效一次。
3. **I2 decision 消费原子**：每个 epoch 至多一个 decision 被准入并消费；typed ingress 只负责校验并写 journal，后续消费走同一实现。消费与全部引擎侧效果在单个状态存储事务内；重启时 `decided` 未消费则直接重消费、不重启对应判定主体，`evaluating` 残留则同 epoch 重问对应主体；滞后 mutation 被同 key 吸收，滞后 decision 被 epoch 与当前执行身份拒绝。
4. **I3 epoch 单调 + 与防抖指纹正交**：epoch 只在消费完成时递增，同 epoch 重放永不跨入下一代次的 key scope；hold consumed → epoch+1 + 记防抖指纹（下一 tick 指纹同则不问、变则新评估）；`evaluating` 残留的重问不查指纹、无条件重问。指纹本体形态归本 issue 的 gate 执行面，此处只钉两概念分离。
5. **I4 边界诚实与可追溯**：协议不承诺「评估恰好一次」；同 epoch 重放中非确定性脚本产生的不同 mutation 各自首次生效、可能残留孤儿 corrections，引擎不撤销、不判定「悬空」（业务语义，违反引擎零策略红线）；gate 评估语境下创建的 item 其 `item.created` 审计事件携带评估 scope 标识，operator 可追溯来源。
6. **普通 operator 路径零影响**：不携带评估 scope 的请求不进幂等分支，既有语义（含 `duplicate_item` conflict）逐字不变。

### 显式决策项（落地时裁，裁决留本 thread）

- 评估状态与 key→response 快照的存储 shape（同表带 kind 还是分表）与快照序列化边界——落地时按状态存储既有形态裁。
- 决策点闭集中无宿主 id 的点（daemon startup/shutdown、tick）的决策点身份构成——与本 issue 的无上下文 payload 决策项对称，协调登记。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | gate hold（RFC 行 2） | chain 声明 post-exit gate（fixture 脚本首答 `hold` 次答 `advance`），真跑两 item 队列 | local | hold 期间不选下一 item、事件可见 hold 与退避重问；advance 后恢复选中 |
| function | onFailure 两语义（RFC 行 4） | 同挂点分别声明 `onFailure=hold` / `advance` 的必崩脚本 | local | hold：决策点扣住退避重问、事件可见；advance：diagnostic 后放行 |
| function | decision 边界 parse | fixture 脚本分别输出非 JSON、词表外值、reopen | local | 均按 onFailure 处置且 diagnostic/审计事件点名违规类别；无静默放行 |
| function | 多 gate AND 合成 | 同点两 gate：一 advance 一 hold | local | 合成 hold；改全 advance 后放行 |
| function | 检查 leaf 与 hold 因果闭环 | fixture gate 脚本在当前 evaluation scope 调 `coder-loop item add` 创建检查 leaf 后返回 hold；检查 leaf 完成后再返回 advance | local | item 创建成功且带稳定 evaluation/task identity；hold 期间原决策点不推进；完成后才恢复；stdout decision 不含 mutation 字段且不依赖 `(position,id)` 抢跑 |
| function | 其他 chain 不受影响 | 两 chain 一有 hold gate 一无，并行真跑 | local | 无 gate chain 照常推进 |
| type | decision ADT 穷尽 | `bun run typecheck`；临时向 decision union 加词观察编译错误面 | local | 全部处置点报错，无 default 吞掉 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | pre-spawn gate | 声明 pre-spawn gate（hold→advance），真跑 | local | spawn 被扣住、退避重问事件可见；advance 后 spawn 发生 |
| function | 状态转移 gate | 声明状态转移 gate，agent 真实写 status | local | hold 返回结构化 `gate_held` 且 mutation 零落地；重试后 advance 才写入生效，事件可见 |
| function | tick 节流 | 声明带节流 tick gate 观察执行节奏；声明无节流 tick gate | local | 前者按节流节奏执行（事件计数可证）；后者装载期拒绝 |
| function | daemon startup/shutdown gate | 各声明一个并先 hold 后 advance，起停 daemon | local | startup 显示 `starting-held` 且 scheduler 未启动；shutdown 显示 `shutdown-held` 且无新调度、socket可查；advance 后完成转移 |
| function | 指纹防抖泛化 | 任一点 hold 后同一决策上下文连续多 tick | local | 脚本不被重复 spawn（指纹命中）；上下文变化后重问 |
| function | 收编无残留 | 泛化落地后 grep chain-complete 指纹专用形态在 gate/join 复用点的残留 | local | 复用点全部走通用机制 |
| function | 四层合成顺序（RFC 行 5 直接声明层份额） | 全局+chain+item 同点各一 gate（脚本记录执行序），其中一层 hold | local | 执行顺序 全局→chain→item；合成 hold |
| type | 决策点闭集穷尽 | `bun run typecheck`；临时加决策点 variant 观察编译错误面 | local | 全处置点报错，无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | I1 崩溃重放 mutation 至多一次（预期结果 1+2） | fixture gate 脚本：`item add` 后立即自杀（不输出 decision）；观察退避重问后的第二次执行 | local | 第二次执行的同一 add 得首次 response 回放（key 命中事件可见）；items 无重复；epoch 未递增（同代次） |
| function | key 与 mutation 同事务（预期结果 2） | gate 脚本 `item add` 成功后，直接查状态存储 | local | item 行与幂等 key 记录同时在场；不存在只有其一的中间态 |
| function | I2 decided 重启恢复不重问（预期结果 3） | fixture 脚本返回 decision 后 daemon 被 kill -9（脚本 sleep 控制时机）；重启 daemon | local | decision 直接被消费，脚本不被重新 spawn；事件序列可证 |
| function | I2 evaluating 重启恢复同代次重问（预期结果 3） | 脚本执行中 kill -9 daemon；重启 | local | 同 epoch 重问；脚本重放的 mutation 被 key 吸收 |
| integration | 下游 ingress 扩展边界唯一 | 对 shared journal/consumer 的 typed ingress seam 做 contract test，再由 #700 的真实 validator CLI 验收继承该 seam | local | 本 child 只有一个 journal/consumer；新增 ingress 只能提交同一 decision ADT，不存在复制 consumer 的入口 |
| function | I3 hold 后 epoch 递增与指纹正交（预期结果 4） | 脚本首答 hold；下一 tick 上下文未变；随后改变上下文 | local | 上下文未变不重问（指纹命中）；变化后重问且为新 epoch（新 key scope，脚本新插入生效） |
| function | I4 审计可追溯（预期结果 5） | gate 脚本 `item add` 后 advance；查 `item.created` 审计事件 | local | 事件含评估 scope 标识字段 |
| function | operator 路径零影响（预期结果 6） | 无注入 env 的普通 `coder-loop item add` 同 itemId 两次 | local | 第二次仍 `duplicate_item` conflict，既有语义不变 |
| type | 评估状态机 ADT 穷尽 | `bun run typecheck`；临时向状态 union 加 variant 观察编译错误面 | local | 全部处置点报错，无 default 兜底 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：scheduler 决策面的 gate 评估级——在「run 终结 → 下一次选择」之间插入一个可编程放行点；decision 协议（stdout JSON 边界 parse + onFailure 折叠）是 script kind 判定器的执行器本体，与 #700 的 agent-phase 判定通道（CLI 写回）互为统一判定契约的两个 kind 实现。
2. **全局坐标**：hook 子进程域（不可信 stdout 字节）→ arktype 边界 parse → 引擎 typed decision 域 → 调度决策消费。入站信任升格点恰好一个（parse）；mutation 不走此边界（走既有 CLI 命令面，复用其校验与审计）。
3. **类型↔值不漂移**：防值漂移——decision 词表若在 parse 侧与消费侧各自定义即失同步；穷尽 union 单一定义封死。防类型泄露——非容器决策点的 `advance | hold` 子集限制以类型/校验表达，不靠散文约定。
4. **消除的错误类别**：「脚本输出垃圾被静默当放行」不可表达（边界 parse + onFailure，无 default）；「stdout 夹带 mutation 被引擎代执行」不可表达（decision schema 无 mutation 位，mutation 只经 CLI）；「一个 chain 的 hold 拖住别的 chain」不可表达（hold 作用域 = 该决策点）。

1. **系统定位**：scheduler/daemon 决策面的 gate 接线全集级——把本 issue gate 执行面立起的单点协议推广为「决策点闭集 × 同一协议」的乘积结构；hold 指纹泛化是该结构的持久化伴生件（决策点通用的幂等防抖）。
2. **全局坐标**：引擎调度域内部改造（各决策点 → 统一 gate 评估入口）；无新增域边界——decision 边界 parse 已由本 issue 的 gate 执行面拥有，本 child 只扩接线面。
3. **类型↔值不漂移**：防值漂移——各决策点若各自实现评估即协议行为漂移；单一评估路径封死。防类型泄露——决策点闭集是引擎内禀 union，不得以字符串散名出现在声明/事件/payload 中各自维护。
4. **消除的错误类别**：「某决策点的 gate 行为与其他点不一致」不可表达（同一路径）；「hold 重问风暴」不可表达（指纹防抖全点生效）；「tick gate 每秒轰炸」不可表达（节流声明装载期强制）。

1. **系统定位**：gate 执行器的可靠性层——本 issue 的 gate 执行面立起 decision 协议的语义面（parse/onFailure/合成），本 child 给同一执行器补齐故障半边：评估身份、mutation 重放安全、decision 持久化与消费原子、daemon 重启恢复。统一判定契约两 kind 中先落 script kind；agent-phase kind 的对称窗口（#700 通道下 agent 在 corrections 与 decision 写回之间崩溃）同根因，落地后由该侧按本协议形态收编，本 child 不越界。
2. **全局坐标**：hook 子进程域（不可信、可崩溃、可重放）→ CLI admission 域（幂等确认新增于此）→ 状态存储域（评估状态机 + key 快照 + 单事务消费）。零新增域边界——评估 scope 经既有 env 注入形态（`CODER_LOOP_RUN_CRED` 先例）进入既有 socket 命令面。
3. **类型↔值不漂移**：防值漂移——评估状态机若散落为 boolean/时间戳组合即无法穷尽恢复路径；`evaluating | decided | consumed` ADT 单一定义封死。防类型泄露——幂等 key 与快照是 admission 层内部事实，不泄进调度类型；防抖指纹与评估代次两概念不合一（操作员裁决 2026-07-10）。
4. **消除的错误类别**：「脚本崩溃重问导致重复 correction items」不可表达（同 epoch key 吸收）；「decision 已返回但 daemon 崩溃后凭空蒸发、脚本改判造成悬空」不可表达（decided write-ahead + 重消费）；「消费效果落地一半」不可表达（单事务）；「重放跨入新代次的 key scope」不可表达（epoch 仅 consumed 递增）。I4 明确不消除：非确定性脚本的孤儿 corrections 是接受的残留边界，以审计可追溯兜底。

## log/观测义务

- 新增 `hook.*` gate decision 事件（decision kind 建议 `decision`，与 #411 五 kind 对齐）：含 hook 标识、决策点、判定词、reason。
- 协议违规/超时/崩溃：diagnostic + 审计事件，点名违规类别——与既有 `invalid_request` 审计契约同风格。
- hold 扣住状态经 status 快照 hooks 节可见（#586（声明模型） 的 hooks 节承载，本 child 填充 hold 运行态字段）。

- 每决策点评估沿本 issue gate 执行面的 `hook.*` decision 事件契约，事件含决策点标识（闭集 union 值）。
- hold 扣住/重问/指纹命中经事件可见（重问节奏可从事件流重建——排障「为什么这个 chain 不动了」的第一入口）。
- status 快照 hooks 节的 hold 运行态字段覆盖全部决策点。

- key 命中（重放吸收）事件：含评估 scope、命中的 command、首次记录时间——排障「脚本为什么没插进去」的第一入口。
- 评估状态转移（`evaluating`/`decided`/`consumed`）与重启恢复动作（重消费/同代次重问）经事件可见。
- gate 评估语境创建的 item 其 `item.created` 审计事件携带评估 scope 标识（I4 可追溯）。
- 新增事件类型经 `ObservabilityEventTypeBoundary` 编译期 union 扩张（#543 观测义务总表惯例）。

## 依赖关系

- Depends on: #586、#710。
- Blocks: #713、#714、#715、#719、#740。



---

## Comments (0)

---

## Timeline (17)

- 2026-07-17T20:36:21Z `assigned` @RiriAgent
- 2026-07-17T20:38:27Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:38:31Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:38:33Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:38:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:39:06Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:39:35Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:02Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-17T20:41:05Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-17T20:41:13Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-17T20:41:59Z `cross-referenced` @RiriAgentsrc=555
- 2026-07-26T16:13:55Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-26T16:13:57Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-26T16:13:59Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-26T16:15:00Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-26T23:49:08Z `cross-referenced` @RiriAgentsrc=711
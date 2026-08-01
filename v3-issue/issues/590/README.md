# #590 feat(scheduler): gate 决策点闭集接线——全点物化、tick 节流与 hold 指纹泛化

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:49Z  | updated: 2026-07-17T20:41:04Z
- closed: 2026-07-17T20:41:04Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/590
- comments: 2  | timeline events: 26

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）。继承条款逐字快照：

> "**hook 点粒度**：「生命周期尽可能齐全，挂钩点够多，是哪个这是运行时的事情」——引擎不预判最小集，挂点清单以齐全为设计目标，用哪个由使用者声明时决定。" — #543 设计裁决 1

> "gate 决策点是引擎内禀闭集（与事件枚举分列）：至少含 run pre-spawn、run post-exit（下一次选择前）、item 状态转移、容器推进/par join（#546 判定点）、chain-complete（吸收现有 trigger 先例；#546 定性为顶层 join 实例）、daemon startup/shutdown、tick（须带节流声明才可挂）。" — #543 核心设计·两类 hook

> "gate hold 后的重问需幂等防抖——chain-complete trigger 的 fingerprint 机制（`chain.metadata` 持久化 keep-active 指纹）是既有先例，具体形态归实现 child。" — #543 执行模型

> "同一挂点多层命中时全部执行，顺序 全局 → chain → preset → item；gate decision 合成为「任一非 advance 即不放行」（AND 放行）" — #543 声明位与合成语义

#561（#546 树，join 评估）的收编约定逐字：

> "hold 的既有先例：chain-complete trigger 的 keep-active + fingerprint 幂等（`src/scheduler.ts:1784-1851`、`chainCompleteTriggerState`）。重问节奏/防抖指纹泛化归 #590；validator 在 CLI 写 decision 前后发生 mutation 或崩溃时的重放安全、decision journal 与原子消费归 #599。本 child 不另造第二套代次/幂等协议，#599 落地后按同一 evaluation epoch 接入。" — #561 上下文

## 目标

gate 决策点从单点（post-exit）扩到闭集全点：run pre-spawn、item 状态转移、daemon startup/shutdown、tick（带节流声明）；hold 幂等指纹从 chain-complete 先例泛化为通用机制并收编既有复用点；四层合成在全部决策点走同一代码路径。（容器推进/par join 与 chain-complete 两点经 #592（join script） 通道，分工见「不应残留」。）

## 使用场景

- pre-spawn gate：spawn 前最后放行点（资源检查、预算控制脚本）。
- item 状态转移 gate：状态写入决策的旁路判定。
- daemon startup/shutdown、tick gate：daemon 级生命周期/周期自动化；tick 挂点带节流声明防每秒轰炸。
- hook 作者在任一决策点面对同一协议（decision/onFailure/合成）——学一次到处用。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- 决策点位置锚点：pre-spawn = `spawnSchedulerRun`（`src/scheduler.ts:921`）入口前；item 状态转移 = `admitItemStatusForRequest`（`src/daemon.ts:3048`）准入语境；daemon startup/shutdown = daemon 生命周期区段（`src/daemon.ts:855-1110`）；tick = `setInterval` 循环（`src/daemon.ts:2862`）+ 单飞机制（`src/daemon.ts:823`、`:2867-2878`）。
- fingerprint 先例：`chainCompleteTriggerState`（`src/runtime-data.ts:454`）+ `coderLoopChainCompleteTrigger` metadata 字段（`src/runtime-data.ts:118`）；#589（gate 执行） 与 #561 各有一处「先复用先例」点，泛化后由本 child 收编。
- 协议路径：#589（gate 执行） 落地的 decision parse / onFailure / AND 合成——本 child 复用同一路径接线新点，不复制。

## 问题

post-exit 单点落地后，闭集其余决策点仍无 gate 能力——裁决 1「挂点清单以齐全为设计目标」未兑现；hold 指纹仍是 chain-complete 专用形态，两处复用点（#589（gate 执行）、#561）各自贴先例走，无通用机制；RFC 关闭验证行 5 的合成语义只在单点成立。

## 预期结果

性质表述：

1. **闭集全点物化**：#543 挂点清单中除容器推进/par join、chain-complete（归 #592（join script））外的全部决策点可挂 gate；每点评估走 #589（gate 执行） 落地的同一协议路径（同一 parse/onFailure/合成代码），不存在每点一套的私有评估逻辑。
2. **闭集是穷尽类型**：gate 决策点为引擎内禀闭集 union；新增决策点由编译器暴露全部处置点（声明校验、评估接线、payload 触发上下文、事件字段）。
3. **tick 节流**：tick gate 必须显式声明正整数 `minIntervalMs`，无默认值；无该字段或非正值 compile 拒绝。每个有效声明独立记录上次 evaluation 完成时刻，达到间隔才可发起下一 epoch；不使用引擎魔法频率。
4. **hold 指纹泛化**：任一决策点的 hold 退避重问带幂等指纹防抖（同一决策上下文不重复问、上下文变化后重问）；chain-complete 先例被泛化机制收编——#589（gate 执行） 与 #561 的先例复用点迁移到通用机制，先例专用形态不残留。
5. **四层合成全点一致**：全局→chain→preset→item 顺序与 AND 放行在全部决策点由同一合成实现保证（RFC 行 5 的合成半边；preset 层份额随#591（具名 gate） 补全）。

### 决策点行为裁决

- **指纹**：每个 point variant 定义类型化 `FingerprintInput`，由决策点 identity、宿主稳定 identity、该点会影响的 canonical 状态投影、effective hook declaration hash 构成；不得 hash 全库偶然字段。canonical JSON hash 与最近 hold 一并存入 #599 的 per-point evaluation store，不再写 `chain.metadata`。hold consumed 后，仅 fingerprint 改变才开新 epoch；崩溃残留 `evaluating` 同 epoch 重放不查 fingerprint。
- **item 状态转移**：同步 RPC 不悬挂。gate hold 时请求返回结构化 `gate_held`（含 point identity/reason/retry hint），mutation 零落地；调用方重试形成下一次候选评估。advance 才在同一请求继续 admission。
- **daemon startup**：socket/status 面先进入 `starting-held`，scheduler 不开始；按 backoff 重评，advance 后进入 ready。**shutdown** hold 时 daemon 进入 `shutdown-held`，停止接收新调度但保留 socket/status 与现有进程回收能力，重评至 advance；operator 的 OS hard kill 不经过 gate。**tick** hold 只跳过该 tick 的调度推进，daemon 继续存活；达到声明的 `minIntervalMs` 且 fingerprint 变化后才重评。
- **无 chain/item 上下文 payload**：使用 #587 同一 payload envelope，host variant 为 daemon，携带 daemon lifecycle facts、tick identity、effective declarations 与当次 status snapshot；不存在伪造的 chain/item id，也不另建匿名 payload shape。

## 不应残留

- 本 child 范围内：任一决策点的私有评估逻辑（必须同一协议路径）；chain-complete 专用指纹形态在泛化收编后残留；无节流 tick gate 的任何通路。
- **闭包转移边不进决策点闭集**（#546 body「资源模型公理」节 + 权威记录 `v3/closure-lifecycle-decision.md` §2「hook 挂点」）：`closure.create` / `run-spawn` / `run-exit` / `suspend` / `reopen` / `consume` 六事件是 **observer-only**（词表扩充归 #586），不得作为新 gate 决策点 variant 进入闭集 union；hold 指纹泛化机制不覆盖转移边（副作用上放 gate = 发明第二推进语义，边界 1 打回项）。要阻止某闭包挂起，正确形态见 #589 「run post-exit gate hold 承载」——推进被扣住，闭包自然不挂起。
- 本 issue 范围之外不应改动：容器推进/par join 与 chain-complete 的接线（归 #592（join script）；chain-complete 声明位迁移归 #566）；具名 gate 绑定解析（归#591（具名 gate））；#561 join 评估本体（只收编其指纹复用点，收编动作与 #561 协调提交）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- hook 执行不阻塞 daemon 主线程；tick 点评估不得破坏 tick 单飞机制。
- 统一判定契约文本以 #546 body 为唯一权威。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

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

## 依赖关系

- Depends on: #589（gate 执行）（协议路径与首点先例）。
- Blocks: #591（具名 gate）、#592（join script）、#593（收尾）。
- 协调边：#599（评估代次与幂等协议——指纹/代次两概念分离、评估状态持久化协调、无宿主决策点的身份构成对称登记）；#561（其 hold 指纹先例复用点由本 child 泛化后收编——跨树协调提交）；#566（chain-complete 决策点经 #592（join script） 通道，本 child 不接线）；#587（payload 契约）（无上下文决策点的 payload 形态，双侧决策项对称登记）；#559（树调度——pre-spawn/推进面重叠，无硬依赖，先合者定接线形态、后合者 rebase 并在 PR 说明）。


---

## Comments (2)

### comment #4866576286 by `RiriAgent` — 2026-07-02T14:01:33Z


## 架构切片

1. **系统定位**：scheduler/daemon 决策面的 gate 接线全集级——把 #589（gate 执行） 立起的单点协议推广为「决策点闭集 × 同一协议」的乘积结构；hold 指纹泛化是该结构的持久化伴生件（决策点通用的幂等防抖）。
2. **全局坐标**：引擎调度域内部改造（各决策点 → 统一 gate 评估入口）；无新增域边界——decision 边界 parse 已由 #589（gate 执行） 拥有，本 child 只扩接线面。
3. **类型↔值不漂移**：防值漂移——各决策点若各自实现评估即协议行为漂移；单一评估路径封死。防类型泄露——决策点闭集是引擎内禀 union，不得以字符串散名出现在声明/事件/payload 中各自维护。
4. **消除的错误类别**：「某决策点的 gate 行为与其他点不一致」不可表达（同一路径）；「hold 重问风暴」不可表达（指纹防抖全点生效）；「tick gate 每秒轰炸」不可表达（节流声明装载期强制）。

## log/观测义务

- 每决策点评估沿 #589（gate 执行） 的 `hook.*` decision 事件契约，事件含决策点标识（闭集 union 值）。
- hold 扣住/重问/指纹命中经事件可见（重问节奏可从事件流重建——排障「为什么这个 chain 不动了」的第一入口）。
- status 快照 hooks 节的 hold 运行态字段覆盖全部决策点。



### comment #5007298749 by `RiriAgent` — 2026-07-17T20:41:04Z

重新拆分后与 #589/#599 一并由 #712 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (26)

- 2026-07-02T12:02:50Z `assigned` @RiriAgent
- 2026-07-02T14:00:51Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-02T14:00:54Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T14:00:57Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-02T14:00:58Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-02T14:00:59Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:19Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:33Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:02:27Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-05T07:48:27Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-10T04:50:27Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-10T11:18:02Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-11T01:10:41Z `cross-referenced` @RiriAgentsrc=555
- 2026-07-13T03:46:47Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-13T05:51:25Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:24Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:36:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:37:25Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:41:04Z `commented` @RiriAgent
- 2026-07-17T20:41:05Z `closed` @RiriAgentcommit=None
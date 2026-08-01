# #561 feat(engine): par join 评估与 validator 判定通道——drain / validator 与 advance | hold | reopen

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T11:15:48Z  | updated: 2026-07-17T20:14:54Z
- closed: 2026-07-17T20:14:54Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/561
- comments: 1  | timeline events: 38

---

## Body

## 必须先读的关联 issue

#546（RFC: v3 任务模型）。统一判定契约的唯一权威文本是 #546 body「join 策略与验证者判定」节（与 #543 的 script gate 共用；两树 children 引用同一文本，不复制不改写、不在各自 body 重新定义语义），逐字引用：

> ```
> decision ::= advance                       -- 放行，外层 seq 推进
>            | hold                          -- 暂不放行，退避后重问（keep-active 语义）
>            | reopen(target, correctionItemIds) -- 退回并精确引用已创建的纠正 item
>              target      ::= self | 同一 seq 内更早的兄弟节点
>              correctionItemIds ::= 同 evaluation scope 下先经 CLI 创建、属于 target 的 item stable id，≥1
> ```

> "验证者是普通 leaf（item+preset 调用），判定经 CLI 写回，走 #397 default-deny 准入门形态（判定词表由 preset 声明，无 stdout 解析）" — #546 body「join 策略与验证者判定」

> "`hold` 承接 #543 操作员裁决 2 与 chain-complete keep-active 先例……hold 的重问节奏/幂等指纹机制归 #543（fingerprint 先例）。" — #546 body「join 策略与验证者判定」

> "错误向上归 join 消化：子任务失败（exhausted 等非 success 终态）不自动传播；由所在 par 的 join 策略处置——drain 照常放行（终态即完成），validator 看得见失败并可 reopen。" — #546 body「取消与错误传播」

> "select/race 不设一等组合子：它是 `par + best-of-n join` 的组合，待 `best-of-n` 按 variant 准入纪律引入时自然获得。" — #546 body「取消与错误传播」

供给条款 3（seq 流转，2026-07-10 修订，权威记录 `v3/closure-lifecycle-decision.md` §3）逐字快照——本 child 判定契约按此钉住合并真相的**流转位置**：

> "**seq 流转**：worktree 之间无依赖关系，只有并发时等待问题——前驱需被构建于其上的工作已合入 base（不然不流转）；引擎不执法——合并真相是 GitHub 面事实，经声明通道由 preset 判定器（validator/script 自查）按 `advance\|hold\|reopen` 消费；引擎零产物传递机制；引擎级 mergedness gate 出局" — #546 body「供给条款」#3

## 目标

par 容器的 validator 判定通道：汇合时 spawn 验证者 leaf、判定经 CLI 写回准入门；hold 使容器退避重问；失败终态归 join 消化。（drain 的结构性放行已随 #559（树调度）落地——全成员 terminal 即容器 terminal；本 child 建的是「需要判定」的那半边，并保证 validator 机制不破坏 drain 语义。）

## 使用场景

并行任务的质量门。operator 在 par 上声明 `join = validator(item 调用声明)` 后，全部分支 terminal 时引擎自动 spawn 验证者 agent；验证者先通过带 evaluation scope 的 CLI 创建所需 correction items，再写 `advance`/`hold`/`reopen(target, correctionItemIds)` 决定容器放行、扣住或退回。drain 容器则零判定直通。reopen 的执行归 #562（reopen 执行），本 child 只接收判定并派发。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`。基线 main，行号实施前自行 grep 核对。
- default-deny 准入门先例：`admitItemStatusForRequest`（`src/daemon.ts:3048`）——词表 + phase exits 双重校验、品牌类型、每判定一条审计事件（#397）。判定写回通道按同形态新建/扩展。
- hold 的既有先例：chain-complete trigger 的 keep-active + fingerprint 幂等（`src/scheduler.ts:1784-1851`、`chainCompleteTriggerState`）。重问节奏/防抖指纹泛化归 #590；validator 在 CLI 写 decision 前后发生 mutation 或崩溃时的重放安全、decision journal 与原子消费归 #599。本 child 不另造第二套代次/幂等协议，#599 落地后按同一 evaluation epoch 接入。
- CLI 用法向 agent prompt 注入的先例：`phaseExitsEpilogue`（`src/loop.ts:5320` 附近）——验证者 leaf 需要同型的判定用法注入。
- 命令鉴权分级：`DaemonCommandAuthClass` 四类（`src/daemon.ts:127`），新判定命令进编译期穷尽分类（#409）。
- 树运行态 shape（本树地基 child）持久化 join 声明 ADT 与容器状态。
- **合并真相的流转位置（供给条款 3）**：v2 曾方向性探讨过「引擎注入 mergedness 进判定 payload」，边界 1 会话对抗后被显式打回（`v3/closure-lifecycle-decision.md` §5——引擎理解 GitHub 字段违反 L1 红线，且 squash merge 杀可达性、v2 自建分支恒假阳性使引擎级 mergedness 判据不可靠，见同报告 §4）。v3 定案：合并真相是 GitHub 面事实，由 preset 判定器（validator/script）**自查** GitHub 面（`gh pr view`、mergedAt/mergeCommit 等已有 review 流程消费的字段），按 `advance | hold | reopen` 写回；引擎侧零 mergedness 判据、零 GitHub 字段注入、零产物传递。**引擎级 mergedness gate 永久出局**——本 child 的 validator 契约在此前提上建立。

## 问题

引擎没有容器汇合概念；唯一 join 形态先例（chain-complete trigger）判定走 stdout 解析（`FINALIZER SUMMARY`，v3 定为退役、归 #566（chain 层声明位））；没有「引擎按声明 spawn 验证者并接收其 CLI 判定」的机制；失败终态（exhausted）无容器消化层——#546 行 11（hold）与错误归 join 的语义无处成立。

## 汇总判定权契约

本 issue 必须把「收集什么」与「谁能判定」分开：

- 引擎只确定性收集当前 evaluation 的 child outcome vector，并以 evaluation identity 冻结本次判定输入；不得从 status/terminal 字面量推导业务成功。
- `drain` 的判定主体是引擎内建结构谓词“全部成员 terminal”；它只回答结构是否排空。
- `validator(item 调用声明)` 的判定主体是该声明实例化出的 validator leaf；本轮 v3 由 #592 加入的 `script` variant，其主体是具名 script gate。
- 判定主体在 evaluation epoch 创建（#599 write-ahead `evaluating`）时对容器 join 绑定**采样并冻结**进 evaluation identity——同 epoch 内（含崩溃重问、validator 重 spawn）主体不换；join 绑定演化归 #564（仅物化容器，对在途 epoch 零影响，`v3/join-evolution-decision.md`）。
- 推进判定权 = 当前 evaluation 绑定的判定主体 ∪ **operator 显式 override**（`v3/join-evolution-decision.md` 裁决 5）：operator 可对当前 epoch 经同一准入门显式写 `advance | hold | reopen`，独立审计词条，消费语义与主体判定一致；override 只作用于该 epoch，join 绑定与下一 epoch 判定主体不变。普通 child、GUI、observer 与 scheduler 其他路径均无判定权。
- 判定输入必须携带主体身份、宿主容器、evaluation identity 和完整 outcome vector；#599 负责重放可靠性，不得另造判定权来源。

## 预期结果

- 性质：join=validator 的 par 容器，全部成员 terminal 时引擎 spawn 验证者 leaf（item+preset 调用声明取自容器 join 字段），容器保持不推进直到判定到达；join=drain 的容器维持 #559（树调度）落地的结构性放行，validator 机制的引入不给它加任何判定等待或失败特殊分支。
- 验证者判定经 CLI 写回：走 default-deny 准入门（判定词表由 preset 声明；无授权主体/词表外值被拒并留审计事件）；引擎零新增 stdout 解析。
- 三词派发：`advance` → 外层 seq 推进；`hold` → 容器不推进不退回、该决策点退避后重新评估（重问时 validator 重新裁决，可改判）、防抖归 #590；同一评估代次内 validator 崩溃重放的 mutation/decision 安全继承 #599（不重复 mutation、不丢或重复消费已持久化 decision）；`reopen(target, correctionItemIds)` → 校验精确 IDs 后转交 reopen 执行（#562）——其落地前引擎对 reopen 判定**显式拒绝**（错误信息点名未支持），不静默吞掉、不留半执行状态。
- join ADT 穷尽处置：本 child 落地时封闭 union 仅含 `drain | validator`、无占位 variant，全部消费点穷尽 switch、无 default 兜底吞掉；本轮 v3 的 #592 随后按 #547 variant 准入纪律把 `script` 连同全部处置点一次加入，`best-of-n` 仍是未来方向。
- 失败归 join：par 成员非 success 终态不自动传播——drain 照常放行；validator 的判定输入可见失败成员。
- **合并真相由 preset 判定器自查（供给条款 3）**：validator prompt / CLI 契约中，合并/发布等 GitHub 面事实的获取由验证者 leaf 自身经声明通道（`gh pr view` 等）读取，引擎不代查、不注入；validator 写回的三词判定即消费结论（`advance` = 合并/发布/满足；`hold` = 未收敛需重问；`reopen` = 需纠正）。
- **operator 一次性判定 override**：operator 对当前 epoch 经同一准入门显式写 decision——生效与消费语义同主体判定、独立审计词条；join 绑定不变、下一 epoch 判定主体照旧。承接「一次性放行/否决」的运维需求（如定义态 validator 坏死解卡），不动程序文本。

## 不应残留

- 本 child 范围内：判定词表字面量驻留引擎业务绑定（词表归 preset 声明）；join 评估的 default 兜底分支；任何新增 stdout 控制信号；**引擎向 validator 判定 payload 注入 mergedness / mergeCommit / mergedAt / GitHub 字段的任何路径**（供给条款 3 打回：引擎级 mergedness gate 出局，合并真相由 preset 判定器自查 GitHub 面消费）。
- 本 issue 范围之外不应改动：不实现 reopen 的游标回退/纠正追加（归 #562（reopen 执行））；不迁移 chain-complete trigger（归 #566（chain 层声明位））；不实现 script 判定器执行机制（归 #543）；不动 join 绑定演化的写通道与授权（归 #564（物化容器判定权演化））。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。
- 统一判定契约文本以 #546 body 为唯一权威（上引），本 child 的实现与文档不得改写或另立第二套词表。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | drain 语义不被破坏（回归） | par(2 leaf，一成功一耗尽 attempts 落 exhausted)，join=drain，真跑 | local | 全员 terminal 后容器结构性放行、外层 seq 推进；失败不上溯、无判定等待 |
| function | validator spawn 与 advance | par 声明 validator，成员全 terminal 后观察；validator preset 写 advance | local | 引擎自动 spawn 验证者 leaf；advance 后外层 seq 推进 |
| function | hold（#546 行 11） | validator 对未收敛 par 写 `hold`，之后再次评估时改写 `advance` | local | hold 后容器不推进不退回、事件可见退避重问；下次判定 advance 生效 |
| function | 判定准入门 | validator run 写词表外判定值；无凭证主体写判定 | local | 均被拒；每次判定尝试有审计事件 |
| function | reopen 派发边界 | #562 落地前 validator 写 reopen | local | 显式拒绝且错误点名未支持（非静默）；#562 落地后此行由其验收接管 |
| function | validator 可见失败成员 | par 含 exhausted 成员时 validator 的判定输入 | local | 失败成员及其终态对验证者可见（判定输入/可查询面中呈现） |
| function | validator mutation 崩溃重放 | validator leaf 经 CLI item add 后、decision CLI 前立即退出；观察同 epoch 重问 | local | validator 重新 spawn；重复 mutation 由 #599 幂等确认吸收；items 无重复、epoch 未递增 |
| function | validator decision 崩溃恢复 | 合法 CLI decision 写入 #599 journal 后、消费提交前 kill -9 daemon；重启 | local | 直接消费已持久化 decision；不重新 spawn validator；容器效果仅一次 |
| function | operator override（预期结果 7） | operator 凭证对未收敛 par 的当前 epoch 写 advance；agent 凭证模仿同请求 | local | operator 写经准入门生效 + 独立审计词条，容器推进，join 绑定与下一 epoch 主体不变；agent 凭证被拒 |
| function | epoch 采样冻结 | evaluation 进行中经 #564 通道追加新绑定后同 epoch 崩溃重问 | local | 重问仍按 epoch 记录采样的旧绑定；下一 epoch 才用新绑定（与 #564 侧验收互证） |
| assumption | 引擎零 mergedness 注入（供给条款 3） | `grep -rn "mergedAt\|mergeCommit\|mergedness\|merge_state" src/ --include="*.ts"` 后人工核对：validator prompt 组装、判定 payload 组装、join 评估路径 | local | 引擎侧无向 validator prompt / 判定 payload 注入 GitHub 面字段的路径；合并真相在 preset 判定器 prompt/CLI 命令中经 `gh` 自查获得 |
| assumption | 零 stdout 判定 | `grep -rn "FINALIZER SUMMARY\|stdout" src/ --include="*.ts" -l` 后人工核对判定路径 | local | 本 child 新增判定路径无 stdout 解析（chain-complete 既有解析的退役归 #566（chain 层声明位），不在本行） |
| type | join ADT 穷尽 | `bun run typecheck`；临时向 join union 加一个 variant 观察编译错误面 | local | typecheck 通过；新增 variant 使全部处置点编译报错（无 default 吞掉） |

## 依赖关系

- Depends on: #558（树运行态 shape，join 声明持久化）、#559（树调度，par 推进语义）、#599（validator 与 script 共用的 evaluation epoch、decision journal 与 consumer；本 child 只提供 CLI ingress 与宿主）。
- Blocks: #562（reopen 执行）、#564（物化容器 join 判定权演化）、#566（chain 层声明位）。
- Relates to: #589 / #590 / #592（#543 children，统一判定契约的执行器机制侧——script spawn 与 stdout decision 归 #589、防抖 fingerprint 泛化归 #590、容器点 script kind 归 #592；validator 接入 #599 的同一协议，不另立语义）。


---

## Comments (1)

### comment #5007117394 by `RiriAgent` — 2026-07-17T20:14:53Z

重新拆分后由 #700 承接共享 decision core 与 validator join。旧 issue 没有关联 PR，按 #546 重拆结果关闭。


---

## Timeline (38)

- 2026-07-02T11:15:49Z `assigned` @RiriAgent
- 2026-07-02T11:18:16Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-02T11:18:22Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-02T11:18:22Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-02T11:18:24Z `cross-referenced` @RiriAgentsrc=564
- 2026-07-02T11:18:25Z `cross-referenced` @RiriAgentsrc=565
- 2026-07-02T11:18:27Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-02T11:18:28Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-02T11:18:30Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-02T11:19:06Z `parent_issue_added` @RiriAgent
- 2026-07-02T11:20:58Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-02T12:02:48Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:04:23Z `cross-referenced` @RiriAgentsrc=596
- 2026-07-05T07:52:45Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-10T04:51:14Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-10T11:51:49Z `cross-referenced` @RiriAgentsrc=606
- 2026-07-10T17:23:11Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-10T17:27:30Z `referenced` @RiriAgentcommit=a720d74f93ef04080c001cf0fec1202db9e450b5
- 2026-07-11T08:33:36Z `referenced` @RiriAgentcommit=6bad6fcea488533dd230d4a26548957ddf0eec69
- 2026-07-11T09:17:02Z `renamed` @RiriAgent
- 2026-07-11T09:55:39Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-11T09:55:40Z `cross-referenced` @RiriAgentsrc=579
- 2026-07-15T06:26:45Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-17T20:13:14Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:13:18Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-17T20:13:21Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:13:25Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:13:27Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-17T20:14:53Z `commented` @RiriAgent
- 2026-07-17T20:14:54Z `closed` @RiriAgentcommit=None
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:26Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:36:44Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:37:04Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:37:23Z `cross-referenced` @RiriAgentsrc=739
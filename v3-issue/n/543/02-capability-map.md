# RFC #543 编号→能力翻译表(中间产物 2/2)

> 输入唯一:`v3-issue/synthesized/SYNTH-543-hook-observability-gate.md`(下称 SYNTH)。
> 目的:清点 SYNTH 中出现的全部 issue/PR 编号,划定稳定引用白名单,把易变的 implementation 编号翻译成**能力级依赖**,产出 consumes / provides / shared 三张能力表。
> 原则(操作员定,2026-07-29):RFC 设计不变,任务拆分细节会变;各 RFC 树正由独立 agent 并行重整,implementation issue 编号即将全部作废;聚合层只登记「依赖什么能力 + 来自哪棵 RFC」。

## 一、稳定引用白名单(允许在聚合文档正文出现)

| 编号 | 性质 | 说明 |
|---|---|---|
| #543 | RFC-4(本树) | 生命周期 hook——引擎扩展点与用户态 gate |
| #544 | RFC-5 | 展示面/事件网关/status 快照(设计不变) |
| #545 | RFC-3 | 共享 context(设计不变;与本树无直接接缝) |
| #546 | RFC-1 | 任务代数/验证者/闭包生命周期(设计不变) |
| #547 | RFC-2 | preset DSL/编译产物(设计不变) |
| #586 + PR #672 | 已合并事实锚 | hook 声明模型已落地,squash `b2b92952d464f135109242f8cf5bdb9dae3397e3` |
| #78 / #109 / #453 | v2 已落地事实 | 代码红线的原始依据 |
| #406 | v2 已落地事实 | run-scoped 凭证 |
| #409 | v2 已落地事实 | 命令四级分级(`hard-deny-for-agent` / `per-phase-authorized` / `mutation-credential-gated` / `read-no-auth`)+ reorder 权利 |
| #411 | v2 已落地事实 | 统一事件流、五 kind |
| #419 | v2 已落地事实 | items 表 `extra` 透明字段先例 |
| #456 | v2 已落地事实 | payload 版本化 / PR body 列 shape diff 先例 |
| #413 | 已被 RFC-1 supersede 的前史 | 只作历史引用,不承载现行契约 |
| #534–#538 | v2 audit 树(已关闭/范围外) | 与本 RFC 并行不悖,不吸进范围 |

## 二、易变编号全量清点与翻译

### 树内编号(全部消灭,条款已在 01-clauses.md 去编号化)

| 编号 | 在 SYNTH 中的身份 | 处置 |
|---|---|---|
| #587–#593、#599 | CLOSED·NOT_PLANNED 旧稿(payload / observer / gate 单点 / 闭集 / 具名 gate / join script / 收尾 / 幂等) | 内容已并入 01 各域条款;编号废弃 |
| #710 | OPEN 稿:payload 契约 | → 01 域 F;编号不再引用 |
| #711 | OPEN 稿:observer 执行 | → 01 域 G |
| #712 | OPEN 稿:gate evaluation 三合一(单点协议+闭集接线+幂等恢复的拼接) | → 01 域 H、I、J(拆回三个自然域) |
| #713 | OPEN 稿:具名 gate 绑定 | → 01 域 K |
| #714 | OPEN 稿:join script 判定器 | → 01 域 L |
| #715 | OPEN 稿:综合验收 | → 01 域 M |

### 跨树编号(翻译为能力,标注 RFC 归属)

| 编号(即将作废) | SYNTH 中的语境 | 翻译后的能力 | RFC 归属 |
|---|---|---|---|
| #549 | payload 编译产物半边「从 #549 产物 schema 派生」 | **编译产物 schema**(CompiledTaskModel 及其边界),payload 派生源 | RFC-2 |
| #555 | 旧稿评论:preset DSL 声明语法 | **preset DSL 具名 gate 声明位**(命名、required/optional 标志;「DSL 演进面」承载) | RFC-2 |
| #558 | 闭包元数据投影「事实源 = #558 闭包状态表」;树结构节 | **闭包状态表**(四视图共同事实源)与任务树结构 schema | RFC-1 |
| #561 / #562 | 旧稿评论中 #700/#701 的前代编号 | 同 #700/#701 行 | RFC-1 |
| #564 | 声明模型稿:「物化态 join 只能经 #564 的独立版本化演化通道改变」 | **join 物化演化通道**(版本化变更,判定权保护) | RFC-1 |
| #574 / #718 | 「匿名槽收紧归 #574/#718」 | **status 快照边界匿名槽收紧**(StatusSnapshotBoundary 精确化) | RFC-5 |
| #575 | 「hooks 节投影唯一归 #575」 | **status 快照 hooks 节投影**(消费本树生效视图) | RFC-5 |
| #684 | 「跨 child 接缝由 #684 在冻结合流 SHA 上证明」 | **整链路 integration 验收流程**(冻结合流 SHA,v3 专用 preset/fixture) | 横切验收(非单树所有) |
| #685 | 「compatibility 验证只由 #685 执行」 | **bundled preset compatibility real E2E 流程**(发布候选 SHA,`scripts/real-e2e.ts`) | 横切验收 |
| #698 | 综合验收依赖「correction subtree 可运行的 runtime」 | **correction subtree runtime**(检查/修复子树可实际运行) | RFC-1 |
| #700 | 「decision 经 stdout 进 #700 的 join 判定通道」「#700 的 validator」 | **统一判定通道框架**(spawn 判定器、decision 接收、派发)与 **validator CLI admission**(agent-phase kind 的 decision 写回准入) | RFC-1 |
| #701 | 「reopen 校验后派发 #701 执行」 | **reopen 执行机制**(校验/认领 corrections、target 重开、seq 游标回退、terminal 不变、单事务) | RFC-1 |
| #705 | 「chain-complete 声明位迁移落地后验收此半边」 | **chain-complete 顶层 join 声明位**(从 v2 trigger 形态迁移) | RFC-1 |
| #739 | 「绑定形态与 #739/#705 声明面协调」 | **join 声明面**(join 策略在 preset 树/chain metadata 的声明位) | RFC-1(声明语法半边涉 RFC-2) |
| #740 | 「#740 只做声明位与产物暴露(语义零实现)」 | **preset 具名 gate 点的 DSL 声明位与编译产物暴露** | RFC-2 |
| #743 | 「解引用 #743 pinned definition;不得重新编译」 | **pinned preset definition**(运行实例定义态固定与解引用) | RFC-2 |
| #719 / #744 | 仅出现在 Blocks 列表,SYNTH 内无内容定义 | 无法翻译——只知其消费本树产物;**登记为存疑**(见聚合文档冲突登记) | 未知 |

## 三、能力依赖三表

### 3a. 本树消费的外部能力(consumes)

| 能力 | 提供方 | 本树哪些条款消费(01 的 ID) | 备注 |
|---|---|---|---|
| 编译产物 schema | RFC-2 | F1、F2 | payload 编译产物半边的派生源 |
| pinned preset definition 解引用 | RFC-2 | F3 | 运行实例不得重新编译当前 preset |
| preset DSL 具名 gate 声明位(命名 + required/optional) | RFC-2 | D4、K1–K3 | preset 侧只声明名字;绑定在本树 |
| 闭包状态表(四视图事实源) | RFC-1 | F7 | 闭包元数据投影派生自其 shape,落地后自动扩张 |
| 闭包转移边事件进入事件词表 | RFC-1(联合) | A4、F7、M2 | 进 observer 词表即自动可订阅(本树零字面量) |
| 统一判定通道框架 + validator CLI admission | RFC-1 | J7、L1、L2 | script kind 经此通道进容器推进点;validator kind 接入本树 journal |
| reopen 执行机制 | RFC-1 | B4、L3 | 校验/认领/重开/游标回退的唯一通道 |
| correction subtree runtime | RFC-1 | M1 | 操作员场景综合验收的运行前提 |
| chain-complete 顶层 join 声明位 | RFC-1 | L4 | 迁移落地后才能验收 chain-complete script 半边 |
| join 声明面(script variant 绑定形态) | RFC-1 | L1 | additive variant,声明形态两侧协调 |
| status 快照边界匿名槽收紧 | RFC-5 | F4 | 收紧后 payload 投影面经派生自动扩张,本树零改动 |
| status 快照 hooks 节投影 | RFC-5 | E2 | 投影实施归 RFC-5;本树只供数据(见 3b) |
| 整链路 integration 验收流程(冻结合流 SHA) | 横切 | M1、M4 | 跨树接缝证明不在本树单条款内执行 |
| compatibility real E2E 流程(发布候选 SHA) | 横切 | (全树) | 本树任何单交付面不运行 real-e2e |

### 3b. 本树供给的外部能力(provides)

| 能力 | 消费方 | 本树哪些条款产出 | 备注 |
|---|---|---|---|
| `hook.*` 事件类型与字段(执行开始/结束/失败/decision) | RFC-5 事件网关、operator 排障 | E1、E3、E4、E5 | 经统一事件流(v2 事实 #411),零新增通道 |
| 四层合成 typed 生效视图 + gate hold 运行态 | RFC-5 hooks 节投影 | D1、D2、E2(视图本体已由 #586 落地) | RFC-5 直接投影,不重读原始声明 |
| script kind 判定器执行机制(spawn/stdout parse/onFailure) | RFC-1 容器推进点、chain-complete | H2、L1、L2 | 统一判定契约的 script 半边执行器 |
| decision journal 的 typed ingress seam | RFC-1 validator kind | J3、J7 | validator 只能接入同一协议,不能复制状态机 |
| evaluation scope 幂等域(key 派生 + 重放吸收) | RFC-1 validator kind | J2 | validator 复用同一请求字段与幂等域 |
| hook stdin payload schema 导出 | hook 作者(用户态) | F5、F6、M2 | 版本化;文档从 schema 派生 |
| observer 订阅面自动覆盖新事件类型 | RFC-1(闭包转移边)及一切未来事件 | A2、A4、G6 | 事件词表扩张零 hook 侧同步 |

### 3c. 共享契约(无单向提供方,各树聚合后必须互相核对一致)

| 契约 | 共享方 | 本树条款 | 核对要点 |
|---|---|---|---|
| decision ADT `advance \| hold \| reopen(target, correctionItemIds)` | RFC-1 ↔ 本树 | B2、R5 | 三词、字段、point × decision 合法组合表两侧必须逐字一致;合法组合归 RFC-1 定义 |
| gate 决策点闭集 = 本树挂点清单 ∪ RFC-1 容器推进点 | RFC-1 ↔ 本树 | A6、I1、I2 | 闭集成员两侧对齐;chain-complete 定性为顶层 join 实例 |
| 闭包转移边 observer-only、gate 闭集不因此扩大 | RFC-1 ↔ 本树 | A4、A7、R11 | 双方 2026-07-10 联合裁决,逐字快照在两树都要在场 |
| corrections 先经 evaluation scope CLI、decision 精确引用 IDs | RFC-1 ↔ 本树 | B3、B4、L3 | 两 kind(script/agent-phase)一律;decision 通道各按 kind(stdout / CLI 写回) |
| hold 语义承接 chain-complete keep-active 先例 | RFC-1 ↔ 本树 | B6、L2 | agent-phase 判定器同样可 hold;「不需要第三词」仅针对 rollback |
| payload「全量元数据」= 编译产物投影 + 运行态快照,不另造第二套 shape | RFC-2 ↔ 本树 | F1、F2 | shape 归 RFC-2/RFC-5 上游,本树只做派生投影 |
| reopen 效果语义(target 重开/游标回退/terminal 不变) | RFC-1 ↔ 本树 | L3 | 定义归 RFC-1,本树 script kind 消费;两侧描述必须同语义 |

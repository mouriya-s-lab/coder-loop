# RFC #543 聚合:v3 生命周期 hook、可观测性与 gate 执行(全局视图)

> **本目录是重拆阶段的唯一输入**,核心文件分工:
> - `aggregation.md`(本文件)— 全局视图:目标、已落地事实、交付标准总表、裁决、能力依赖、冲突登记
> - `01-clauses.md` — 原子条款原料库(机制条款 A–M、裁决 R、全量验收行、决策项 P),本文件以 ID 引用
> - `02-capability-map.md` — 编号→能力翻译对照与 consumes/provides/shared 三表全文
> - `03-implementation-status.md` — 代码实现现状调查(main `699842e`,逐条款 已实现/部分实现/未实现 判定 + 锚点)
> - `20-external-contract-resolution.md` — RFC-1/RFC-2 外部合同归属与 blocker
> - `21-runtime-consistency-resolution.md` — metadata、shutdown、journal 的最弱结果合同
> - `22-observer-process-resolution.md` — observer process、identity、payload、diagnostic、并发裁决
> - `23-expected-foundation.md` — 上述修补完成后应成立的统一预期地基与证明计划
>
> **编号纪律**:正文只允许 RFC 编号(#543–#547)、已合并事实锚(#586/PR #672 及 v2 先例)出现;一切 OPEN implementation issue 编号已翻译为能力描述(对照见 02)。「来源」引证指向 SYNTH(`v3-issue/synthesized/SYNTH-543-hook-observability-gate.md`)。
> 聚合纪律:只登记、不裁决;事实与主张分开;矛盾原样并列进 §七。

## 一、顶层目标

操作员目标 5(verbatim,2026-07-02):

> "我希望存在生命周期,这样可以挂脚本在 hook 上,这是为了更复杂的可扩展任务机制。举例一个场景:daemon 每一次运行都可以去跑某个脚本,跑脚本会把元数据都传进去,然后 hook 可以计算迭代进行了几轮。为了防止代码腐化,首先插队单独的全面检查代码任务,如果有问题继续插队由这个任务派生的修复任务,然后才继续。这种 gate 怎么设计是后来人自己设计,程序要提供这种接口和能力。"

RFC 设计一句话:引擎在生命周期事件(observer,异步旁路)与调度决策点(gate,可 hold)上提供可挂脚本的扩展点,元数据全量经 stdin 传入;hook 经 `coder-loop` CLI 以 operator 身份操作队列;gate 经 stdout 返回 `advance | hold | reopen` decision;策略语义(查什么、何时插队)全归使用者,引擎只提供接口和能力。

## 二、已落地事实(不是任务)

**#586 hook 声明模型已合并**(PR #672,squash `b2b92952d464f135109242f8cf5bdb9dae3397e3`,2026-07-15 关闭):

| 已交付 | 内容 |
|---|---|
| 声明 ADT | 穷尽 `observer \| gate` 判别 union + 脚本路径 + 超时 + gate `onFailure`,arktype 边界 parse,非法声明装载期拒绝并点名(未知事件类型/未知决策点/缺 onFailure/`hook.*` 自反订阅) |
| 四层装载合并 | 全局 `<loop-data-root>/hooks.json`(版本化 JSON,malformed 即 load error)+ chain(`ChainMetadata.hooks`)+ preset(named-gate-placeholder variant 占位)+ item(`ItemExtra.hooks`,寿命随 item 记录);合成为单一 typed 生效视图,顺序 全局→chain→preset→item,保留来源层 provenance |
| 词表派生 | observer 挂点从事件词表结构派生并结构排除 `hook.*`(新增非 `hook.*` 事件自动可订阅、新增 `hook.*` 自动不可表达);gate 决策点单一导出闭集 ADT |
| 写入面 | 一切声明写入 operator-only;run 凭证的 add/batch-add/replace/patch/直接清除/省略式间接清除全部拒绝并留审计 |
| 零执行副作用 | 声明存在不改变调度;声明的脚本零 spawn(执行归后续交付面) |

这些性质已被其合并前验收(C1–C9,含 engine-integration 进程级验证)证明,重拆时视为地基,不重做。

v2 既有事实(gate 语义构建其上):统一事件流五 kind(#411)、run-scoped 凭证(#406)、命令四级分级与 per-phase 权利(#409)、chain-complete trigger 的 keep-active + fingerprint 先例、`(position, id)` pending 排序与 phase-continuation 优先、item `extra` 透明字段(#419)。

## 三、交付标准总表

### 3a. 骨架:RFC 8 行关闭验证(完成的定义,全文见 01 §三)

| 行 | 一句话 | 挂载条款(01 的 ID) | 依赖外部能力? |
|---|---|---|---|
| 1 | observer 被调、stdin 收元数据、自反订阅不可表达 | A1–A3、G1–G3、F1;声明期拒绝半边已由 #586 落地 | 无 |
| 2 | gate 能 hold 调度决策 | A5、H1、H3、B5 | 无 |
| 3 | 操作员场景(轮数→检查 leaf→hold→修复→advance) | C2、M1、B3、J2 | RFC-1 correction subtree runtime |
| 4 | onFailure 两语义(hold/advance) | B5、H2、G3 | 无 |
| 5 | 四层声明位与合成(全局→chain→preset→item,AND) | D1、D2、I9、K1–K5;装载合并半边已由 #586 落地 | RFC-2 具名 gate DSL 声明位 |
| 6 | hook 执行可观测(`hook.*` 事件) | E1、E3–E5 | 无(经既有事件流) |
| 7 | 引擎零 gate 策略业务字面量 | R7、M3 | 无 |
| 8 | script gate 的 reopen 判定(容器推进点) | B2–B4、L1–L3、D3 | RFC-1 判定通道 + reopen 执行机制 |

### 3b. 8 行之外的新增交付面

这些是 RFC 迭代过程中滚入的交付物,8 行骨架不覆盖;重拆时逐面审视其必要性与归属:

| 交付面 | 条款 | 何以在 8 行之外 |
|---|---|---|
| payload 契约(零平行 shape、pinned 解引用、匿名槽不透传、版本化、schema 导出、GitHub 字段排除) | F1–F8 | 行 1 只要求「stdin 收到元数据」;shape 纪律与派生关系是红线驱动的工程化新增 |
| 决策点闭集全点物化(pre-spawn、状态转移 `gate_held`、daemon `starting-held`/`shutdown-held`、tick 节流) | A6、I1–I9 | 8 行只在 post-run 单点考核;裁决 1「挂点齐全」把闭集全点变成交付物 |
| tick 节流(`minIntervalMs` 显式无默认) | I3、R15 | 同上,tick 可挂的前置条件 |
| hold 指纹泛化(FingerprintInput 类型化、先例收编) | B6、I4、I5 | 行 2 只要求 hold 成立;防重问风暴是执行层新增 |
| 评估代次与幂等协议(状态机、mutation 重放吸收、decision journal、重启恢复、epoch 正交) | J1–J7 | 8 行完全未涉;为「hold 后重问可改判 + 脚本可崩溃」补的可靠性半边,是最大的一块新增 |
| 具名 gate 三态绑定与遮蔽(optional/required、chain 覆盖 global、selected+shadowed 可见) | K2–K4 | 行 5 只考四层各一 gate;未绑定语义与遮蔽是裁决展开 |
| 多 reopen 合成 | D3、R14 | 行 8 只考单 reopen |
| 闭包接缝(转移边 observer-only、闭包元数据投影、阻止挂起走 post-exit hold) | A4、A7、F7、M5、R11 | RFC-1 闭包生命周期 2026-07-10 落定后联合新增 |
| hook 作者文档 + 派生守护 + 证据映射 | M2、M4 | 收尾交付物,8 行的行 7 只覆盖字面量守护半边 |

### 3c. 细化验收行

全量验收行(按域 F/G/H/I/J/K/L/M 归组,共 50+ 行)见 `01-clauses.md` §三;全域通用 `bun run typecheck && bun test` 全绿。SYNTH 中每一张验收表的每一行都已归入 01 §三或本文件 §七(见 §八自查)。

## 四、已裁决约束(重拆时不得重新设计)

清单全文见 01 §二(R1–R16)。索引:

- **操作员裁决 1–5**(2026-07-02):挂点齐全不预判(R1)、onFailure 自选(R2)、operator 全权无第三主体(R3)、四层声明位(R4)、与 RFC-1 统一判定接口 + decision 三词闭集 + point×decision 合法组合(R5)
- **代码红线**(R6):全链路 ADT、无 any/匿名形状/真 as、arktype 边界 parse
- **引擎边界红线**:零 gate 策略业务语义(R7)、无 spawnSync 主线程阻塞(R8)、不注入 GitHub 面字段(R13)
- **后续操作员/联合裁决**:`hook.*` 自反排除双层防护(R9,2026-07-02)、指纹与代次正交(R10,2026-07-10)、转移边 observer-only 且 gate 闭集不扩(R11,2026-07-10 与 RFC-1 联合)、声明写入 operator-only(R12)、多 reopen 合成(R14)、tick 强制节流(R15)
- **v2 语义前提**:插队只在 item 边界生效(R16)

## 五、能力依赖(跨树,全文见 02 §三)

### 消费(本树 ← 外部)

| 提供方 | 能力 |
|---|---|
| RFC-2 (#547) | 编译产物 schema;pinned preset definition 解引用;preset DSL 具名 gate 声明位(命名 + required/optional) |
| RFC-1 (#546) | 闭包状态表;闭包转移边事件入词表(**部分就绪**:main `699842e` 已有 5 种 `closure.*` 事件在词表并真实发射,但非 A4 六条转移边一一对应,详见 `03-implementation-status.md` 附加调查 2);统一判定通道框架 + validator CLI admission;reopen 执行机制;correction subtree runtime;chain-complete 顶层 join 声明位;join 声明面(script variant 形态协调) |
| RFC-5 (#544) | status 快照边界匿名槽收紧;status 快照 hooks 节投影(消费本树数据) |
| 横切验收 | 冻结合流 SHA 整链路 integration;发布候选 SHA compatibility real E2E |
| RFC-3 (#545) | **显式无接缝**(SYNTH 原文:hook 如需读共享 context,经该 CLI 的普通读取面,不新增契约)——登记以免重拆时误判为遗漏 |

### 供给(本树 → 外部)

| 消费方 | 能力 |
|---|---|
| RFC-5 (#544) | `hook.*` 事件类型与字段;四层生效视图 + gate hold 运行态(供 hooks 节投影) |
| RFC-1 (#546) | script kind 判定器执行机制;decision journal 的 typed ingress seam(validator 接入);evaluation scope 幂等域(validator 复用);observer 订阅面自动覆盖新事件(闭包转移边落地即自动可订阅) |
| hook 作者(用户态) | stdin payload schema 导出(版本化);作者文档 |

### 共享契约(无提供方,各树聚合后互核一致)

1. decision ADT `advance | hold | reopen(target, correctionItemIds)` — 与 RFC-1;point×decision 合法组合表归 RFC-1 定义
2. gate 决策点闭集 = 本树挂点清单 ∪ RFC-1 容器推进点;chain-complete 定性为顶层 join 实例
3. 闭包转移边 observer-only、gate 闭集不扩 — 2026-07-10 联合裁决,逐字快照两树都须在场
4. corrections 先经 evaluation scope CLI、decision 精确引用 IDs — 两 kind 一律;decision 通道各按 kind(script=stdout,agent-phase=CLI 写回)
5. hold 承接 keep-active 先例;agent-phase 判定器同样可 hold
6. payload = 编译产物投影 + 运行态快照,不另造第二套 shape — 与 RFC-2
7. reopen 效果语义(target 重开/游标回退/terminal 不变)— 定义归 RFC-1,本树 script kind 消费

## 六、决策项收敛

- **P3 已裁为结果合同**：同一或不同脚本跨 event、chain 与连续触发均允许并发；每个 match 独立 delivery，不合并、不跳过，也不提供 per-script/global lane。文件、Git、数据库、第三方服务及跨脚本 effect 的可重入、协调与幂等归脚本作者；引擎只保证自身 durable state、stable delivery/execution identity、固定 payload、局部 CLI 事务和审计关联，不兜底外部 effect。
- **P1/P2/P4/P5 不再作为操作员产品裁决**：实现只需满足稳定结果合同，所需物理表示由实现决定，也可能无需新增表示。投影/无上下文 snapshot 必须保持 F/I 的 typed、版本化与 host-variant 结果；存储只需表达 J 的 durable facts；无宿主 id 的 identity 只需稳定且不伪造 chain/item。具体切片、字段、表、索引、编码与模块位置不是 RFC 语义，不得继续向操作员提问。
- retry 次数、terminal 分类、payload 固定性、identity 生命周期、diagnostic replay、metadata 冲突后果与 `shutdown-held` admission 已由 `20`–`22` 收敛；grace 数值、batch、schema/API/锁/队列/outbox/consumer 形态属于实现参数或证明计划。

### 修补后预期地基

统一合同与逐域矩阵见 `23-expected-foundation.md`。其最低结论是：

1. observer 使用 durable at-least-once delivery；delivery 与 execution identity 分层并贯穿 payload/stdin、journal、audit 与 diagnostic；同一 delivery replay 使用固定 pinned payload；clean stop 有界回收，只有 crash 后非终态 attempt 先回收再重派，success/nonzero/spawn-stdio failure/timeout/clean-stop termination 等已知终态不自动 retry；execution terminal 是 diagnostic 权威，派生 `hook.*` 零自反；observer 任一 outcome 不改变 scheduler decision。
2. gate runtime 使用 typed current-state mutation 与 durable evaluation/journal authority；成功不得 stale silent overwrite；`shutdown-held` 保持 query、拒绝新 mutation/dispatch；pending 引擎内 delivery/effect 可在 restart 恢复。
3. #543 只消费外部 authority，不设计替代实现。三组外部 blocker 是：
   - RFC-2 pinned definition artifact/resolver；
   - RFC-1 canonical closure 六边 transition/identity；
   - RFC-1 structured reopen authority（target、claim、budget、cursor 与原子 effect）。
4. 明确非保证：脚本成功/最多一次/完成顺序、普通失败自动 retry、event sink 或外部 effect exactly-once、文件/Git/服务事务与回滚、跨脚本锁、distributed transaction、effect sandbox、当前路径 fallback，以及任何预选 schema/API/表/锁/队列物理形态。

## 七、冲突与存疑登记(原样并列,不裁决)

1. **三合一拼接稿**:OPEN 的 gate evaluation 稿是三份旧稿(单点协议/闭集接线/幂等恢复)的物理拼接——正文含三段独立「架构切片」、三张验收表,且拼接时把跨稿引用改写为「本 issue」造成循环自指(如「泛化机制即本 issue 的决策点闭集,落地后收编该复用点」)。本聚合已按自然域 H/I/J 拆回;重拆时不得沿拼接稿划界。
2. **OPEN 稿全部缺「本 issue 的验证边界」节**:CLAUDE.md 强制每个 v3 issue 有该节 + real-e2e 命令级逐字结论;六份 OPEN 稿全部缺失(RFC body 与已关闭的 #586 有)。重拆产出的每个 issue 必须补齐。
3. **验收外包**:payload 稿把自己的 integration 验收行写成「由 observer 执行稿的验收行接管」——交付标准跨 issue 悬挂,正是「前一个依赖后一个」的验收层形态。重拆时每个 issue 的交付标准必须自闭合。
4. **两套编号并存**:SYNTH §五保留的旧稿评论用旧编号体系,与 OPEN 稿正文的新编号并存且对不上。已由 02 的能力翻译整体消解;登记备查。
5. **继承快照与现行 body 漂移**:#586 的继承条款快照引用的 RFC 文本是旧版(observer 挂点无 `hook.*` 减法、多 reopen「见开放问题」),与 RFC 现行 body(减法版、已裁)不一致。现行以 RFC body 为准;此为 body 修订后快照未更新的痕迹。
6. **#586 关闭前 review findings——已核实全部修复**(2026-07-29 代码调查,证据见 `03-implementation-status.md` 专项疑点节):observer 词表已是 `Exclude<EventType, \`hook.${string}\`>` 结构派生减法(含未来事件的编译期测试);`HookSourceLayer` 是 `keyof HookLayers` 派生且被消费,无平行词表;whole-carrier replacement 省略 `hooks` 时保留、仅显式 `hooks: null` 清除(含集成测试)。§二事实节的成色成立,无残留债。
7. **两个无法翻译的下游编号**:Blocks 列表中出现的两个编号在 SYNTH 内无任何内容定义,只知其消费本树 payload/gate 产物;无法翻译成能力。若重拆后仍有对应需求,由其所属树自行以能力语言重新声明依赖。
8. **8 行表双份拷贝**:RFC body 与综合验收稿各持一份(当前一致)。重拆后应单一来源,验收面只引用不复制。
9. **验收驱动器演变史**:#586 的 executable-contract 第一代把 real-e2e 列为 C9,第二代起改为 engine-integration 并显式禁止 real-e2e(与 CLAUDE.md 验证边界一致)。supersede 链明确,现行为后者;登记以防误读第一代 contract。
10. **操作员场景的外部 runtime 耦合**:综合验收(M1)依赖 RFC-1 correction subtree runtime 才能真跑;该顺序耦合是真实的,重拆时收尾 issue 的排期必须显式声明这条外部能力依赖,而非引用对方树的 issue 编号。

## 八、自查记录

- **编号纪律**:本目录核心合同文件正文中,implementation issue 编号仅出现于:02 的翻译对照表(其存在目的)、本文件 §七的引证语境、01 来源列的 SYNTH 定位符。条款正文与依赖表述零残留(grep 复核见下)。
- **验收行反向核对**:SYNTH 全部验收表(RFC 8 行 ×2 份、payload/observer/gate×3/具名 gate/join/综合验收各表、#586 两代 C1–C9)——8 行入 3a 骨架;各 OPEN 稿验收行入 01 §三按域归组;#586 的 C1–C9 属已落地事实的历史验收,归 §二事实(不进未来交付标准);无验收行被静默丢弃。
- **条款反向核对**:SYNTH §一(RFC 骨架)、§二(六份 OPEN 稿全文)、§三(#586)、§四(旧稿摘要,内容与新稿重合,已并入对应域)、§五(裁决记录与架构切片,并入 R9/R10 与各域)、§六(依赖图,已翻译)——全部节均有归宿。

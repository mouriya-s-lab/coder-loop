# RFC #543 条款抽取(中间产物 1/2)

> 输入唯一:`v3-issue/synthesized/SYNTH-543-hook-observability-gate.md`(下称 SYNTH)。
> 本文件把 SYNTH 的 issue 外壳剥掉,抽出原子条款:机制条款、已裁决约束、交付标准、显式决策项。
> **编号纪律**:条款正文不出现任何 implementation issue 编号(它们是易变的拆分细节);跨树依赖在正文中写成能力描述,编号→能力的翻译对照见 `02-capability-map.md`。「来源」列是 SYNTH 文内定位引证,允许出现原稿编号,不构成依赖。
> 稳定引用白名单(设计/事实不变,允许在正文出现):RFC 编号 #543–#547;已合并落地的事实锚 #586(PR #672,squash `b2b9295`)及 v2 已落地先例编号(#78/#109/#406/#409/#411/#419/#453/#456)。

## 一、机制条款(要做的事)

### A. 两类 hook 模型

| ID | 条款 | 来源 |
|---|---|---|
| A1 | observer hook:订阅生命周期事件,异步旁路执行,不影响调度;失败只记 diagnostic 事件 | SYNTH §一·核心设计·两类 hook |
| A2 | observer 挂点词表 = observability 事件类型枚举 **减去固定自反子集 `hook.*`**;不另发明挂点命名;事件枚举扩张时挂点面自动扩张,`hook.*` 永久排除 | SYNTH §一·核心设计;§五·自反挂点裁决记录 |
| A3 | `hook.*` 自反防护是双层的:订阅 `hook.*` 的声明装载期拒绝 + 事件发射路径对 `hook.*` 零 observer 派发(防进程风暴/自激励回路);hook 的可观测性由事件查询面(logs/events)提供 | SYNTH §一·核心设计;§五·裁决记录 |
| A4 | 闭包生命周期落定后,闭包转移边(create / run-spawn / run-exit / suspend / reopen / consume)作为新事件类型进入 observer 事件词表,自动可订阅 | SYNTH §一·核心设计·两类 hook;§一·跨 RFC 接口假设(RFC-1 逐字快照) |
| A5 | gate hook:挂在调度决策点上,逻辑 hold 住宿主决策点(run/item/container/chain/daemon/tick 的推进不发生)直到返回 decision;实现上异步 spawn 子进程,不阻塞 daemon 主线程与其他 chain 的调度 | SYNTH §一·核心设计·两类 hook |
| A6 | gate 决策点是引擎内禀闭集(与事件枚举分列),至少含:run pre-spawn、run post-exit(下一次选择前)、item 状态转移、容器推进/par join、chain-complete(吸收现有 trigger 先例,定性为顶层 join 实例)、daemon startup/shutdown、tick(须带节流声明才可挂) | SYNTH §一·核心设计·两类 hook |
| A7 | 闭包转移边**不进** gate 决策点闭集——转移边 observer-only,不可 gate(suspend 零资源副作用,consume 才允许 GC;副作用上放 gate = 用户态扣住引擎资源管理、发明第二推进语义);要阻止挂起,在 run post-exit gate 上 hold,推进被扣则闭包自然不挂起 | SYNTH §一·核心设计;§一·跨 RFC 接口假设(逐字快照) |

### B. 执行模型与 decision 协议

| ID | 条款 | 来源 |
|---|---|---|
| B1 | hook = 任意可执行文件;输入:全量元数据 JSON 经 stdin;gate 经 stdout 返回 decision JSON;observer 无输出契约 | SYNTH §一·执行模型 |
| B2 | decision wire 是统一判定契约三词 ADT:`advance \| hold \| reopen(target, correctionItemIds)`,可附 reason。`advance` 放行;`hold` 扣住该决策点、退避重问(keep-active 先例);`reopen` 退回并要求纠正,仅容器推进类决策点合法,其余决策点非法 | SYNTH §一·执行模型;设计裁决 5 |
| B3 | corrections 先经带 evaluation scope 的 CLI 创建为既存 item,decision 只精确引用这些 item 的 id(`correctionItemIds`);stdout 不承载 mutation | SYNTH §一·执行模型 |
| B4 | reopen consumer 原子完成的是「校验并认领既存 corrections + target 重开 + 游标/预算/decision consumed」;不谎称先前 CLI mutation 与 decision 消费属于同一事务 | SYNTH §一·执行模型 |
| B5 | 每 hook 声明超时;超时/崩溃按其 `onFailure = hold \| advance` 声明处置:`hold` = 决策点退避重问(事件可见),`advance` = 记 diagnostic 后放行 | SYNTH §一·执行模型;设计裁决 2 |
| B6 | gate hold 后的重问需幂等防抖——chain-complete trigger 的 fingerprint 机制(keep-active 指纹)是既有先例,泛化为通用机制 | SYNTH §一·执行模型 |

### C. 能力契约(hook 如何操作队列)

| ID | 条款 | 来源 |
|---|---|---|
| C1 | hook 操作队列 = 在脚本内以 operator 身份调 `coder-loop` CLI(socket 命令面);不引入「stdout 返回结构化 mutation 指令由引擎代执行」的第二套协议;mutation 全走现有命令面,自动获得既有校验与审计 | SYNTH §一·能力契约;设计裁决 3 |
| C2 | 操作员验收场景:post-run gate 读元数据算轮数 → 达阈值以当前 evaluation scope 调 `item add` 创建检查 leaf 并返回 `hold`;原决策点保持扣住,不能靠全局 `(position, id)` 排序冒充控制流;检查 leaf 及其派生修复 leaf(由检查任务 agent 经 per-phase createItems 权利派生)全部完成后,同一 gate 才返回 `advance`,原 seq 才继续;检查/修复与被扣决策点的关联必须以稳定 task/evaluation identity 表达 | SYNTH §一·能力契约 |

### D. 声明位与合成语义

| ID | 条款 | 来源 |
|---|---|---|
| D1 | 四层声明位全支持:全局 loop-data root、chain 级(metadata)、preset 级(抽象具名 gate 点,接口与实现分离)、item 级 | SYNTH §一·设计裁决 4 |
| D2 | 同一挂点多层命中时全部执行,顺序 全局 → chain → preset → item;gate decision 合成为 AND 放行(任一非 advance 即不放行);hold 与 reopen 并存时 reopen 优先 | SYNTH §一·声明位与合成语义 |
| D3 | 多 reopen 合成:同 target 合并并去重 correction IDs(稳定顺序并集);不同 target 无可证明安全的隐式优先级,合成为 hold + 含全部冲突 target 的 diagnostic,绝不按声明顺序任选一个 target | SYNTH §一·已分配裁决;§二·join script 稿·多 reopen 裁决 |
| D4 | preset 级是抽象 gate 点:preset 只声明「此处需要一道命名 gate」(可分发、不含本机脚本路径),具体脚本由全局/chain 层绑定到该名字;声明语法归 RFC-2 DSL | SYNTH §一·声明位与合成语义 |

### E. 可观测性

| ID | 条款 | 来源 |
|---|---|---|
| E1 | hook 执行自身进入事件流:新增 `hook.*` 事件类型(执行开始/结束/失败/gate decision),经既有事件类型边界的编译期 union 扩张 | SYNTH §一·可观测性;§二·observer 稿·观测义务 |
| E2 | gate hold 状态与 hook 声明清单(四层合成后的生效视图)进 status 快照新增的 hooks 节,使 hold 与 hook 故障对 `status --json` 与 GUI 可见;经统一事件流被 RFC-5 网关消费,零新增通道 | SYNTH §一·可观测性;跨 RFC 接口假设(RFC-5) |
| E3 | observer 失败 diagnostic 事件最小字段集:hook 标识、触发事件类型、失败原因分类(非零退出/超时/spawn 失败) | SYNTH §二·observer 稿·观测义务 |
| E4 | gate decision 事件含:hook 标识、决策点标识(闭集 union 值)、判定词、reason;协议违规/超时/崩溃发 diagnostic + 审计事件并点名违规类别 | SYNTH §二·gate evaluation 稿·观测义务 |
| E5 | hold 扣住/重问/指纹命中经事件可见(重问节奏可从事件流重建);key 命中(重放吸收)事件含评估 scope、命中 command、首次记录时间;评估状态转移与重启恢复动作经事件可见 | SYNTH §二·gate evaluation 稿·观测义务 |

### F. hook stdin payload 契约

| ID | 条款 | 来源 |
|---|---|---|
| F1 | 唯一 payload 组装函数与 typed 契约,三块组成:触发上下文(挂点 + 触发事件或决策点标识 + 关联键)、编译产物投影、运行态快照;observer/gate 共用,无第二套拼装 | SYNTH §二·payload 稿·预期结果 1 |
| F2 | 零平行 shape:编译产物半边从 RFC-2 编译产物 schema 派生;运行态半边从 status 快照边界派生;触发事件半边从事件信封边界派生;上游 shape 演进自动传导,本侧零同步代码 | SYNTH §二·payload 稿·预期结果 2 |
| F3 | 运行中实例的编译产物半边必须解引用其 pinned preset definition(RFC-2 的定义 pin 能力),不得重新编译同路径当前 preset | SYNTH §二·payload 稿·预期结果 2 |
| F4 | 红线适配:status 快照边界现存的匿名 object 槽**不透传进 payload**;payload 只投影已具精确 boundary 的节;上游收紧后投影面经派生关系自动扩张 | SYNTH §二·payload 稿·预期结果 2 |
| F5 | payload 自带版本标识;shape 演进 bump,PR body 列 shape diff(#456 先例) | SYNTH §二·payload 稿·预期结果 3 |
| F6 | schema 可导出:hook 作者可获知 payload 精确形态 | SYNTH §二·payload 稿·预期结果 4 |
| F7 | 闭包元数据投影:闭包转移边事件作为 observer 触发事件时,payload 运行态半边须投影闭包元数据(生命周期态 活跃/挂起/已消费、worktree 路径、闭包分支、par pin commit、sessionIds);事实源 = RFC-1 闭包状态表,投影派生自其 shape,零平行定义 | SYNTH §二·payload 稿·预期结果 5 |
| F8 | 引擎不注入 GitHub 面字段:payload 任何半边不得含 mergedness、mergeCommit、PR 状态等 GitHub 面事实(L1 红线;正确通道是 preset 判定器脚本自查 GitHub 面) | SYNTH §二·payload 稿·预期结果 6 |

### G. observer 执行

| ID | 条款 | 来源 |
|---|---|---|
| G1 | 生效视图中订阅事件类型 E 的每个 observer 在 E 发射时被异步 spawn(fire-and-forget):调度不等待、不消费退出码;tick 时长不随 observer 数量与脚本时长增长 | SYNTH §二·observer 稿·预期结果 1 |
| G2 | payload 经单一组装函数写 stdin;任意可执行文件可消费,不要求特定语言/运行时 | SYNTH §二·observer 稿·预期结果 2 |
| G3 | 每 hook 声明超时生效(SIGTERM→SIGKILL 组信号回收);observer 失败(非零退出/超时/spawn 失败)只记 diagnostic——不影响调度、不重试、不升级 | SYNTH §二·observer 稿·预期结果 3 |
| G4 | observer/gate 共用同一 hook 进程执行层(spawn/stdin/超时/并发语义) | SYNTH §二·observer 稿·目标 |
| G5 | hook 路径零同步阻塞:无 `Bun.spawnSync` 新增;spawn/stdin 写入/回收全部异步 | SYNTH §二·observer 稿·预期结果 5;§一·约束 |
| G6 | observer 订阅匹配直接用事件类型 union,不建平行「挂点名」映射表 | SYNTH §二·observer 稿·架构切片 |

### H. gate 决策协议(单点语义)

| ID | 条款 | 来源 |
|---|---|---|
| H1 | 决策点上生效视图命中的 gate 逐层逐个执行(全局→chain→preset→item),AND 放行;非容器决策点词表是 `advance \| hold` 二词子集(无 seq 游标可退) | SYNTH §二·gate evaluation 稿·预期结果 1 |
| H2 | stdout decision JSON 经 arktype 边界 parse 为穷尽 union;非法输出(非 JSON、词表外值、本点收到 reopen)按该 hook 的 `onFailure` 处置并记 diagnostic + 审计事件;无静默放行、无 default 兜底;stdout 不承载 mutation | SYNTH §二·gate evaluation 稿·预期结果 2 |
| H3 | hold 作用域 = 该决策点:该 chain 的决策扣住,其他 chain 调度不受影响;退避重问时脚本重新执行、可改判 | SYNTH §二·gate evaluation 稿·预期结果 4 |
| H4 | 非容器 reopen 裁决:声明只能约束挂点,不能证明脚本未来 stdout 不输出 reopen——不伪造「装载期可证明脚本输出」的保证;脚本实际输出 reopen 时,stdout boundary 判为 `decision_not_allowed_at_point`,记 diagnostic,严格按已声明 `onFailure` 处理;compile 负责拒绝把显式 container-only gate 绑定到非容器点 | SYNTH §二·gate evaluation 稿·非容器 reopen 裁决 |
| H5 | decision 词表在 parse 侧与消费侧单一定义(穷尽 union),不得两处各自定义 | SYNTH §二·gate evaluation 稿·架构切片 |

### I. 决策点闭集接线与指纹泛化

| ID | 条款 | 来源 |
|---|---|---|
| I1 | 闭集全点物化:除容器推进/par join、chain-complete(归 join script 判定通道)外的全部决策点可挂 gate;每点走同一协议路径(同一 parse/onFailure/合成代码),无每点私有评估逻辑 | SYNTH §二·gate evaluation 稿·闭集预期结果 1 |
| I2 | 闭集是穷尽 union 类型:新增决策点由编译器暴露全部处置点(声明校验、评估接线、payload 触发上下文、事件字段);不得以字符串散名在声明/事件/payload 中各自维护 | SYNTH §二·gate evaluation 稿·闭集预期结果 2 |
| I3 | tick 节流:tick gate 必须显式声明正整数 `minIntervalMs`,无默认值;缺失或非正值 compile 拒绝;每个有效声明独立记录上次 evaluation 完成时刻,达到间隔才可发起下一 epoch;不使用引擎魔法频率 | SYNTH §二·gate evaluation 稿·闭集预期结果 3 |
| I4 | hold 指纹泛化:任一决策点的 hold 退避重问带幂等指纹防抖(同一决策上下文不重复问、变化后重问);chain-complete 先例被收编,专用形态不残留 | SYNTH §二·gate evaluation 稿·闭集预期结果 4 |
| I5 | 指纹构成:每个 point variant 定义类型化 `FingerprintInput`——决策点 identity、宿主稳定 identity、该点会影响的 canonical 状态投影、effective hook declaration hash;不得 hash 全库偶然字段;canonical JSON hash 与最近 hold 存入 per-point evaluation store,不写 `chain.metadata` | SYNTH §二·gate evaluation 稿·决策点行为裁决 |
| I6 | item 状态转移点:同步 RPC 不悬挂——gate hold 时请求返回结构化 `gate_held`(含 point identity/reason/retry hint),mutation 零落地;调用方重试形成下一次候选评估;advance 才在同一请求继续 admission | SYNTH §二·gate evaluation 稿·决策点行为裁决 |
| I7 | daemon startup hold:socket/status 面进入 `starting-held`,scheduler 不开始,按 backoff 重评,advance 后 ready;shutdown hold:进入 `shutdown-held`,停止新调度但保留 socket/status 与进程回收,重评至 advance;OS hard kill 不经过 gate;tick hold:只跳过该 tick 的调度推进,daemon 存活,达 `minIntervalMs` 且指纹变化后重评 | SYNTH §二·gate evaluation 稿·决策点行为裁决 |
| I8 | 无 chain/item 上下文的挂点(daemon startup/shutdown、tick)用同一 payload envelope,host variant 为 daemon,携带 daemon lifecycle facts、tick identity、effective declarations、当次 status snapshot;不伪造 chain/item id,不另建匿名 payload shape | SYNTH §二·gate evaluation 稿·决策点行为裁决 |
| I9 | 四层合成顺序与 AND 放行在全部决策点由同一合成实现保证 | SYNTH §二·gate evaluation 稿·闭集预期结果 5 |

### J. 评估代次、幂等与恢复

| ID | 条款 | 来源 |
|---|---|---|
| J1 | 评估代次状态机:每个 gate 决策点评估有持久化身份 `(决策点身份, epoch)`(决策点身份 = 决策点类型 × 宿主 chain/container/item/run id);生命周期 `evaluating`(spawn 前 write-ahead)→ `decided`(kind-specific ingress 准入成功,decision 单事务持久化)→ `consumed`(效果落地,与效果同一事务);崩溃/超时/非法 decision 停留 `evaluating`;epoch 仅在 `consumed` 递增;持久化不进 `chain.metadata` | SYNTH §二·gate evaluation 稿·可重放不变量 1 |
| J2 | I1 mutation 幂等:evaluation scope 注入判定主体执行环境(既有 env 注入形态先例),CLI mutation 自动附加为请求字段;幂等 key 从 `(evaluation scope, command, 规范化 args)` 派生;daemon admission 层 key 命中即返回首次 response 快照、零副作用;miss 时 mutation 与 key 记录同一事务;同 epoch 内重放多次,每个逻辑 mutation 至多生效一次 | SYNTH §二·gate evaluation 稿·可重放不变量 2 |
| J3 | I2 decision 消费原子:每 epoch 至多一个 decision 被准入并消费;typed ingress 只校验并写 journal,消费走同一实现;消费与全部引擎侧效果单事务;重启时 `decided` 未消费直接重消费(不重启判定主体),`evaluating` 残留同 epoch 重问;滞后 mutation 被同 key 吸收,滞后 decision 被 epoch 与当前执行身份拒绝 | SYNTH §二·gate evaluation 稿·可重放不变量 3 |
| J4 | I3 epoch 单调 + 与防抖指纹正交:epoch 只在消费完成递增,同 epoch 重放不跨入下一代次 key scope;hold consumed → epoch+1 + 记防抖指纹;`evaluating` 残留的重问不查指纹、无条件重问;指纹与代次是两个正交概念 | SYNTH §二·gate evaluation 稿·可重放不变量 4;§一·已分配裁决 |
| J5 | I4 边界诚实:协议不承诺「评估恰好一次」;同 epoch 重放中非确定性脚本的不同 mutation 各自首次生效,可能残留孤儿 corrections——引擎不撤销、不判定「悬空」(业务语义);gate 评估语境创建的 item 其 `item.created` 审计事件携带评估 scope 标识,operator 可追溯 | SYNTH §二·gate evaluation 稿·可重放不变量 5 |
| J6 | 普通 operator 路径零影响:不携带评估 scope 的请求不进幂等分支,既有语义(含 `duplicate_item` conflict)逐字不变 | SYNTH §二·gate evaluation 稿·可重放不变量 6 |
| J7 | journal/consumer 保留精确 typed ingress 扩展边界:script/validator 两 kind 各按其 ingress(script = stdout parse,validator = CLI default-deny admission)提交同一 decision ADT;下游 validator 通道只能接入同一协议,不能复制状态机;全系统只有一个 journal/consumer | SYNTH §二·gate evaluation 稿·目标/问题/验收 |

### K. preset 具名 gate 绑定

| ID | 条款 | 来源 |
|---|---|---|
| K1 | 绑定声明:全局/chain 层可声明 gate 名 → 脚本绑定(含超时/onFailure),arktype 边界 parse,进生效视图 preset 层成员(合成顺序位置 = preset) | SYNTH §二·具名 gate 稿·预期结果 1 |
| K2 | 解析三态穷尽:已绑定(执行如普通 gate,统一评估路径零特例)\| 未绑定 optional(空过,跳过事件可见)\| 未绑定 required(新实例创建结构化拒绝并点名 gate;既有 pinned 实例恢复时缺绑定则显式 hold,不回退 optional、不换脚本);无 default 兜底 | SYNTH §二·具名 gate 稿·预期结果 2 + 绑定解析裁决 |
| K3 | preset compile 不依赖某台机器的绑定,required 未绑定不在 compile 期伪报;解析发生在 chain/item 实例创建时 | SYNTH §二·具名 gate 稿·绑定解析裁决 |
| K4 | 同名绑定配置覆盖语义:chain binding 覆盖 global binding,只有一个 effective script 作为 preset 层 gate 执行;全局/chain 自己的普通 hooks 与「为 preset named gate 提供绑定」是两种不同角色,互不影响;生效视图同时显示 selected binding 与 shadowed source | SYNTH §二·具名 gate 稿·绑定解析裁决 |
| K5 | 可分发性质:preset 本体(toml + 模板)中不存在本机脚本路径的通道 | SYNTH §二·具名 gate 稿·预期结果 3 |

### L. join script 判定器与 reopen

| ID | 条款 | 来源 |
|---|---|---|
| L1 | join 声明可取 `script` variant(additive);join 评估的穷尽 switch 处置该 variant——容器全成员 terminal 时 spawn script gate(复用 hook 执行层与 decision 协议),而非 validator leaf | SYNTH §二·join script 稿·预期结果 1 |
| L2 | script 判定与 agent-phase validator 走同一 decision ADT 与同一派发路径:advance 放行、hold 扣住退避重问(指纹泛化机制)、reopen 校验后派发 reopen 执行机制;容器推进点三词全部合法 | SYNTH §二·join script 稿·预期结果 2 |
| L3 | reopen 语义(消费 RFC-1 契约):纠正 item 追加进 target、seq 游标回退、已 terminal item 状态不变;非法 target(未跑节点/跨 seq)被拒 + 审计,容器状态不变;script 判定不绕过 reopen 校验唯一通道 | SYNTH §二·join script 稿·验收;架构切片 |
| L4 | chain-complete 作为顶层 join 可绑 script(声明位随 RFC-1 侧迁移落地后验收) | SYNTH §二·join script 稿·预期结果 4 |
| L5 | mergedness ground truth 在 GitHub 面:合并真相由 script 判定器经声明通道自查(脚本内以 operator 身份调 `gh`/GitHub API),不由引擎注入 payload;判定器可读的引擎自有面 = 闭包分支上有无工作、发布没发布 | SYNTH §二·join script 稿·预期结果 6 |

### M. 收尾:综合验收、文档与守护

| ID | 条款 | 来源 |
|---|---|---|
| M1 | 操作员验收场景端到端真跑(RFC 关闭验证行 3 全语义):轮数 gate → evaluation-scoped 检查 leaf → hold → 检查 agent 派生修复 → 全部完成 → advance → 原 seq 继续;事件序列可证;不得以队列 position 抢跑冒充 gate | SYNTH §二·综合验收稿·预期结果 1 |
| M2 | hook 作者文档:声明位四层、observer 挂点(事件词表引用)、gate 决策点闭集、payload schema、decision 协议与 onFailure、重放语义与幂等边界(评估代次、重放吸收、孤儿残留边界、脚本确定化义务、引擎外副作用不受保护的提醒)、能力契约、tick 节流与具名 gate 绑定、闭包转移边事件词表与「转移边 observer-only」边界;枚举性内容从代码/schema 派生或测试守护,手写计数 drift 时测试红 | SYNTH §二·综合验收稿·预期结果 2 |
| M3 | 全局守护测试:引擎源码无轮数阈值/检查任务类 gate 策略业务词;引擎只含挂点、payload、decision 协议(RFC 行 7 从 review 约定升级为测试执法) | SYNTH §二·综合验收稿·预期结果 3 |
| M4 | RFC 8 行关闭验证 → 各交付面验收证据的映射登记,支撑 RFC 关闭;任一行不成立回到拥有该契约的交付面修复 | SYNTH §二·综合验收稿·预期结果 4 |
| M5 | 「阻止挂起 = 推进被扣」验证:run post-exit gate hold 期间闭包不挂起(停 active);advance 后正常挂起进闭包分支;证明的是推进被扣而非转移边被 gate | SYNTH §二·综合验收稿·验收行 2 |

## 二、已裁决约束(不再重新设计)

| ID | 裁决 | 来源 |
|---|---|---|
| R1 | 挂点粒度:「生命周期尽可能齐全,挂钩点够多,是哪个这是运行时的事情」——引擎不预判最小集,清单以齐全为目标,用哪个由使用者声明时决定(操作员裁决 1,2026-07-02) | SYNTH §一·设计裁决 |
| R2 | gate 失败/超时语义:声明时自选 `onFailure = hold \| advance`(操作员裁决 2) | SYNTH §一·设计裁决 |
| R3 | hook 身份:operator 全权——hook 子进程无凭证调 CLI,走操作员路径,不新增第三类主体;声明模型不引入凭证字段(操作员裁决 3) | SYNTH §一·设计裁决 |
| R4 | 声明位四层全支持(操作员裁决 4) | SYNTH §一·设计裁决 |
| R5 | 与 RFC-1 统一 gate 接口:推进决策点可绑定 kind = script \| agent-phase 判定器;公共 decision 闭集 `advance \| hold \| reopen(target, correctionItemIds)`;普通推进点只允许 `advance \| hold`,仅容器推进/par join 与顶层 join 允许 `reopen`;非法 point × decision 组合在边界拒绝;script 判定器执行机制归本 RFC(操作员裁决 5) | SYNTH §一·设计裁决 |
| R6 | 代码红线(2026-06-12 全仓统一):全链路 ADT,禁止类型退化;无 `any`/匿名形状;`unknown` 仅限 catch 与边界 parse 入口;禁真 `as`(`as const` 除外);外部输入经 arktype 边界 parse;违反 = changes requested 无例外(依据 #78/#109/#453) | SYNTH §一·约束 |
| R7 | 引擎零 gate 策略业务语义:轮数阈值、检查任务内容、插队位置全在 operator 脚本内;引擎只提供挂点、元数据、decision 协议 | SYNTH §一·约束 |
| R8 | hook 执行不得阻塞 daemon 主线程:禁止 `Bun.spawnSync` 形态,不新增已点名的阻塞债 | SYNTH §一·约束 |
| R9 | observer 自反挂点裁决(2026-07-02,当场裁):observer 挂点词表 = 事件枚举 − `hook.*`;声明期拒绝 + 发射期零派发双层;「hook 观测 hook」需求由事件查询面覆盖,无场景损失 | SYNTH §五·裁决记录 |
| R10 | 防抖指纹与评估代次两概念不合一(操作员裁决 2026-07-10) | SYNTH §二·gate evaluation 稿;§五·幂等稿切片 |
| R11 | 闭包转移边 observer-only、gate 决策点闭集不因闭包生命周期扩大(RFC-1 侧 2026-07-10 修订,双方联合结论) | SYNTH §一·跨 RFC 接口假设(逐字快照) |
| R12 | hook 声明写入面 operator 专属:一切写入通道对 agent 主体 deny(agent 可改声明 = agent 可自行解除 gate);拒绝留审计事件(已由落地事实证明) | SYNTH §三·声明模型·预期结果 5 |
| R13 | L1 引擎不注入 GitHub 面字段进 payload/判定输入;mergedness 自查归 preset 侧脚本(边界会话打回记录) | SYNTH §二·payload 稿·预期结果 6;join script 稿·预期结果 6 |
| R14 | 多 reopen 合成裁决:同 target 合并去重;异 target hold + diagnostic,绝不任选(见 D3) | SYNTH §一·已分配裁决 |
| R15 | tick 必须带节流声明才可挂;`minIntervalMs` 显式正整数无默认(见 I3) | SYNTH §一·核心设计;闭集裁决 |
| R16 | 「插队」不打断进行中 item 的 pipeline,只在 item 边界生效(phase-continuation 优先于 pending 选择)——v2 既有事实,gate 语义在其上构建 | SYNTH §一·现状事实 |

## 三、交付标准(全量验收行)

### 顶层:RFC 8 行关闭验证(唯一稳定的完成定义)

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | observer hook 在事件发生时被调用且元数据经 stdin 传入;自反订阅不可表达 | 声明 observer 订阅 `agent.exit` 并跑一个 run;另声明订阅 `hook.*` | `agent.exit` 脚本收到含该 run 元数据的 JSON 且调度不受影响;`hook.*` 声明装载期拒绝且发射期零派发 |
| 2 | gate hook 能 hold 调度决策 | post-run gate 返回 `hold` | 该 chain 不选下一个 item,事件流可见 hold;返回 `advance` 后恢复 |
| 3 | 操作员验收场景成立 | post-run gate 脚本算轮数、达阈值后在同一 evaluation scope 创建检查 leaf 并 `hold`;检查/修复 leaf 完成后再 `advance` | hold 期间原 seq 不推进;检查 leaf 及其派生修复 leaf 全部完成后才恢复;正确性不依赖全局 `(position, id)` 排序 |
| 4 | `onFailure` 两种语义都成立 | 同一挂点分别声明 `hold` / `advance` 的必崩脚本 | `hold`:决策点退避重问且事件可见;`advance`:记 diagnostic 后放行 |
| 5 | 四层声明位与合成语义成立 | 全局+chain+preset+item 同挂点各声明一个 gate | 按 全局→chain→preset→item 顺序执行,任一 hold 即 hold |
| 6 | hook 执行可观测 | 跑 1/2/4 各场景后查事件流 | 每次 hook 执行有 `hook.*` 事件(开始/结束/失败/decision) |
| 7 | 引擎无 gate 策略业务字面量 | grep 引擎源码中轮数/检查任务等词表 | gate 策略全在 operator 脚本;引擎只有挂点与协议 |
| 8 | script gate 的 reopen 判定 | 容器推进点 gate 先经带 evaluation scope 的 CLI 插入纠正 item,再返回 `reopen(target, correctionItemIds)` | 精确 IDs 被校验并认领;target 重开、seq 游标回退、已 terminal item 状态不变;预插入 mutation 不被伪称为 decision 消费事务的一部分 |

(此表在 SYNTH 中出现两份拷贝——RFC body 与综合验收稿——内容一致。)

### 按域归组的细化验收行(来自各稿验收表,去 issue 化)

**payload(域 F)**

| Check | 方式 | Expect |
|---|---|---|
| payload 三块齐全且过 schema | 单元:fixture chain/run 组装后经边界 schema 校验 | 三块在场;校验通过;版本标识在场 |
| 操作员场景数据面 | 单元:多 runs fixture 从运行态半边数 run 次数 | 「迭代进行了几轮」可从 payload 得出 |
| 零平行 shape | 类型级断言派生关系;grep 无重复字段手写定义 | 派生成立;无平行 shape |
| stdin 端到端交付 | 由 observer 执行域的「脚本收到含 run 元数据 JSON」行接管(payload 域本身只到单元级) | — |

**observer 执行(域 G)**

| Check | 方式 | Expect |
|---|---|---|
| observer 被调且 stdin 收 payload(RFC 行 1) | 声明订阅 `agent.exit`(fixture 脚本落盘 stdin),真跑 run | 收到含 run 元数据 JSON;调度不受影响 |
| 失败只记 diagnostic | 必崩脚本 + 超时脚本各一,真跑 | diagnostic 在场且点名 hook;调度照常;无重试 |
| 异步旁路 | sleep 长于 tick 间隔的慢脚本,观察 tick 节奏 | tick 不被拉长;脚本与调度并行 |
| hook.* 事件(RFC 行 6 observer 份额) | 跑上述场景查事件流 | 每次执行有开始/结束/失败事件,关联键可回溯 |
| 自反回路双层防护(发射期半边) | 发射路径对 `hook.*` 的派发检查(单元) | `hook.*` 事件零派发 |
| 无 spawnSync 新增 | 对 diff 范围 grep | 零新增 |

**gate 单点协议(域 H)**

| Check | 方式 | Expect |
|---|---|---|
| gate hold(RFC 行 2) | post-exit gate(首答 hold 次答 advance),两 item 队列真跑 | hold 期间不选下一 item、事件可见 hold 与退避重问;advance 后恢复 |
| onFailure 两语义(RFC 行 4) | 同挂点 `onFailure=hold`/`advance` 必崩脚本 | hold:扣住重问、事件可见;advance:diagnostic 后放行 |
| decision 边界 parse | 脚本分别输出非 JSON、词表外值、reopen | 均按 onFailure 处置,diagnostic/审计点名违规类别;无静默放行 |
| 多 gate AND 合成 | 同点两 gate:一 advance 一 hold | 合成 hold;改全 advance 后放行 |
| 检查 leaf 与 hold 因果闭环 | gate 脚本 evaluation scope 内 `item add` 检查 leaf 后 hold;完成后 advance | item 创建成功且带稳定 evaluation/task identity;hold 期间不推进;stdout decision 无 mutation 字段;不依赖 `(position,id)` 抢跑 |
| 其他 chain 不受影响 | 两 chain 一有 hold gate 一无,并行真跑 | 无 gate chain 照常推进 |
| decision ADT 穷尽 | typecheck;临时加词观察编译错误面 | 全处置点报错,无 default 吞掉 |

**决策点闭集(域 I)**

| Check | 方式 | Expect |
|---|---|---|
| pre-spawn gate | 声明(hold→advance)真跑 | spawn 被扣、重问事件可见;advance 后 spawn 发生 |
| 状态转移 gate | 声明后 agent 真实写 status | hold 返回结构化 `gate_held` 且 mutation 零落地;重试后 advance 才写入,事件可见 |
| tick 节流 | 带节流 tick gate 观察节奏;无节流声明 | 前者按节流执行(事件计数可证);后者装载期拒绝 |
| daemon startup/shutdown gate | 各声明一个先 hold 后 advance,起停 daemon | startup 显示 `starting-held` 且 scheduler 未启动;shutdown 显示 `shutdown-held` 且无新调度、socket 可查;advance 后完成转移 |
| 指纹防抖泛化 | 任一点 hold 后同一上下文连续多 tick | 不重复 spawn(指纹命中);上下文变化后重问 |
| 收编无残留 | grep chain-complete 指纹专用形态在复用点的残留 | 复用点全部走通用机制 |
| 四层合成顺序(直接声明层份额) | 全局+chain+item 同点各一 gate(记录执行序),其一 hold | 顺序 全局→chain→item;合成 hold |
| 决策点闭集穷尽 | typecheck;临时加 variant 观察错误面 | 全处置点报错,无 default 兜底 |

**幂等与恢复(域 J)**

| Check | 方式 | Expect |
|---|---|---|
| I1 崩溃重放 mutation 至多一次 | gate 脚本 `item add` 后立即自杀(不输出 decision);观察重问后第二次执行 | 同一 add 得首次 response 回放(key 命中事件可见);items 无重复;epoch 未递增 |
| key 与 mutation 同事务 | `item add` 成功后直接查状态存储 | item 行与 key 记录同时在场;无只有其一的中间态 |
| I2 decided 重启恢复不重问 | 脚本返回 decision 后 kill -9 daemon;重启 | decision 直接被消费,脚本不被重新 spawn;事件序列可证 |
| I2 evaluating 重启恢复同代次重问 | 脚本执行中 kill -9;重启 | 同 epoch 重问;重放 mutation 被 key 吸收 |
| ingress 扩展边界唯一 | journal/consumer 的 typed ingress seam contract test;validator 侧继承验收 | 只有一个 journal/consumer;新增 ingress 只能提交同一 decision ADT |
| I3 hold 后 epoch 递增与指纹正交 | 首答 hold;下一 tick 上下文未变;随后改变 | 未变不重问(指纹命中);变化后重问且为新 epoch(新 key scope) |
| I4 审计可追溯 | gate 脚本 `item add` 后 advance;查 `item.created` 审计 | 事件含评估 scope 标识字段 |
| operator 路径零影响 | 无注入 env 的普通 `item add` 同 itemId 两次 | 第二次仍 `duplicate_item` conflict |
| 评估状态机 ADT 穷尽 | typecheck;临时加 variant | 全处置点报错,无 default 兜底 |

**具名 gate 绑定(域 K)**

| Check | 方式 | Expect |
|---|---|---|
| 绑定执行(RFC 行 5 preset 层份额) | fixture preset 声明具名 gate 点,chain 层绑定脚本(hold→advance),真跑 | 声明点按 preset 层合成顺序执行;行为与其他层 gate 一致 |
| optional 未绑定空过 | optional gate 点零绑定,真跑 | 调度照常;跳过事件可见 |
| required 未绑定 | 零绑定分别创建新实例、恢复既有 pinned 实例 | 新实例结构化拒绝;既有实例 hold;都点名 gate,无 optional fallback |
| 层间遮蔽/回落 | 同名 binding 同置 global 与 chain 层 | 只执行 chain binding;生效视图显示 selected + shadowed;普通 hooks 不受影响 |
| 可分发性质 | grep fixture preset 全文 | preset 本体无本机脚本路径 |
| 四层全景合成(RFC 行 5 完整化) | 全局+chain+preset(绑定)+item 同挂点各一 gate,其一 hold,真跑 | 顺序 全局→chain→preset→item;任一 hold 即整点 hold |

**join script 与 reopen(域 L)**

| Check | 方式 | Expect |
|---|---|---|
| script join advance | par(join=script) 全成员 terminal,脚本 advance,真跑 | 引擎 spawn 脚本(非 agent leaf);外层 seq 推进 |
| script join hold | 首答 hold、重问改答 advance | 容器扣住重问(指纹防抖事件可证);改判生效 |
| script reopen(RFC 行 8) | 先经 evaluation scope CLI 插纠正 item,再 stdout `reopen(target, correctionItemIds)` | 纠正 item 追加进 target、seq 游标回退、已 terminal item 不变 |
| 非法 reopen target | reopen 指向未跑节点/跨 seq 节点 | 被拒 + 审计;容器状态不变 |
| reopen 合成 | 一 hold+一 reopen;两同 target reopen;两异 target reopen | reopen 优先;同 target 合并去重;异 target hold + diagnostic,容器不推进 |
| chain-complete script 实例 | chain metadata 顶层 join 绑 script,全 item terminal | 脚本判定 完成/keep-active(依赖 RFC-1 侧声明位迁移落地) |
| join ADT 穷尽兑现 | typecheck(variant 真实化后全消费点显式处置) | 通过;无 default 兜底 |

**收尾(域 M)**

| Check | 方式 | Expect |
|---|---|---|
| 操作员场景(RFC 行 3) | 多轮任务树真跑完整链 | hold 期间原 seq 绝不推进;检查→修复→完成才继续;移除/改变 position 不影响正确性;事件序列完整可证 |
| 阻止挂起走 post-exit hold | run post-exit gate hold,观察闭包在 phase 推进离开处 | hold 期间闭包不挂起(停 active);advance 后正常挂起;证明「推进被扣」而非「转移边被 gate」 |
| 文档派生守护 | 文档清单守护测试 | 挂点清单/payload 字段/决策点闭集与代码同步;人为 drift 时测试红 |
| 业务字面量守护(RFC 行 7) | 守护测试 + 人工 grep 复核 | 引擎无轮数/检查任务类 gate 策略词 |
| RFC 关闭映射 | 查证据映射登记 | 8 行逐行指向验收证据 |

**全域通用行**:每个交付面都要求 `bun run typecheck && bun test` 全绿。

## 四、显式决策项(已授权落地时裁,不算未决设计)

| ID | 决策项 | 所属域 | 来源 |
|---|---|---|---|
| P1 | 编译产物投影切片范围:全量 vs 按挂点相关切片(「全量元数据」语义与 payload 体积的平衡) | F | SYNTH §二·payload 稿 |
| P2 | 无 chain/item 上下文挂点(daemon startup/shutdown、tick)的运行态快照范围(与决策点闭集协调) | F/I | SYNTH §二·payload 稿 |
| P3 | 同一挂点多 hook / 跨 chain 并发触发同一脚本的互斥与重入语义(执行层公共语义,gate 侧继承) | G | SYNTH §二·observer 稿 |
| P4 | 评估状态与 key→response 快照的存储 shape(同表带 kind 还是分表)与快照序列化边界 | J | SYNTH §二·gate evaluation 稿 |
| P5 | 无宿主 id 决策点(daemon startup/shutdown、tick)的决策点身份构成(与 P2 对称,协调登记) | I/J | SYNTH §二·gate evaluation 稿 |

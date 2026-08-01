# RFC #547 R3：R4 供给侧设计符合性深审切片

> 基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
> 本报告只使用 `AGGREGATE-547.md`、`02-implementation-facts.md`、`03-raw-verification-results.md`、`03-draft-annotation.md`；未读源码、未运行实验。R2 的路径与符号仅作为待 R4 复核的线索，不作为符合性结论。

## A. 主 agent 摘要

### A1. 问题与结论

R4 不能沿旧 issue 或单一 symbol 深审。现存供给横跨六个不同的语义/事务边界：定义装载与公共 artifact、值从声明到实例再到渲染的类型流、定义树到运行态树的身份与提交、capability 声明到授权/执法握手、实例定义 pin 到恢复消费、以及通用引擎入口与持久化中残留的 GitHub/preset 原语。

**推荐六片，而不是暗示的五片。** 暗示的五片遗漏 D7/D9 的“通用引擎入口与存储退原语”供给；把它塞进 compile、runtime tree 或 resume pin 都会跨越不同权威判定点。D6 应并入 binding/type flow（它是 binding 声明到文档投影的消费者）；D8 应并入 compile artifact（它是装载期 finding）；D11 不另立供给深审片，而是 R4 汇总时的跨片覆盖/接缝核对，最终综合验收仍留在未来冻结 SHA。

| R4 片 | 报告路径 | 核心边界 | 主要稳定域 |
|---|---|---|---|
| S1 装载编译、artifact 与 finding | `05-r4-compile-artifact.md` | TOML/模板 → canonical model → 公共投影/schema/finding | D1、D8；§2 A/B/I、§2.3/2.4 |
| S2 binding 类型流与声明驱动消费者 | `06-r4-binding-type-flow.md` | source schema → binding → create-time admission → render/doc projection | D2、D6；§2 C–F、代码红线 |
| S3 定义树、运行态树、identity 与 transition commit | `07-r4-runtime-tree-identity.md` | compiled tree/path → 实例化事务 → SQLite/status/events → scheduler/closure | D3；D10 identity 接缝；§2.5 |
| S4 capability 注册、gate/tool 声明与执法握手 | `08-r4-capability-registry.md` | 声明/投影 → availability/outcome → runtime capability/授权 | D4、D5；§2 G/H |
| S5 不可变执行定义与 resume pin | `09-r4-resume-definition-pin.md` | instance pin → 定义内容存储 → resume/重启/缺失处理 | D10 |
| S6 通用入口与持久化退原语 | `10-r4-engine-primitives.md` | CLI/wire/create admission → chain/item 持久化 → status/recovery | D7、D9；§2 H、§2.5 的 `baseBranch` 例外 |

建议 **6 个 R4 subagent**，每片一人、只写各自报告。S1/S2/S4/S6 可独立源码深审；S3 与 S5 可并行，但必须交换“谁拥有定义内容、谁只持 ref”的接缝证据；S4 需从 S3 取得 host identity/decision-point 可表达性事实，但不审树调度；主 agent最后做一次矩阵核对，不新增需求。

### A2. 复杂边界

1. **D3/D10 必须拆开但不可断开。** S3 审“定义节点怎样实例化为运行节点、identity 如何贯穿事务和观测”；S5 审“实例引用的定义内容是否不可变且 resume 只按 pin 读取”。`ExecutionDefinitionRef` 的 shape/外键由 S5 证明，节点携带与跨面连续由 S3 证明。
2. **gate/tool 可同片但不能混成同一模型。** 两者共享 capability registry、compile projection、doctor/运行期消费者与“不得静默忽略”保证；S4 必须分别给出 gate 的挂点/host identity 与 tool 的 provider/availability/outcome/enforcement 四轴证据，不能以一个字段替代另一套语义。
3. **D7/D9 是第六片。** 它们审的是入口词表、wire shape、create admission、SQLite migration 与恢复，不是编译 DSL。R2 已显示 opaque item wire 与 presetless null 部分存在、repository 列/default seed 仍在；这是独立事务边界。
4. **D11 不属于现存供给实现片。** 它规定冻结 SHA 上的跨 consumer 验收和 real E2E 边界。R4 只能检查现有测试/驱动究竟证明哪些生产保证，不能把绿色测试当符合性，也不能提前执行未来综合验收。

### A3. 覆盖与置信边界

六片覆盖 §2 A–I、D1–D10、§2.5 五条引擎原生供给，以及 R2 登记的现存/部分现存资产；D11 由 R4 汇总核对 owner，不作为单独实现深审。没有资产无人负责。

尚未确定、必须由 R4 源码深审而非本报告补证的关键事实：canonical model 与投影是否真正同源；compile identity 与 runtime definitionNodeId 是否有生产映射；运行态树写入是否确实只存在 fixture；closure 原生行为是否存在 DSL override；GateDecisionPoint 现有词表是否能表达稳定条款要求的 host identity；definition 表是否足以恢复定义内容；repository v16 migration 的真实读写优先级；R2 所称 hook 四层“存储在”与“执行未接通”的准确边界。

**结论：可以进入 R4。** 进入条件是按六片任务书只审现存供给符合性；发现缺失时记录“无供给/部分供给”和接缝，不设计补齐方案，不推导 R10 需求。

---

## B. 证据附录

## B1. 六片任务书

### S1 — 装载编译、artifact 与 finding

**稳定条款**：§2 A/B；§2.3 最早可决定阶段与单一权威判定点；§2.4 variant 准入；D1 P-D1-1/2；D8 P-D8-1/2/3；S1/S2 公共供给。

**R2 所见现存供给**：`CompiledTaskModel`、`CompileResult` 两分支、`preset compile --json` schemaVersion 1、八个顶层块、root/phase identity、确定性字节、结构化 diagnostics；compile projection 中 tree/type/tools 的退化或空占位；plan 面已退役；dead-vocabulary finding 已在，dead-fragment 未见；schema artifact 未见。

**生产保证类别与审查问题**：

- 声明/装载编译：parse 是否唯一进入 canonical ADT；跨表检查和 finding 是否都在装载期且不靠 exception 文本。
- artifact/投影：公共 DTO 是否只有一个从 canonical model 出发的投影；root、phase、fragment、tool、tree identity 是否被完整投影；source hash、materialization 与字节确定性的输入边界是什么。
- schema 消费：公共 schema 是否真实可分发、能独立派生类型且无需执行 arktype；若不存在，只判“无供给”。
- finding：dead-fragment 的注册/消费关系能否由 compiled structure 判定；现有 declared-unused/dead-vocabulary 脏 finding 是否会掩盖它。
- variant：退化 task tree、固定 string、空 tools 是明确兼容基线还是 projection-only 假象；不得因 shape 存在判符合。

**明确排除**：ValueType 具体设计（S2）；非退化树语义与调度（S3）；工具/gate 真实声明（S4）；未来 schema artifact 的方案选择、doctor 是否应吸收 findings（R10，除非已有供给可审）。

**必要输入**：四份允许材料、S1/S2/S6 公共供给表；R2 A1–A8、C1–C3。报告必须列出 canonical→projection 每个块的源码证据与至少一个拒绝分支，不以 compile 实跑绿色替代设计链。

### S2 — binding 类型流与声明驱动消费者

**稳定条款**：§2 C/D/E/F、§2.2 红线、§2.3；D2 P-D2-1…7；D6 P-D6-1…3；S5 typed bindings。

**R2 所见现存供给**：item/chain/runtime 三种 source；字符串 binding、chain scalar default；item/chain 缺失可落 `""` 而 runtime 抛错；compile type 恒 string；无 ValueType/required/exit.*；item-field 有另一套类型词表；runtime-inputs doc 已消费 prefix/suffix/style/blankBefore 且源码无 ISSUE 分支；variables 外层 boundary 仍宽；测试 selector 仍按 ISSUE。

**生产保证类别与审查问题**：

- source schema/type authority：现有 item field、chain binding、runtime fact 是否有单一命名 domain type，还是跨边界坍缩。
- admission transaction：chain create、item add/batch-add、item update 各自在何时验证已有值；失败是否在事务写入前且有结构化诊断。
- render：缺失/default/stringify 三条路径是否存在静默伪造；结构值是否能 canonical projection；异常是否点名 binding/source。
- consumer：compile JSON、prompt bindings、runtime-inputs doc 是否消费同一 typed declaration；doc renderer 是否完全不读业务 key。
- exhaustive flow：新增 source variant 是否会迫使所有 parse/create/render/projection consumer 更新，还是可被 catch-all/default 隐藏。

**明确排除**：为缺失的 ValueType/exit.* 设计 variant、决定 json 默认呈现、决定首批结构类型（R10）；transition commit 的调度消费（S3）；prompt 落盘外部实现。

**必要输入**：R2 F1–F7、B1–B4 与 D2/D6 标注。必须复核 R2 内部修正：草稿称 chain missing 可 throw，R2 实测称它也静默 `""`；报告不得预选一方。

### S3 — 定义树、运行态树、identity 与 transition commit

**稳定条款**：D3 P-D3-1…9；§2.4 variant 准入；§2.5 起点、闭包分支、seq、par pin、回收/采样均为不可 override 的引擎原生行为；S6/S7；C3/C4/C5；D10 P-D10-6 仅作接缝。

**R2 所见现存供给**：运行态 leaf/seq/par ADT、cursor/reopen、drain|validator join、candidate `(definitionRef,candidateId)`、pinCommit、epoch/bindingVersion；v16 任务树/节点/join/closure/reachability/session/consumption 表；status/events identity；scheduler closure 生命周期；线性 phase 自动物化；R2 同时断言一般 `createTaskTree` 生产写入不存在、scheduler 仍按线性 index、无 TransitionPath/par guard/树 DSL。

**生产保证类别与审查问题**：

- 定义/实例化：现存退化 compiled tree 是否进入同一个 runtime tree constructor，还是另有 scheduler phase-list 旁路；树创建与 item/chain 创建是否同一事务。
- 存储身份：runtimeNodeId、definitionRef、definitionNodeId、compile identity 各自含义及唯一/外键约束；结构路径是否只展示。
- transaction/commit：seq readiness 当前究竟消费什么业务完成信号；join epoch/binding version 是否 append-only；closure reachability/consume 是否与节点状态原子协调。
- 恢复：daemon restart 对 cursor、closure、pinCommit、active run 的重建权威来源；fixture API 与生产 API 是否同一实现路径。
- 原生供给：fresh base、closure branching、seq flow、par same-commit pin、回收与消费采样是否没有 DSL 参数或 preset 名分支。
- consumers：SQLite/status/events 的 identity 集合是否可交叉核对；hook/GUI 未接入只能记录缺口。

**明确排除**：设计 seq/par TOML、transition path/exit schema、script join、par 调度语义（R10）；定义内容 pin 与 resume prompt（S5）；closure/worktree 需求再设计。

**必要输入**：R2 H1–H7、J6、issue-558/560 驱动的存在性描述和 §2.5。必须把“ADT/表存在”“fixture 可写”“生产 scheduler 消费”分成三种结论。

### S4 — capability 注册、gate/tool 声明与执法握手

**稳定条款**：§2 G/H；D4 P-D4-1…5；D5 P-D5-1…4；S3/S4；C1/C6。

**R2 所见现存供给**：compile tools/toolRequirements 空 shape；doctor 无条件检查 gh；无 tools 四轴和 toolRequirementsDoc；GateDecisionPoint 八点词表、四层 hook declaration、preset placeholder 类型与部分存储；preset TOML loader、gate 投影、unsupported-capability、脚本执行/decision/hold 路径未见。

**生产保证类别与审查问题**：

- registry：tool 定义、phase requirement、gate placeholder 是否各有封闭 ADT 和精确 boundary；空 projection 是否只是占位。
- orthogonality：tool provider/availability/outcome/enforcement 是否可分别表示；required 合法性是否只依赖 outcome。
- authorization/enforcement：doctor、prompt doc、runtime finalization 是否读同一 registry；required tool/gate 未支持时是否在调度前结构化拒绝而非忽略。
- gate host identity：现有 `container.advance`/`chain.complete` 等 point 是否携带或可关联稳定 host identity；不得自行把它等同聚合中的 `container.join`/顶层 join identity。
- consumer/execution：四层 declaration 的 merge/view/serialization 与真实 script execution 必须分别证明；“存储在”不等于“执行在”。

**明确排除**：设计 external wrapper/outcome 新 variant、runtime enforcement 机制、gate script/decision 语义、裁决 point 词表改名（R10）；树 host identity 的产生由 S3。

**必要输入**：R2 G1–G5、I1–I5 和 D5 词表冲突登记。报告需分别给 tool 与 gate 两张符合性表。

### S5 — 不可变执行定义与 resume pin

**稳定条款**：D10 P-D10-1…6；§2 A 的内容寻址关联、§2.3、§2.4；C3/C7；V-R10 只作未来验收锚点。

**R2 所见现存供给**：严格 tagged `PresetDefinitionRef | ChainDefinitionRef` boundary；execution_definitions identity/外键骨架；preset source directory bytes 的 SHA-256；semantic_hash 可能以 content_identity 占位；表不存定义内容；status/events/node 暴露 refs；resume 被报告为按当前 preset 重渲染，重启后重读当前源；定义缺失无 hold。

**生产保证类别与审查问题**：

- protected field set：目前到底有哪些创建前定义字段，哪些只存在 projection，哪些运行时值明确排除。
- content storage：ref 能否解析到完整、不可变、经过 boundary 校验的定义内容；hash 的对象是 source bundle、canonical ADT 还是 projection；semantic_hash 是否有独立意义。
- pin transaction：chain/item 创建成功前是否写定义和 ref；节点外键与实例提交是否原子。
- resume consumers：首次 spawn、resume 重渲染、daemon restart、status/events/hook 是否都沿 pin；路径 cache 不能冒充持久 pin。
- failure：定义缺失/损坏是否显式 hold/报错且绝不回退当前文件。
- join seam：运行态 join binding version 只属于实例演化，不得改变 definitionRef。

**明确排除**：设计 artifact store/MVCC/migration/rebind；决定 source hash 与 compiled hash 的未来组合（R10）；节点/closure 推进（S3）。

**必要输入**：R2 J1–J6、D10 标注、A7 确定性事实。必须解决 02 与 03 的表述差异：02 说“内容寻址与消费半边未做”，03 raw 修正 preset identity 已是真实源内容寻址；R4 应区分“hash 真实”与“定义内容可恢复”。

### S6 — 通用入口与持久化退原语

**稳定条款**：§2 H；D7 P-D7-1…4；D9 P-D9-1…3；§2.5 `chain.baseBranch` 是允许保留的一等引擎字段，其余分支/pin 声明不进 DSL。

**R2 所见现存供给**：opaque itemId wire 与 metadata.bindings 部分通路；queue unblock 仍用 issue；`--issue` 与 logs `--item` 名称冲突；repository 仍有 NOT NULL 列、CLI/daemon 格式准入，缺 repository 会被拒；preset 列可 null、显式 presetless 已在，但缺省仍 seed DEFAULT_PRESET_NAME；item 恢复使用 per-item preset；baseBranch 被 closure 真实消费；schema 已 v16，旧 v13→v14 验收过时。

**生产保证类别与审查问题**：

- CLI/wire：item id 是否在所有命令、socket、batch 路径保持 opaque；同名 flag 冲突的现状仅登记，不设计改名。
- create admission：repository/preset 缺省与格式检查在哪一层发生；是否存在 CLI 与 daemon 两套判定。
- storage/migration：chains.repository/preset/metadata.bindings 的当前 schema、写入优先级、读取兼容与冲突处理；真实 v16 migration 链是否无损且响亮失败。
- recovery/consumer：queue/status/scheduler/item resume 是否仍从 legacy 列或默认名补值；显式 null 是否跨重启稳定。
- zero primitive：所有 preset/GitHub 字面量是否是 L2 数据还是 L1 行为分支；`baseBranch` 保留是否只因真实 worktree 机制消费。

**明确排除**：提出新的 CLI 命名、migration 版本或 chain declaration schema（R10）；chain tree/top-level join 语义；实现代码与 issue 重拆。

**必要输入**：R2 D1–D9、E1–E4、D7/D9 标注与 §6-1/3/8。必须将旧验收路径过时登记为证据缺口，不能沿 v13 fixture 下结论。

## B2. 跨片接缝矩阵

| 接缝 | 左片必须提供 | 右片必须提供 | 主 agent 判定问题 |
|---|---|---|---|
| S1 ↔ S2 | canonical variable/doc projection 的来源与 DTO | 同一声明在 parse/create/render 的精确类型链 | projection 是否只是固定 string 假象 |
| S1 ↔ S3 | compiled root/node/path identity 全集与 tree shape | runtime constructor 对这些 identity 的映射及事务写入 | 是否存在 phase-list 第二模型 |
| S1 ↔ S4 | tools/gates/findings 的公共 projection 入口 | registry/placeholder 的真实声明与 compile diagnostics | 空 shape 是否被误报成供给 |
| S1 ↔ S5 | sourceHash/确定性/可投影的定义字段 | ref 可解析的持久定义内容与 hash 语义 | 当前文件查询与实例事实源是否分离 |
| S2 ↔ S3 | typed exit/input 数据边可用供给（没有则明确无） | readiness/commit 当前实际消费信号 | 是否以 terminal/runner exit 绕过数据边 |
| S3 ↔ S4 | host runtime/definition identity 与合法 decision point | gate declaration 对 host 的引用、调度前握手 | point 名存在是否足以定位挂点 |
| S3 ↔ S5 | 节点携带 ref、join version 与观测集合 | ref 的创建、解析、不可变内容与 resume | identity 连续与定义不漂移分别是否成立 |
| S3 ↔ S6 | baseBranch/closure 的真实引擎消费 | create/storage 中 baseBranch 的唯一合法一等入口 | 零原语清理是否误删必要机制 |
| S4 ↔ 外树 | 声明、outcome/gate 点、unsupported 结果 shape | runtime 执法/脚本执行能力 | R4 只判现有供给，不补外树需求 |
| 全片 ↔ D11 | 每片列可复现证据与未供给项 | 主 agent做 V-R owner/接缝核对 | 不提前把局部证据冒充冻结 SHA 验收 |

接缝证据不重复归属：生产者证明“值/identity/ref/声明如何产生且受 boundary 约束”，消费者证明“只从该值读取、失败时不 fallback”。双方都引用同一 ID 集或 fixture 并不构成重复。

## B3. D1–D11 全覆盖映射

| 域 | R4 owner | 供给审查范围 | 当前不属于供给审查 |
|---|---|---|---|
| D1 | S1 | compile ADT/result、公共投影、identity、determinism、schema artifact 是否存在 | schema 分发方案、doctor/findings 未决裁决 → R10 |
| D2 | S2 | 现有 source/binding/default/create/render/type projection | ValueType/exit.* 新设计与最小 variant → R10 |
| D3 | S3（与 S5 接缝） | 退化 compile tree、运行态 ADT/表/closure/identity/调度生产接线 | seq/par DSL、transition path、script join、par 语义 → R10 |
| D4 | S4 | 空 artifact、doctor gh、现有 capability/consumer | registry/outcome/enforcement 缺失能力设计与外树执法 → R10 |
| D5 | S4（host identity 取 S3） | decision-point ADT、四层 declaration、placeholder、loader/projection/执行/握手实际供给 | point 词表裁决、gate 执行设计 → R10 |
| D6 | S2 | doc declaration boundary、renderer、测试中的 key 依赖 | boundary 精化方案 → R10 |
| D7 | S6 | CLI/wire/storage/migration/opaque id/repository 实际路径 | 新 CLI 命名与 migration 方案 → R10 |
| D8 | S1 | plan 退役、dead-fragment/dead-vocabulary finding 与脏 findings | 新检查实现方案 → R10 |
| D9 | S6 | default seed、explicit null、per-item recovery、chain metadata 实际 boundary | chain declaration boundary 归属裁决 → R10 |
| D10 | S5；S3 审节点携带 | ref/hash/定义表/pin/resume/restart/status/events/join version | artifact store、缺失 hold、迁移/rebind方案 → R10 |
| D11 | 主 agent R4 汇总 | 现有 integration 驱动与每条 V-R 的供给 owner/证据能力 | 冻结 SHA 整链路 integration 与 real E2E → 后续验收阶段 |

## B4. §2 与 R2 资产覆盖核对

| 稳定约束/现存资产 | owner |
|---|---|
| A canonical compile、版本投影、按需计算、round-trip | S1；pin 接缝 S5 |
| B TOML 与 boundary schema | S1；各域精确 boundary 由对应片复核 |
| C/D/E/F ValueType、required/default、无 computed、doc 声明驱动 | S2 |
| G tool 四轴与 gate/tool 零原语 | S4 |
| H 六项零原语 | S4（doctor/tool）、S6（GitHub/default preset）、S2（key 特判）；主 agent汇总清零 |
| I plan 退役/dead-fragment | S1 |
| 代码红线、阶段原则、variant 准入 | 每片本域；主 agent汇总 |
| 起点/closure 分支/seq/par pin/回收采样原生供给 | S3；baseBranch 入口由 S6 |
| compile CLI、结构化 diagnostics、八块 artifact、root identity | S1 |
| string binding/chain default/静默空串/doc renderer | S2 |
| task-runtime ADT、v16 tree/closure tables、issue-558/560 drivers | S3 |
| empty tools shape、gh doctor、hook declarations/points/placeholders | S4 |
| ExecutionDefinitionRef、execution_definitions、source hash、resume current-file 风险 | S5 |
| opaque item wire、metadata.bindings、repository 列、preset null/default seed | S6 |
| context_entries 等 R2 仅登记的外树资产 | 不作本 RFC 符合性 owner；仅在对应消费者接缝实际读取时由 S3/S4 记录，不扩审本体 |

## B5. R4 必须保留的问题登记

1. **R2 证据层级混杂**：compile 实跑、grep、源码路径、fixture 驱动被并列为“实现在”；R4 必须逐项区分 shape、boundary、生产写入、生产消费和运行恢复。
2. **D3 生产接线未证**：02/03 均称一般树创建只有 fixture，线性 phase 自动物化又存在。S3 要找到所有生产 constructor/caller，不能据调用次数摘要直接裁决。
3. **D10 表述差异**：02 概述称“内容寻址半边未做”，raw 又证明 preset source hash 为真实内容 SHA-256。S5 应判定 hash 对象、持久内容、resolver 三件不同事实。
4. **gate 词表冲突**：稳定聚合写 `container.join`/chain-complete 顶层 join identity，R2 所见代码为 `container.advance`/`chain.complete` 且更多 daemon/tick 点。S4 只报告现状能否满足 host identity 保证，不裁词表。
5. **hook 存储/执行边界不清**：R2 称 global/chain/item 读取在、preset loader 无、script 不执行。S4 必须逐层列 declaration source、merge、serialization、dispatch、decision consumer。
6. **D6 已完成程度不一**：src key 特判据称清零，但测试 selector 仍依赖 ISSUE，outer variables boundary 宽。S2 应按生产保证分别判，不以“尾声”合并。
7. **D7 migration 基线过时**：v13→v14 验收无效，v16 当前列与迁移冲突策略未被 R2 完整核对。S6 必须从当前 migration 链重建事实。
8. **D8 finding 脏基线**：bundled compile 已有大量 unused/dead-vocabulary warnings；S1 要验证 dead-fragment 的判定域和可识别性，不能要求“findings 全空”。
9. **D9 boundary 归属矛盾**：聚合同时把 chain metadata parse 列作本树供给 S8 和外部消费 C2。S6 只定位现有 parser/consumer，归属与新设计留 R10。
10. **测试不等于设计证明**：issue-558/560、unit、engine integration 只可用于定位可执行路径；每片仍须从生产 boundary、transaction、consumer 与 failure path 给证据。

## B6. 排除到 R10 的需求侧内容

- 所有未实现能力的 ADT variant、TOML 语法、schema、artifact store、CLI 名称、migration 版本与错误事件设计。
- seq/par/transition path、ValueType/exit.*、tool outcome/enforcement、gate execution、definition hold/rebind 的补齐方案。
- chain declaration boundary 和 GateDecisionPoint 词表冲突的裁决。
- schema artifact 采用 CLI 还是独立发布物、doctor 是否吸收 findings、json 展示默认等未决项。
- 将现有运行态资产认定为未来实现“地基”、评估 PR 大小或重新拆 issue。
- D11 冻结 SHA integration、compatibility real E2E，以及外树 GUI/hook/context/tool enforcement 的需求推导。

## B7. R4 完成判据

每份报告须对本片每个稳定保证给出 `符合 / 部分符合 / 不符合 / 无现存供给 / 无法由本片确定`，并包含：生产 boundary、持久化或事务点、至少一个消费者、失败/恢复路径、与相邻片交换的 identity/ref/声明证据、明确排除项。主 agent只有在六份报告与接缝矩阵均能交叉核对、D1–D11 和 §2 覆盖无空 owner 后，才可结束 R4；结论不得转写为实施方案。

**尾部结论：R3 已形成六片、全覆盖、可证伪的供给侧深审设计；五片候选因遗漏 D7/D9 的独立入口/持久化事务边界而不完整。可进入 R4，但不得启动需求侧或综合验收。**

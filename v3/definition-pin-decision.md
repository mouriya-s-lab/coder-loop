# v3 裁决报告：运行实例定义绑定——源 bundle pin（边界 A）

> 裁决日期 2026-07-11，裁决主体操作员，产生于「边界 A：长时间运行实例免受 preset / CompiledTaskModel 漂移」受边界约束设计审查会话。
> 本报告是该裁决的权威记录；#605 / #549 / #558 body 的对应条款以本报告为源同步修订。影响面：#605、#549、#558、#552、#557、#582、#587、`design-boundary.md` §3.1、G1 行 7、G6 行 9。

## 1. 裁决内容

1. **「事前」= 实例创建；编译无时点权威。** 编译是源 bundle 的确定性纯函数，随时可重算出同一产物，因此「在哪个时刻编译」是伪问题；有权威的是 **pin 时点**：item create 冻结 item 的定义引用（默认继承 chain 的 pin；显式指定 preset 时在创建刻对当前文件 re-pin 为新 pin），chain create 冻结 chain 级结构声明（#566 顶层树/join、预算值）。task materialize 与 attempt spawn 只解引用，永不 pin。

2. **保护产物 = 源 bundle 的内容寻址快照（模型 B），不是编译产物 DTO（模型 A）。** 实例创建时物化源 bundle（复用既有 `materializePreset`，`src/loop.ts:4084`），definitionHash = bundle 内容 hash，实例行持久引用该 hash；同时记录 pin 时刻的 canonical projection **语义 hash** 与 schemaVersion 作验证钉。模型 A（持久化编译产物 DTO、运行时直接消费存档）被否决：① 需要 JSON→CompiledTaskModel 第二构造路径，违反 #605 明文「不得为持久化复制第二套 parser/IR」；② 迫使引擎对每个历史 schemaVersion 永久维护迁移，把消费端「schemaVersion 不符显式失败」的纪律反转成引擎侧无限兼容义务。

3. **重建走唯一编译管线 + 语义 hash 校验。** 运行/恢复/渲染按 definitionHash 定位 bundle → 唯一 compile 管线重编译 → 语义 hash 与记录一致则继续；不一致（引擎演化改变了闭集语义）或 bundle 缺失/损坏 → 显式 hold 并点名 definition identity，任何路径不得静默 fallback 到当前磁盘 preset。

4. **三项配套裁决（操作员 2026-07-11 确认）：**
   - #549 裁决 A 的「单一事实源是定义文件本身；按需计算不落缓存」加 scope：它回答的是「该 preset **现在**说什么」（compile CLI、新实例创建、ingress 预校验）；运行中实例的事实源是其 pin，两个问题答案不同、不冲突。
   - 语义 hash 只覆盖可保护字段闭集的 canonical 子投影；闭集外的 additive 演进（新 findings 类别、观测性字段）不参与。闭集逐字段清单在 #605 落地设计记录裁决（#605 准入条件不变）。
   - #558 的 shape 设计记录必须在设计期 comment 里即含实例定义引用（definitionHash）的存储位，不得留给 #605 作事后 schema migration。

## 2. 不可妥协不变量

1. **实例语义 = f(pinned definition identity, 运行态)，仅此二者。** 实例创建后 preset 路径/文件不再是该实例的语义输入——渲染、resume 重渲染、恢复词表（`statuses.entry`）、exits/trigger DAG、join 声明全部从 pin 读。
2. **definition identity = 源 bundle 闭包的内容 hash**（preset.toml + 全部被引用 fragment/模板，即 `collectPresetSourceFiles` 集合）。节点语义身份是 `(definitionHash, nodeId)` 对；node id 单独不构成定义相同的证据（#605 原文）。
3. **编译确定性是被测试守护的不变量**：同一源 bundle + 同一引擎 schemaVersion → 字节稳定的 canonical projection。
4. **缺失/不匹配 → 显式 hold 点名 definition identity**；prune、恢复、GUI 读一律不得 fallback 当前文件。
5. **definitionHash 写一次**：引擎不存在任何就地改写实例定义引用的操作（无 rebind API）。定义演进只有两扇门——显式新实例、另行裁定的显式 migration。
6. **运行态值永不进保护产物**（反向同样成立：定义产物无运行时写路径）：cursor、evaluation vector、decision、reopen 计数、动态 child、sessionIds、worktree 路径、par pin commit、binding 当前值、runner/model override、attempt 计数、keep-active fingerprint。
7. **动态物化继承 enclosing 实例的 definitionHash，绝不从磁盘 re-pin。** 同 chain 新增顶层 item 默认继承 chain pin；「新 item 才可选择 H2」的准确语义是显式选择，不是默认继承磁盘。
8. **唯一构造路径**：持久化的是源，重建走唯一 compile 管线；不存在 JSON→model 第二 parser。

## 3. 四域边界

| 域 | 内容 | 可变性 |
|---|---|---|
| definition（保护域） | 六块闭集：statuses/stateGraph、phases（任务树、join ADT、runner/model **默认值**、typed variable 声明、toolRequirements、rights）、tools、fragments 内容、findings | 写一次，内容寻址 |
| invocation/bindings | chain/item binding 当前值、`set-runner-model` / item `--runner` override | 可变；每 attempt 实际取值经 #572 prompt.md/bindings.json 冻结为**证据**（历史不漂移由证据层负责，不由定义层负责） |
| dynamic runtime tree | 容器身份、动态 child、par pin commit、seq 游标 | 运行态 |
| evaluation/decision | outcome vector、join 判定、reopen 计数 | 运行态 |

三条边界钉子：

- **定义保护 ≠ 世界冻结**。preset prompt 指示 agent 运行时读 `/Ext/app` 活文件、target 的 CLAUDE.md——那是 agent 运行时读取，走声明通道/escape 语义（`task-closure-decision.md` §3）。引擎只保证自己渲染进 effectivePrompt 的字节来自 pin。
- **函数演化（#564）的边界**：任何运行中语义变更不得以「切换定义版本」形态出现——rebind 在 API 面上不可表达，#564 的设计空间被限定在运行态域 + 显式 migration 门之内。本裁决只钉边界，不裁函数演化本体。
- **唯一原子性面 = 创建期写序**：「实例创建成功前完成编译、边界校验、内容寻址」隐含 definition 产物先于实例行的写序，否则 crash 窗口产生悬空引用。实现形态钉死：definitions 表进 SQLite（hash、schemaVersion、语义 hash、manifest），与实例行同事务写入；物化目录是渲染读面，允许滞后重建（从存储的 bundle 重物化后验 hash）。这是完全事前可计算的创建期义务，不是运行态事务，与「禁止 MVCC」不冲突。

## 4. v2 事实核查记录（2026-07-10 逐处核实）

| 事实 | 代码锚点 | 对裁决的意义 |
|---|---|---|
| `materializePreset` 已按 sha256 内容 hash 物化源 bundle 到 `preset-materialized/<name>-<hash>/`（含 staging、race 处理、marker） | `src/loop.ts:4084-4153` | 模型 B 的存储原语已存在 ~80%；缺的只是实例持久引用 hash |
| items 只存 preset **名/路径**（`items.preset` / `items.preset_path`），无任何内容锚点 | `src/sqlite-state.ts:396+`、`src/runtime-data.ts:110-115` | 正是 #605「仅持久化 preset 名或文件路径却声称定义已绑定」的反模式实证 |
| `prunePresetMaterializedRoot` 在 daemon 启动时删除所有非当前源 hash 的物化目录 | `src/loop.ts:4215`（`src/daemon.ts:4666` 驱动） | 现状不是「不保护」而是「主动销毁」旧定义；keep 集合必须改为「活实例 pin ∪ 当前源 hash」，且**与 pin 同 PR**，否则启动清扫吃掉 pinned bundle |
| `loadedPresetCache` 按源目录路径为 key，成功后永不失效（仅加载失败时 delete） | `src/daemon.ts:833、3686-3713` | 同一 daemon 进程内定义**偶然**不漂移；漂移在 daemon 重启时一次性兑现。pin 落地后缓存 key 改为 definitionHash，偶然语义转正（内容寻址缓存天然永不失效） |
| daemon recovery 是进程层善后（#508），不触 preset、不校验 item.phase | `src/daemon.ts:857-895、1745-1777` | 漂移症状面：重启后旧 item 下次 spawn 撞 `phase_not_found_in_preset`（`src/loop.ts:4872`），或更糟——静默按新语义跑 |
| scheduler 主路径 resume 实发重新渲染的完整 effectivePrompt | `src/scheduler.ts:1006-1022`（`task-closure-decision.md` §4 已钉） | resume 是漂移进入面之一；pin 落地后渲染输入全部来自 pin，resume 自动被覆盖，但落地 issue 须显式点名（此处历史上出过讹传） |
| phase 身份全链路是字符串 name（`items.phase TEXT` 等），无别名/迁移机制 | `src/sqlite-state.ts:396/450/460` | `(definitionHash, nodeId)` 成对身份是唯一出路，rename 类漂移不可能靠字符串层自愈 |

## 5. 最强反例与化解

**编译器演化 hold 风暴**：dogfood 下每次 app 更新都重启 daemon（`daemon-restart-after-app-update` 规则）；若验证钉覆盖面过宽（findings、注释性字段、字段顺序都算），一次无害引擎升级就 hold 全部在途实例，operator 被迫造「忽略 hold」旁路——旁路一旦存在，保护名存实亡。化解是结构性的：语义 hash 只盖可保护字段闭集的 canonical 子投影（裁决 4-②），闭集 shape 本身变更必须 bump schemaVersion 并走显式 migration 裁决。这把 #605「先列字段闭集」的准入条件从文档要求变成可执行工程物。

模型 B 的残余暴露被显式接受：**引擎演化漂移**（编译器改了，同源产出不同闭集语义）表现为 hold，不假装保护。想连引擎演化都保护等价于给每个实例陪葬一份旧引擎代码，越过 v3 边界（`design-boundary.md` §5 精神）。

## 6. Falsifier

1. **确定性测试**：同一 bundle 跨两次进程启动/两台机器编译，canonical projection 字节不相等 → 模型 B 地基崩塌，被迫退向模型 A（届时「唯一构造路径」约束需操作员重裁）。现实风险点：map 迭代序、绝对路径混入投影、`{{PRESET_ROOT}}` 物理替换被算进投影。
2. **G1 行 7 / #605 function 验收行原样**：H1 创建 → 跑到 hold → 改 H2 → kill -9 → 重启 → 旧实例仍 H1、新实例 H2、全消费者同 identity。
3. **爆炸半径测试**：只新增 findings 类别的引擎升级不得 hold 任何 pinned 实例；改变 join 归一化的升级必须 hold 且点名 identity。做不出该区分 → hold 风暴反例成立，闭集粒度退回重裁。
4. **#564 反证**：若函数演化最终设计被证明必须就地 rebind 才可表达，不变量 5 被证伪，migration 门需扩宽——那是显式操作员裁决点，不是实现自由度。

## 7. 对既有产物的修正清单

| 产物 | 修正 | 状态 |
|---|---|---|
| #605 body | 新增裁决记录节（模型 B、pin 时点、验证钉、原子性面显式承认）；完成态片段点名 resume 重渲染路径 | 本次执行 |
| #549 body | 新增「与 #605 的 scope 边界」节（裁决 A scope 限定） | 本次执行 |
| #558 body | 预期结果与验收 assumption 行补实例定义引用（definitionHash）存储位要求 | 本次执行 |
| `design-boundary.md` §3.1 | #605 锚点段补本报告引用 | 本次执行 |
| #552/#557 | 「per-item preset」在 pin 语义下读作「item pin 的定义」——落地实施时按本报告解释，body 不回改（append-only 快照引用不动） | 登记 |
| #587 | 「上游 shape 演进自动传导」只作用于 shape（schema 派生），不作用于内容：旧实例 payload 的编译产物半边来自 pin 的定义投影 | 登记，落地时执行 |

术语防讹传登记：「运行态快照」（`StatusSnapshotBoundary` 读投影，合法）≠ 操作员禁令中的「运行态 MVCC/事务快照」（存档形态，非法）；par pin commit 的「pin」（git 世界，运行态）≠ 定义 pin 的「pin」（定义世界，写一次）。后续文档使用时须区分命名。

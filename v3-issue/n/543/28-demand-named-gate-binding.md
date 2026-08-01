# RFC #543 · R10 需求侧：preset 具名 gate 绑定

> 本文只从 `01-clauses.md` 的 D1、D4、K，`23-expected-foundation.md`，以及既有供给/接缝报告的主摘要推导需求。本文不读取源码、不做实验、不选择 schema、API、表、文件、缓存或锁的物理形态，也不拆 implementation issue。文中的“原子”只描述必须同时成立的可观察结果。

## A. 摘要

preset 具名 gate 的目的不是在 preset 中间接藏一条本机路径，而是把**可分发的策略要求**与**部署现场的可执行授权**分开。preset DSL 只给出稳定名称、gate point 与 `required | optional` 必要性；全局和 chain 层分别可以为名称提供脚本绑定。解析时 chain binding 遮蔽 global binding，最终只有一个 selected binding 进入 preset 层的执行位置；被遮蔽来源仍必须可见，但绝不能被执行。

解析结果只有三态：`bound`、`optional-unbound`、`required-unbound`。`bound` 沿统一 gate evaluation 路径执行；`optional-unbound` 空过并留下可见记录；`required-unbound` 对新实例实行结构化创建拒绝，对既有 pinned 实例的恢复实行显式 hold。不得把 required 降级为 optional，不得在恢复时改用另一脚本，也不得让 preset compile 依赖某台机器的 binding。

RFC-2 必须供给可分发 DSL 声明、公共 compile projection 与 pinned definition resolver；#543 自建 binding 边界、解析/遮蔽、创建 admission、恢复 hold、执行接线及 selected/shadowed 可见性。现有 typed hook declaration、四层 effective-view 顺序、operator-only mutation 分类和 durable definition identity 是可复用地基，但 placeholder 骨架不等于 binding 已落地。

## B. 需求语义

### B1. 可分发声明

1. preset DSL 的每个抽象 gate 声明必须携带稳定 `name`、其 gate point，以及穷尽的必要性 `required | optional`。
2. `name` 是部署侧 binding lookup key，不是脚本路径、命令行或主机资源标识；preset TOML、模板与公共 compile projection中不得出现本机脚本路径通道。
3. preset compile 只校验抽象声明自身及 point 所需约束；它不读取 global/chain binding，也不因当前机器缺少 required binding 而失败。
4. 公共 compile projection 必须保留声明的 name、point、必要性与 provenance，使运行实例能从 pinned definition 得到同一抽象要求；#543 不另造一份平行 preset shape。

### B2. binding 与角色隔离

1. global 与 chain 层都可声明 `gate name → executable binding`；binding 至少保留普通 gate 执行所需的脚本身份、timeout 与 `onFailure` 语义，但本文不规定其物理表示。
2. binding 配置必须经过精确 typed boundary；未知、缺损或非法字段产生结构化拒绝，不能用默认脚本、默认失败策略或宽松 object 吞掉。
3. “为 preset named gate 提供 binding”和“在 global/chain 层直接声明普通 hook”是两个角色。前者只填充 preset 层抽象位置，后者仍按自己的直接声明层执行；同一配置来源同时存在这两种角色时也不得互相去重或替代。
4. binding mutation 属 operator-only 配置权；hook/agent 身份不能借现有 mutation command 改写 global/chain binding。授权校验必须在权威写入 admission 内发生，而不是只靠 CLI 展示层或调用约定。

### B3. 解析、遮蔽与分发安全

1. 对每个 pinned preset named gate，解析顺序固定为 chain binding 优先于 global binding；chain 命中时它是唯一 selected binding，global 同名项为 shadowed source。
2. shadowed binding 只用于解释与审计，零 spawn、零 decision、零 failure effect；不得把 global 与 chain 同名 binding 当成 D2 的两个 gate 做 AND 合成。
3. 未命中 chain 时才可选择 global；两层均未命中时按 preset 声明的必要性进入 optional-unbound 或 required-unbound。
4. 一个 selected binding 进入 effective view 的层级是 preset，因而它与其他直接 hook 的总体顺序仍是 global → chain → preset → item；它不因来源是 global 或 chain 而移动执行层级。
5. preset name 到 binding 的解析只产生下述三态，所有调用者必须穷尽处置，不允许 catch-all/default：
   - `bound`：携带 selected binding、其来源和全部 shadowed provenance；
   - `optional-unbound`：不执行脚本，记录可见 skip；
   - `required-unbound`：不执行脚本，进入对应 lifecycle admission 失败语义。
6. `bound` 后的 gate 与普通 gate 共用同一 evaluation、decision parse、`onFailure`、journal、hold/reopen 合成路径；不得因其来自 named binding 而产生第二套执行协议。

### B4. 创建、恢复与 pin

1. 新运行实例创建时，必须针对该实例的 pinned definition 穷尽解析全部 named gates；任一 required-unbound 都使创建结构化拒绝，并逐项点名 gate name 与可审计来源。不得先创建可运行实例再异步发现缺绑定。
2. optional-unbound 不阻止创建；其空过状态必须在 effective hooks/status 读面及统一事件因果链中可见，避免“没有执行”和“系统漏派发”不可区分。
3. 创建成功时，实例所采用的 pinned definition identity、各 named gate 的解析结果、selected binding identity/provenance 与实例可运行事实必须形成一个不可撕裂的 durable outcome。崩溃后不能出现“实例已创建但不知道当时选择了哪个 binding”，也不能出现“binding 已认领但实例不存在”的半状态。
4. 既有实例恢复必须先按其 pinned definition 读取抽象声明，再恢复该实例已固定的 binding resolution；不得重编译当前路径，不得因 global/chain 配置后来变化而为旧实例换脚本。
5. 既有 pinned 实例所固定的 required binding 在恢复时不可取得、不可验证或不可执行，结果必须是显式 hold，并暴露 gate name、pinned definition identity、selected binding provenance 与 typed failure；不得回退 global、降级 optional、静默空过或另选当前同名脚本。
6. pinned optional-unbound 恢复后仍是 optional-unbound；它不能因现场后来新增同名 binding 而无审计地变成 bound。若产品未来允许显式 rebinding，那是独立、operator-authorized lifecycle mutation，不是 restart resolution 的隐式副作用。

### B5. 可见性

1. effective hooks/status 必须对每个 named gate 显示 name、point、required/optional、三态解析结果、selected source/identity，以及存在时的 shadowed source；本机敏感执行细节只按既有安全边界展示，本文不扩张 secret 暴露面。
2. 创建拒绝、optional skip、恢复 hold、binding parse/admission failure 都必须使用稳定 typed category，并关联 pinned definition 与实例 identity；不得只写自由文本 stderr。
3. selected/shadowed 可见性是解释解析结果，不授予 shadowed binding 执行权，也不改变四层合成顺序。

## C. 原子需求清单

| ID | 原子需求 | 可观察失败 |
|---|---|---|
| NB-01 | RFC-2 DSL/compile projection以精确类型表达 `name + point + required|optional` | runtime 只能猜必要性或复制 DSL shape |
| NB-02 | preset artifact 零本机脚本路径通道 | preset 不可分发或泄漏主机布局 |
| NB-03 | compile 与现场 binding availability 解耦 | 同一 preset 在不同机器无法独立 compile |
| NB-04 | global/chain binding 由 typed boundary 穷尽 parse | 非法 binding 被默认或静默忽略 |
| NB-05 | binding mutation 只经 operator-authorized admission | hook/agent 可提升自身执行权 |
| NB-06 | chain-over-global 只选择一个 effective script | 同名脚本被执行两次或错误 AND 合成 |
| NB-07 | selected 仍处于 preset execution layer | 来源层改变整体执行顺序 |
| NB-08 | bound/optional-unbound/required-unbound 穷尽解析 | 未绑定状态被 catch-all 放行 |
| NB-09 | optional-unbound 空过且可见 | 无法区分合法 skip 与漏派发 |
| NB-10 | required-unbound 在新实例创建前结构化拒绝 | 半创建实例进入调度后才失败 |
| NB-11 | 创建、definition pin、binding resolution 与 runnable admission 是不可撕裂 durable outcome | restart 后实例与选择结果不一致 |
| NB-12 | bound 复用唯一 gate evaluator/journal | named gate 形成第二协议与恢复路径 |
| NB-13 | 恢复按 pinned definition 与已固定 binding resolution | source/config 漂移改变旧实例行为 |
| NB-14 | pinned required binding 缺失时 hold，零 fallback/换脚本/降级 | 旧实例静默执行不同授权代码 |
| NB-15 | selected 与 shadowed provenance 同时可查询，shadowed 零执行 | 排障无来源或 shadowed 获得副作用 |
| NB-16 | parse、拒绝、skip、hold 均有 typed category 与稳定因果 identity | 只能从自由文本推断运行态 |
| NB-17 | 直接 global/chain hook 与 named-binding provider 角色隔离 | provider 意外多执行或直接 hook 被吞 |
| NB-18 | restart 不把新增 binding 隐式应用到旧 optional-unbound 实例 | 重启成为未经授权的 rebinding |

## D. 地基、自建与 blocker 分类

| 分类 | 需求/资产 | 判定 |
|---|---|---|
| 地基直接供给 | typed hook declaration ADT、global→chain→preset→item effective-view 层序、普通 gate timeout/onFailure 语义、operator/agent auth 分类、durable runtime/definition identity | 可复用，但只证明边界与槽位存在，不证明 named binding consumer |
| #543 自建 | NB-04–NB-18 中的 binding parse、operator admission、chain-over-global resolver、三态处置、创建拒绝、resolution pin、恢复 hold、统一 evaluator 接线、status/event selected+shadowed 可见性 | #543 owner；不得下沉给 RFC-2，也不得用 placeholder 测试冒充完成 |
| RFC-2 blocker | NB-01–NB-03 及 NB-13 所依赖的 pinned definition公共 projection/resolver | **RFC-2-PIN / RFC-2-RESOLVER**；RFC-2 未供给时，#543 不得另建 hook 专属 resolver或当前路径 fallback |
| 组合接缝 | NB-11、NB-13、NB-14 | 需在冻结 RFC-2 供给 SHA 与 #543 runtime 上联合证明；任一侧局部绿色都不足以关闭 |

本域没有 RFC-1 blocker。named binding 只决定哪个 gate executable 获得执行授权；它不改变 decision ADT、reopen authority 或外部副作用责任边界。

## E. 接缝证明计划

1. **可分发 compile：** 同一 preset 在无 binding、只有 global binding、chain override 三种现场 compile projection 相同；projection 含 name/point/必要性且不含本机路径。
2. **三态与遮蔽：** 对 bound、optional-unbound、required-unbound 做穷尽运行；chain/global 同名时只启动 chain-selected脚本，status 同时展示 selected 与 shadowed，shadowed execution计数为零。
3. **创建 admission 原子性：** required 缺失时实例、调度、事件与进程均无半创建副作用；在 durable outcome 各 commit 边界 kill/restart，观察实例与 pinned resolution始终全有或全无。
4. **pinned recovery：** H1实例选择脚本 B1；随后源路径变 H2、global/chain配置改为 B2并重启。旧实例仍解析 H1并保持 B1 resolution，新实例解析 H2/B2。移除或损坏 B1时旧实例进入可查询 hold，绝不执行 B2。
5. **optional recovery：** H1实例创建时 optional-unbound；之后新增同名 binding并重启，旧实例仍可见 optional-unbound且零 spawn，新实例按新现场解析 bound。
6. **授权：** operator binding mutation成功；agent/hook携 credential尝试同一 mutation得到 typed拒绝且 durable binding不变。授权检查与写入间故障不产生未经授权的 selected resolution。
7. **统一执行路径：** selected named gate覆盖 advance、hold、非法 stdout、timeout与 `onFailure`；journal/status/event结果与同参数普通 gate一致，证明零第二协议。
8. **角色隔离：** 同层同时配置直接 hook与同名 provider，验证直接 hook按自己的层执行一次、selected provider仅在 preset位置执行一次，无合并、吞掉或重复。

## F. 尾部核对

- 原子需求：**18**（NB-01–NB-18）。
- 分类计数：地基直接供给 **4 类资产**；#543 自建 **15 项需求范围**（NB-04–NB-18）；RFC-2 blocker **3 项直接需求并影响 pinned recovery 接缝**（NB-01–NB-03、NB-13）；组合接缝 **3 项核心原子保证**（NB-11、NB-13、NB-14）。分类可交叠，不能相加为需求总数。
- 外部 blocker：**1 组**——RFC-2 pinned definition artifact/resolver（沿用 `RFC-2-PIN / RFC-2-RESOLVER` 两个供给标记）。
- 剩余操作员产品裁决：**0**。外部脚本的文件、Git、数据库及第三方 effect 仍由脚本作者负责，引擎不兜底。
- 未选择 schema、API、表、列、索引、文件、锁、缓存、artifact 介质、resolver 返回形态或 migration 方案。
- 未实现代码、未运行实验、未拆 issue、未创建 worktree。

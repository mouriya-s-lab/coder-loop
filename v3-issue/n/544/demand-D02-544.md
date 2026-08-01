# RFC #544 R10 / D2 — per-attempt prompt 与 bindings artifact 原子需求

> 输入边界：只读 `AGG-544-gui-observability-gateway.md` 的 D2、`expected-foundation-544.md` 的 F16–F21/X03/X04/U11–U13，以及 `decision-S4-attempt-544.md` 的稳定摘要。本报告不读取源码、旧 issue 或实现，不选择存储载体，不拆 implementation issue。D2 只负责 per-attempt 输入 artifact；D11 仍是 current name-based compile。

## A. 主 agent 摘要

D2 需要建立一个以 **attempt identity** 为键的输入快照：同一次 resolver/render 产生 pinned definition identity、完整 binding entries、resume 元数据和唯一 `effectivePrompt`；runner argv 与 artifact 只投影这一个内存产品。每个 fresh、普通 resume、finalizer 特例 attempt 都必须留下 `prompt.md` 与 `bindings.json`。普通 resume 保存当次完整 phase prompt、resume 标记与 session 引用；finalizer 的固定“继续”只属于其专用 variant。

完整 artifact pair 的发布边界必须避免把半写状态冒充成功：只有 prompt 与 bindings 都来自同一 attempt input packet、都完整可读时，typed read 才返回 `present`。任一写入失败或进程在发布中断，attempt 仍继续，但读取结果必须是 `write-failed/incomplete`，并产生 D2 唯一要求的 diagnostic event；不得从 argv、stdout、当前 preset 或 GUI 重建。这里要求的是 **单个 attempt artifact pair 的一致发布与失败分类**，不是 runner 提交事务、通用 durable operation、跨 SQLite/events/files 的共同 commit 或 crash-recovery 平台。

D2 的 identity 最少包含稳定 attempt/run/phase 归属、attempt variant，以及其完整 pinned definition identity。CAP-2 提供并约束 definition 在 spawn/retry/daemon restart 生命周期操作中的可达解引用，D2 必须消费该 resolver，不能重读同路径 current preset。D2 自建 artifact pair 的写入、发布状态、独立 typed read boundary 与失败分类；D10 只消费这个 route 并逐字展示，不要求 artifact 进入 status。

`bindings.json` 当前合同以每个 `{{KEY}}` 的 source 与 scalar render string 为基线。CAP-3 到达后只能通过 additive typed seam 增加证据，不能改变旧字段语义；精确 typed shape 未知不阻塞 D2。保留随 run 目录既有生命周期，D2 不新增 TTL、无限保留或 GC 合同。

### A1. 结论计数

| 分类 | 数量 | 结论 |
|---|---:|---|
| D2 必须自建的原子保证 | 9 | identity/input packet、两类 resume、pair publication、失败分类、typed read、diagnostic、逐字读取、CAP-3 seam |
| 预期地基已供的保证 | 4 | CAP-2 pinned 可达、events 可见通道、artifact 独立 route 规则、scalar + additive typed 基线 |
| 真正地基未闭合 | 0 | U11–U13 是运行证明或外部 shape 未知，不是需求缺口 |
| 非阻塞未知 | 3 | U11、U12、U13 |
| 明确排除的范围增长 | 7 | historical D11、TTL/GC、重建历史输入、runner事务、通用 durable operation、共同 commit、CAP-3 shape 猜测 |

## B. 原子需求矩阵

### B1. D2 自建保证

| ID | 原子保证 | 身份 / 读写 / 发布 / 恢复语义 | 地基映射 | 验收可证伪点 |
|---|---|---|---|---|
| **D2-R01** | attempt artifact identity | artifact pair 绑定稳定 attempt/run/phase identity、attempt variant 与完整 pinned definition identity；不同 retry/resume 不共享可变“当前”身份 | F16、F19、X04 | 两次 attempt 即使同 phase/name 也能按各自 identity 读回，且 definition identity 与当次解析一致 |
| **D2-R02** | 单一 attempt input packet | 同一次 resolver/render 产生 definition identity、完整 bindings、resume metadata 与唯一 `effectivePrompt`；argv、`prompt.md`、`bindings.json` 只从该 packet 投影 | F16 | `prompt.md` 字节与交给 runner invocation 的 prompt 值相等；bindings 与同次 resolver 结果逐项相等 |
| **D2-R03** | fresh / 普通 resume 完整性 | fresh 与普通 scheduler resume 都保存当次真实完整 `effectivePrompt`；普通 resume 包含 resume 标记与所续 session 引用 | F16 | fresh 与普通 resume 各自读回真实实发输入，普通 resume 不退化为固定“继续” |
| **D2-R04** | finalizer variant 隔离 | chain-complete finalizer 的固定“继续”作为显式特例保存，不外推到普通 resume | F16 | finalizer 与普通 resume 的 variant 和内容分别匹配各自 argv |
| **D2-R05** | artifact pair 一致发布 | typed read 仅在 prompt 与 bindings 都由同一 input packet 完整发布后返回 `present`；半写、截断或 identity 不匹配不得被当成成功 pair | F16–F18、X04 | 在两文件任一写点注入失败/中断，消费者不能得到伪 `present` 或跨 attempt 混配 |
| **D2-R06** | 非阻塞失败与最小恢复 | artifact 写入/发布失败不阻止 runner attempt；失败或遗留 partial 在恢复/读取时分类为 `write-failed/incomplete`，不从其他来源补造并冒充原输入 | F17、F18 | 写失败后 runner 仍启动；重启后 partial 仍不被展示为完整输入 |
| **D2-R07** | diagnostic 唯一义务 | D2 artifact 失败产生可关联 attempt identity 的 diagnostic event；成功路径不新增事件 | F17、X03 | 失败恰有可定位 diagnostic，成功路径为零新增 D2 event |
| **D2-R08** | 独立 typed read boundary | 提供 engine-owned typed artifact route，结果至少穷尽 `present`、`legacy-missing`、`write-failed/incomplete` 与精确 parse/read failure；artifact 不进入 status wire | F18、X01、X04 | D10 可经该 route 逐字读取；各缺失/失败 variant 不被 nullable/catch-all 折叠 |
| **D2-R09** | bindings 基线与 additive seam | 每个 KEY 保存 source 与 scalar render string；为 CAP-3 owner shape 保留 non-breaking additive typed seam，但当前不猜字段/variant/复合值编码 | F21、X04 | 旧 scalar 消费保持不变；没有 CAP-3 产物时完整满足基线 |

### B2. 预期地基已供

| ID | 已供保证 | D2 如何消费 | 不得误扩 |
|---|---|---|---|
| **D2-F01** | F19：attempt 所属 pinned definition 可按完整 identity 在 spawn/retry/restart 生命周期操作中解引用 | D2-R01/R02 只调用该 identity resolver 取得当次 definition | 不把 artifact 自身当完整 definition repository；不重读 current path |
| **D2-F02** | F17/X03：events 是 artifact failure 的可见诊断通道，payload 语义由 D2 拥有 | D2-R07 发出唯一要求的 diagnostic event | 不要求 event 与文件或 runner 共同 commit |
| **D2-F03** | F18/X01：attempt artifact 使用独立 typed route，不要求进入 status | D2-R08 输出 artifact boundary，供 D10 消费 | 不新建 parallel status wire，也不把 artifact 塞入 status snapshot |
| **D2-F04** | F21：scalar render string 基线与 CAP-3 additive seam | D2-R09 先交付 scalar+source，后续从 owner boundary additive 派生 | CAP-3 精确 shape 不作为 D2 启动 gate |

### B3. 供需归属与未闭合判断

| 需求面 | 预期地基已供 | D2 自建 | 真正地基未闭合 |
|---|---|---|---|
| identity | CAP-2 的完整 pinned identity 与生命周期可达性（F19） | attempt/run/phase/variant 与 pinned identity 的 artifact 归属（R01） | 无 |
| render/write | 同源与覆盖范围是固定保证（F16） | input packet、fresh/resume/finalizer 投影、文件写入（R02–R04） | 无 |
| atomic publication | 地基禁止把 artifact 升级为 runner 事务（F17） | 单 attempt pair 的 complete/partial 发布判定（R05） | 无；具体载体由实现选择 |
| recovery | pinned definition 在 daemon restart 后仍可达（F19） | partial 分类、非阻塞继续、不重建（R06） | 无；不要求通用 recovery framework |
| diagnostic | events 通道与不要求共同 commit（X03） | D2 failure event identity/payload 与成功零事件（R07） | 无 |
| typed read | artifact 独立 route、D10 如实消费（F18/X01） | engine-owned artifact result ADT 与精确 parser（R08） | 无 |
| typed values | scalar + additive seam（F21） | 保存 KEY/source/render string 并预留 owner-derived typed evidence（R09） | 无；CAP-3 shape 是 U13、非阻塞 |

### B4. 非阻塞运行未知

| 未知 | 对 D2 的影响 | 不能推出 |
|---|---|---|
| **U11** fresh、普通 resume、finalizer 与写失败的真实 runner 全路径 | 决定 R02–R08 的专项 fixture/E2E 样本 | 不能弱化同源、覆盖范围、非阻塞失败或 typed 失败分类 |
| **U12** definition 历史、repository 可达性与 GC 实现 | 验证 D2 对 CAP-2 resolver 的消费和 restart/retry 路径 | 不能新增 TTL、无限保留或 historical D11 |
| **U13** CAP-3 精确 typed shape | owner 到达后验证 additive 派生 | 不能阻塞 scalar 基线，也不能由 D2 猜 union/字段 |

### B5. 明确排除

1. 不把 D11 扩成 historical-pinned compile、current+pinned 双视图或历史 diff。
2. 不新增 TTL、无限保留、固定 GC 算法或独立于 run 目录生命周期的保留合同。
3. 不从 argv、stdout、当前 preset 或 GUI rerender 重建缺失 artifact。
4. 不把 artifact publication 与 runner spawn/exit 合成提交事务。
5. 不建立通用 durable operation、operation query/replay 或 recovery framework。
6. 不要求 SQLite、events、artifact files 与 runner 共同 commit、outbox、saga 或 command log。
7. 不猜 CAP-3 的字段、variant、复合值编码；只保留 additive typed seam。

### B6. R11 接缝

| 接缝 | 供方 | 消费方 | 固定边界 |
|---|---|---|---|
| pinned definition resolver | CAP-2 / F19 | D2-R01/R02 | 完整 identity 可达；D2 不读 current path |
| diagnostic event | events / X03 | D2-R07 | D2 拥有 failure payload；无共同 commit |
| artifact typed route | D2-R08 | D10 / F18 | 独立于 status；逐字 prompt、精确 bindings、穷尽缺失/失败 |
| additive typed values | CAP-3 / F21 | D2-R09 | scalar 基线不变，owner shape 到达后派生 |


# RFC #544 R10 / D11 — current preset compile 预览原子需求

> 输入边界：只读 AGG D11/CAP-7、`expected-foundation-544.md` 的 F20/F21/X04/U12–U13，以及 S4 中 CAP-7/CAP-3 接缝摘要。本报告不读取源码、旧 issue 或实现，不定义 CAP-7 的具体字段 shape，不拆 implementation issue。

## A. 主 agent 摘要

D11 是 **current name-based preset compile** 的纯消费者。operator 选择当前 preset name，gateway 调用 CAP-7 与 `coder-loop preset compile <name> --json` 共用的 compile 计算路径；GUI 不读取 `preset.toml`、不重建 parser/compiler，也不把 attempt pinned definition 当作本页面输入。

CAP-7 的成功产物是一个经稳定 `schemaVersion` boundary 验证的六块 artifact：

1. preset metadata；
2. statuses + stateGraph；
3. phases + phase task tree；
4. tools；
5. fragments；
6. findings。

D11 必须消费完整 artifact，但其固定可视交付是三视图与 findings：stateGraph 的状态节点、exit 边和引擎自有转移；phases 的任务树；每 phase variables 的 KEY/type/source/required 类型流；warn findings 列表。三视图必须从 **同一次 compile 返回的同一个 artifact** 投影，不能各自再编译或按不同时间读取 current preset。

CLI 与 GUI 的一致性是计算路径、schemaVersion 与 artifact block 的一致性，不是两份相似实现。gateway route/frontend 的类型从 CAP-7 boundary 派生；compile rejection、typed findings、unsupported schemaVersion 与 transport/route failure 必须是可区分结果。unsupported version 必须显示实际版本号且拒绝渲染，不能 silent downgrade；compile 被 findings 判为失败时不能把 partial artifact 冒充成功预览。

CAP-3 只允许未来在 owner-defined shape 到达后 additive 携带 typed binding evidence。当前 D11 展示 CAP-7 已给出的 variable KEY/type/source/required，不猜 typed runtime value 的字段、variant 或复合值编码，也不把 CAP-3 作为 D11 启动 gate。

D11 不提供 historical pinned preview、current/pinned 双视图、历史 diff 或 attempt definition repository；这些不能从 CAP-2 的可达性要求反推出来。

### A1. 结论计数

| 分类 | 数量 | 结论 |
|---|---:|---|
| D11 必须自建的原子保证 | 10 | name input、单 compile 调用、六块 artifact、三视图、变量流、findings、CLI 一致、schema rejection、typed result、CAP-3 seam |
| 预期地基已供的保证 | 2 | F20、F21 |
| 真正地基未闭合 | 0 | CAP-7 在预期地基中是 D11 的供给；U12/U13 只影响验证/后续 additive 接入 |
| 非阻塞运行未知 | 2 | U12、U13 |
| 明确排除的范围增长 | 6 | historical preview、双视图、历史 diff、第二 compiler、typed shape 猜测、CAP-2 repository/GC |

## B. 原子需求矩阵

### B1. D11 自建保证

| ID | 原子保证 | D11 必须成立的语义 | 地基映射 | 可证伪验收 |
|---|---|---|---|---|
| **D11-R01** | current name input | preview request 只接收当前 preset name；页面明确陈述 current definition，不接受 attempt/run pinned identity 作为编译输入 | F20、X04 | 选择两个 preset name 得到各自 current artifact；route 不含 historical attempt selector |
| **D11-R02** | 单一 compile 计算路径 | gateway 调用 CAP-7 与 CLI 共用的 compile service/boundary；GUI/frontend 不读源文件、不复制 parser/compiler | F20 | 同一次 current 输入下 GUI route artifact 与 CLI artifact 逐块一致；无第二编译实现 |
| **D11-R03** | 单 artifact 不动点 | 一次 preview refresh 只取得一个 versioned compile artifact；全部视图从该值投影，不按视图重复 compile | F20 | 在源可能变化的测试中，单次页面的三视图仍引用同一 artifact identity/version |
| **D11-R04** | 六块结构可消费 | success artifact 穷尽包含 preset metadata、statuses+stateGraph、phases+task tree、tools、fragments、findings，并经 owner boundary parse | F20 | 缺块、错 variant 或额外非法结构被拒绝；不以匿名 object 接收 |
| **D11-R05** | stateGraph 视图 | 从 statuses+stateGraph 块渲染状态节点、exit 边与引擎自有转移；不从 prompt/phase 文本反推 | F20 | 两个 fixture 的节点和边逐项等于同一 CLI artifact |
| **D11-R06** | phases/taskTree 视图 | 从 phases 块的树结构渲染 phase 层级/任务树，不将数组顺序另编成第二模型 | F20 | single-phase 与多 phase fixture 的树节点/层级逐项一致 |
| **D11-R07** | variables 类型流视图 | 每 phase 展示 CAP-7 给出的 KEY/type/source/required；同一 artifact 内跨 phase 投影，不猜 runtime typed value shape | F20、F21 | 变量条目逐项与 CLI 相等；未知 CAP-3 shape 不影响当前视图 |
| **D11-R08** | typed findings 与 compile rejection | warn findings 随成功预览可见；compile rejection 保留 owner-defined typed findings/reason，不能转成空预览或 generic message | F20 | warn fixture 显示 findings；rejected compile 不渲染伪 success 三视图 |
| **D11-R09** | schemaVersion 严格消费 | route/frontend 只渲染明确支持的 schemaVersion；不支持时返回 typed consumer rejection，显示实际版本号且不 silent downgrade | F20 | 注入 unsupported version，页面显式显示版本并停止渲染 artifact |
| **D11-R10** | CAP-3 additive seam | owner-defined typed binding evidence 到达后从 CAP-7 boundary additive 派生；现有 variable 字段语义和旧 artifact 消费不改变 | F21、X04 | 无 CAP-3 时当前预览完整；新增 typed evidence 不破坏旧 consumer |

### B2. 预期地基已供

| ID | 已供保证 | D11 如何消费 | D11 不得重造 |
|---|---|---|---|
| **D11-F01** | F20：current name-based compile；GUI 与 CLI 共用计算路径/schemaVersion，三视图与 findings 来自同一 artifact | R01–R09 建立 route、typed result 与视图投影 | historical compile、第二 parser/compiler、按视图重复编译 |
| **D11-F02** | F21：scalar 基线与 non-breaking additive typed seam，外部 shape 到达后派生 | R07/R10 保持现有 variables 投影并预留 owner-derived evidence | 猜 CAP-3 字段、variant、复合值编码或把 shape 当 gate |

### B3. 六块 artifact 与 D11 消费

| CAP-7 block | D11 必须消费/保留的事实 | 可见交付 | 禁止推导 |
|---|---|---|---|
| preset metadata | 当前 name 对应的 artifact metadata | 预览身份/标题所需字段随 owner boundary | 不绑定 historical attempt |
| statuses + stateGraph | statuses、状态节点、exit 边、engine transition | stateGraph 视图 | 不从 prompt 或 GUI 规则重算边 |
| phases + task tree | phase definitions 与 owner-provided 树 | phase/taskTree 视图 | 不另建 GUI 专属 phase model |
| tools | compile artifact 的 tools 块 | 可由页面保留/展示，具体布局不新增语义 | 不扫描本机工具重建 |
| fragments | compile artifact 的 fragments 块 | 可由页面保留/展示，具体布局不新增语义 | 不重读 fragment 文件 |
| findings | typed warn/error/rejection evidence | warn 列表与 rejection 详情 | 不用 generic string 抹平 severity/reason |

### B4. typed result 边界

| 结果 variant | D11 呈现 | 不得冒充 |
|---|---|---|
| supported success artifact | parse 六块后渲染同一 artifact 的三视图与 warn findings | 不得混入另一 compile 的块 |
| compile rejected | 展示 owner-defined typed rejection/findings，不渲染成功预览 | 空成功 artifact、HTTP generic failure |
| unsupported schemaVersion | 显示实际版本号与 unsupported 状态 | silent downgrade、best-effort partial render |
| boundary invalid | 显式说明产物不符合 CAP-7 contract | compile rejected 或无 findings |
| transport/route failed | 保留通信失败类别 | compile/domain rejection |

具体 variant 名称和字段由 CAP-7 owner boundary 决定；本表只要求这些语义不能折叠，不发明 wire shape。

### B5. 供需归属与未闭合判断

| 需求面 | 预期地基已供 | D11 自建 | 真正地基未闭合 |
|---|---|---|---|
| compile source | F20 current name + shared path | name selector 与 route 接线 | 无 |
| artifact structure | CAP-7/F20 versioned boundary | 单 artifact 持有与六块消费 | 无 |
| three views | F20 | stateGraph、phase tree、variables 投影 | 无 |
| findings/rejection | F20 的 findings/strict version contract | typed UI/result 映射 | 无 |
| typed binding evolution | F21 | additive consumer seam | 无；U13 非阻塞 |
| historical definition | 不属于 D11 | 不建 | 不构成缺口 |

### B6. 非阻塞运行未知

| 未知 | D11 验证影响 | 不得推出 |
|---|---|---|
| **U12** 真实 definition 历史分布与 repository/GC | 只用于证明页面没有误连 historical identity | historical preview、双视图、TTL/GC 合同 |
| **U13** CAP-3 精确 typed shape | owner 到达后的 additive compatibility fixture | 当前 D11 阻塞或自造 typed union |

### B7. 明确排除

1. 不增加 historical pinned compile preview。
2. 不增加 current/pinned 双视图、切换器或历史 diff。
3. 不让 GUI、gateway 或 frontend 重建 parser/compiler，亦不按三视图分别 compile。
4. 不读取当前源文件后拼装与 CAP-7 平行的第二事实源。
5. 不猜 CAP-3 typed value 的字段、variant、复合值编码或 error shape。
6. 不让 D11 承担 CAP-2 definition repository、retention、TTL 或 GC。

### B8. R11 接缝

| 接缝 | 供方 | D11 消费点 | 固定边界 |
|---|---|---|---|
| compile service/artifact | CAP-7 / F20 | R01–R09 | current name；同 CLI path/schemaVersion；六块单 artifact |
| typed binding evolution | CAP-3 / F21 | R07/R10 | additive、owner-derived、非阻塞 |
| CAP-2 pinned definition | F19 | 无 D11 消费语义 | 不从可达性反推 historical preview |


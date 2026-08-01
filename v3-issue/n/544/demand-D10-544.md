# RFC #544 R10 / D10 — per-attempt prompt 与 bindings 展示原子需求

> 需求事实源仅为 AGG D10、`expected-foundation-544.md` 及 D2/CAP-2/CAP-3 接缝。本报告定义 D10 对 attempt artifacts 的 typed 消费需求，不把artifact正文塞入status，不扩展D11，不猜CAP-3 shape或保留期限。

## A. 一页摘要

D10 是 D2 落盘产物的唯一 GUI 消费者。它必须让操作员看到 **某个确切 attempt 实际发出的输入**，而不是根据当前preset重建：

- `prompt.md`全文逐字显示，不截断、不做Markdown二次加工；
- `bindings.json`按KEY→source/value精确展示；
- fresh、普通resume、chain-complete finalizer特例穷尽区分；普通resume显示所续session与当次完整`effectivePrompt`，固定“继续”只属于finalizer；
- artifact存在、历史legacy缺失、写入失败形成穷尽typed结果，不能以空白或猜测代替；
- route绑定准确attempt identity，响应经独立typed artifact boundary进入GUI。

共形成 **12项原子需求 D10-R01–R12**：地基直接供给6项，D10自身建立6项，地基缺口0。D10复用F16–F19/F21与X04，不要求artifact进入status；status只提供导航所需的attempt identity。CAP-3精确shape未落地时维持scalar render string并保留additive typed seam，不构成阻塞。

验收必须以真实fresh、普通resume和finalizer attempt对照实际runner argv及磁盘artifact，并打开历史legacy与注入写失败样本。不得用builder对象、重render结果或静态fixture替代整条浏览器路径。

## B. 原子需求矩阵

### B1. 需求、供给与所有权

| 需求 ID | 原子需求 | 稳定来源 | F / X 映射 | Owner / 分类 | 验证时必须观察 | 仍未知 |
|---|---|---|---|---|---|---|
| **D10-R01** | 每个fresh/resume attempt的`prompt.md`取自与runner argv相同的`effectivePrompt`值；不得事后重建 | D2性质1/2；D10全文如实 | F16，X04 | **地基直接供给，D10消费** | 捕获真实runner argv并逐字比较artifact bytes；fresh与resume均一致 | U11 |
| **D10-R02** | `bindings.json`来自同次resolver结果，完整携带每个KEY的source与实际render value | D2绑定快照；D10对照表 | F16，X04 | **地基直接供给，D10消费** | artifact的KEY集合、source/value与当次render输入逐项相等 | U11 |
| **D10-R03** | artifact领域形态穷尽区分fresh、普通resume与chain-complete finalizer；普通resume关联所续session并保存完整prompt，固定“继续”仅属finalizer | D2/D10 resume语义 | F16 | **地基直接供给，D10消费** | 三类真实attempt均落正确variant；finalizer文本不泄漏到普通resume | U11 |
| **D10-R04** | artifact写失败不阻止attempt，但产生diagnostic事件；成功路径不新增事件 | D2失败语义 | F17，X03/X04 | **地基直接供给，D10消费** | 注入prompt/bindings写失败后runner仍执行，diagnostic可见且能关联attempt | U11 |
| **D10-R05** | spawn/retry/restart使用attempt所属pinned definition解引用，不读同路径current内容；因此artifact与实发输入的定义来源稳定 | CAP-2；D2硬前提 | F19，X04 | **地基直接供给，D10消费** | V1 attempt后路径改V2并restart/retry；V1 identity仍解析自身输入，后续artifact与各自argv一致 | U12 |
| **D10-R06** | bindings保持当前scalar render string基线；CAP-3落地后只通过non-breaking additive typed seam携带类型，D10不猜shape | CAP-3；D2 additive性质 | F21，X04 | **地基直接供给，D10消费** | 基线scalar artifact仍可parse；upstream typed扩展到达后旧consumer不破坏 | U13 |
| **D10-R07** | 提供独立typed artifact route，以loop-data root/chain/run/phase/attempt identity定位唯一artifact结果；不得返回相邻attempt内容 | D10 per-attempt展示；D5 typed边界红线 | F18 | **D10自身建立** | 两个同phase连续attempt交叉请求，响应identity与内容不串线；未知identity显式失败 | U11、U12 |
| **D10-R08** | route结果使用精确ADT，至少穷尽`present`、`legacy-missing`与`write-failed`；present内prompt/bindings/mode/identity均精确parse | D10缺失如实/类型不塌；F18 | F18、F21 | **D10自身建立** | 每个variant正例通过，字段缺失/非法mode/宽object拒绝；GUI exhaustive render | U11、U13 |
| **D10-R09** | attempt页按artifact原始字节显示prompt全文，不截断、不Markdown渲染、不重新插值或补写epilogue | D10性质1 | F18 | **D10自身建立** | 包含Markdown、模板样文本、长行与epilogue的prompt逐字对照文件 | U11 |
| **D10-R10** | bindings对照表逐项显示KEY、source与render value；顺序变化不得造成键值错配，GUI不得调用resolver | D10性质2/4 | F18、F21 | **D10自身建立** | 多KEY、相似KEY、空字符串、number/boolean渲染string样本逐项一致 | U11、U13 |
| **D10-R11** | attempt页穷尽显示fresh/resume/finalizer语义：普通resume明示所续session及完整实发prompt；仅finalizer显示固定“继续”特例 | D10性质2及resume验收 | F16、F18 | **D10自身建立** | 三类页面标签与artifact variant一致；普通resume不被误标finalizer | U11 |
| **D10-R12** | legacy-missing显示“该attempt早于prompt持久化，无快照”；write-failed显示该次落盘失败且可关联diagnostic；两者不报页面错误、不留欺骗性空白 | D10性质3；D2失败可观测 | F17、F18 | **D10自身建立** | 打开真实legacy与失败fixture；原因准确，attempt其他信息仍可浏览 | U11、U12 |

### B2. 计数与依赖判定

| 分类 | 需求 | 数量 | 判定 |
|---|---|---:|---|
| 地基直接供给 | D10-R01–R06 | **6** | D2/CAP-2/CAP-3负责artifact真实性与typed seam |
| D10自身建立 | D10-R07–R12 | **6** | 独立typed route、identity绑定、精确parse与GUI穷尽展示 |
| 地基未闭合 | 无 | **0** | U11–U13是运行/外部shape未知，不是owner gate |
| 原子需求总计 | D10-R01–R12 | **12** | 可进入后续需求拆分 |

### B3. Artifact identity / type / consistency 边界

#### Identity

- route定位的是一次具体attempt，不是“某run当前phase”或“同名preset最新内容”。
- prompt、bindings、mode、resume session与diagnostic必须关联同一个attempt identity。
- status可提供run/phase/attempt导航identity，但**artifact正文与bindings不进入status snapshot**；D10使用独立typed route。

#### Type

- present/legacy-missing/write-failed是穷尽结果，不用nullable文件或统一404折叠。
- `bindings.json`在渲染前必须经过精确boundary；GUI内部不保留`JsonObject`或anonymous record。
- CAP-3 shape由upstream拥有；D10只消费additive typed位，不预定义字段、variant或复合值编码。

#### Consistency

- prompt与argv的同一性在构造点证明，不以事后文本相似度推断。
- bindings与prompt来自同次resolver/render；GUI不能重新解析模板或读取current preset。
- artifact route不要求与status/events形成跨介质事务；identity关联足以导航与诊断。

### B4. 验证观察矩阵

| 场景 | 操作 | 必须观察 | 不能替代 |
|---|---|---|---|
| fresh | 跑一个真实fresh attempt，打开attempt页 | prompt文件=argv prompt=页面文本；bindings逐项一致；fresh标记正确 | renderer unit test |
| 普通resume | 使用真实session resume | 完整effectivePrompt、resume标记、session引用均与argv/artifact一致 | finalizer fixture |
| finalizer | 触发chain-complete finalizer | 仅该variant显示固定“继续”，与实际argv一致 | 把所有resume都显示“继续” |
| identity隔离 | 同phase连续两个attempt，请求两个route | identity/content不串线，URL直达各自页面 | 单artifact happy path |
| legacy缺失 | 打开机制落地前attempt | 明示早于持久化；无空白欺骗或整页失败 | 人工删除新artifact冒充legacy |
| 写失败 | 注入artifact写失败 | attempt继续、diagnostic可见、页面显示write-failed | 只断言日志字符串 |
| 精确类型 | present与两种missing/error、非法shape | boundary/exhaustive render闭合；非法值拒绝 | 手写TypeScript interface |

### B5. 仍未证明但不构成地基缺口

| 未知 | 后续处理 | 不得生成的需求 |
|---|---|---|
| **U11** fresh/普通resume/finalizer及写失败的真实runner全路径 | 真实fake/实际runner捕获argv并走浏览器E2E | artifact/runner原子事务、额外成功事件 |
| **U12** definition历史分布、repository可达/GC实现、仓外hash消费者 | 作为CAP-2兼容与回收参数 | TTL、永久保留、historical D11 |
| **U13** CAP-3精确typed shape | upstream落地后派生artifact/GUI类型 | 猜字段、union、复合编码或阻塞scalar基线 |

### B6. 明确排除

1. 不把`prompt.md`或`bindings.json`正文加入status snapshot；只允许导航identity接缝。
2. 不增加historical-pinned D11、current+pinned双视图或compile diff。
3. 不猜CAP-3字段、variant、值域或编码，不把其shape作为R10 gate。
4. 不承诺TTL、无限保留或具体GC算法。
5. 不由GUI读取preset、重放renderer、解析argv/stdout或从事件重建prompt。
6. 不要求artifact写入与runner spawn、SQLite或events跨介质原子提交。

## C. 证据索引

- 稳定语义：`AGG-544-gui-observability-gateway.md` D10；供给前提为D2、CAP-2、CAP-3。
- 修补后地基：`expected-foundation-544.md` F16–F21、X03、X04、U11–U13。
- 本报告未读取源码、旧issue或实现候选。

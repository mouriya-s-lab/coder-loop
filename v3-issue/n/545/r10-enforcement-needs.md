# RFC #545 R10：required / expected outcome 执法需求

本文只把 `aggregate.md` 的 D3/D4/D5/D7/D8/D14、S29–S39、CAP-IN-1/CAP-IN-4 与 `r9-expected-foundation.md` 翻译成执法能力所需的原子地基。它不重开 D4，不定义实现设计，也不把外部输入误记为本能力已经交付的资产。

## A. 摘要

稳定执法对象不是“是否调用过 CLI”，而是 **run finalize 时，该 run 的 credential-derived author 名下是否存在至少一条 durable context entry**。`required` 缺失时把本次 run 判失败并复用既有 attempt / exponential backoff / exhausted 通道；`expected` 缺失时只发 validation event；未声明时零扰动。空白 body、控制记号或状态字面量都能满足 existence，其他 run 的 entry 则不能满足本 run。该语义对普通、trigger、validator 等**一切 run**相同。

R9 已把这组终态保证登记为 F-07，并把 prompt 可执行寻址登记为 F-08；可保留的现存底料只有 backoff/exhausted、typed event infrastructure、doc builder/phase slicing/runtime binding count guard，以及部分 typed credential/storage 资产。R9 同时明确：tool registry/outcome evaluator、author existence query、统一 finalize 边界、context capability doc、全部 phase 的运行证明当前都不能依赖。

执法能力可自建 context capability 注册消费、outcome existence evaluator、finalize verdict、required/expected/undeclared 分派、既有失败通道适配、expected validation event、文档内容与 ADT 穷尽消费；但它不能自造 CAP-IN-1 的工具声明语法/编译合同，也不能用普通 run 的 lifecycle 代替 CAP-IN-4 的 trigger/validator 统一 lifecycle。两项外部输入未闭合时，稳定范围仍是一切 run，只是对应编译或运行证明未闭合。

## B. 原子需求

### N-E01 Tool declaration consumption

- 消费 CAP-IN-1 提供的闭合 `[[tools]]` 注册表、per-phase `toolRequirements` 的 `required | expected` 词表，以及“只有定义 outcome 的 capability 才可 required”的编译结果。
- context CLI 必须成为闭合 capability union 的成员，而不是自由字符串或散落的工具名分支。
- capability 携带覆盖 append/read 的真实用法文档；执法 outcome 仍只对应 append 后的 entry existence，read 没有 outcome。

### N-E02 Credential-derived run identity

- outcome 查询的主体必须来自 daemon 已解析的 agent credential，精确绑定 chain/item/run/phase；请求、prompt handle、provider 或 caller 自报字段均不能构造 author。
- operator 与 agent(run) 仍是唯一两类主体；不得为了执法新增第三类主体或权限粒度。

### N-E03 Durable outcome existence

- context outcome 是：在 finalize 判定点，durable store 中存在至少一条 `author = 当前 run credential-derived author` 的 entry。
- evaluator 必须直接求 existence，不能以 audit 数量、provider 调用记录、进程内标记或 body 内容代替。
- other-run entry 永不满足本 run；空白、marker、控制记号等任意合法 body 均满足本 run existence。

### N-E04 Single finalize / evidence window

- outcome 判定与 credential revoke 必须落在同一个统一 finalize 边界，使证据窗口和判定窗口同时关闭。
- verdict 一次确定；判定后不得接受迟到写来改变 verdict，也不得允许判定前已 durable 的合法 entry 被遗漏。
- finalize 的持久状态、credential revoke 与恢复语义必须共同覆盖 crash/restart；不能把现有多段 await 或分事务状态更新当成已经闭合。

### N-E05 Requirement verdict ADT

- 对每个声明 capability，以封闭 ADT 表达 `required | expected | undeclared`，并与 `outcome-present | outcome-missing` 穷尽组合。
- `required + missing` 产生 run failure；`required + present` 零干预成功路径；`expected + missing` 只产生 validation event；`expected + present` 零干预；`undeclared` 对现有收尾行为零扰动。
- 不得有 catch-all/default 隐藏新增 capability、requirement 或 verdict variant。

### N-E06 Existing attempt/backoff/exhausted channel

- required missing 必须进入已有 run failure、attempt 递增、指数退避与 attempts 耗尽后的 exhausted 终态。
- 不得为 context required 新建平行失败状态、独立重试器或第二套终态。
- “已有”仅指 R9 认可的 backoff/exhausted 底料；各运行类别能否统一使用它，仍取决于 N-E10/CAP-IN-4。

### N-E07 Expected validation event

- expected missing 必须发出 typed validation event，明确表达缺少 required/expected context outcome 的实际 variant；对调度、状态、attempts、backoff 均零影响。
- required missing 也必须留下可审计/validation 的 typed 原因，但 event 不能替代 durable existence 判定。
- event producer、payload 和消费者必须进入闭合 union 的穷尽处理，不能用自由字符串模拟结果。

### N-E08 Trigger / validator and scheduler unification

- 同一个 outcome evaluator 与同一个 finalize verdict 必须用于普通 run、item trigger、chain trigger、validator 及统一 lifecycle 所涵盖的其他 run；不得按 phase kind 豁免或复制特判。
- scheduler 对 required failure 的状态推进与 validator/trigger 的判定入口必须消费同一 typed verdict，避免 trigger path、validator path 与普通 completion path 各自解释 requirement。
- CAP-IN-4 必须先为 trigger/validator 提供真实 credential、attempt 语义与共同 finalize 点；本能力只消费，不从当前异构 lifecycle 猜补。

### N-E09 Executable documentation injection

- 仅向声明该 capability 的 phase 注入 context append/read 的真实 CLI 文档和本 run 当前可执行寻址说明。
- credential 自动推导的参数必须说明无需填写；CLI 显式要求的 stable key 必须给出当前合法值；无合法 scope 时明确不可用，不猜测、不合成、不 fallback。
- prompt 不注入任何 entry body；handle 不是授权，daemon 仍按 N-E02 独立鉴权。
- 文档必须由 CAP-IN-1 的 per-phase `toolRequirementsDoc` slicing 接入；不能靠所有 phase 通用静态文字冒充声明驱动注入。

### N-E10 Full-chain typed boundaries

- tool declaration、capability、requirement、outcome query/result、finalize verdict、failure reason、validation event、scheduler/validator consumption 与 doc binding 全链路使用命名 ADT 和 arktype 边界解析。
- 禁止 `any`、匿名 object、raw map、stringly capability、真实 `as` 断言；`unknown` 只允许停留在外部 parse/catch 边界。
- capability union、requirement union、event union 与 run-kind/lifecycle consumption 均须穷尽。

## C. Foundation / CAP 匹配

| 原子需求 | R9 已供或预期地基 | 执法能力自建 | 外部输入 / 未闭合点 |
|---|---|---|---|
| N-E01 | F-07/F-08 登记 capability/outcome/doc 终态；现有 doc builder/phase slicing 可保留 | 注册 context capability、定义其 outcome 与用法文档、穷尽消费 | **CAP-IN-1** 提供声明语法、per-phase requirements、required 合法性编译与 doc slicing 合同；当前未交付 |
| N-E02 | F-01/F-05 预期 credential-derived authority；现有 socket credential author 是局部资产 | outcome evaluator 只接收已解析 run identity | storage/read authority 的 F-01/F-05 runtime proof 未闭合，不能以 caller 字段补洞 |
| N-E03 | F-03 提供合法 persisted exactness；F-07 固定 existence 语义 | author-scoped durable existence evaluator及正负 verdict | 当前无 existence query；必须等对应 storage authority/exactness 修补证明后才能形成可靠证据 |
| N-E04 | F-07 固定 finalize/revoke 同边界 | 原子化 verdict、revoke 接缝与 crash recovery 消费 | 当前 complete/revoke 多段窗口及分事务恢复未闭合；**CAP-IN-4** 还需统一非普通 run finalize |
| N-E05 | F-07 固定三态及 body 不透明；F-10 要求 pure typed oracle | requirement/outcome/verdict ADT 与穷尽 evaluator | CAP-IN-1 的声明编译结果是输入，不由本能力重定义 |
| N-E06 | 可保留 existing backoff/exhausted 底料；F-07 固定复用 | required failure 到既有失败通道的 typed adapter | CAP-IN-4 必须让 trigger/validator 同样具备 attempt/backoff/exhausted lifecycle；当前 item-trigger/chain-trigger/validator 不一致 |
| N-E07 | 可保留 typed event infrastructure | expected validation 与 required failure reason 的 typed event producer | event 不能补偿 N-E03/N-E04 缺失；统一运行类别消费仍依赖 CAP-IN-4 |
| N-E08 | F-07/K2 固定“一切 run”；K3 明确跨 RFC 供给账 | 单一 evaluator/verdict 与 scheduler/validator 消费接口 | **CAP-IN-4** 提供 trigger/validator credential、attempt 与共同 finalize；缺失只阻断证明，不缩窄语义 |
| N-E09 | F-08 固定可执行寻址；现有 doc builder/binding guard 是底料 | context 文档正文、合法 scope projection、零 body 注入 | CAP-IN-1 提供 requirement-driven doc binding；group handle 等合法 scope 还要消费相应权威地基，不可猜造 |
| N-E10 | F-03/F-05/F-07/F-08/F-10 规定 typed boundary 与 proof scope | 全链路 ADT、arktype parse、穷尽 switch | 上游 CAP 输出本身也必须是精确 typed 合同；字符串或匿名 shape 不能作为临时兼容输入 |

## D. 运行类别与事务、恢复、授权接缝

| 运行类别 | 稳定语义 | 当前缺口 | 闭合责任 |
|---|---|---|---|
| 普通 scheduler run | finalize 求本 run author existence；required 失败复用 attempts/backoff/exhausted，expected 只发 event | close→revoke 存在迟到写窗口；completion/clear 分事务且 crash recovery 未证 | 执法能力闭合 evaluator/verdict/revoke 接缝，并依赖 F-01/F-03 的 durable authority |
| item trigger run | 与普通 run 完全相同 | 当前 lifecycle 的 attempts 不递增 | CAP-IN-4 统一 lifecycle；执法能力不得特判豁免 |
| chain trigger run | 与普通 run 完全相同 | 当前无 attempt 语义 | CAP-IN-4 统一 lifecycle；执法能力消费统一 verdict |
| validator run | 与普通 run 完全相同 | 当前无 runner credential/finalize lifecycle | CAP-IN-4 供给真实 run identity 与共同 finalize；validator 只消费同一 verdict |

事务接缝的最低稳定结果是：合法 entry durable 化先于 existence verdict；同一 finalize 边界关闭写入授权并持久化 verdict/运行结果；restart 后不得重新开放已关闭 credential、丢失已确定 verdict，或把 required failure 恢复成 success。这里不新增 exactly-once caller 结果保证，但也不能用“无需 exactly-once”掩盖 finalize verdict 与授权窗口必须一致。

授权接缝的最低稳定结果是：existence query 由 daemon 内部使用已解析 credential identity，不接受显式 chain/run/phase 扩权；prompt 中的 stable key 只帮助寻址；operator entry、其他 run entry、同 item 其他 attempt 的 entry 均不能满足当前 run outcome。

## E. 不得依赖与范围外

- 不得把 provider 被调用、CLI 进程启动、audit event 数量、进程内布尔值或 prompt 文本当 outcome；唯一 outcome 是 durable author-scoped entry existence。
- 不得检查 body 质量、marker、摘要、状态词或语义完整性；合法空白 body 也满足 outcome。
- 不得新增 required-read。read 当前没有可验证的输出条件；“必须读”仍是 prompt 纪律。
- 不得把“一切 run”缩成普通 phase，或因 CAP-IN-4 未到位而给 trigger/validator 永久豁免。
- 不得由本能力定义 DSL 语法、工具声明装载或 required 合法性规则；这些是 CAP-IN-1。
- 不得暴露 opaque credential、把 prompt handle 当 capability、增加 `run` scope，或把 entry body推入 prompt。
- 不得建立 context 专属 retry/exhausted 通道，也不得以 validation event替代 run failure。
- 不得依赖当前空 tools projection、当前异构 trigger/validator lifecycle、未闭合的 store authority、audit 计数或 fixture-only 证明。
- 不新增 exactly-once caller、内容质量、transition、后继 handoff、GUI 或 `shared.md` 行为。

## F. 验证需求与证据

### F.1 纯函数与编译证据

1. capability、requirement、outcome、verdict、failure/event 与运行类别均由封闭 ADT 表达；新增 variant 会令所有消费点编译失败，typecheck 绿色且无 stringly tool branch。
2. outcome evaluator 表驱动覆盖：本 run entry存在/不存在、other-run 多条、operator entry、空白/control/marker body；oracle 只随本 run existence 变化。
3. requirement × outcome 穷尽矩阵证明 required/expected/undeclared 的状态、attempt 与 event效果。
4. doc renderer 对声明/未声明、自动参数、显式合法 stable key、无合法 scope逐项断言；预置唯一 sentinel body 后所有 phase prompt 零命中。

### F.2 普通 run 运行证据

1. required + exit 0 + 无 entry：finalize 失败、attempt递增、实际退避、耗尽后真实 exhausted；event明确缺少 context outcome。
2. required + 本 run 一条合法 entry：成功推进、无失败/退避；分别使用空白、控制记号、状态字面量 body重复证明不解析内容。
3. required + 仅其他 run 多条 entry：仍失败。
4. expected + missing：只出现 validation event，run状态、调度、attempts 与 backoff零变化；expected + present零干预。
5. undeclared：与基线收尾路径逐项一致，且 prompt无 capability doc。

### F.3 窗口、事务与恢复证据

1. 在 entry durable、existence判定、credential revoke、run结果持久化各接缝故障注入并 restart；恢复后 verdict与durable事实一致。
2. finalize/revoke 并发迟到 append：边界前被接受且计入，或边界后明确拒绝；不存在判定后补写改变 verdict。
3. raw socket伪造 chain/run/phase 与复制 prompt handle均不能令其他 author 的 entry满足 outcome或继续写入已关闭 run。

### F.4 一切 run 的真实证明

CAP-IN-4 集成后，普通、item trigger、chain trigger、validator 分别运行 required missing/present、expected missing、undeclared 四类关键路径；观察真实 credential、统一 finalize、attempt/backoff/exhausted 与 validation event。源码无 phase-kind 豁免只是辅助证据，不能代替这些运行路径。CAP-IN-4 未到位时，报告必须写“统一范围已固定但运行证明未闭合”，不得宣称 S33 完成，也不得把验收缩成普通 run。

### F.5 文档与端到端证据

1. CAP-IN-1 集成后的真实 preset compile：有 outcome 的 context capability可 required；无 outcome 的 read-only capability required 在编译边界拒绝；expected/undeclared切片精确。
2. 声明 phase 从注入文档直接执行真实 append/read命令；自动参数无需填写，显式 key 使用当前合法值，无 scope路径明确不可用。
3. help、schema、作者手册、runtime doc binding 与实际 CLI一致；binding/count guard绿色。
4. 冻结 SHA 上重跑全套普通与统一 lifecycle 路径；证据必须观察最终 run状态、attempt/backoff/exhausted、validation events、credential拒绝和durable existence，不能用 unit/typecheck/mock替代同范围运行结论。

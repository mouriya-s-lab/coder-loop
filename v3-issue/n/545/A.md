# RFC #545：chain 生命周期内的结构化上下文交换

## 问题不是让 agent 记住更多，而是让一次 chain 内的工作能够被后续运行取用

coder-loop 的 agent run 是一次性执行单元。一个 run 结束后，后续 run 不继承它的进程内存；不同 item、不同 phase 和并行 branch 也不能依靠同一个会话继续交谈。这种无状态性是调度器可恢复、可重试和可更换 runner 的前提，却带来一个具体缺口：前一个 run 获得了对后续判断有帮助、但又不属于永久业务事实的信息时，没有受约束的中间交换面。

把所有信息都写进 GitHub 并不能解决这个缺口。GitHub issue、PR、review 和默认分支承载的是跨 chain 仍需成立的业务事实与工作产物；它们必须在人离开 coder-loop 后仍可审计。一次调查中的临时线索、同一 item 两个 phase 间的观察、并行分支间的协调信息不一定值得永久污染 GitHub。反过来，任何会决定任务是否完成、下一条 transition 走向何处、后继必须接收什么输入的内容，都不能只存在于一个随 chain 删除的缓存里。

仓库已有 `shared.md`，但它解决的是另一类问题。该文件是 chain 级自由文本面：preset 可以把路径告诉 agent，agent 自行约定内容和写法，引擎不解释其结构，也不为每一条贡献建立作者、作用域和审计记录。它适合人工可读的共同草稿，不适合作为一组可过滤、可归因并由 daemon 执法的记录。RFC 不替换 `shared.md`，也不把它改造成数据库前端。

context CLI 增加的是第三种、生命周期更短而控制更强的通道。它把每次发布表示为 entry，由 daemon 存储并允许后续 run 主动拉取。它只在所属 chain 存活期间存在，不升格为持久业务事实。三者因此并存：

| 通道 | 保存的事实 | 引擎承担的责任 | 生命周期 |
|---|---|---|---|
| GitHub 与 git 产物 | 业务状态、评审、交付物、可追溯决定 | 调度只消费既定事实，不把它当临时消息队列 | 独立于 chain，长期存在 |
| `shared.md` | agent 自由组织的共同草稿 | 暴露文件路径，不定义内容行为 | 随工作区和 chain 使用方式存在 |
| context entry | 对同一 chain 后续判断有帮助的受控中间信息 | 归因、scope 校验、存储、查询、审计和生命周期清理 | 与 chain 同生共死 |

这条边界保留了“run 无状态”和“持久业务语义只落在 GitHub”两项原则。context 不是 agent 的隐藏记忆，也不是 transition 的替代品；它是显式调用才能读写的 chain 内服务。

## entry 是最小持久单元，envelope 受控而正文不受解释

一条 entry 由稳定身份、时间、scope、author 和 body 组成。引擎必须精确理解 envelope，因为查询、授权、清理和审计都依赖它；引擎不得理解 body，因为正文一旦参与调度判断，普通文本就会变成未声明的控制协议。

body 因而按原字符串保存和返回。正文中即便出现状态名、终态标记、prompt 片段或看似命令的文字，也不会改变 scheduler、trigger、validator 或 item 状态。引擎不抽取 topic，不匹配标签，不评估内容质量，也不以正文是否“有用”决定一条发布是否成立。证据文件等大对象继续走既有 evidence 路径，entry 可以保存引用；这不是 body 的语义解析。

scope 是封闭的三种地址，而不是任意字符串命名空间：

- `item` 表示同一 item 谱系中的共享。不同 run、不同 phase 只要属于该 item，就可按这个稳定 item 身份查询。
- `chain` 表示同一 chain 内跨 item 的公告或公共线索。
- `group` 表示真实并行容器中的分支交换，键是并行结构层赋予的稳定容器身份。

没有 `run` scope。entry 的 author 已经记录来源 run；再增加只能被同一次短命 run 使用的 scope，既不能完成跨 run 传递，也会扩大过滤和授权状态空间。没有跨 chain scope，因为 chain 本身就是隔离与删除单位。也没有 topic、tag 或自由查询字符串；若将来出现真实消费场景，应通过新增 typed variant 演进，而不是提前留下无法穷尽的字符串入口。

entry 只追加，不修改、不单条删除。更正通过发布新 entry 表达，历史贡献仍可归因。唯一删除时机是整个 chain 生命周期结束。这个选择既避免“读到的上下文后来被改写”，也使 required outcome 可以基于持久存在的发布事实判断。它并不承诺 caller 重试 exactly once：一次网络不确定性可能让 caller 不知道提交是否发生，这属于传输结果问题，不能反向制造本 RFC 没有要求的全局幂等协议。

author 不是 CLI 参数。operator 路径只能生成 operator author；agent 路径从 daemon 已验证的 run credential 恢复 chain、item、run 和 phase。调用者提交一个看似合法的 author 对象也不能改变归因。这里的目的不只是防伪，还要让 finalize 时查询“本 run 是否曾发布”具有权威数据来源。

## daemon socket 是权限边界，也是协议边界

产品读写都必须经过 daemon socket。SQLite 表和 store 方法是 daemon 内部实现持久化所需的 primitive，不构成产品 API，也不因测试或 fixture 能直接调用而成为另一条产品入口。operator 可以在无 run credential 的明确路径下操作任意 chain，agent 的可见范围则恒定收缩到其 credential 所属 chain。请求中携带另一个 chain 标识不能扩权。

agent 可调用的 context read 属于普通命令域，与事件流不是同一个权限类别。事件流仍可拒绝 agent；不能因为两者都是“读取”就把 context read 放入免鉴权分类。命令 union、daemon 的 auth classification、CLI 自动附 credential 的分类必须由同一封闭模型约束。当前两份清单会漂移：新增命令若只加入 daemon 侧，CLI 可能不附 credential，服务端便把请求误认成 operator。这是授权地基缺陷，而非文档疏漏。

每次 write admission 都留下接受或拒绝的审计记录，拒绝原因要能区分不存在的 chain/item/group、非成员、跨 chain、失效凭证和协议错误。审计描述的是 daemon 作出的 admission verdict，不是 body 的内容。接受 verdict、随之产生的 entry 与接受审计必须相互一致；拒绝 verdict 与拒绝审计也必须一致。socket response 是另一层 transport 结果，不参加这个 durable admission 关系。

socket 同时给正文传输设定真实边界。RFC 不人为规定“context 最多若干字节”，也不允许静默截断。若 JSON line、runtime 或操作系统存在实测限制，CLI 应按序列化后的真实字节边界传输，无法承载时显式返回 boundary error。普通字符数不能替代线上字节数：控制字符经 JSON escaping 会膨胀，固定按 JavaScript code unit 分块可能超过 daemon 的单请求限制。连接断开、残片、响应不完整或 daemon restart 导致一次请求不能完成时，caller 必须得到明确失败而不是永久等待。现实现把未 commit 的 begin/chunk session 放在 daemon 内存中；RFC 不要求这些 session 具备断连清理、TTL、restart 恢复或 durability，也不保证失败响应能告诉 caller entry 是否已经提交。

## read 是拉取协议，不是 prompt 自动拼接

entry 内容不会自动进入 prompt。自动注入会让 prompt 大小随 chain 历史无界增长，也会让每个 phase 在未表达需求时接收全部上下文。更严重的是，它会把“可以查询的信息”变成“默认影响 agent 判断的信息”，破坏 scope 和过滤的意义。agent 应明确调用 read，选择需要的集合，然后自行解释 body。

公开读取不是现有 `listContextEntries(chainId)` 的简单暴露。它必须有独立的 typed request/response boundary，并只接受闭合集合中的过滤条件：scope variant 与稳定 key、author subject/phase、以及 `after` cursor。多个过滤条件共同收窄结果；未声明参数应在边界解析时被拒绝，不能暗中支持 offset、自由 SQL 式条件或 topic 查询。

分页的消费者合同包含四项可观察行为：

1. caller 每次显式给出正整数 `pageSize`，不存在隐藏默认总量上限；
2. 结果按稳定 keyset 排序，而不是用会因并发插入漂移的 offset；
3. 返回值显式区分 `nextCursor` 与 `exhausted`，caller 可以一直取到集合末尾；
4. 并发 append 时，协议必须定义本轮分页所观察的集合，确保该集合中已有 entry 不重不漏。

最后一项不是要求全程持有数据库快照，也不是预先决定页间新 entry 必须可见或不可见。实现可以选择满足合同的集合语义，但必须让 cursor 与该语义一致，并以并发 append 的 runtime 场景证明。单页查询正确不能证明多页消费者合同。

read boundary 同时是未来 GUI 和 hook 的消费边界。GUI 只负责展示返回 envelope，hook 以 operator 身份调用普通读取路径；它们不能反过来定义数据库 shape。返回 JSON 的变化必须先改变精确 boundary，并明确告知消费者。当前仓库没有已落地的 GUI/context consumer，这不构成永久不存在外部消费者的证明。

大 body 的读取也服从真实 transport boundary。协议不能用一个任意 response cap 静默丢掉后半页，也不能因“可能太大”发明 RFC 未要求的 body 上限。若一页真实无法传输，应返回可识别的边界错误；分页规模由 caller 调整。malformed 持久行则以明确 boundary failure 暴露。本 RFC 不要求跳过坏行继续返回其他行，因为逐行容错会悄悄改变集合与审计含义。

## group scope 只使用并行结构的结论，不重新定义并行

group 的存在是为了真实并行分支交换，不是让 context 子系统推测“哪些节点看起来像同组”。并行结构层负责定义合法任务数学、物化容器、赋予稳定 group identity，并告诉每个 branch run 它属于哪个容器。context 只消费这个权威结论，在写入时由 daemon 校验 credential 所属 run 对目标 group 的 membership。

不能从 SQLite fixture 能构造的 ancestry 推导产品 membership。存储层可能为了恢复或兼容表达比合法 DSL 更宽的树形；能造出多个 `par` 祖先，不等于 source 数学允许嵌套并行，更不等于一个 run 自动属于所有祖先 group。RFC 不定义 nested membership，也不选择“最近祖先”或“全部祖先”。当并行层不给出合法容器身份时，group scope 不可用，daemon 应拒绝而不是猜测、合成或回退到 chain。

真正证明 group 通信需要生产调度路径：真实 `par` 被物化，两个 branch run 分别拿到自己的 credential，各自以并行层给出的同一 group key 写入，再从公开 read 双向取到对方 entry。直接写 task tree、直接插 entry 或构造 ancestry fixture，只能证明 parser、持久化与局部 admission，不能证明 producer、credential 绑定或 scheduler 接缝。

scope 是查询维度而非保密边界。同一 chain 的下游 run 可以用 chain 内允许的读取方式取得上游信息；join 后不需要专门的“handoff group”协议。组外 run 按某 group 过滤不应命中该组记录，但这不意味着它在 chain 级授权下永远不可见。真正的保密边界是 chain，不是 group。

## required 与 expected 检查可观察产出，而不是猜测 agent 是否调用过命令

preset 的工具声明需要区分“没有调用会使 run 失败”和“没有调用只记录验证事件”。context 的可执法 outcome 被定义为：该 run 的权威 author 下存在至少一条 durable entry。选择 existence 而非调用日志，原因是工具调用动作本身不能证明产生了可供后续读取的结果；失败的 begin、被拒的 scope 或中途断线都不应满足要求。

`required` 在 run finalize 时检查这个 outcome。未满足时，run 进入既有失败、指数退避和 attempts exhausted 通道，不新建一套 context 专属状态机。`expected` 未满足只产生 validation event，不改变调度、状态或 attempt。未声明工具要求的 phase 保持现有行为。空白 body、控制字样或看似终态的正文都能满足 existence，因为内容质量不属于引擎判断；其他 run 发布再多条也不能替代当前 run 的 outcome。

判定与 credential revoke 必须位于同一个收尾边界。若先判失败后仍允许该 credential 迟到写入，最终事实会与 verdict 矛盾；若先撤销又没有稳定 existence 查询，则本次 run 的贡献可能无法正确归属。finalize 需要一次确定 required、expected 或 undeclared 的 typed verdict，并在 crash/restart 后保持已提交 outcome 与最终状态的一致关系。

这套语义适用于进入统一 scheduler lifecycle 的所有 run，不按普通 phase、trigger 或 validator 做例外。当前 trigger/validator 的 lifecycle 尚不统一，因此“一切 run”是外部能力到位后必须验证的合同，不是已经存在的事实。RFC 也不定义 required-read。读取没有可以证明“后续系统获得了什么”的 durable output；把一次 read request 日志当 outcome 只会执法形式动作。若未来确需 required-read，必须先重新定义其真实产出。

## prompt 与文档给出可执行寻址，但不泄露内容或凭证

无状态 agent 不能靠记忆知道 context 命令格式和当前合法地址。声明 context capability 的 phase 应获得与实际 `--help` 一致的 append/read 用法，以及完成调用所需的 scope 寻址说明。最终命令自动推导的参数要明确标成无需填写；最终命令要求显式提交的 selector 或 stable key，则提供当前 run 可用的合法值。固定基线中的 append 仍要求 positional chain selector，未来 read/append 的最终 command shape 不能由 prompt 文案预先替实现决定。当前没有合法 group 时，文档明确说明不可用，不能要求 agent 猜 ID。

这些 handle 是地址，不是 capability。daemon 仍从 credential 独立重建身份并验证 membership；复制别的 run prompt 中的 group ID 不会获得权限。credential 本身不进入 prompt，已有 entry 的 body、摘要、计数也不进入 prompt。run/phase identity 标签若不能组成 scope 参数，也不应被误称为 scope。

文档注入只发生在声明该工具的 phase。它应沿既有 doc-binding 与 phase slicing 机制生成，而不是在 prompt 拼一段与 CLI 漂移的手写说明。新增 binding 必须进入 runtime key 的封闭集合和计数守护。根命令 help、子命令 help、preset 作者手册、项目命令列表与 schema 必须描述同一个接口；旧的“唯一持久层”或“唯一 handoff”措辞要直接替换成三类通道的当前边界，不能保留互相否定的新旧叙述。

## 持久层与恢复行为是上层能力成立前必须补齐的地基

当前代码已经提供可复用的局部构件，但不能概括为“写面已经完成”。现有资产包括：`item | chain | group` 与 `operator | agent` 的 ADT、arktype 解析、SQLite `context_entries` 表及 chain 外键、按时间和 ID 的索引、daemon 从 credential 推导 agent author、append 的 begin/chunk/commit wire、item 存在性检查、group 暂时拒绝、接受/拒绝审计事件、chain 删除成功路径中的清理，以及 `shared.md` 的独立创建与注入。

这些构件之间仍有会污染 read、group 和 outcome 的产品缺口：

- soft chain delete 与 context cleanup 是分开的事务，进程在两者之间退出会留下 deleted chain residue，restart 不会自动对账；
- admission verdict、entry 与对应审计尚未构成一致的 durable 事实；socket response 只需完整成功或显式失败，不需要与前述事实原子提交，失败时也不保证 caller 能判断 entry 是否存在；
- begin/chunk session 是 daemon 内存态，断连、残片、响应不完整或 restart 必须以失败结束而不能挂起；其清理、TTL、恢复和持久化不属于交付保证；
- 固定字符分块没有按 JSON 序列化字节计算，合法控制字符正文可以撞上请求上限；
- SQLite schema 接受的 author/scope 集合比 runtime parser 更宽，单个 malformed row 会使整次内部 list 失败，历史生产数据是否存在此类行仍未知；
- context 公开 read、过滤、分页和返回 boundary 尚不存在；group 正向 admission/read 尚不存在；tool declaration、outcome evaluator、统一 finalize 和 context doc-binding 尚不存在；
- CLI credential attribution 与 daemon auth classification 是两套事实源，新增命令可能被错误归类。

修补这些问题的目的不是追求比 RFC 更强的数据库完美性，而是防止上层合同建立在不可收敛删除或不确定读取集合之上。要求的是产品可达路径服从 daemon authority、新写入的 stable key 在 admission 当下属于 caller chain、合法数据精确保真、chain 终结后清理在故障与 restart 后收敛、协议错误分类稳定。内部 persistence primitive 可以继续直接表达存储操作；RFC 不从它的可表达能力推导产品旁路或 item-delete 生命周期。它也不要求自动清洗一切历史坏数据、不要求每行坏数据都被跳过，不要求 session cleanup/recovery，或为未知的外部调用者建立兼容旁路。

## 类型边界负责让新增状态无法被静默忽略

scope、author、命令鉴权类别、query filter、分页完成态、tool requirement verdict 和 task node 都应是封闭 ADT。外部 JSON、SQLite JSON 列、CLI 参数与 socket payload 在入口以 arktype 解析为精确类型，内部函数不继续传递匿名 object 或 raw string map。新增 variant 必须让 exhaustive switch 和类型检查暴露所有消费点。

类型检查只能证明分支被处理，不能证明生产路径真的生成该 variant。`par` node parser 完整不证明 scheduler 会生成真实 branch credential；read boundary 正确不证明 daemon confinement；prompt renderer 的 unit test 也不证明 agent 能执行文档中的命令。因此每项证明必须与主张等宽：纯 filter/cursor 用确定性测试，socket authority 与 transport 用真实 daemon/CLI，故障与 restart 用隔离 lifecycle 场景，group 用真实 `par` producer，required/expected 用真实 finalize、retry 和 exhausted 观察。

GUI 仍是 read boundary 的消费者，不在这个 RFC 内实现展示。hook 复用 operator read，不获得特殊后门。DSL 中 `[[tools]]`、`toolRequirements` 的声明位、合法 `par` 数学、真实并行 producer，以及 trigger/validator 统一 lifecycle 是本 RFC 消费的外部能力；context 实现不能为了让自己的测试通过而重新定义它们。

## 完成后的实际运行

这里描述的是 RFC 自有的 context 能力与前述工具声明、真实并行 producer、权威 membership、统一 run lifecycle 等 CAP-IN 同时到位后的组合行为，不表示这些外部能力由 RFC #545 自己实现。

一个带有效 credential 的 agent 调用 append 时，按最终 CLI 合同提交 body、目标 scope 以及命令明确要求的 selector/key。CLI 经 socket 发送请求；daemon 从 credential 恢复 author 与授权 chain，校验 item 或并行层提供的 group 身份，记录接受或拒绝审计，并在接受时追加不可变 entry。operator 不带 agent credential 走明确的 operator 路径。任何调用者都不能自报 author、写入虚空 scope 或越过 chain。

后续 agent 调用 read，给出当前合法 scope/filter、正整数页大小与可选 cursor。daemon 以 credential 限定 chain，按 typed query 返回一页精确 envelope 和下一页状态。caller 可翻页至 exhausted；prompt 从不替它预读 body。join 后的任务仍通过普通 chain 内读取取得需要的信息，不存在隐式 transition handoff。

声明 context 为 required 的 run 在 finalize 前必须已经由自己的 author 产生至少一条 entry；否则沿既有 retry，最终可能 exhausted。expected 缺失只留下 validation event。正文是什么不影响 verdict。判定完成后 credential 被撤销，迟到写不能改变结果。

chain 结束或删除后，它的 entries 最终全部消失，restart 不会永久留下已终结 chain 的 residue；其他 chain 不受影响。合法 entry 在 migration、重开和分页中保持 envelope 与 body 原样。malformed 持久数据、真实 transport 超限和鉴权失败分别作为明确错误暴露，不靠截断、fallback 或扩大权限掩盖。

## 明确不由该 RFC 实现的能力

context 不提供跨 chain 共享，不增加 run scope，不增加 topic/tag，不支持 entry update 或单条 delete。它不承担前驱到后继的必需输入交付，不替代 typed transition/exit，也不把正文变成调度信号。它不承诺 caller 重试 exactly once，不承诺无限单次 response，不为未知限制制定任意 cap，不要求 malformed rows 逐行容错。

它不定义 nested `par` 是否存在或一个 run 在嵌套结构中属于哪些 group，不实现并行 DSL、容器 producer 或 branch scheduler。它不实现 GUI 展示，也不为 hook 新建专属读取协议。它不规定 agent 必须阅读的内容质量，不实现 required-read。`shared.md`、evidence、trace、GitHub 业务事实和 git 产物继续保留各自职责。

这些排除项不是“以后顺手补”的留白，而是防止 context 从受控中间态膨胀成第二套业务数据库、消息总线或工作流语言。只有出现新的真实消费问题并重新确定其信任、生命周期与失败语义时，才应扩展现有封闭合同。

## 事实依据

文中“当前”指 RFC 调查固定基线 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`，不是对未来分支的推断。

- entry ADT、persisted parser 与 scope 穷尽转换：`src/context-entry.ts:4-145`。
- SQLite 表、索引、append/list 和 chain 清理 primitive：`src/sqlite-state.ts:354-356,775-808,2045-2063`。这些源码只证明内部持久化形状，不证明另有产品入口。
- socket append admission、credential-derived author、item 检查、group 拒绝与 commit 路径：`src/daemon.ts:1763-1917`。
- chain soft delete 与 context 清理的分步产品路径：`src/daemon.ts:2505-2538`。
- CLI append、positional chain selector、固定 chunk 与 root usage：`src/loop.ts:1943-1986,3046-3058`。
- daemon 命令闭集和 auth spec：`src/daemon.ts:203,1732-1763,5731`；CLI credential attribution 清单：`src/loop.ts` 中 `AGENT_ATTRIBUTED_COMMANDS`（固定基线调查定位见 `r4-cli-consumer.md` B3）。两处是当前漂移事实的直接代码面。
- 当前 store 读取只有全 chain list：`src/sqlite-state.ts:2056-2061`；daemon command union 与 CLI context 子命令没有公开 read：`src/daemon.ts:5731`、`src/loop.ts:1969`。
- task node 的 `leaf | seq | par` ADT 与稳定 `groupId`：`src/task-runtime.ts:43-140`；context group admission 仍无条件拒绝：`src/daemon.ts:1865-1873`。
- preset boundary/runtime model 尚无工具声明，compile projection 仍输出空数组：`src/loop.ts:490-573,714-739,2935-2954`；scheduler finalize 尚无 context outcome 求值：`src/scheduler.ts:2028-2183`。
- 当前 prompt builder 无 context capability doc，作者手册只记录既有 binding：`src/loop.ts:5824-5850`、`docs/preset-authoring.md:278-294`。
- 真实 CLI 大 body、凭证归因、admission、chain 删除和不完整响应等既有运行覆盖索引：`tests/integration/cli/central-cli.integration.ts:1347-1419`、`tests/integration/daemon/context.integration.ts:4-175`、`tests/unit/runtime/context-entry.test.ts:46-91`。

阶段报告仅作为调查路径索引，不替代上述固定 SHA 源码与运行证据：pagination/concurrent set 见 `r7-d04-pagination.md`，read auth 分类见 `r7-d05-read-auth.md`，并行数学纠错见 `r8-nested-par-validity-audit.md`，prompt 寻址合同见 `r8-prompt-decision-validity-audit.md`，供需边界复核见 `r9-expected-foundation.md`、`r10-*.md` 与 `r11-supply-demand-map.md`。

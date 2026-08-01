# RFC #543：生命周期扩展协议实现了什么，以及为什么必须这样实现

## 一、问题边界：从“能记录事实”到“能据事实控制推进”

coder-loop 的调度内核负责按 preset 推进 chain、item 与 phase，却不应知道“运行几轮后必须检查”“哪些修复完成才可继续”或“某个外部质量标准是否满足”。这些判断属于具体项目和操作员策略。RFC #543 要解决的核心问题，是在不把这些策略写进引擎的前提下，让外部脚本既能观察生命周期事实，也能在受控位置影响调度决定。

这不是普通的回调需求。仅在事件发生后运行一个程序，最多提供通知能力；它不能证明脚本看到了与当前运行实例一致的定义，不能在 daemon 崩溃后说明一次执行究竟是否发生，也不能让“暂停推进”成为可恢复的引擎状态。反之，若允许脚本直接改写 scheduler 内部状态，策略外置就会退化为无边界的内部扩展：不可信输出可能破坏状态机，脚本重放可能重复创建纠正任务，局部故障也会扩散到调度主路径。

因此，本 RFC 的交付对象是一条生命周期扩展协议。它从引擎已经掌握的 typed 事实出发，经声明解析、输入投影、子进程执行、决策解析、持久化消费与统一观测，将外部策略接入调度系统；与此同时，它规定哪些权威仍属于引擎、哪些能力必须由相邻 RFC 供给，以及哪些外部副作用明确不由引擎兜底。

必须先说明现状。main 已经具备 observer 挂点的类型派生、对 `hook.*` 自反订阅的结构排除、gate 决策点闭集、四层声明形状及固定合成次序等基础；global、chain、item 层已有 operator-only 持久化语义，部分 closure 生命周期事实和 chain-complete 指纹也提供了先例。然而，这些基础尚未形成运行闭环：声明视图没有完整的生产与消费路径，observer 与 gate 脚本没有真正执行，hook payload、decision ingress、evaluation journal、具名绑定、script join 与结构化 reopen 均未在当前 main 上完成。下文所称“RFC 实现”指其目标协议与修补后应成立的合同，不把这些目标误写成已经落地的事实。

## 二、为什么已有事件日志和 agent phase 不足以完成闭环

典型需求不是“某次 run 结束后记一条日志”，而是“在特定轮次检查结果，必要时创建检查与修复工作，并在它们完成前阻止原流程继续”。这条链至少跨越三种不同动作：读取运行事实、产生额外工作、作出调度决定。事件日志只解决第一种动作的可见性；普通 agent phase 虽能执行任务，却无法天然代表 scheduler 在某个决策点上的放行权。

如果把检查脚本当作普通 observer，它即使发现问题，也只能旁路执行。scheduler 可能在脚本完成前已经选择下一个 item。把新建检查任务排到较前位置也不能构成正确性保证，因为全局排序不等于“原决策点被扣住”；其他 chain、并发 writer 和重启恢复都可能改变实际选择顺序。真正需要的是一个由 scheduler 承认的 hold 状态：只约束相关 chain 或容器的推进，而不阻塞 daemon 的其他工作。

如果让 gate 的标准输出直接携带任意 mutation，脚本就获得了绕过既有 CLI admission、权限校验和审计的能力。RFC 因而把“创建纠正 item”和“决定是否推进”分开：脚本以 operator 身份通过既有命令面实施 mutation，gate stdout 只返回一个受类型约束的 decision；当 decision 引用既存 correction IDs 时，消费方再校验其归属和合法性。该分离使 mutation 继续服从原有控制面，而决策通道保持窄小、可解析、可穷尽。

这也解释了 RFC 为何不能用单一 hook 概念覆盖全部场景。通知失败与决策失败具有根本不同的后果：前者应当被记录但不得改变调度，后者必须按声明的失败策略折叠为 hold 或 advance。只有先拆开这两种责任，才能分别定义正确的进程所有权、持久化状态与恢复行为。

## 三、声明模型：四层来源如何形成一个可治理的生效视图

RFC 把 hook 声明分布在 global、chain、preset 与 item 四层，并规定生效次序为 global→chain→preset→item。四层不是重复配置入口，而是四种不同治理范围。global 表达整台运行环境的统一要求；chain 绑定某个工作流实例的操作策略；preset 提供可分发的抽象要求；item 则允许对单个工作单元追加局部约束。固定次序使同一决策点的实际执行集合能够被重建和审计，避免调用处各自拼接而产生不同含义。

声明边界使用封闭 ADT，而非任意字符串与 optional-field 集合。ObserverHookPoint 直接从统一 observability 事件词表派生，并结构性排除所有 `hook.*` 事件；因此，新增普通事件能够自动成为 observer 候选，新增 hook diagnostic 则不会意外形成递归订阅。GateDecisionPoint 是显式闭集，因为 gate 不是“凡有事件就能阻塞”：它只能位于 scheduler 真正拥有决定权的位置。closure transition 属于已发生的权威事实，只适合 observer；若需要阻止挂起，应在其前置的 run post-exit 决策点 hold，而不是试图 gate 一条已经提交的 transition。

四层声明必须由 operator 控制。agent 或 preset 授权不能创建、替换或清除 hooks，否则被调度的工作负载可以改变自己的监督条件。此处的责任属于 daemon admission，而非脚本执行器：权限问题发生在声明写入边界；一旦声明通过并进入 durable 生效视图，执行器只消费已授权事实。

当前 main 已落下这部分的主要骨架，但“能解析声明”不等于“声明已有执行语义”。完整协议还要求生产路径实际装配生效视图，status 暴露选中来源与运行状态，并让每个决策点都经过同一个 evaluator。否则，四层顺序仍只是静态结构，无法保证运行中的行为一致。

## 四、Observer：旁路观察为何仍需要严格的进程所有权

Observer 的职责是对统一事件流做匹配，并为每个“事件×匹配声明”建立独立 delivery。它不返回调度 decision，也不能改变触发事件的结果。生产者在调用栈内完成 admission、spawn/error 握手和完整 stdin 写入后即可继续，不等待子进程结束；脚本成功、非零退出、超时或派生 diagnostic 失败均不得反向改变 scheduler 的决定。

旁路并不意味着可以丢弃生命周期管理。daemon 若只 spawn 后遗忘 PID，正常停止会遗留进程，崩溃重启也无法判断旧脚本仍在运行还是已经结束。RFC 因而把 delivery 与 execution attempt 持久化：delivery 表示某个匹配应被投递的一次逻辑责任，execution 表示一次真实启动。同一 delivery 在崩溃恢复时可以有多个 attempt，但每次 attempt 都有独立身份和终态。

正常停止采取有界回收。daemon 先停止接受新的 observer dispatch，等待已有脚本在限定时间内完成；超时后对其进程组发送 TERM，再在必要时发送 KILL，等待 close 并落下权威终态后才关闭相关存储。采用进程组而非单 PID，是因为脚本可能派生子进程；仅终止直接 child 不能证明 daemon 已收回自己拥有的进程树。

崩溃恢复遵循 at-least-once，而非 exactly-once。重启后的 daemon 只处理所有权记录仍悬而未决的启动：先清除它可能遗留的进程组，再履行原来的 delivery。凡是已经写下确定结局的投递，无论结局是完成、脚本报错退出、启动或输入通道失败、达到时限，还是在正常停机中被强制结束，都不会仅因 daemon 再次启动而重跑。这样做消除的是“引擎不知自己还欠哪次投递”的状态空洞，并不声称脚本只会运行一次。

Observer 与 agent 可以共享领域无关的异步 subprocess primitive，但不能直接把现有 agent executor 当作 hook executor。公共 primitive 只处理 spawn、stdio、进程组、timeout、TERM→KILL 和 close；agent 的 slot、phase、session、credential 与 backoff 仍由 agent adapter 管理，observer 的 delivery 与 diagnostic 则由 observer adapter 管理。把领域状态塞进公共层会使两种进程的恢复语义相互污染；复制第三套底层进程代码又会让超时和回收行为漂移。因此，共享的是机制，而不是生命周期模型。

## 五、Payload：脚本看到的必须是固定事实，而非重放时的“最新解释”

Observer 与 gate 共用一个版本化、typed payload。它由三部分合成：运行实例所 pin 的定义投影、当前 runtime snapshot，以及触发上下文。定义态与运行态来自已有公共 schema/projection，而不是在每条执行路径手写字段；hook assembler 只做选择性投影和封装，不建立第二个事实源。匿名或内部状态槽不能因为“全量元数据”这一表述而原样泄给脚本，GitHub mergedness 等业务事实也不能被注入 L1 引擎 payload。

固定 payload 是 crash recovery 的必要条件。设某个 delivery 在定义版本 H1 下建立，脚本启动前后源路径已经变为 H2。若恢复流程重新解释当前文件，第一次进程和恢复进程面对的就不再是同一项投递，此前的 mutation、decision 与 diagnostic 也无法放进一条因果记录。恢复时必须重用 delivery 建立时封存的输入内容，而不能再次组装；信封以逻辑投递编号连接多次运行，并另行标明这一次子进程运行的编号。

这一要求不能由 #543 自行读取当前 preset 路径来满足。它依赖 RFC-2 提供不可变的 pinned definition artifact、跨重启 resolver 和公共 compile projection。resolver 必须对 missing、corrupt、unsupported version 给出 typed failure，不能静默退回当前路径。物理介质可以是 inline、blob 或其他形式，hash、压缩和 GC 也属于实现参数；#543 只消费“给定 definitionRef 可恢复对应定义或明确失败”的权威合同。若没有这一层，所谓稳定 payload 只是当前进程内的偶然一致，无法跨重启成立。

Payload 的版本字段同样不可省略。外部脚本是独立部署的消费者，schema 演化无法依赖 TypeScript 编译器同步提示。版本化使脚本可以显式拒绝未知形态，也使 execution terminal、decision journal 与审计记录能够指出当时究竟使用了哪一种输入契约。

## 六、Gate：把不可信脚本输出收窄为可穷尽的调度决定

Gate 位于明确的 scheduler 决策点，例如 run 结束后的下一步选择、容器 join 或 chain-complete。它执行脚本，将 stdout 在唯一信任升格点解析为 typed decision ADT，再由调度消费。基础词表是 `advance`、`hold` 与容器语境可用的 `reopen`；非容器点只接受与该点相容的子集。非法 JSON、未知 variant、缺失字段、超时和进程崩溃均属于协议失败，必须按声明的 `onFailure` 显式折叠为 hold 或 advance，不能以 default 分支静默放行。

`advance` 表示本 gate 对当前点无阻塞意见，`hold` 表示相关 chain 或容器暂不推进并按退避策略重新评估，`reopen` 则请求容器恢复到一个合法 target 并消费明确的 correction items。Decision schema 不携带任意 mutation。如此划界，是因为 stdout 是不可信字节，而 CLI mutation 已有权限、边界解析和审计；把二者混合会让 gate executor 同时承担命令解释器和调度判定器两种不相容的责任。

同一决策点可能来自四层多个 gate。执行顺序固定，但合成不是“最后一个结果覆盖前面结果”。对只允许 advance/hold 的点，全部 gate 均 advance 才能放行，任一 hold 即扣住。容器点还需要处理 reopen：reopen 优先于 hold；多个 reopen 若指向同一 target，则 correction IDs 以稳定顺序去重合并；若指向不同 target，引擎没有安全的隐式优先级，结果应收敛为 hold 并发出冲突 diagnostic。声明顺序仅用于可重建的执行次序，不能被偷换成业务冲突裁决。

Hold 必须是局部、可见的持久状态。一个 chain 的 gate 不应冻结其他 chain，也不应让 daemon 查询面失效。反复评估还需要 fingerprint：它由该决策点的 typed 评估输入与有效声明派生，排除 gate 自己写入的状态；同一 fingerprint 下已 hold 的输入不应形成无意义的重问风暴，输入变化后才产生新评估机会。Tick gate 还需为每项声明设置独立的正整数最小间隔，避免周期触发退化为高频脚本轰炸。

## 七、身份与 Journal：为什么一次 gate 不能只靠退出码记忆

RFC 用四层身份贯穿完整因果链。Transition identity 指认上游权威状态机发生的那一次生命周期转移；delivery identity 指认该事实与某个匹配声明结合后产生的一项逻辑投递责任；execution identity 指认履行这项 delivery 时某一次真实的子进程尝试；evaluation identity 则指认 scheduler 围绕某个决策点开展的一次判定事务。四者不能互代：同一 transition 可以匹配出多个 deliveries，一项 delivery 可以因恢复产生多个 executions，而进程运行次数也不能证明某项 decision 已被消费。Epoch 与 fingerprint 都从属于 evaluation：前者划分 decision 消费后的判定代次，后者刻画该代次所见评估输入是否发生变化；它们是判定的两个维度，不是与上述四层并列的新身份。

若只有子进程退出码而没有 durable evaluation journal，daemon 可能在几个关键窗口崩溃：脚本已创建 correction item 但尚未返回 decision；decision 已解析但尚未写盘；decision 已写盘但其引擎内 effect 尚未消费；effect 落了一半但 consumed 标记未提交。重启后重新运行脚本既可能重复 mutation，也可能让脚本基于新状态改判，使旧 correction 失去归属。

Journal 因而以 `evaluating | decided | consumed` 之类的封闭状态记录权威 evaluation identity、decision 与待执行的引擎内 intent。Spawn 前必须先建立可恢复身份；decision 与 pending intent 之间有明确的原子边界；decided 但未 consumed 的记录可在重启后继续消费，而不要求原触发事件再次发生；只有消费完成后 epoch 才递增。这里不规定具体是 outbox、表还是 consumer 拓扑，要求的是每个崩溃窗口都有唯一、可穷尽的恢复后果。

Gate 脚本经 CLI 创建 mutation 时携带 evaluation scope。Admission 层把规范化 mutation key 与首次响应持久化：同一 epoch 内的重放返回第一次结果，而不是再次创建相同 item；普通 operator 命令继续维持既有语义，不被强行纳入 evaluation 幂等协议。`item.created` 等审计事实也应携带 scope，从而能追踪某项纠正工作由哪次判定产生。

这种设计仍不承诺非确定脚本没有孤儿 effect。脚本可能在留下某个外部动作后崩溃，也可能创建了最终 decision 未引用的 correction。Journal 能保证引擎拥有的 mutation、decision 和消费效果可恢复、可审计；它不能回滚任意外部世界，也不能把判定主体变成 exactly-once。

## 八、具名 Gate：可分发 preset 与本机脚本之间的接口边界

Preset 需要表达“这里必须经过某项策略检查”，但可分发的 preset 不能嵌入某台机器的绝对脚本路径。RFC 以具名 gate 把需求与供给分离：preset 只声明 gate 名、决策点以及 required/optional 性质；global 或 chain 层由 operator 提供名称到脚本、timeout 与 onFailure 的绑定。

绑定解析是穷尽三态。已绑定时，选中的脚本作为 preset 层成员进入统一 gate evaluator，不产生专用执行路径；optional 未绑定时显式空过并留下可观测 skip；required 未绑定时，新实例在创建边界被结构化拒绝，已存在的 pinned 实例在恢复时进入可见 hold。Required 不能在 compile 时依赖某台运行机器的绑定，也不能在重启后暗中降级为 optional。

同名绑定采用 chain 覆盖 global 的配置语义，实际只执行一个 effective binding；status 同时显示 selected 与 shadowed source，以便解释脚本为何来自某一层。它与 global、chain 自己声明的普通 hooks 是两种角色：前者为 preset 接口提供实现，后者是该层直接添加的行为。若把两者混为一组依次执行，覆盖语义会被错误地变成叠加语义。

这项机制由声明/装载层负责，而非 subprocess primitive 或 scheduler 决策合成层负责。路径可分发性、绑定优先级和缺失语义都发生在“抽象需求如何解析为有效声明”的边界；执行层只应接收已经解析完毕的 gate，不应了解 preset 来源。

## 九、Script Join 与 Reopen：脚本判断如何接入容器推进

容器的成员全部 terminal 并不必然意味着外层 seq 可以推进。并行批次可能需要质量判定，chain-complete 也可能需要外部条件确认。RFC 因而为 join 判定器增加 script variant，使脚本与 agent-phase validator 共用同一 decision ADT、同一派发路径和同一 reopen consumer，而不是形成第二套容器状态机。

Script join 的输入仍来自统一 payload，输出仍经唯一 decision parser。Advance 放行容器，hold 扣住并按 fingerprint/退避重新评估，reopen 则引用脚本此前通过 evaluation-scoped CLI 创建的 correction IDs。脚本若需要检查 GitHub mergedness，应以 operator 身份调用 GitHub 能力自行查询；L1 引擎不拥有这一业务事实，也不应为了某个判定器向 payload 加入 GitHub 字段。

Reopen 不能由 #543 通过“改几张表”自行完成。一个合法 reopen 必须判断 target 是否属于当前容器、是否位于允许回退的 seq、是否已经运行，校验 correction IDs 的 membership 与 claim，解析并消耗预算，回退游标，同时保持已经 terminal 的 item 状态不变。Target reopen、cursor/budget 更新、correction claim 与 decision consumed 必须全有或全无；重复、冲突、预算耗尽和崩溃恢复也需要 typed 结果。

这些权威属于 RFC-1 的 structured reopen authority。#543 递交的是可归属到一次 evaluation 的判定、未由本层解释的 target，以及 decision 明确点名的既存 correction IDs；权威 consumer 返回结果后，#543 才推进自己的 journal。它不能用 metadata carrier 或连续若干次 CLI mutation 拼出一个貌似原子的 reopen。类似地，closure 的 create、run-spawn、run-exit、suspend、reopen、consume 六条 canonical transition 也由 RFC-1 确定发生时点、当时的 snapshot 与 transition identity。这里的 transition identity 正是§七四层因果身份的起点；observer 从该身份派生 delivery，不能拿 delivery identity 反过来充当生命周期边的去重依据，也不能从现有五类主题性 `closure.*` 事件推断缺失的权威转移。

## 十、可观测性：让扩展协议本身也成为可调查对象

Hook 系统若只在成功时留下脚本输出，就无法回答最关键的运维问题：脚本是否启动、收到了哪个 payload、为何超时、哪个 gate 扣住了 chain、重启后是重新执行还是继续消费旧 decision。RFC 因而要求 `hook.*` lifecycle、decision 与 diagnostic 进入统一事件边界，并在 status 中投影有效声明、当前 hold、选中绑定及评估状态。

Observer execution 的 durable terminal record 是 diagnostic 权威。统一事件由该记录派生；若 daemon 在“终态已提交、事件尚未追加”之间崩溃，重启后可以补做派生。相反，事件追加成功但标记未完成时允许重复派生，重复记录用稳定 execution identity 关联。事件流不是第二权威，也不要求 sink exactly-once。采用这一方向，是因为进程结果属于 execution 生命周期，而事件只是面向调查者的投影；若先把事件当权威，sink 故障会错误地改变 delivery 状态。

Gate 的观测还需包含 decision、协议违规、onFailure 折叠、hold、fingerprint 命中、重新评估、journal 状态转移与重启恢复。这样，“为什么没有继续”“为什么没有再次插入 item”“为什么 required gate 没执行”都能从 status 与事件因果链回答，而不必猜测内存状态。

所有派生的 `hook.*` 事件必须在声明期和发射期双重零自反。声明期使递归订阅不可表达；发射期即使面对旧数据或边界绕过也不得再次派发 observer。若缺少后一层，一次失败 diagnostic 仍可能触发同一失败脚本，形成无限的进程与事件风暴。

## 十一、并发、外部副作用与当前仍未解除的依赖

RFC 允许不同脚本并发，也允许同一脚本跨事件、chain 和连续触发并发。每个 match 都形成独立 delivery，不因为脚本名相同而合并、跳过或串行。引擎提供稳定 identity、固定 payload、自有状态的持久化、局部 CLI 事务与审计关联，但不提供 per-script lane、全局串行、跨脚本资源锁或外部分布式事务。

因此，脚本对文件、Git、数据库和第三方服务造成的并发冲突由脚本作者负责。目标系统若提供幂等 key、CAS、锁或事务，脚本应自行使用；若不提供，引擎不会伪造 exactly-once。特别是在 observer crash 重派和 gate 判定重问中，同一逻辑责任可能产生多次外部调用。将这些 effect 纳入引擎回滚既需要理解资源协议，也会把项目业务语义带回 L1，违背本 RFC 的策略外置边界。

Gate 或 daemon 生命周期一旦决定进入 held 收敛阶段，待排空集合就必须停止增长。若 socket 仍接受 mutation、scheduler 仍建立工作、observer 仍产生 delivery，排空过程会不断获得新成员；与此同时，存储关闭可能与新 intent 的提交交错，使一项已获接纳的工作最终没有 durable outcome。查询必须继续开放，因为 operator 需要借此定位 hold 的来源、观察 drain 进度，并取得解除 hold 所需的事实；这不是把读权限等同于写权限。

`shutdown-held` 因而只让读取路径继续服务。新的 mutation、调度工作和 observer 投递在进入执行前即被 typed reject，已经接受的工作则按 drain 规则走到可记录结局；一次拒绝不能顺带写 DB、追加事件或启动进程。调用方若要再次提交被挡下的 mutation，必须自行发起新的请求，引擎不会因 held 解除而代为补交。

截至预期地基复核，三组外部能力仍是完成声明的 external blocker。第一，RFC-2 的 pinned definition artifact/resolver 与公共 compile projection，阻塞跨重启固定 payload 及具名声明的可靠解析。第二，RFC-1 的 canonical closure transitions，阻塞六条资源转移边的权威 observer 触发。第三，RFC-1 的 structured reopen authority，阻塞 target、claim、budget、cursor 与原子 reopen effect。它们只阻塞相应完成主张，不授权 #543 建立临时替代品。与此同时，外部文件或服务的幂等能力不是 external blocker，而是明确排除在引擎保证之外。

还需区分预期合同与已证明的运行事实。Observer 的 spawn/ownership kill-point、固定 payload 重派、进程树回收、diagnostic replay，gate 的 transaction crash matrix、metadata 并发 mutation、`shutdown-held` admission，以及 RFC-1/RFC-2 接缝都尚需在真实路径上验证。静态 ADT、声明测试或局部 transaction 先例不能证明这些跨进程与跨重启性质已经成立。

## 十二、结论：扩展能力的价值来自边界组合，而非脚本数量

RFC #543 最终改变的不是“系统可以多运行几段脚本”，而是 coder-loop 对外部策略的承载方式。Observer 把已发生的生命周期事实送到旁路消费者，gate 在引擎拥有决定权的位置接受受限判定；共享 payload 保证判断基于固定、可说明的输入，分层 identity 与 journal 使崩溃恢复具有确定后果，四层声明和具名绑定把治理范围与可分发接口结合，script join/reopen 则把容器判定接回 RFC-1 的权威状态转移。统一 observability 使这条协议本身也可以被查询、审计和复盘。

这些机制必须组合出现。没有 observer/gate 分离，通知故障会污染调度或决策失去阻塞力；没有 pinned payload，同一 delivery 的重放会改变问题本身；没有 evaluation journal，decision 与 mutation 在崩溃窗口中无法归属；没有具名绑定，preset 要么携带本机路径，要么只能留下无执行语义的名字；没有 RFC-1 authority，reopen 就会成为跨表的非原子猜测；没有外部 effect 边界，引擎将被迫理解 GitHub、文件和数据库的业务事务。

协议的可靠性因此来自职责精确，而非保证无限扩张。引擎保证自己拥有的声明、投递、评估、decision、admission 和状态消费可类型化、可恢复、可审计；脚本负责其策略和外部副作用；RFC-1 与 RFC-2 分别提供任务生命周期与固定定义的权威事实。正是这种分工，使业务策略能够留在引擎之外，而调度决定仍然保持为引擎内部受约束、可证明的状态转移。

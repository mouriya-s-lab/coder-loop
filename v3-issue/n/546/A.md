# 为什么 coder-loop 需要任务代数，以及这套设计实际上建立了什么

> 本文不是 RFC 的缩写，也不承担规范权威。它从 coder-loop 的现实故障出发，解释为什么仅给现有队列补字段无法得到可靠并发，以及 RFC #546 所定义的目标语义、仓库里已经存在的工程地基和仍待实现的生产行为分别是什么。规范裁决以 [RFC.md](RFC.md) 为准，事实出处以 [EVIDENCE.md](EVIDENCE.md) 为准。

## 1. 先看一个并不特殊的工作流

设一个 chain 刚创建时有三个工作单元 A、B、C。它们处理同一项目里的三个问题，却没有业务依赖，因此应该同时取得运行机会。A 完成第一次工作后，根据返回结果产生一个后继 A2；B 运行到一半发现必须等待一个审查任务 B-check；C 的 runner 进程崩溃，重试次数最终耗尽。与此同时，操作员向仍未结束的顶层工作集合追加 D。所有分支落定以后，一个 finalizer 检查这批工作是否足以结束 chain。运行期间 daemon 可能在任意两次持久化动作之间崩溃；运行结束后，系统还要判断哪些 worktree、分支和 session 可以回收，并如实报告工作成果是否曾经发布到自己负责的远端通道。

这个案例会迫使系统回答一些看似属于不同模块、实则共享同一逻辑根的问题。A2 为什么有资格运行？B-check 是 B 的内部步骤还是一个独立并发对象？C 的崩溃会不会阻止 A、B、D？追加 D 时，谁决定它属于哪一个并行集合？finalizer 看见的是哪一批已落定结果？daemon 在“记录 C 已异常”和“释放 C 的锁”之间退出后，重启应相信什么？删除 worktree 后，审计记录还能否证明那个任务存在过？

v2 的队列可以分别为这些问题增加条件分支，但那样得到的只是更多互相校正的状态字段。真正的困难不是缺少一个 `status` 值，而是系统没有明确区分：什么东西在被调度，什么东西在执行中积累状态，什么东西只是函数的输入或输出；也没有一组封闭的组合规则说明并发结构怎样产生、怎样落定、怎样被消费。

“任务代数”因此不是为了让术语更像编程语言理论。它要把上述所有行为压到少数可组合、可持久化、可验证的构造中，使非法状态没有正常写入路径。删除这层约束，系统仍可以跑简单的线性 preset，却无法对动态并行、崩溃恢复、资源回收和审计给出同一个答案。

## 2. 现有模型为什么会在复杂场景里分裂

旧实现把 item 同时当作业务材料、队列成员和生命周期载体。`item.status` 既可能表示 agent 返回的业务结论，又可能被 scheduler 当作可运行性依据；phase 既像函数标签，又像固定流程位置；slot 的串行约束还会把本来没有依赖的工作表现成先后关系。这些概念在简单队列中看似方便，因为一行记录就能回答很多问题。一旦出现 B 的内部等待、A 派生 A2 或顶层追加 D，同一行就不再能同时代表值、执行现场与组合位置。

分裂最直观的后果是两个读面都“有依据”，却给出相反结论。现有生产调度仍主要沿 flat phase/slot 路径运行，而数据库已经有 task tree、closure 和 lock 的结构地基。某个兼容命令可以改变 flat item 或 closure 的状态，却没有同时产生一条合法的树演化。结果不是简单的缓存延迟，而是两个模型对“谁可以运行”各自作答。EVIDENCE 对 main 的冻结审计确认：shape 已能表达树，生产 scheduler 仍未以递归树状态作为唯一 ready-leaf 来源（[EVIDENCE.md §2](EVIDENCE.md#2-main-实然底图能力-an)）。

如果用双写补丁弥合这种分裂，新的问题马上出现：两次写之间 crash 怎么办？哪一边先写？重试如何去重？旧字段和树结构冲突时相信谁？每多一个派生方式，都要复制同样的协调逻辑。任务代数选择另一条路：只允许少数事实事件进入权威历史，其余 current state 都由它们投影；调度资格只能从一个组合结构推导。兼容读面可以继续存在，却不能成为第二个推进器。

用户可观察的改变不是“状态表更漂亮”，而是同一个任务在 CLI、daemon、GUI、重启恢复和 GC 判断中不会出现互相矛盾的生命周期。验证这一点也不能只查 schema；必须构造一次 flat 兼容写与 tree 状态冲突，证明生产系统拒绝制造额外 ready leaf，或者只把兼容操作翻译成合法的前向事件。

## 3. 三个域解决的是责任混淆，不是命名问题

设计把案例中的实体拆成三个域。对象域只有 task：A、A2、B-check、D、finalizer 都是 task。它们拥有稳定身份、在组合结构中的位置以及运行锁，但不保存 agent 的业务判断。函数域是每个 task 执行时的闭包：A 的 worktree、branch、runner session、scratch 和等待 B-check 时需要保留的现场属于这里。值域是不变数据：创建 A 的 item 是种子参数，phase 是将要调用的函数标签，status tag 是函数返回值的一部分，binding 和 exit 是参数或结果。

这个切分最重要的效果是，调度器不再解释业务词。假设 C 的 agent 返回 `needs_revision`。只要它通过声明的返回 union，并由派发表接住，这就是一次正常返回；业务上是否失败由下一个 task 处理。只有 runner 崩溃或 attempts 耗尽、从而没有提交返回值，才是引擎异常。若把两者继续混成“失败状态”，scheduler 就必须知道每个 preset 的词义，并且无法区分“已产生可路由的负面结果”和“没有结果”。

删除对象域与值域的分界，D 的种子数据就可能再次变成一个可变队列单元；删除对象域与函数域的分界，worktree 生命周期便会跟业务 status 绑定；删除函数域和值域的分界，session 中的临时现场可能被误当成可重放的持久输入。三域不是要求实现三个服务，而是要求跨模块数据类型不再用同一个松散 record 冒充三种身份。

对用户来说，这意味着 `status` 读面会明确展示“task 是否已返回或异常”“closure 资源处于何种生命周期”“业务返回值是什么”，而不是给出一个含义随命令变化的字符串。其代价是迁移期必须为旧字段建立明确的投影或转换，不能继续让任何字段既是权威输入又是派生输出。验证要覆盖类型边界和运行路径：给引擎一个业务失败 tag，应当正常派生声明的处理 task；杀死 runner 而不提交返回，应当记录 exception，且不能伪造同一个业务 tag。

## 4. 三个时态使“定义”和“正在运行的程序”不再互相改写

同一个工作流至少有三种不同事实。定义态描述 phase 能返回哪些 variant、每个 variant 接到什么后继、是否会 await 下级任务、chain 使用哪个 base branch，以及 finalizer 是什么。编译态把这些声明解析为精确类型，检查派发是否覆盖全部返回 variant、结构是否可组合、dependsOn 是否成环，并冻结一个可引用的 execution definition identity。运行态只实例化已经编译的构造，持有锁，追加事实，不修改正在运行实例的定义。

这不是“chain 先配置、再编译、最后永远运行”的三段流水线。D 是在 chain 已运行后追加的，它仍需经过自己的定义解析和编译边界。B 运行中派生 B-check 时，B-check 的定义也必须已经被 pin 并通过同样检查。每个定义对象都有自己的三时态，运行中可以实例化新对象，但不能热改旧对象。

为什么 pin 必不可少？设 daemon crash 后，preset 文件已经被人修改，A 的 `review_needed` 原来派生 A2，现在却被改成直接 terminal。若重启时读取磁盘最新文本，恢复便不再是恢复，而是用新程序解释旧历史。类似问题也出现在 join：D 加入前后若允许改写消费者，已经收集的元组将失去确定含义。冻结 definition identity 的代价是升级不能悄无声息地作用于 in-flight chain；迁移必须显式创建新定义或按受控规则转换。这个限制正是所需的可复现性，而非可用性缺陷。

用户可观察的结果是：同一 run 在重启前后保持相同派发和 join 语义；磁盘漂移或 schema 不匹配时系统明确失败并报告 pinned identity，而不是“尽力猜”。可证伪测试应启动一个暂停中的 chain，修改 preset，再重启 daemon；旧实例必须继续绑定旧定义，或以类型化不兼容错误停止，绝不能静默采用新文本。

## 5. 柯里化派生把流程推进变成函数应用

A 并不是在创建 chain 时就带着一串预建节点。phase 声明先接受静态声明参数，编译成一个等待输入值的函数；运行时把 item 种子或前驱返回值交给它，应用的结果才是具体 task。A 返回后，返回 tag 选择下一函数，应用返回值形成 A2。这里借用“柯里化”描述的是分阶段供参：声明参数先固定，运行值后到达，而不是要求实现采用某种函数式库。

这种设计消除了“未启动后继”的悬挂状态。C 没有返回，只产生 exception，因此没有任何返回值可用于应用后继函数；C 的依赖线自然停止。相反，A 即使返回的是业务负面结果，只要声明为该 variant 配置了处理函数，A2 就正常产生。派发表在编译时必须穷尽，因而不会在生产中遇到一个合法 tag 却不知道往哪里走。

若预先创建完整节点图，动态数据决定的分支必须靠 enable/disable 标志维护，未选中的节点会污染完成判定、GC 和 UI。若运行时用任意脚本决定下一个节点，系统又无法静态证明返回 variant 都有归宿。柯里化派生把两端接起来：流程可以由运行值选择，同时选择空间来自冻结定义。

其代价是运行历史必须记录应用所用的 definition ref 和输入值身份，调试工具也要展示“为何派生这个 task”，不能只列节点名。非目标是把 prompt 或 agent 内部计算变成纯函数；闭包当然有副作用。这里要求确定的是跨 task 的生成关系。验证时应为一个有三个返回 variant 的 phase 分别提交返回，确认三条派发表逐一命中；删去一个声明分支，编译必须失败；制造 exception，确认没有后继对象被预建或激活。

## 6. seq、par 和 join 给并发一个可计算的边界

案例中 A 的后继 A2 与 A 构成 seq：只有 A 返回值存在，A2 才能被应用。A、B、C 是顶层 par 的成员，因为三者没有相互依赖；所谓“初始顺序”只可作为调度优先级，不能暗中把它们变成依赖线。D 在顶层尚未落定时追加，也成为该开放并行集合的成员。

par 不仅表示可以同时运行，还必须说明何时把各成员结果交给谁。join 是消费成员落定结果的函数。它按 all-settled 语义观察每个成员：正常返回携带值，exception 也作为一种落定结果进入边界。这样 C 的崩溃不会阻止 A、B、D 继续，但最终消费者能看见 C 没有返回。若声明者不关心成员值，可以使用 drain，即明确丢弃结果并放行；若需要判断，则实例化 validator task，它消费结果元组并通过普通返回值给出决定。

join 必须在并行容器诞生时固定。允许运行中热改 join，等价于对已执行程序改写其消费者：同一组 A/B/C/D 结果在不同重启时可能走不同路径。需要新增检查时，可以在尚开放的外围结构中追加新的检查 task，或让 finalizer 把关，而不是改变已存在容器的含义。

同级 leaf 未落定就不能越过它推进到下一级，这是组合代数的基本约束。seq 的位置只向前；par 只有达到声明的落定条件并经 join 消费后才能释放后继；不存在 cursor 后退、事后恢复已越过节点或重开 terminal 容器。这个限制不仅防止状态错乱，也确保 crash replay 可以从事件前缀唯一重建 frontier。旧兼容命令若暗示“把过去节点改回 ready”，必须被退役或重新定义为只作用于尚未完成的位置。

用户会观察到：A、B、C 可并发；C exception 后其他成员不受阻；D 若在容器落定前成功追加，join 等待并消费 D；一旦 join 已提交，追加被拒绝，不能让已放行的结构重新打开。代价是某些临时运维欲望不能靠改状态解决，只能创建新的前向工作。验证需在时间上竞争 append 与 join commit，证明原子边界只允许两种结果：D 被纳入固定元组，或追加失败；绝不能出现 join 已放行但 D 又被算入旧容器。

## 7. await 与 dependsOn 不是两种隐藏队列

B 需要 B-check 时，B 的闭包尚未返回。await 允许运行中的 task 派生下级 task，保存自己的函数现场，释放执行锁，等下级返回后把值送回同一个函数实例继续执行。它是全模型中唯一允许“正在运行的函数从外部再接收一个值”的正规通道。B-check 仍是对象域中的 task，有自己的闭包、资源和锁；它不是 B session 里一个无法观察的子进程。

如果没有 await，开发者通常会用 resume prompt、共享文件或手写 status 把 B-check 结果塞回 B。这些旁路既绕开类型检查，也无法证明 crash 后值被消费了几次。await 把等待关系和继续点放进持久模型，使 B 释放计算资源而保留必要现场。若 B-check exception，B 收到的不是伪造业务值；异常如何处理由声明的消费者结构决定。

dependsOn 解决另一种需求：D 只要求 A2 先落定，却不消费 A2 的返回值。它相当于等待后丢弃，不应借用 seq 传值，也不应偷偷把 D 放进 A 的函数域。依赖图在写入或装载时查环；依赖方在前驱 exception 而无可消费结果时不会启动。系统不自动升级、不猜测“也许可以继续”，因为那会把业务政策写进引擎。

await 的成本是闭包现场需要可恢复，锁释放和重取必须有精确协议；dependsOn 的成本是动态追加时也要重复环检测。二者都不承诺分布式事务式的任意回滚，也不引入取消传播。验证应让 B await B-check 时停止 daemon，确认重启后 B 不被重复 spawn、B-check 仍可完成且返回值只注入一次；另造 A dependsOn D、D dependsOn A，写入必须在任何执行前失败。

## 8. 动态追加不是改数组，而是扩展尚未完成的结构

操作员追加 D 时，系统面对的不是“往 items 表插一行”，而是“在哪个仍开放的组合边界派生新 task”。如果目标原本是单个尚未落定 task，首次追加可把它原地物化为一个 par 容器：原 task 与 D 成为同级成员，容器取得稳定 identity，并在诞生时绑定 drain 或声明的 join。后续追加复用这份 pin。嵌套结构各自拥有独立容器 identity，不能凭路径字符串猜归属。

为什么必须限制为未落定结构？如果 finalizer 已消费 A/B/C 的结果，再加入 D，就会要求重开消费者或让 D 永远不被顶层完成条件看见。前者破坏单调性，后者制造孤儿。前向追加只允许改变尚未决定的未来，因此与崩溃重放兼容。

append 还必须经过定义编译与授权。operator 可以按产品合同操作；agent 默认拒绝，只有 phase slice 明确授予 derive/create 权利并限定 scope 时才可追加。否则任意 task 都能扩大工作树、消耗无限资源或逃出自己的结构边界。配额和并发上限属于声明参数；未声明不等于引擎偷偷给一个经验默认值。

用户可观察到稳定 group identity、追加来源、授权判定和加入后的 join 成员关系。代价是 CLI 必须要求明确目标容器或可唯一解析的 scope，不能继续依赖“当前 item 附近”这种隐式位置。验证应覆盖第一次物化、再次追加、嵌套追加、越权追加、落定后追加以及 daemon 在写容器和成员之间 crash 的恢复；每次重试都只能得到同一个 D identity，不得复制成员。

## 9. 异常语义必须像程序异常，而不是业务状态机的万能失败

C 的 runner 崩溃并耗尽 attempts 时，没有产生函数返回值。其 seq 线上因此没有可应用的后继，异常向最近的 par 边界传播，在那里成为一个已落定成员结果。A、B、D 继续。若 C 不在 par 内且没有声明消费者，流程就停在那里。这不是 scheduler 故障，而是程序没有定义处理路径。

业务失败完全不同。假设 A 返回 `{tag: "review_rejected", ...}`，该值是声明 union 的合法成员。派发表可以把它交给 correction task，这就相当于显式 catch。引擎不应内置“review_rejected 要重试”或“失败要通知操作员”。把业务 tag 和 exception 混合会让 validator 无法判断自己收到的是明确否决还是根本没有产出，也会诱使全局兜底绕过 preset 设计。

设计允许一个受审计的 `override-advance`，但它只对汇合点实施一次前向推进，并通过与普通返回相同的提交边界。它不是回退、删除、取消、修改 join 或重新打开完成节点。它的存在承认判定 task 自身可能坏死，同时不破坏事件前缀单调性。

用户看到的 exception 应包含 attempt 和闭包身份，并与业务返回 tag 分栏；没有消费者时界面要显示“结构在此停止”，而非永远 spinning。代价是 preset 作者必须完整设计业务补救，而引擎不会替其善后。验证至少包括：业务负面返回派生 correction；进程崩溃不产生 correction；par 隔离 exception；无 par 时 frontier 停止；override 只推进一次且全程留审计事实。

## 10. 五类事实事件和锁把 crash 变成可重放问题

目标运行模型可用五类领域事实描述：某个已编译函数被应用；task 正常返回；task 异常落定；新 task 由既有结构派生；join 消费一组落定结果。实际命令层还会有 spawn、release 和受控 override，但权威历史记录的是足以重建程序演化的事实。锁表回答“哪个 run 此刻拥有某 task 的执行权”，并保证每个 task 至多一个活跃 run。

锁不能代替事件，事件也不能代替锁。若只有可变 current row，daemon 在写返回值和派生 A2 之间 crash，会留下无法判断是否应重试的中间态。若只有事件却没有执行租约，两个 scheduler 可以同时启动 A，随后竞争提交。正确边界是一次 committed transition 原子地确认锁所有权、记录返回、完成当前 task，并构造由该返回选择的下一应用；失败重试依据同一 identity 去重。

状态、GUI 和日志是这份 durable history 的具名投影。它们可以因刷新延迟暂时不同，但必须携带 freshness 或 divergence，不可反向拥有 mutation 权。日志若只是文本输出，不能证明 committed transition；GUI 看到一个 terminal 卡片，也不能越过 DB 事实决定 GC。

代价是事件 schema 和投影版本需要迁移，历史量也会增长；本 RFC 不要求把所有 runner stdout 做成事件溯源，更不把 Git 对象库复制进数据库。验证的关键是 fault injection：在锁获取、runner spawn、返回提交、派生、join consume 的每个边界杀 daemon，重启后应重建同一 frontier，既不丢 task，也不双跑；并以第二个 scheduler 竞争同一 task，证明活 run 唯一性来自 closure/task identity，而非 slot 的偶然串行。

## 11. 函数域资源让并发真正隔离，而不是只让数据库行并行

即使 A、B、C 在调度表中并行，如果它们共享同一可写 checkout，内容仍会互相覆盖。目标合同为每个 task 供给私有 closure：独立 worktree、引擎命名的 closure branch、runner session 和 scratch。B await 时释放运行锁，但这些现场原地保留；恢复从 closure branch tip 和保存的 session 继续，不是回到 chain base 重新开始。

跨 task 的数据只能走声明通道。提交的值、Git origin/GitHub 事实、受权的 context CLI 和 chain 级 shared prompt 面各自有明确用途。共享 Git 对象库、remotes、config 和 hooks 不是 task 私有状态；引擎对其中结构性写操作必须按稳定 repository identity 串行，并限制在自己的 namespace。cwd、remote URL、chain id 和 repo 协调 identity 不能互换，因为同一 repo 可以有多个 worktree和路径，而多个 chain 也可能共享对象库。

Git 的职责还要分清。引擎负责 fetch、解析 `chain.baseBranch` 的新鲜起点、建立 branch/worktree、保存 pin、采样终态和回收；agent 负责内容性的 commit、冲突解决、push 与 PR。base branch 的权威来自 chain 声明，prompt 或 ambient checkout 不能成为第二来源。并行成员从持久 pin 派生，避免各自在不同时间 fetch 后得到不同基底。

删除这种资源合同，所谓 par 只会把竞态搬到文件系统。反过来，把所有 Git 行为都收进引擎也会越过业务边界，使引擎理解 PR 和项目策略。代价是更多 worktree 与磁盘占用，以及共享 Git 操作的协调。验证必须让 A/B 同时修改同名文件，证明未提交内容互不可见；让二者分别 commit/push，确认 branch identity 稳定；在 fetch、branch create、worktree create、DB登记之间逐点 crash，启动对账要枚举 residue，而不是依据单一表面静默删除。

## 12. GC 和 publication 证据解决“资源已删”与“历史仍真”的冲突

完成 task 不等于立即删除 closure。B 完成后，其返回值可能尚未被 join 消费；活 run 或前向可达引用也可能存在。目标消费谓词只要求没有活 run，且该 closure 不再被任何未来可达结构引用。在这个消费时刻，系统先采样并持久保存后续 observer 所需的证据；证据已被冻结为历史数据，而不是额外延迟 GC 的资源引用。消费事实与证据持久化后，GC 便可回收 worktree、引擎分支、session 等活资源。release 只是暂时解锁，绝不触发 GC。

资源 identity 与历史 identity 必须分开。回收 worktree 或删除引擎分支后，task 的应用、返回、异常、派生和消费记录仍然存在；否则 `delete` 会变成改写过去。启动时系统需要对数据库、分支和 worktree 三方核对，且只清理引擎 namespace。发现不一致要暴露为可处理 residue，不能猜测某个陌生分支是垃圾。

publication 是消费时采样的证据，不是生命周期门。它回答 closure 自己负责的远端通道是否包含 closure tip：有工作且 tip 被自有远端分支或已知 PR head 历史包含，可报告已发布；明确未包含则报告未发布即弃；查询失败保留为无法求值；没有工作另成一类。远端是否 merged 是业务判定 task 的职责，不应由 GC 推断。采样结果和采样所依据的 origin freshness 必须持久化，外部通知重试使用同一份样本，而不是重启后重新查询一个已变化的远端。

没有四值证据，网络错误很容易被压成“未发布”，给用户一个错误责备；若 publication 参与推进，Git provider 抖动会阻塞任务代数；若回收时重新查询，force-push 或 ref 删除会篡改历史报告。代价是系统必须保存 evidence intent、采样时间和错误类别，并接受“无法求值”不是立即可消除的状态。验证应在 consume 后改变远端 ref，再重放通知，结果必须保持原样；模拟 fetch 失败，不能输出 unpublished；GC 后查询历史，仍能看到 closure identity 与已冻结证据。

## 13. finalizer 是任务，不是 daemon 中的特殊 if

当 A、B、C、D 全部落定时，固定的顶层 join 不先做一次普通消费、再把结果二次交给别的判定环节。它的消费者就是被实例化并运行的 finalizer task；finalizer 直接接收顶层成员的结果元组，因而这一次消费本身就是 chain 结束判定。finalizer 使用自己的闭包和声明，返回 advance tag 时 chain 完成，返回 hold tag 时 chain 保持开放。它遵循相同的锁、提交、异常和审计规则，而不是由 daemon 解析 stdout 中某个魔法短语。

将 finalizer 特判在引擎里会重新引入业务词义：daemon 必须知道何谓“足够完成”，stdout 格式变化还可能误判。把它变成普通 task 后，preset 可以检查 GitHub、测试证据或其他声明通道，同时引擎只看返回 union。hold 后如何防抖、如何形成再次询问的幂等指纹属于相邻设计，不应在这里偷偷创造周期调度。

用户可观察到 finalizer 的输入成员集合、definition identity、返回值和异常，且这些都出现在同一 task history 中。代价是 chain complete 不再是一个廉价布尔字段，而是投影出的业务结果。验证应让 finalizer 分别返回 advance、hold 和 exception：只有 advance 使 chain 完成；hold 保持开放但不重开任何已完成成员；exception 按声明结构停止，不能被 stdout 文本绕过。

## 14. 授权必须跟派生能力一起收紧

任务代数赋予 derive 和 append 后，安全边界不再只是“runner 能写哪个目录”。一个被攻陷的 agent 若能向任意容器追加任务，就能改变未来程序结构；若能读取 loop-data 全局目录，就能跨 task 获得凭据或未声明输入；若能修改共享 Git config/hooks，则能影响其他 closure 的执行。

现有地基已经包含 default-deny 准入、typed exit、run-scoped credential 和 phase-sliced binding/sandbox 权利，这些可以复用，但尚不能证明整套生产语义已接通。目标授权把 runner 可见面穷尽分为 task 私有资源、显式声明通道和 repo 级共享 Git 协调面。全局读取与 host environment 暴露是两个不同能力，缺失 runtime binding 时不能退回全局搜索。derive 可复用已有 create-items 类权利，但必须加结构 scope；operator 的干预也要审计。

若授权只检查命令名，不检查目标 identity，B 可能合法调用 append 却把 D 塞进 A 的容器。若 sandbox 只保护文件系统而允许 ambient Git credential，无声明通道仍可外泄。代价是每个 phase 需要精确声明 roots、bindings 和结构权限，调试初期会看到更多明确拒绝。非目标是封装 agent 的所有计算或禁止它访问项目允许的互联网；目标是让每一条跨 task 和共享写路径都有可说明的来源。

验证要用真实 runner credential 尝试：读取自己的 closure 成功，读取另一 task scratch 失败；读取声明 context 成功，无 binding 时不能 fallback；向获授权容器 append 成功，跨 scope 失败；修改引擎外 branch/config/hooks 失败；所有拒绝与成功均带 run/task/phase 审计身份。

## 15. 迁移不能把 v2 的偶然串行误写成业务顺序

仓库已有规范化 tree、closure、lock shape，以及授权切片等实现地基，但 v2 数据怎样进入新模型仍需谨慎。最危险的转换是把旧 item 列表机械迁移成顶层 seq。v2 的 slot 串行更多是资源调度限制，不代表 item 之间有数据依赖；迁成 seq 后，前一个 item exception 会封死整条 chain，改变已有业务行为。合理目标是把初始 items 视为默认并行同级，旧位置只保留为优先级；真正的依赖由 dependsOn 或显式组合声明表达。

closure 的持久键也要从旧 `(item, phase)` 观念迁向 task identity，原字段降为绑定元数据。现有 current status 列可在过渡期作为事件投影或兼容读面，却不能继续接受绕过树的独立写入。in-flight 数据必须关联冻结 definition ref；无法证明转换语义时应显式阻断，而不是用最新 preset 猜测。

迁移的代价包括一次性数据转换、双读核对和旧 CLI 行为收缩。它不承诺所有历史内部状态都能无损变成新运行实例；审计历史可以保留，而无法安全恢复的活实例应明确处置。验证应选取包含多个独立 item、失败 item、blocked dependency、已存在 worktree 的 v2 fixture，迁移后证明并行性、历史身份和资源归属正确；再跑现有 bundled preset compatibility E2E，确认没有把旧生产路径的 PR/merge/issue closure 行为误当作新代数已完成。

## 16. 这项设计刻意不做什么

它不提供任何向后移动。完成是吸收态，seq 不倒退，par 消费后不重开，terminal leaf 不通过 unblock 恢复。需要纠正已完成工作时，创建新的前向 task，并保留旧历史。

它不提供子树取消和自动回滚。整 chain 的 stop/resume/delete 属于实例运维；异常不会抹掉已经提交的 sibling 结果。业务补救由声明 task 表达。

它不允许 join 热改，也不靠 epoch 技巧让同一个已实例化消费者改变意义。新增验证只能作为未来结构中的新 task。它不把 observer、GUI、event notification 或文本日志提升为推进权威；这些只是带版本和新鲜度的投影。

它不规定 DSL 的最终表面语法、不实现 context 工具本体、不定义所有 hook 或重问策略，也不把 GitHub mergedness塞进 GC。它不声称“用了事件日志”就自动获得分布式 exactly-once；外部通知采用 durable intent 与幂等重试，runner 副作用仍须由各自合同约束。

这些非目标不是缺页，而是防止设计因反例无限膨胀。每个新增机制都必须追溯到实际问题：若只为守住一句过强主张而扩大系统，正确动作是弱化主张，而不是发明更多状态。

## 17. 从用户入口看，完成后的系统应怎样表现

回到案例。chain 创建后，status 展示一个顶层并行结构及 A/B/C 三个 ready task，它们有不同 closure identity 和同一冻结 base pin。scheduler 可同时锁定三者。A 提交返回时，一笔 transition 完成 A 并派生 A2；界面能解释 A2 使用了哪个返回 variant。B 派生 B-check 后释放自己的运行锁，closure 显示 suspended 而非 terminal；B-check 返回后，B 只消费一次该值并继续。C attempts 耗尽后记录 exception，A、B 仍运行。

追加 D 的调用指出顶层容器，授权和定义检查通过后只增地加入；若调用与 join 落定竞争，结果要么明确纳入，要么明确拒绝。所有规定成员落定后，固定的顶层 join 实例化 finalizer，并把包含 C exception 以及 A2、B、D 返回的整个结果元组直接交给它。这里没有一个先行的普通 join 消费步骤；finalizer 就是该顶层 join 的消费者，最终以普通返回选择 advance 或 hold。

若 daemon 在任何一步 crash，重启先重建事件前缀和锁，再对账 branch/worktree/DB；它不会从 flat status 猜一个额外 ready leaf，也不会用改过的 preset重解释旧 task。消费后，GC 依据 durable 可达性回收 closure 资源，同时保留 task history 与 publication 样本。GUI 可晚于 DB 刷新，但会说明自己的 projection version；它不能因为缓存显示 completed 就触发删除。

这套行为的价值在于所有观察点共享一套因果关系。用户不必知道“对象域”这个词，也能得到稳定答案：为什么这个任务能跑、它从哪个值派生、在等谁、哪个结果让容器放行、资源为何还没删、远端证据为何无法求值。若产品无法回答其中任一个问题，就还没有真正实现任务代数。

## 18. 状态分辨：目标语义、现有地基与尚未落地

### 18.1 RFC 已经定义的目标语义

RFC 已定义 task/closure/value 的责任边界，定义态—编译态—运行态的冻结关系，以及以部分应用和返回派发产生后继的机制。它规定 seq、par、固定 join、drain、validator、await、dependsOn、动态 append、异常传播与顶层 finalizer怎样组合；规定运行演化只能前向，完成结构不可重开；规定事件历史、锁与 committed transition 是恢复和唯一活 run 的基础。

它也定义每 task 私有 closure、Git 结构供给与 agent 内容职责的边界，消费驱动 GC、durable history、publication 四值证据、启动 residue 对账，以及派生和资源访问必须受 phase-sliced 权利约束。迁移方向上，旧顶层队列应解释为默认并行而非业务 seq，closure identity 转向 task id，旧 current 字段降为投影。

这些都是“产品完成后必须成立”的语义，不是对当前代码的描述。

### 18.2 当前代码已经具备的地基

冻结 main 审计显示，数据库和类型层已经有规范化任务树、closure 生命周期与锁表的 shape；`chain.baseBranch` 已有消费路径；default-deny 准入、typed exit 协议、run-scoped credential、binding 切片与 sandbox 权利为提交和授权提供了可复用底座。部分 closure activate、worktree/branch 资源和 runtime metadata 也已经存在。具体冻结位置与 SHA 见 [EVIDENCE.md §2](EVIDENCE.md#2-main-实然底图能力-an) 和 [EVIDENCE.md §3](EVIDENCE.md#3-供给审计)。

这些地基只证明某些结构可以存、某些权限可以表达。它们不证明 scheduler 已按树运行，不证明 exit 已成为原子 committed transition，也不证明 GC、append、await、validator 或 finalizer 已按本设计工作。

### 18.3 尚未实现的生产行为

生产 scheduler 仍以 v2 flat phase/slot 路径为主，尚未仅从递归组合结构导出 ready leaves。返回、完成和后继派生尚未统一成原子 transition；五事件投影、crash replay 和 task-identity 活 run 唯一性尚未形成完整生产闭环。运行时 par 物化、动态 append、固定 join 消费、validator task、await 的现场保存与值注入、dependsOn 的统一构造语义，以及顶层 finalizer 的普通 task 化仍需实现。

每 task Git closure 的完整 create/reconcile/consume/GC 事务、publication 冻结采样、三方 residue 对账和共享 repository identity 串行也未闭合。授权地基还需要接到 derive scope 与所有 runner-visible surface；迁移需要把旧队列和 closure key 转为新身份而不改变并发语义。GUI/observer 需要读取具名投影和 divergence，而不是拥有推进权。

因此本文不能说 RFC “已经实现”。它建立的是目标模型和可检验合同；代码只落地了其中若干承重结构。

## 19. 可证伪验收：怎样证明不是只换了词

验收首先应证明代数。构造 A/B/C 顶层并行，确认三者能在没有显式依赖时同时获得锁；让 A 返回并派生 A2，确认 A2 只在提交后出现；让 C exception，确认 sibling 继续且 exception 被 join 看见；让一个同级 leaf 永不落定，确认外层绝不推进。尝试重开 terminal、倒退 seq、热改 join，都必须没有合法 mutation 路径。

其次证明动态结构。并发执行 append D 与 join consume，重复数百次并在事务边界注入 crash；每次恢复后 D 要么是同一 identity 的成员，要么追加明确失败，不能重复、丢失或出现在已消费容器。嵌套 append 必须落到指定稳定 group，越权 scope 必须拒绝。

再证明 await 和依赖。B await B-check 时杀 daemon，重启后保持 B 现场，B-check 结果恰好注入一次；构造 dependsOn 环在写入期失败。dependsOn 的前驱以 exception 落定时，原依赖方永不启动；即使声明结构为该异常提供 consumer 或 catch，它也只能派生另一条新的前向 task，不能解封原依赖方。业务负面 tag 必须走正常派发，runner exception 则没有返回值。

然后证明持久化和锁。在应用、spawn、返回、派生、join 消费的每个间隙 crash，事件前缀重放得到唯一 frontier；两个 daemon 竞争同 task 时最多一个活 run；projection 删除重建后，status 与原历史一致。flat 兼容字段任意改写都不能制造树外 ready leaf。

资源验收要实际创建并行 closure。A/B 修改同名文件互不污染；resume 从各自 branch tip 继续；fetch 和 base pin 在同 repo 下协调。分别在 branch、worktree、DB create 前后 crash，启动对账准确分类 residue，只清引擎 namespace。closure consume 后回收活资源，history identity仍可查询。

publication 验收在采样后 force-push、删除 ref 或制造网络错误。已持久化通知重试必须复用旧样本；网络错误显示无法求值而非未发布；tag、他人 branch 或 provider synthetic ref 不应冒充 closure 自有发布通道；merged 判定只能由业务 task给出。

授权验收使用真实 runner 路径，而非 mock 一个布尔函数。phase 能访问自己的 worktree和声明 binding，不能读取其他 task scratch或全局 loop-data fallback；允许 derive 的 phase只能在 scope内追加；共享 Git写只作用于引擎 namespace并留下审计。ambient host env和Git credential必须按独立表面核验。

最后区分三层 gate。单个 implementation issue 运行类型检查、单元测试和直接触发其新增行为的最小 runtime/integration；冻结合流 SHA 上由专用 integration 连接 compile、tree、scheduler、gate、context、ingress、status/events 与 GUI；发布候选再跑两个真实 GitHub preset的 compatibility E2E。后者只能证明现有 runner—PR—merge—issue closure路径没有回归，不能替代前面对新任务代数的专项证明。只要上述任何一个反例仍可产生，RFC 的目标语义就尚未实现。

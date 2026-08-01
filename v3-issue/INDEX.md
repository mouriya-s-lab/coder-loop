# v3 Issue Index

Total: **116** issues

| # | state | author | created | comments | timeline | title |
|---|---|---|---|---|---|---|
| [#543](issues/543/README.md) | open | `RiriAgent` | 2026-07-02 | 3 | 57 | RFC: v3 生命周期 hook——引擎扩展点与用户态 gate |
| [#544](issues/544/README.md) | open | `RiriAgent` | 2026-07-02 | 4 | 84 | RFC: v3 可观测性 API 与 Web GUI——mesh 内独立网关进程（PC+移动端） |
| [#545](issues/545/README.md) | open | `RiriAgent` | 2026-07-02 | 3 | 45 | RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递 |
| [#546](issues/546/README.md) | open | `RiriAgent` | 2026-07-02 | 13 | 121 | RFC: v3 任务模型——统一序/并任务代数与并行执行语义 |
| [#547](issues/547/README.md) | open | `RiriAgent` | 2026-07-02 | 5 | 88 | RFC: v3 类型系统——装载期编译、可计算元信息与零原语任务定义 |
| [#548](issues/548/README.md) | open | `RiriAgent` | 2026-07-02 | 4 | 41 | RFC: v3 第三方调用接口与 GitHub 外挂——socket 原生契约 + 外挂消费 daemon |
| [#549](issues/549/README.md) | closed | `RiriAgent` | 2026-07-02 | 7 | 52 | v3 编译管线：CompiledTaskModel 与 `preset compile --json` 稳定编译产物 |
| [#550](issues/550/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 4 | 17 | doc 渲染声明驱动化：非法化引擎按变量名分支 |
| [#551](issues/551/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 3 | 20 | 引擎 GitHub 记法与 repository 原语退役 |
| [#552](issues/552/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 21 | 变量绑定类型流：目标端类型化与缺失语义统一（required 校验前移创建期） |
| [#553](issues/553/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 16 | [[tools]] 注册表与 per-phase toolRequirements 编译 |
| [#554](issues/554/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 24 | phase 任务树声明面：seq/par 递归结构、join ADT 与装载期检查 |
| [#555](issues/555/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 16 | 具名 gate 点声明位 |
| [#556](issues/556/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 15 | dead-fragment 编译检查与 plan 面退役 |
| [#557](issues/557/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 16 | chain 级 preset 兜底退役：DEFAULT_PRESET_NAME 清除与显式 null |
| [#558](issues/558/README.md) | closed | `RiriAgent` | 2026-07-02 | 13 | 66 | feat(engine): v3 任务树运行态持久化与 status 快照树结构 shape（含闭包状态表） |
| [#559](issues/559/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 35 | feat(scheduler): v3 序/并任务树调度——seq 游标推进、par 真并发与 slot 退役 |
| [#560](issues/560/README.md) | REOPENED | `RiriAgent` | 2026-07-02 | 23 | 100 | feat(scheduler): 任务闭包资源生命周期——起点、挂起/重开/消费与启动状态对账 |
| [#561](issues/561/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 38 | feat(engine): par join 评估与 validator 判定通道——drain / validator 与 advance | hold | reopen |
| [#562](issues/562/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 25 | feat(engine): reopen 执行语义——纠正追加、seq 游标回退、级联再验证与预算耗尽 |
| [#563](issues/563/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 19 | feat(engine): 运行中追加平行任务——leaf 原地物化 par 与 createItems 作用域授权 |
| [#564](issues/564/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 30 | feat(daemon): 物化容器 join 判定权演化——绑定版本追加、候选引用与授权方向 |
| [#565](issues/565/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 11 | feat(engine): 子树取消向下传播 |
| [#566](issues/566/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 26 | feat(engine): chain 层任务树声明位——chain metadata 承载顶层 join 与 chain-complete 迁移 |
| [#567](issues/567/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 17 | feat(scheduler): item 展开 preset phase 任务树——数组推进退役与 trigger phase 迁移 |
| [#568](issues/568/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 10 | docs(v3): 任务模型收尾对齐——文档、旧概念退场登记与机制/参数分离守护 |
| [#569](issues/569/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 12 | GitHub 消费 daemon 立项：router 规范化事件到 coder-loop CLI 结构化调用（新建独立 repo） |
| [#570](issues/570/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 11 | GitHub 消费 daemon 请求预校验：消费 preset compile --json 编译产物 |
| [#571](issues/571/README.md) | closed | `RiriAgent` | 2026-07-02 | 3 | 16 | Spike: TanStack Start (Bun) 网关宿主——多接口选择性绑定与 SSE/WS 推送可行性 |
| [#572](issues/572/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 16 | feat(engine): 渲染后 prompt 与绑定值快照落盘（prompt.md + bindings.json） |
| [#573](issues/573/README.md) | closed | `RiriAgent` | 2026-07-02 | 5 | 20 | feat(engine): events 消费契约固化——boundary 导出与滚动段规则测试钉住 |
| [#574](issues/574/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 19 | feat(engine): status 快照 boundary 收紧——七个匿名 object 槽换精确 schema |
| [#575](issues/575/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 17 | feat(engine+gui): status 快照 hooks 节与 gate hold 可见性 |
| [#576](issues/576/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 7 | 29 | feat(gui): 网关进程骨架——TanStack Start (Bun) + mesh-only 监听 + socket RPC/SQLite 只读两数据面 |
| [#577](issues/577/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 3 | 22 | feat(gui): events 直读与实时推送——fs.watch 增量读 + WS/SSE 到前端 |
| [#578](issues/578/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 19 | feat(gui): 首屏「跑没跑」——daemon 三证活性与一键生命周期控制 |
| [#579](issues/579/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 15 | feat(gui): 控制面解卡动作与 F 档写入口收口 |
| [#580](issues/580/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 21 | feat(gui): 全链路层级展示——daemon→chains→items→runs→phases/attempts 钻取与任务树渲染 |
| [#581](issues/581/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 17 | feat(gui): prompt 展示——per attempt 渲染全文与变量→值对照 |
| [#582](issues/582/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 14 | feat(gui): 元信息预览——消费 preset compile 编译产物渲染状态机图与任务树 |
| [#583](issues/583/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 17 | feat(gui): context entries 展示面——纯消费 #545 read boundary |
| [#584](issues/584/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 18 | feat(gui): 移动端与 PWA——mesh 内手机可用的首屏与控制面 |
| [#585](issues/585/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 19 | docs(v3): GUI 网关收尾对齐——红线审计与文档终态 |
| [#586](issues/586/README.md) | closed | `RiriAgent` | 2026-07-02 | 6 | 41 | feat(engine): v3 hook 声明模型——四层声明位装载合并与生效视图 |
| [#587](issues/587/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 17 | feat(engine): hook 全量元数据 stdin payload——编译产物投影与运行态快照契约 |
| [#588](issues/588/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 15 | feat(daemon): observer hook 执行——事件订阅派发与异步脚本执行层 |
| [#589](issues/589/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 22 | feat(scheduler): script gate 执行与 decision 协议——run post-exit 决策点端到端 |
| [#590](issues/590/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 26 | feat(scheduler): gate 决策点闭集接线——全点物化、tick 节流与 hold 指纹泛化 |
| [#591](issues/591/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 16 | feat(engine): preset 级具名 gate 点——绑定解析与未绑定语义 |
| [#592](issues/592/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 23 | feat(engine): join script 判定器——容器推进点 script gate 与 reopen 派发 |
| [#593](issues/593/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 2 | 13 | docs(v3): 生命周期 hook 收尾对齐——操作员验收场景、作者文档与字面量守护 |
| [#594](issues/594/README.md) | closed | `RiriAgent` | 2026-07-02 | 2 | 20 | feat(engine): context 共享存储与写入面——envelope ADT、SQLite append-only 表与凭证推导 author |
| [#595](issues/595/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 17 | feat(cli): context 共享读取命令面——scope 过滤查询与 GUI 消费 boundary |
| [#596](issues/596/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 13 | feat(engine): context 共享 group scope 真实化——par 容器稳定 id 键解析 |
| [#597](issues/597/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 18 | feat(engine): context 共享「必须调用」执法——run 收尾 required|expected 判定 |
| [#598](issues/598/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-02 | 1 | 16 | docs(v3): context 共享收尾对齐——无状态前提边界重述与文档同步 |
| [#599](issues/599/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-10 | 2 | 22 | feat(engine): gate 评估代次与幂等协议——mutation 重放安全与 decision 消费原子性 |
| [#601](issues/601/README.md) | closed | `RiriAgent` | 2026-07-10 | 5 | 35 | feat(engine): 收敛引擎递出授权面——runner --add-dir 剥离 loopDataRoot 整根授权 |
| [#602](issues/602/README.md) | open | `RiriAgent` | 2026-07-10 | 0 | 27 | 外部执行终端 runner 的缺席语义与 daemon 显式警告路径 |
| [#603](issues/603/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-10 | 1 | 13 | hapi runner 接入：外部执行终端样板与真实远端 session 验收 |
| [#604](issues/604/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-10 | 1 | 19 | feat(presets): bundled preset v3 化——闭包分支契约落地与 agent 结构性 git 操作退役 |
| [#605](issues/605/README.md) | closed (NOT_PLANNED) | `RiriAgent` | 2026-07-10 | 1 | 32 | 运行实例绑定事前可计算的不可变执行定义 |
| [#683](issues/683/README.md) | open | `RiriAgent` | 2026-07-15 | 0 | 7 | RFC: v3 整链路验收分层 |
| [#684](issues/684/README.md) | open | `RiriAgent` | 2026-07-15 | 0 | 124 | test(v3): 冻结合流 SHA 的整链路 integration 验收 |
| [#685](issues/685/README.md) | open | `RiriAgent` | 2026-07-15 | 0 | 127 | test(v3): bundled preset compatibility real E2E 验收 |
| [#698](issues/698/README.md) | open | `RiriAgent` | 2026-07-17 | 36 | 61 | feat(scheduler): 从公开入口实例化并调度 seq/par drain |
| [#699](issues/699/README.md) | open | `RiriAgent` | 2026-07-17 | 2 | 27 | feat(scheduler): 任务闭包资源生命周期与 Git supply |
| [#700](issues/700/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 23 | feat(engine): 共享 decision core 与 validator join |
| [#701](issues/701/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 16 | feat(engine): reopen、纠正项与 leaf 重激活一致语义 |
| [#702](issues/702/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 17 | feat(engine): 运行中动态物化 par |
| [#703](issues/703/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 14 | feat(daemon): 物化容器 join binding 演化 |
| [#704](issues/704/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 10 | feat(engine): 子树取消向下传播 |
| [#705](issues/705/README.md) | open | `RiriAgent` | 2026-07-17 | 2 | 23 | feat(engine): chain 任务树与顶层 join |
| [#706](issues/706/README.md) | open | `RiriAgent` | 2026-07-17 | 2 | 20 | feat(scheduler): preset phase tree 与 trigger 迁移 |
| [#707](issues/707/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 12 | feat(presets): bundled preset 闭包 Git 契约迁移 |
| [#708](issues/708/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 17 | docs(v3): 旧概念退役与任务模型收尾 |
| [#709](issues/709/README.md) | open | `RiriAgent` | 2026-07-17 | 1 | 15 | test(v3): 在冻结 SHA 上完成 #546 综合验收 |
| [#710](issues/710/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 11 | feat(engine): hook 全量元数据 payload 与运行态快照契约 |
| [#711](issues/711/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(daemon): observer hook 订阅派发与异步执行 |
| [#712](issues/712/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 17 | feat(engine): 共享 gate evaluation、script decision 与指纹协议 |
| [#713](issues/713/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 9 | feat(engine): preset 级具名 gate 点声明与绑定解析 |
| [#714](issues/714/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 13 | feat(engine): join script 判定器与 reopen 派发 |
| [#715](issues/715/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 11 | docs(v3): hook 与 gate 冻结 SHA 综合验收 |
| [#716](issues/716/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 9 | feat(engine): status snapshot 严格只读 SQLite 入口 |
| [#717](issues/717/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 5 | feat(engine): 渲染后 prompt 与 bindings 快照 |
| [#718](issues/718/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 9 | feat(engine): status snapshot 精确 schema boundary |
| [#719](issues/719/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(engine+gui): status hooks 与 gate hold 可见性 |
| [#720](issues/720/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 14 | feat(gui): TanStack 网关与严格只读数据面 |
| [#721](issues/721/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 8 | feat(gui): events 增量读取与实时推送 |
| [#722](issues/722/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 9 | feat(gui): daemon 活性首屏与生命周期控制 |
| [#723](issues/723/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(gui): 控制面解卡动作与写入口收口 |
| [#724](issues/724/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 13 | feat(gui): chain/item/run 任务树层级展示 |
| [#725](issues/725/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(gui): per-attempt prompt 与 bindings 展示 |
| [#726](issues/726/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 8 | feat(gui): 编译元信息与任务树预览 |
| [#727](issues/727/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(gui): context entries 只读展示 |
| [#728](issues/728/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(gui): mesh 内移动端与 PWA |
| [#729](issues/729/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 16 | docs(v3): GUI 网关冻结 SHA 收尾验收 |
| [#730](issues/730/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(cli): context scope 过滤读取与 GUI boundary |
| [#731](issues/731/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(engine): real-par context group scope |
| [#732](issues/732/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(engine): ordinary run context required/expected 执法 |
| [#733](issues/733/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 10 | feat(engine): trigger 与 validator context outcome 集成 |
| [#734](issues/734/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | docs(v3): context 冻结 SHA 综合验收 |
| [#735](issues/735/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 5 | feat(engine): doc 渲染声明驱动化 |
| [#736](issues/736/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 6 | feat(engine): GitHub 记法与 repository 原语退役 |
| [#737](issues/737/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 13 | feat(engine): 变量绑定类型流与创建期 required 校验 |
| [#738](issues/738/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 9 | feat(engine): tools 注册表与 phase requirements 编译 |
| [#739](issues/739/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 16 | feat(engine): phase task tree 声明与装载期检查 |
| [#740](issues/740/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 8 | feat(engine): 具名 gate point 声明位 |
| [#741](issues/741/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 6 | feat(engine): dead-fragment 检查与 plan 面退役 |
| [#742](issues/742/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 8 | feat(engine): chain preset fallback 退役 |
| [#743](issues/743/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 14 | feat(engine): immutable execution definition ref |
| [#744](issues/744/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 20 | test(v3): 编译契约冻结 SHA 综合验收 |
| [#745](issues/745/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 5 | feat(engine): preset compile schema artifact 分发 |
| [#746](issues/746/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(router): GitHub 事件到 coder-loop CLI 的独立消费 daemon |
| [#747](issues/747/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | feat(router): 使用 compile schema 预校验请求 |
| [#748](issues/748/README.md) | open | `RiriAgent` | 2026-07-17 | 0 | 7 | test(v3): 外部 router 与 HAPI runner 冻结 SHA 综合验收 |
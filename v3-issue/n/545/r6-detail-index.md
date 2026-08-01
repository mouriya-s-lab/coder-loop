# RFC #545 R6：待调查细节索引

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本索引只使用 `aggregate.md` 与 `r5-supply-ledger.md`；未读取源码、测试、git 历史或 R4 证据附录，未运行实验。本报告把 R5 账目分为明确事实、纯证明缺口、地面事实不足的分叉与范围登记，不产生实现形态、推荐、工作量、实施顺序、issue 拆分或需求侧结论。

## A. 主 agent 摘要

### 分类分布

38 个 ledger 条目零遗漏地归入四类：

- **明确事实、无需 R7：16 项**；
- **纯证明缺口：4 项**；
- **地面事实不足的分叉、进入 R7：18 项**；
- **范围外/仅登记：0 个 ledger 条目**。另有不属于 L001–L038 的 **D12 无供给结论**，只作范围关系登记。

16 个 R7 条目按可能跨层的真实因果边界聚合为 **7 个 Detail**，而不是按函数或文件切开：

1. store 权威入口、引用完整性与 chain 生命周期；
2. append 会话、提交、审计、响应与 transport；
3. 历史持久数据与公开读取的毒化边界；
4. 稳定分页、并发写入与响应边界；
5. agent/operator 读取身份与命令鉴权分类；
6. par 生产、group 身份、嵌套谱系与生命周期；
7. tool outcome、run finalize、凭证吊销与 trigger/validator lifecycle。

另列 **3 个纯证明任务**：prompt 零内容注入、外部 GUI/hook 消费边界、既有与未来路径的验证账补强。它们不得被表述为工程分叉。

### 未决边界

- L035 是多个报告对“仍需地面证据”的汇总，不是一个可独立调查的根因；它已分别映射进相关 Detail，并把纯外部消费证明留在证明任务中。
- L036 是测试同错/盲区账，不自动要求新增机制；只用于定义最小证明覆盖，并跟随对应 Detail 或纯证明任务。
- 已知缺失的 read、group、tool requirement、doc binding 等能力本身是明确事实。缺失不等于已经知道未来补法，但 R6 不把“尚未实现”本身伪装成需要 R7 重新证明的工程分叉；只有现有地基的行为、身份、事务或运行边界不足以决定其可依赖保证时才进入 Detail。
- D12 没有 R4 供给结论。它只说明本次供给调查不能证明 context 是否参与 transition；不得由此扩展供给调查或生成新需求。

### R7 批次建议

以下只按调查独立性与证据依赖分批，不是实施顺序：

- **可互相独立并行：** D-01、D-03、D-06、D-07。
- **共享 append/transport 事实但问题可分：** D-02 与 D-04；两者应交换已确认的协议边界，避免分别假定 request/response 行为。
- **依赖读取命令真实接线清单：** D-05；其身份结论应供 D-04 的公开读取实验使用，但不要求两者合并为一个调查。

R7 开始前无需处理明确事实清单，也不得把纯证明任务升级成产品修补。

## B. 逐 Detail 索引

### D-01 · store 权威入口、引用完整性与 chain 生命周期

- **稳定条款 / ledger：** D3、D6、D7、D11；S01–S03、S06；L003、L006，以及 L035 中的并发 delete/commit 与 WAL/崩溃事实。
- **报告观察事实：**
  - chain 软删状态与 entries 清除分属两个事务；中断可留下 residue，重试会补清。
  - item scope 在 begin 时验证，但 store/schema 没有 item FK；后续删除或 store 直写可留下悬空或跨边界 key。
  - physical chain delete 的 FK cascade 与正常 soft-delete 路径不是同一生产语义。
- **为何现证据不足以决定补法：** 总账没有给出所有生产删除入口、并发 append 在各事务点的可见结果、存量 residue/悬空记录是否存在、重启恢复究竟由谁触发，也没有证明 item 删除是否存在普通 daemon 竞态。只知道偏离成立，尚不知道必须闭合的真实事务与恢复边界。
- **可能涉及层（非根因预设）：** store API、schema/FK、daemon admission、chain/item lifecycle、事务与 WAL、重启恢复、运维对账、历史数据。
- **需查的代码/数据/运行实验类型：**
  - 全部 chain/item 删除与 store append 写入口及其调用者；
  - schema 约束、事务提交点、软删恢复/重试路径；
  - 生产或隔离副本中的 residue、悬空 item scope、跨 chain key 查询；
  - 可控故障注入：soft-delete 各提交点、delete/append 并发、重启后恢复。
- **可证伪问题：** 是否存在一个真实可达的执行序列，使已软删 chain 仍保留 entries，或 item 已不可寻址但 entry 仍可被当前/未来读取面返回，并且现有恢复路径不会在无需人工介入下收敛？
- **为何必须单独 subagent：** 这是跨 schema、写入口、删除生命周期、故障恢复和存量数据的闭环；单看 store 函数会漏掉 daemon 与恢复消费者。
- **与其他 Detail 的重叠/依赖：** 与 D-02 共享 append 提交点，但 D-01 关注对象生命周期和引用完整性；与 D-06 共享 group/item scope 键，但不调查 par 谱系语义。

### D-02 · append 会话、提交、审计、响应与 transport

- **稳定条款 / ledger：** D7、D9；S05、S09、S12；L005、L009、L011，以及 L035 中的审计失败/WAL 响应、特殊 argv 和 transport 实验。L037 是已明确的反例口径，不作为新分叉。
- **报告观察事实：**
  - 固定 code-unit chunk 在 JSON 转义膨胀时可能越过 1 MiB request boundary。
  - commit 先丢 session，再 INSERT，再 audit/response；失败可能形成已提交但 caller 失败、无 allow audit 或重试重复。
  - 未提交 session 没有 TTL、abort、disconnect cleanup 或 restart 恢复；credential 重启后失活。
  - partial response reject 只证明响应未齐会失败，不证明 commit result 可恢复。
- **为何现证据不足以决定补法：** 未知真实 socket/request/response 边界及错误分类，未知 audit 失败是否能回滚 entry，未知连接中断和 daemon restart 后服务端保留了什么，未知 CLI 对失败重试的真实行为。账目证明了窗口，但没有确定各窗口可观察的持久终态。
- **可能涉及层（非根因预设）：** CLI argv 与 chunking、socket framing、daemon session registry、credential registry、SQLite transaction/WAL、audit emitter、响应编码、重试与恢复。
- **需查的代码/数据/运行实验类型：**
  - begin/chunk/commit/abort 的完整调用链及状态转移；
  - request 与 response 的解析、大小限制和错误传播；
  - audit 与 entry 写入的事务关系；
  - 控制字符/大 body、特殊 argv、断连、audit 注入失败、commit 后断响应、daemon restart 的隔离实验；
  - 实验后核对 entry、audit、session、credential 与 caller 结果。
- **可证伪问题：** 对每个可达的中断点，是否都能从 caller 结果和持久状态唯一判定 append 未发生或恰好发生一次，且接受/拒绝审计与该结果一致、未提交 session 不会无限遗留？
- **为何必须单独 subagent：** 需要把 wire、内存 session、credential、DB、audit 与 caller 五种状态对齐；任何单层报告都无法证明端到端结果。
- **与其他 Detail 的重叠/依赖：** 向 D-04 提供真实 transport boundary；与 D-01 共享 SQLite 提交/故障事实，但不处理 chain/item 生命周期。

### D-03 · 历史持久数据与公开读取的毒化边界

- **稳定条款 / ledger：** D10、D14；S10、S11、S17、S20；L010、L038，以及 L035 中的生产异常行调查。
- **报告观察事实：**
  - 合法 fixture 内 migration 与 ADT parser 成立。
  - 历史 malformed author/scope 可使整链 list 失败；迁移不规范化历史 JSON。
  - 生产存量是否含异常行未知；公开 read 若复用现 list 行为会继承整页/整链毒化。
- **为何现证据不足以决定补法：** 没有生产数据分布、异常来源与可达写入口事实，也不清楚异常是历史遗留、当前旁路仍可制造，还是仅合成可能。没有这些事实就无法确定公开 boundary 必须承受的真实输入集合及失败隔离粒度。
- **可能涉及层（非根因预设）：** migration、schema 约束、store 旁路、persisted parser、list/query、boundary parser、生产数据与运维修复。
- **需查的代码/数据/运行实验类型：**
  - 历次 schema/migration 与所有可写 author/scope 的入口；
  - 只读生产数据审计，统计异常 variant、字段与 chain 分布；
  - 在隔离数据库构造单条 malformed row，观察现 list 与拟接 read boundary 的失败范围；
  - 确认 daemon 启动/迁移是否会因异常中断。
- **可证伪问题：** 当前可达写路径或真实存量中是否存在能通过 DB 层却不能通过 persisted ADT parser 的 row，并且一条该 row 会阻断同链其他合法 entries 的读取？
- **为何必须单独 subagent：** 这是历史数据、当前写面、迁移和消费者失败隔离的联合事实，必须有数据审计，不能由类型定义推断。
- **与其他 Detail 的重叠/依赖：** D-01 可能确认 store 旁路仍能制造异常；D-04 需要本 Detail 给出的 row 失败粒度来定义分页实验输入。

### D-04 · 稳定分页、并发写入与响应边界

- **稳定条款 / ledger：** D9、D10、D15；S16、S18、S20；L014、L015，以及 L035 中的同秒分页与 response 极限实验。
- **报告观察事实：**
  - 当前键为秒级 `createdAt` 加 UUID，虽可全序，但跨页同秒新 UUID 可能倒插 cursor 之前；回填 createdAt 会放大这一点。
  - 当前 list 无 limit、snapshot 或 page API。
  - socket 单响应只明确 request cap；真实 response boundary 静态未知。
- **为何现证据不足以决定补法：** 未知所有 createdAt 生产/回填入口、SQLite 查询的一致性窗口、并发写入对“已有 entries 不漏不重”的实际集合定义、socket/JSON response 的真实上限与错误表现。总账只证明风险存在，不能确定可依赖的排序和 transport 事实。
- **可能涉及层（非根因预设）：** schema 与 key、timestamp/UUID 生成、query planner/transaction、cursor boundary、socket response framing、JSON/arktype boundary、GUI consumer contract。
- **需查的代码/数据/运行实验类型：**
  - createdAt/ID 的全部生产与历史回填路径；
  - 当前索引、排序、事务 snapshot 与 list consumer；
  - 同秒多写、页间插入、回填时间、翻页至 exhausted 的确定性实验；
  - 逐步增大 response，观测 daemon、client、boundary parser 与错误类型。
- **可证伪问题：** 在当前可生产的 key 与事务语义下，是否存在页间合法写入导致翻页结束后漏掉或重复“第一页请求时已存在”的 entry；响应增大时是否存在未被显式 boundary error 表达的截断、挂起或解析失败？
- **为何必须单独 subagent：** 分页正确性需要同时掌握 key 生成、数据库快照、并发时序和 transport；它不是单一 query 函数问题。
- **与其他 Detail 的重叠/依赖：** 使用 D-02 确认的 response transport；使用 D-03 的 malformed-row 事实区分 cursor 错误与 row parser 失败；不负责 read 授权。

### D-05 · agent/operator 读取身份与命令鉴权分类

- **稳定条款 / ledger：** D3、D7；S15、S16、S21；L016、L018。
- **报告观察事实：**
  - 现有 read-no-auth 不能隔离 agent chain。
  - CLI credential 注入 tuple 与 daemon auth Record 是双事实源，新增命令漏列会把 agent 当 operator。
  - credential registry 足以派生 chain-bound agent identity，operator 无凭证模型也存在，但没有专用 agent-readable chain-bound read auth class/handler。
- **为何现证据不足以决定补法：** 总账未列全命令分类的编译期封闭面、CLI 注入与 daemon 验证的所有消费者、无凭证连接的实际信任边界，以及 read 参数中 chain 标识如何被丢弃或校验。现有资产可用不等于已经证明唯一授权来源。
- **可能涉及层（非根因预设）：** CLI command ADT、credential 注入、socket request boundary、daemon auth classifier、credential registry、read query 参数、operator trust model、审计。
- **需查的代码/数据/运行实验类型：**
  - 全部命令 variant 到 CLI credential 与 daemon auth 分类的穷尽映射；
  - credential mint/revoke/lookup 及 run→chain 解析；
  - agent 指定本 chain/他 chain、缺凭证、失活凭证、operator 无凭证的端到端命令实验；
  - 编译期 exhaustive guard 和测试是否共享同一漏项来源。
- **可证伪问题：** 是否存在任一可构造的 read 命令或参数组合，使有效 agent 凭证可观察他 chain，或 agent 因分类漏项被按 operator 处理；operator 无凭证路径是否仍保持既定信任语义？
- **为何必须单独 subagent：** 这是 CLI 与 daemon 两套分类、credential 生命周期和 query 参数共同构成的安全边界，必须全命令枚举而非局部 handler 检查。
- **与其他 Detail 的重叠/依赖：** D-04 的公开 read 实验需要使用这里确认的主体构造；D-07 共用 credential registry，但 D-05 只调查读取授权，不调查 finalize 吊销。

### D-06 · par 生产、group 身份、嵌套谱系与生命周期

- **稳定条款 / ledger：** D2、D3、D6、D11、D14；S23、S25、S27、S28；L020、L022、L024，以及 L035 中的真实 par 实验。K1 与 K4a 仍是 aggregate 已登记未决项，不在本报告裁决。
- **报告观察事实：**
  - durable tree、leaf、稳定 runtime node ID 等底料存在；正常生产当前只造 seq+leaf，没有已确认 par producer/updater。
  -可信 run 可追到 leaf/tree；`sourceParNodeId` 只表示直接父，不是祖先链。
  - terminal tree 可保留，而 soft chain delete 会清 entries。
  - context group 仍硬拒绝、store 可写任意 group key、没有 membership/read。
- **为何现证据不足以决定补法：** 未知真实 par shape 的生产者、持久化与更新时点，未知嵌套 par 的实际祖先信息是否已经可恢复，未知 terminal/restart 后身份稳定性，未知 fixture 与真实调度能分别证明什么。K4a 的裁决输入因此尚不完整。
- **可能涉及层（非根因预设）：** task/tree compile、scheduler、runtime tree persistence/updater、run credential identity、group admission、store、read/filter、restart/delete lifecycle、测试 fixture。
- **需查的代码/数据/运行实验类型：**
  - par node 从声明到 runtime materialization、update、terminal、restart 的完整生产/消费链；
  - run→leaf→全部 par 祖先的可恢复数据；
  - 真实并行调度与隔离 fixture 分别写/读 group 的实验；
  - terminal、restart、soft delete 后同一 group ID 与 entries 的行为；
  - 所有 group key 写入口与 membership 校验点。
- **可证伪问题：** 在真实 scheduler 产生的嵌套 par 树中，任一分支 run 是否能仅凭 durable 状态恢复其可寻址 group 容器集合，并在 restart/terminal 后保持同一稳定身份，同时拒绝不属于该集合的 group key？
- **为何必须单独 subagent：** 根因可能跨 compile、scheduler、持久 tree、credential、admission 和 read；以 group append handler 为边界会预设错误根因。
- **与其他 Detail 的重叠/依赖：** D-01 提供 scope 引用完整性事实；D-05 提供 agent chain 隔离事实；本 Detail 的产出是 K1/K4a 后续档案的地面输入，但不裁决它们。

### D-07 · tool outcome、run finalize、凭证吊销与 trigger/validator lifecycle

- **稳定条款 / ledger：** D4、D5、D14；S30–S35、S37–S39；L027、L028、L029、L030，以及 L035 中的 finalize crash 实验。L025、L026、L031 是明确的缺失/资产事实，不需重复调查。
- **报告观察事实：**
  - item-trigger 与普通 run 统一；chain-complete trigger 绕开 credential/run/close；validator 没有 runner lifecycle，S33 当前不成立。
  - child close 到 credential revoke 间有多个 await，迟到 credential 可写。
  - completeRun 与 clearCurrentRun 分事务，crash 恢复未知；outcome 判定与吊销的同点不存在。
  - 非零失败已有 backoff/exhausted；exit 0 + required 缺失没有 typed failure 输入，item-trigger attempts 语义不能自动外推。
  - typed event 基础存在，但没有 tool outcome payload/mapper/renderer。
- **为何现证据不足以决定补法：** 未知所有 run/trigger/validator 的真实生命周期种类及最终化入口，未知 crash/restart 后 current run、attempt 与 credential 的组合状态，未知迟到写在现有事务可见性下如何影响存在性求值。账目无法证明一个统一收尾保证可覆盖哪些现有执行体。
- **可能涉及层（非根因预设）：** scheduler run state machine、trigger/validator execution、child process close、credential mint/revoke、context existence query、attempt/backoff、SQLite transactions、event model/renderer、restart recovery。
- **需查的代码/数据/运行实验类型：**
  - 所有生产 run 类别及其 spawn、close、finalize、attempt、terminal 路径；
  - credential 与 currentRun 的完整状态机及事务边界；
  - entry existence 的 author/run 查询事实；
  - exit 0/非零、required outcome 有/无、迟到 append、各 await/crash 点、restart 的隔离实验；
  - event consumer 对 typed failure/validation 的约束。
- **可证伪问题：** 对每种真实 run 生命周期，是否存在一个可观测窗口，使 finalize 已作出成功/失败判定后同一 run 凭证仍能改变 outcome，或 crash/restart 后 attempt、current run、credential 与 outcome 判定不一致？
- **为何必须单独 subagent：** 必须遍历多种执行体并联合 scheduler、credential、DB、events 与恢复；仅调查 required evaluator 会把尚不存在的统一 lifecycle 当作前提。
- **与其他 Detail 的重叠/依赖：** 与 D-02 共享 context append 的提交可见性，与 D-05 共享 credential registry；K2/K3 的后续决策档案依赖本 Detail，但本 Detail不得定义 S33 归属。

## C. 纯证明任务

### P-01 · prompt 零内容注入的全 phase 负向证明

- **对应 ledger / 条款：** L008、L017，以及 L036 中无 prompt 路径覆盖；D5、D8；S08、S19。
- **已知事实：** 静态没有 body→prompt 生产边，scheduler 的单一 marker 场景不受影响。
- **最小证明：** 在具备读取面后，store 预置唯一 sentinel body，渲染每一种 direct 与 trigger/validator phase prompt，逐产物确认 sentinel 零命中；同时确认 doc binding 只含 CLI 用法而无 entry 内容。
- **边界：** 这是稳定主张的 runtime proof，不产生新的 prompt 防御机制，也不决定 doc-binding 形态。

### P-02 · 外部 GUI/hook 消费边界证明

- **对应 ledger / 条款：** L034，以及 L035 的外部复核部分；D15；S16、S22。
- **已知事实：** 本仓内没有 GUI/hook read consumer，不能外推仓外是否直读 DB。
- **最小证明：** 对权威 GUI/hook 工程及部署接线做只读消费者清单，证明其数据源、boundary 与是否存在 SQLite 直读；如无访问权，明确保留未知而非假定不存在。
- **边界：** 只确定现有消费者事实，不设计 GUI，不把展示面吸入本 RFC。

### P-03 · 既有/未来路径验证账补强

- **对应 ledger / 条款：** L036；并包含 L032 中 S13 冻结 SHA 未复核、L037 已修正的 JSON escaping 反例口径。
- **已知事实：** 现有测试覆盖 write/tree/backoff，但会正常化 store 旁路、旧 group 拒绝、空 tools projection、手工 credential 与常见 Unicode；这证明盲区存在，不证明需要新机制。
- **最小证明：**
  - 在冻结 SHA 复核 `shared.md` 创建/注入 S13；
  - 为进入 R7 的每个 Detail 使用其报告指定的最小反例/故障实验，不以现有绿色测试代替；
  - transport 反例固定为 JSON 控制字符转义膨胀，不再用 astral 字符作确定反例；
  - 对已知缺失能力，只记录“尚无可运行路径”，不伪造验收。
- **边界：** 这是证据质量与复现口径任务；其结果跟随对应 Detail 或终态复核，不单独形成工程分叉。

## D. 明确事实 / 无需追加调查清单

| Ledger | 明确事实与 R6 处置 |
|---|---|
| L001 | socket author/credential ADT 可保留而公开 store 接受自报 author；偏离与资产均已明确。 |
| L002 | 独立 chain-entry delete 可达且测试将其当 fixture；违反 append-only 的事实明确。 |
| L004 | 既定信任模型下 operator 无凭证 socket 写任意未删 chain，author 固定 operator；无需 R7 重证。 |
| L007 | group wire 当前硬拒绝、reason 过宽、测试只锁定旧拒绝；现状明确，真实 group 地面问题归 D-06。 |
| L012 | 公开 read CLI/daemon/boundary/GUI shape 不存在；内部全量 list 不能冒充能力。 |
| L013 | scope/author ADT、parser、索引、typed command/auth、credential、socket client、doc-builder 是已登记资产；资产资格不等于未来符合。 |
| L018 | registry 与 operator 模型是身份底料、专用 read auth class/handler 不存在；缺失明确，双源可达边界归 D-05。 |
| L019 | tree 底料存在而 context group 的 admission/read/filter/store guarantee 不存在；宏观供给事实明确。 |
| L021 | tree ADT、ID invariant、normalized tables、terminal persistence、递归遍历是已登记资产。 |
| L023 | 多数 traversal 穷尽、runtime boundary parser 不是穷尽 switch；局部 D14 偏离明确。 |
| L025 | tools/toolRequirements 只是 compile 空数组；声明、消费、outcome 均不存在，空 shape 是负资产。 |
| L026 | “本 run entry 存在”可计算，但 existence API/index/evaluator/verdict 不存在；audit 不能替代 outcome。 |
| L031 | doc builder、phase slicing、key/count guard 可保留；context 用法与 requirements doc 缺失。 |
| L032 | shared 机制存在且文档定位未收敛；S13 的冻结 SHA 复核归 P-03，不形成工程分叉。 |
| L033 | help/CLAUDE 列表漂移、root help exit 1 且无自动一致性测试；文档实态偏离明确。 |
| L037 | 确定 transport 反例是 JSON 控制字符转义膨胀，astral 字符不构成必然超限；仅保留复现口径。 |

L006 中“store/schema 无 item FK、只在 begin 时校验”也是明确观察，但其普通 item lifecycle、竞态与存量影响仍缺地面事实，所以在 ledger 单一主分类中整体进入 D-01，不在本清单重复计数。

### 范围关系登记

- **D12：** R5 明确没有 R4 供给结论。它与本供给调查的唯一关系是：任何 Detail 都不得把 context 参与 transition/后继 prompt 当作既有事实或补法前提。D12 不生成 R7 Detail，不扩展到需求侧。
- aggregate 已列范围外的 GUI 展示、DSL 声明语法、并行结构唯一性、audit 修复等仍保持范围外；本索引只调查本 RFC 消费它们时所需的地面接口事实。

## E. L001–L038 反向覆盖矩阵

单一主分类用于零遗漏统计；Detail 可在说明列引用明确子事实，但每个 ledger 只计一次。

| Ledger | 主分类 | Detail / 证明任务 | 最小判别事实或处置 |
|---|---|---|---|
| L001 | 明确事实 | — | socket identity 资产与 store 自报旁路已明确。 |
| L002 | 明确事实 | — | 独立 delete 旁路已明确。 |
| L003 | R7 | D-01 | 软删中断后持久终态与自动收敛边界。 |
| L004 | 明确事实 | — | operator 信任模型下 socket 写行为明确。 |
| L005 | R7 | D-02 | 真实 request boundary、chunk/error 与 session 终态。 |
| L006 | R7 | D-01 | 普通 item lifecycle、竞态与存量悬空事实。 |
| L007 | 明确事实 | — | 当前 hard reject 及过宽 reason 明确。 |
| L008 | 纯证明 | P-01 | 全 phase sentinel runtime proof。 |
| L009 | R7 | D-02 | commit/audit/response 各中断点的可观察终态。 |
| L010 | R7 | D-03 | 生产异常 row 与当前可达制造入口。 |
| L011 | R7 | D-02 | session/credential 在断连、restart 后的真实生命周期。 |
| L012 | 明确事实 | — | 公开 read 全面缺失。 |
| L013 | 明确事实 | — | 可保留底料清单，不自动认证符合。 |
| L014 | R7 | D-04 | 同秒/回填/页间写的漏重实验。 |
| L015 | R7 | D-04 | response boundary 与显式错误行为。 |
| L016 | R7 | D-05 | CLI/daemon 命令分类全映射与跨 chain 对抗。 |
| L017 | 纯证明 | P-01 | read 落地后的 direct/trigger sentinel 负向验收。 |
| L018 | 明确事实 | — | identity 地基与专用 read auth 缺失明确；接线风险由 L016 调查。 |
| L019 | 明确事实 | — | tree 存在/group context 缺失的宏观事实明确。 |
| L020 | R7 | D-06 | 嵌套 par 的 durable 祖先信息与真实 run 可追溯性。 |
| L021 | 明确事实 | — | tree/ADT/persistence 资产明确。 |
| L022 | R7 | D-06 | 真实 par producer/updater、group key 可达路径。 |
| L023 | 明确事实 | — | traversal 部分穷尽偏离明确。 |
| L024 | R7 | D-06 | K1/K4a 所需真实调度、fixture、terminal/restart 地面输入。 |
| L025 | 明确事实 | — | 空 tools projection 与声明/消费缺失明确。 |
| L026 | 明确事实 | — | existence 可计算及 evaluator/verdict 缺失明确。 |
| L027 | R7 | D-07 | 全部 trigger/validator 真实 lifecycle 枚举。 |
| L028 | R7 | D-07 | 迟到写、finalize/revoke 与 crash/restart 状态组合。 |
| L029 | R7 | D-07 | exit0 缺 outcome 如何进入现有 typed failure/attempt 路径的现状事实。 |
| L030 | R7 | D-07 | outcome event 的生产/消费边界及现有 event 约束。 |
| L031 | 明确事实 | — | doc-builder 资产与 context doc 缺失明确。 |
| L032 | 明确事实 | P-03（仅 S13） | 机制/文档偏离明确；冻结 SHA 复核是证明。 |
| L033 | 明确事实 | — | help/doc 漂移明确。 |
| L034 | 纯证明 | P-02 | 权威外部 consumer 清单。 |
| L035 | R7 | D-01～D-04、D-06、D-07；P-02 | 汇总项按各未知的真实因果边界拆投，不作为独立根因。 |
| L036 | 纯证明 | P-01、P-03；并跟随各 Detail | 盲区只定义证明覆盖，不要求机制。 |
| L037 | 明确事实 | P-03（复现口径） | 报告内部修正已收敛。 |
| L038 | R7 | D-03 | malformed row 的真实来源、存量与失败隔离粒度。 |

## F. 完整性审计

1. **允许输入：** 只读 `WORKFLOW.md`、`aggregate.md`、`r5-supply-ledger.md`；未读取源码、测试、git 历史或 R4 证据附录。
2. **单一主分类终值：**
   - 明确事实 16：L001、L002、L004、L007、L012、L013、L018、L019、L021、L023、L025、L026、L031、L032、L033、L037；
   - 纯证明 4：L008、L017、L034、L036；L032 的 S13 是明确事实条目内的子证明义务，不重复计数；
   - R7 18：L003、L005、L006、L009、L010、L011、L014、L015、L016、L020、L022、L024、L027、L028、L029、L030、L035、L038；
   - 范围外/仅登记 0 ledger；D12 单独登记。
3. **统计口径：** 最终分布为 **明确事实 16、纯证明 4、R7 18、范围外 0，共 38**。P-03 中的 S13 是 L032 的子证明义务，不把 L032 重复计入纯证明。
4. **Detail 覆盖：** 18 个 R7 ledger 全部进入 D-01～D-07；L035 因是未知汇总可跨 Detail，但只计一次。
5. **证明隔离：** P-01～P-03 明确写出最小证明与边界；没有把测试盲区或外部未知自动转成产品机制。
6. **反向覆盖：** E 表逐项覆盖 L001–L038，无遗漏、无 ledger 重复计数。
7. **防污染：** 未把“可保留资产”等同于符合；未从风险推出防御要求；未写实现形态、推荐、工作量、实施顺序或 issue 拆分；未裁决 K1–K4；未扩展 D12。

**完整交付：** 本报告已完成 L001–L038 分类、7 个可证伪 R7 Detail、3 个纯证明任务、明确事实与范围登记、反向覆盖矩阵及完整性审计；未修改 `WORKFLOW.md`、产品、测试或配置，未创建 worktree/issue/PR。

# RFC #544 R5 供给侧统一总账

核算基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
唯一事实输入：`supply-events-544.md`、`supply-status-544.md`、`supply-read-api-544.md`、`supply-mutations-544.md`、`supply-gateway-boundary-544.md` 的 A/B 全文。本文不重新调查源码，不提出修补方案、选项、需求或工作量判断。稳定条款标签仅沿用五份报告已引用的 AGG 标签。

## A. 主 agent 摘要

### 覆盖与结论

五份 R4 报告的偏离、静态未知、测试同错/盲区、可保留资产和纯未来消费端责任均已进入下方统一总账，并可从“原报告 → 总账覆盖矩阵”反向定位。核算采用**语义事实去重、来源不去重**：同一事实被多份报告重复建立时只设一个总账 ID，但保留每个精确来源；多报告同意不提升置信度。

总账共 **38 条**：偏离 20、静态未知 4、测试同错或盲区 4、可保留资产 6、纯未来消费端责任 4。五份报告共核算 **46 个来源核算单元**（events 8、status 8、read-api 10、mutations 11、gateway-boundary 9），全部有映射，**无法归类/遗漏为 0**。

### 主要簇

1. **只读状态与树**：严格只读 opener、schema mismatch、单时点事务、精确 wire boundary 与三证独立供给均未成立；task-tree 持久化/精确递归 boundary 是资产。
2. **events 恢复协议**：精确事件/segment 原料可保留；并发写、提交/崩溃窗口、坏尾行、跨流顺序和 cursor/reconnect 均不足或未知。
3. **attempt 与只读 API**：prompt/bindings 快照、可解引用 pinned definition、context 外部读取面缺失；compile projection 是最完整的现存资产，但只表达当前定义态。
4. **mutation 与 lifecycle**：四个 verb 的 happy path 存在；F 子闭集、精确 RPC、体系级唯一裁判、请求幂等/跨副作用一致性、CAP-4 decision 均未供给，并登记了一项明确授权偏离。
5. **gateway 边界**：模块导入、root resolver、若干导出 helper 是原料；单 root request 隔离、HTTP/SSE、双进程生命周期和关闭编排属于尚不存在的消费端责任，不能记成当前供给偏离。

### 互证、冲突与不能得出的结论

- 互证集中在 D1、D3、D5 socket 宽边界/无 timeout、events 三流与增量恢复、lifecycle 词义、无凭证 operator 语义；详见各 ID 的关系栏。
- **事实冲突 0 项。** 有两组仅属边界澄清而非冲突：`spawnOneAttempt` 的固定“继续”不能外推到普通 scheduler resume（L20）；gateway 的独立进程/root/HTTP/SSE 责任不能倒记为引擎当前偏离（L32–L35）。
- 本总账不能推出实现范围、修改量、拆 issue 方式、候选方案、优先级、兼容策略或“多份报告同意所以更可信”。也不能把静态未知改写为缺陷。

### 下一步 gate

R6 只能索引本总账中标记为“R6 索引：是”的条目，继续保持事实、未知、盲区、资产与未来消费责任分栏；在索引完成前，不得由本总账生成修补方案或需求。

---

## B. 完整总账

### B1. 核算方法

- **来源核算单元**：每份报告的 B1/B5 三态矩阵按主题合并其 A 结论、B 细节、测试盲区与资产；没有矩阵覆盖的 gateway future responsibility、实验未知和测试同错另成单元。
- **类型互斥**：每条总账记录取一个主类型。某偏离同时存在测试盲区时，偏离进事实条，盲区另进 `测试同错或盲区` 条，避免吞掉证明缺口。
- **关系**：`互证` 表示不同报告独立陈述同一事实面；`重复` 表示同一事实被多报告重述后合并；`边界` 表示必须保持的归属区分；`冲突` 只登记文字上不可同时为真的事实主张。
- **R6 索引**只表示未来报告需要建立索引，不构成调查题、选项、方案或裁决。

### B2. 稳定条款/主题总账

| ID | 条款/主题 | 类型 | 简明事实与影响条件 | 来源报告精确章节/条目 | 关系 | R6 索引 |
|---|---|---|---|---|---|---|
| L01 | D1 严格只读 SQLite | 偏离 | status 的 DB 读取复用 read-write opener，会设置 WAL 并迁移；daemon down 不改变该路径，`createIfMissing:false` 只防新建。 | status A#1；B1「D1」「daemon-down」；B3。read-api B1/B5「D1」。gateway A#1；B1「D1」；B2。 | 三报告互证并重复；无冲突。 | 是 |
| L02 | D1 schema/error 结果 | 偏离 | 旧/不可消费 schema 没有类型化 mismatch；多类 open/migration 失败被折叠为 `missing-state`。 | status A#1；B1「daemon-down」；B3。read-api B1。gateway B1「D1」/B2。 | L01 的错误语义分项；互证。 | 是 |
| L03 | D3 status boundary 单源 | 偏离 | 七个顶层槽仍为匿名 object，TS shape 平行手写，生产 boundary 不导出；gateway 无可导入精确 parser。 | status A#2；B1「D3」；B2.1–B2.6。read-api B1。gateway A#2；B1「D3」；B2。 | 三报告互证并重复。 | 是 |
| L04 | status 最终 wire shape | 偏离 | boundary assert 后 `flattenExtraReplacer` 改写输出，故被验证对象不等于 CLI wire JSON。 | status A#2；B2.5；B7.4。 | 无跨报告重复。 | 是 |
| L05 | status/task-tree 单时点一致性 | 偏离 | snapshot 用多个连接/语句；taskTree 递归读取也无显式 read transaction，并发 writer 下可跨提交撕裂。 | status A#3；B1「CAP-1」「D9」；B4；B5。gateway A#1；B2。 | gateway/status 互证；与 L06 资产不冲突。 | 是 |
| L06 | CAP-1/D9 task-tree 持久事实 | 可保留资产 | task-tree 有递归 exact ADT/boundary、normalized tables/FK/check、生命周期约束与迁移资产；它读取 persisted 事实而非从 git/process 推断。 | status A「可保留资产」；B1「CAP-1」「D9」；B5。 | 与 L05 是“shape 资产/读取一致性偏离”的边界，不可互相抵消。 | 是 |
| L07 | D7 三证独立活性 | 偏离 | pid file 不在 snapshot；ps 与 socket/RPC 被折叠/去重，missing 被丢弃，connect 与应答不分；rateLimit 等 daemon.status 信息未进入 status。 | status A#4；B1「D7」；B6。gateway B3「daemon down…」。 | socket timeout另见 L08；互证。 | 是 |
| L08 | socket timeout/失败边界 | 偏离 | transport 无 timeout/取消；半开或接受后不应答会 pending；response id 不核对，client response 无大小上限，高层错误 ADT不导出。 | status A#4；B6。mutations B2.2/B5。gateway A#3；B1「D5」；B3。 | 三报告互证；各自补充不同失败面。 | 是 |
| L09 | 状态读取平台/历史行为 | 静态未知 | Bun read-only flags、WAL 下跨语句行为、无权限 pid/socket/db 错误矩阵、真实历史盘只读拒绝结果未由现有报告证明。 | status A「未知」；B8。gateway A「置信边界/未知」。 | 不得因 L01 的代码反证而吞掉这些平台事实未知。 | 是 |
| L10 | status 测试边界 | 测试同错或盲区 | 无磁盘中立、schema mismatch、七槽负例、wire reparse、并发一致性和三证组合测试；harness 自建局部 boundary。 | status B2.6；B7.1–B7.7。gateway B6「status integration」「SQLite tests」。read-api B1「测试盲区」。 | 三报告互证；绿测不证明 D1/D3/D7。 | 是 |
| L11 | events 精确 ADT/segment 原料 | 可保留资产 | 精确 event ADT/parser（当前 52 type）、五 kind、路径/文件名 parser、segment discovery/order、轮转常量与串行完整行夹具可保留；`ts` 只验证 string。 | events A「可保留」；B1「精确事件 ADT」「active/历史」「日界/32MiB」。gateway A#4/A「资产」；B1「B/E」；B4。 | 两报告互证；“52 vs AGG 44”登记为同条契约漂移。 | 是 |
| L12 | events 单 writer/并发 rotate | 偏离 | 产品调用集中于 daemon，但 append API 无 owner 约束和 mutex/lock；并发 writer 可争 sequence/rename并静默丢事件。 | events A#2/#5；B1「daemon唯一写入方」「并发 writer」；B2–B4。 | 与 L11 资产不冲突。gateway B4 亦提示写 API 可导入，但不另立事实。 | 是 |
| L13 | events 提交/崩溃恢复 | 偏离 | rotate 是 rename 后另行 append，无事务/fsync/commit marker；崩溃可留下 history 已提交、active/新 event 缺失，tolerant wrapper 可吞写错。 | events A#2/#3；B1「写入原子性」「进程崩溃/重启」；B3。 | 与 L14 reader 恢复相关但不重复。 | 是 |
| L14 | events partial/corrupt/legacy 内容 | 偏离 | 任意非空坏行/尾部 partial/旧 schema event 使全量 query throw；legacy 仅有文件名兼容，无 envelope version/migration。 | events A#1/#7；B1「partial」「legacy」「daemon-down」。gateway A#4；B4。 | 两报告互证；daemon-down 可读仅在完整且兼容文件条件下成立。 | 是 |
| L15 | events 静态顺序与多流 | 偏离 | legacy/new 混排不形成时间全序；同 timestamp 无全局 sequence；主流不含 lifecycle/runner failure 两流，daemon logs 的三流合并也只按 ts。 | events A#5/#6；B1「段排序」；B2。gateway A#4；B1「B/E」；B4。 | 两报告互证；“是否必须合并 failure streams”另属 L18 未知。 | 是 |
| L16 | D6 增量 cursor/reconnect | 偏离 | 导出面只有 snapshot/full query，没有 offset、tail parser、watch recovery、读写同步；不能证明 rotate/reconnect 无丢无重。 | events A#3/#4；B1「D6」；B5。gateway A#4；B1「B/E」；B4。 | 两报告互证。未来 gateway 如何消费另见 L34。 | 是 |
| L17 | events OS/workload 恢复性质 | 静态未知 | 单 daemon 真实并发频率、append 原子性/持久性、kill 各系统调用点、fs.watch 合并/丢通知行为未判定。 | events A「纯证明缺口」；B5/B6。gateway A「纯证明缺口」；B6。 | 多报告同意不升级置信度。 | 是 |
| L18 | failure streams 的目标可见性 | 静态未知 | 现存三流事实明确，但 AGG 目标是否要求 gateway 合并两个 failure streams，报告声明不可猜。 | gateway A「未知」；B4。events A#5/B2 提供现状。 | events 提供事实、gateway 登记需求边界；非冲突。 | 是 |
| L19 | events 测试边界 | 测试同错或盲区 | 测试证明串行完整文件与内部排序自洽，不覆盖并发写/读、partial、kill/fsync、schema 演进、多流/cursor/watch；next-sequence 与 readback 共享 helper 有同错风险。 | events B5。gateway B6「events tests」。 | 两报告重复/互证。 | 是 |
| L20 | D2/D10 attempt prompt/bindings | 偏离 | scheduler 的 finalPrompt 局部同源进入 runner argv，但 attempt 目录不落 prompt/per-key bindings/fresh-resume artifact；restart/retry 会重新读取/渲染。普通 scheduler resume 重渲完整 prompt，不能用 `spawnOneAttempt` 固定“继续”外推。 | read-api A；B2.1–B2.2；B5「D2」「D10」。 | 边界澄清，无冲突。 | 是 |
| L21 | CAP-2 pinned definition | 偏离 | exact hash identity 持久且短期 materialization/cache 原子收口，但无 definition blob/repository/resolver；restart 重读当前 path，旧 hash sibling 会 prune。 | read-api A；B2.3；B5「CAP-2」。 | 资产部分拆入 L25；事实无冲突。 | 是 |
| L22 | CAP-3 typed binding values | 偏离 | item source 有类型声明，但 phase projection/render 最终统一为 string；无 per-attempt typed value/source 快照。 | read-api A；B2.4；B5「CAP-3」。 | additive shape 如何表达属 L24。 | 是 |
| L23 | CAP-6/D12 context read | 偏离 | context 有 strict ADT/table/internal全量 list，但无 daemon/operator read command、权限、分页/filter；group 写明确拒绝，append session/DB/event 存在非原子重试窗口。 | read-api A；B4；B5「D12」「CAP-6」。 | 与 context 资产 L26 分开。 | 是 |
| L24 | read API 未决语义 | 静态未知 | CAP-2 retention/GC、CAP-6 分页/filter 最终 shape、CAP-3 additive typed shape、D11 对 CAP-2 的消费语义未由现状裁决。 | read-api A「未知」；B2.4；B3；B6。 | 只登记未知，不生成调查问题/选项。 | 是 |
| L25 | CAP-7 compile projection | 可保留资产 | compile 具共享计算路径、精确 versioned boundary、typed rejection/findings和六块确定投影；只表达当前定义态，不是 historical/pinned，variables/tools/tree 能力有限。 | read-api A「可保留」；B3；B5「D11」「CAP-7」。 | 与 L21 边界明确：CAP-7 不替代 CAP-2。 | 是 |
| L26 | identity/context/prompt 基础类型 | 可保留资产 | ExecutionDefinitionRef/run identity 校验、materialization staging、context scope/author/row boundary、prompt renderer和 binding source parser可保留，但均不等于目标 read API。 | read-api A「可保留资产」；B2.3；B4。 | 与 L20–L23 的缺口不冲突。 | 是 |
| L27 | read API 测试边界 | 测试同错或盲区 | prompt/runner tests不证明 artifact；compile tests不证明 restart/identity/GUI；context tests用内部 store list核对，绕过缺失 read boundary；status tests共享可写 opener。 | read-api A「纯证明缺口」；B1；B2.2；B3；B4「tests同错/盲区」。 | 与 L10 有 D1 重复，其余独立。 | 是 |
| L28 | D5/F 精确 mutation RPC 子闭集 | 偏离 | daemon command/auth 分类是大闭集；wire仍为 string+JsonObject，F 四 verb无独立 subset/client，CLI另有平行命令清单。 | mutations A；B1「command穷尽」「全链路ADT」「四verb」「F闭集」；B2。gateway A#3；B1「D5」；B3。 | gateway/mutations 互证；四 verb happy path作为 L31 资产。 | 是 |
| L29 | mutation trust/唯一裁判与授权 | 偏离 | 无 credential 被消极分类为 operator，socket peer/用户/capability identity缺失；store mutator公开可旁路。reorder gate未绑定 caller 的 item/chain，跨目标可先提交后审计失败。 | mutations A；B1「唯一裁判」「主体」「准入」；B2–B4。gateway B1「零凭证」；B3。 | “零凭证=operator”现状互证；gateway禁止透传 credential 属 L33。 | 是 |
| L30 | mutation 原子性/幂等/审计 | 偏离 | 单 store mutator有 IMMEDIATE transaction，但 DB、run termination、events/RPC跨副作用；无 request id 去重/CAS/串行锁，重试不能补缺副作用。 | mutations A；B1「事务/幂等/竞态/审计」「stop/resume」；B4。 | 与 L31 的单事务资产不冲突。 | 是 |
| L31 | mutation/join 基础资产 | 可保留资产 | command/auth dispatch 穷尽、credential→active-run identity、四 verb 参数/happy path、scheduler pause、store IMMEDIATE、typed audit subject及 join PK/FK/epoch/bindingVersion可保留。 | mutations A「可保留资产」；B1「四动作存在」；B3/B4/B6。 | 不表示 F 闭集或 CAP-4 已供给。 | 是 |
| L32 | D7 lifecycle 与 CAP-4 | 偏离 | `up/down` 才是真 daemon 启停；`start`只 status、`stop`是 chain.stop、`restart`不重启。CAP-4 仅有初始化 join 行，无 decision ADT/capability/operation/consumer。 | mutations A；B1「D7」「CAP-4」「历史迁移」；B5/B6。gateway B1「进程start/stop」；B5。 | lifecycle 两报告互证；CAP-4 独立。 | 是 |
| L33 | mutation 测试边界 | 测试同错或盲区 | store 直写 fixture掩盖旁路；无 reorder cross-item/chain、并发四动作、event/terminate/socket fault、request-id幂等、真实 lifecycle、CAP-4 operation测试。 | mutations B7/B8。gateway B6「socket integration」。 | socket共享宽 parser盲区与 L08 相连。 | 是 |
| L34 | gateway 单 root 与 HTTP trust | 纯未来消费端责任 | 未来 gateway 启动期固定 root、route 禁止覆盖、HTTP 不接受/透传 agentCredential、建立自己的不可变 context；当前 resolver/daemon root固定只是原料。 | gateway A#5/A「未来消费端责任」；B1「零凭证」「单root」；B3/B5。 | 不得倒记为当前引擎供给偏离。 | 是 |
| L35 | gateway host/SSE/双进程生命周期 | 纯未来消费端责任 | gateway host、HTTP boundary、SSE watch/offset、listener统一关闭、gateway退出不杀daemon、双进程 kill/ready/单实例证明尚不存在，责任在未来消费实现。 | gateway A#1/#4/#5；B1「独立gateway」「进程start/stop」；B4–B6。 | 引擎先决供给 L01/L03/L08/L16/L28 仍是偏离；二者不可混记。 | 是 |
| L36 | gateway 安全导入与 path 原料 | 可保留资产 | 模块 import 无文件副作用；`resolveLoopDataPaths` 有绝对 root precedence；events helpers、command name/transport、status业务聚合、detached start plan均是原料而非完整 gateway API。 | gateway A「资产」；B1/B2/B3/B4/B5；B6 E1。 | 与 L34/L35 的未来责任互补。 | 是 |
| L37 | gateway route/runtime E2E | 纯未来消费端责任 | 因 gateway 不存在，daemon-down HTTP、gateway kill、root逃逸、重复 start/stop 和 listener shutdown 没有现存 E2E 对象。 | gateway A「纯证明缺口」；B6「没有gateway进程」。 | 不是“测试漏了已实现功能”，故不归 L10/L19/L27/L33。 | 是 |
| L38 | gateway command/result HTTP 映射 | 纯未来消费端责任 | 未来 gateway 自身需建立 HTTP boundary parse、socket timeout/取消/错误映射和固定 args；当前报告没有给出其形态。 | gateway A「未来消费端责任」；B3「operator主体」；B5。 | 依赖 L08/L28，但不把未来责任转成供给事实。 | 是 |

### B3. 原报告 → 总账逐条覆盖矩阵

这里的“核算单元”把同一报告中 A 的结论、B 的三态行及其展开证据合并为一个可反向核对的主题；测试/未知/资产若横跨多节则单列。每个单元至少映射一个总账 ID。

#### `supply-events-544.md`（8/8）

| 原报告核算单元 | 总账 ID |
|---|---|
| B1：精确事件 ADT、active/history 命名、串行日界/32MiB、可保留资产 | L11 |
| B1/B2–B4：唯一 writer、并发锁、写提交与崩溃窗口 | L12, L13 |
| B1：partial/corrupt、legacy schema、daemon-down 条件读取 | L14 |
| B1/B2：segment 顺序、same-ts、三流消费者 | L15 |
| B1：D6 rotate/reconnect | L16 |
| A/B6：OS durability、真实并发、kill/watch 静态未知 | L17 |
| A/B2：failure streams 现状及目标归属边界 | L18 |
| B5：测试覆盖、同错与盲区 | L19 |

#### `supply-status-544.md`（8/8）

| 原报告核算单元 | 总账 ID |
|---|---|
| B1/B3：D1、daemon-down、schema/error | L01, L02 |
| B1/B2：D3 boundary/type/output 单源 | L03, L04 |
| B1/B4：CAP-1/D9 的读取一致性偏离 | L05 |
| A/B5：task-tree shape/persistence/migration 资产 | L06 |
| B1/B6：D7 三证与 daemon.status 投影 | L07, L08 |
| A/B8：平台、权限、历史盘静态未知 | L09 |
| B7：status 测试同错/盲区 | L10 |
| B1「daemon-down 快照」的条件结论 | L01, L02, L07 |

#### `supply-read-api-544.md`（10/10）

| 原报告核算单元 | 总账 ID |
|---|---|
| B1/B5：D1 | L01, L02, L10 |
| B2.1–B2.2/B5：D2/D10 attempt prompt/bindings | L20 |
| B2.3/B5：CAP-2 | L21, L25, L26 |
| B2.4/B5：CAP-3 | L22, L24 |
| B3/B5：CAP-7/D11 | L25 |
| B4/B5：CAP-6/D12 context read | L23, L26 |
| A「可保留资产」 | L25, L26 |
| A「未知」 | L24 |
| A/B1/B2/B3/B4：纯证明缺口与测试盲区 | L27 |
| B6：只读调查限制（未将未实验升级为保证） | L09, L17, L24 |

#### `supply-mutations-544.md`（11/11）

| 原报告核算单元 | 总账 ID |
|---|---|
| B1：command/auth 穷尽、精确边界、F 子闭集、四 verb | L28, L31 |
| B1/B2：daemon 唯一裁判与 store/socket 旁路 | L29 |
| B1/B3：operator/agent 主体 | L29, L34 |
| B1/B4：准入，含 reorder target 未绑定 | L29 |
| B1/B4：事务/幂等/竞态/审计 | L30 |
| B1/B4：stop/resume active-run 语义 | L30, L32 |
| B1/B5：D7 lifecycle | L32 |
| B1/B6：CAP-4 identity/capability/decision | L31, L32 |
| B1/B6：历史迁移/存量 | L31, L32 |
| A「可保留资产」 | L31 |
| B7/B8：测试同错/盲区与未做实验 | L33 |

#### `supply-gateway-boundary-544.md`（9/9）

| 原报告核算单元 | 总账 ID |
|---|---|
| B1/B2：D1 严格只读 | L01, L02, L05 |
| B1/B2：D3 status boundary | L03 |
| B1/B3：D5 typed socket client/timeout/operator | L08, L28, L29, L38 |
| B1/B4：B/E events 供给、三流与增量恢复 | L11, L14, L15, L16, L18 |
| B1/B5：单 root/request 不可覆盖 | L34, L36 |
| B1/B5：独立 gateway 与进程 start/stop | L32, L35 |
| A/B5/B6：模块导入、path、现存可保留原料 | L36 |
| B6：现有测试同错/盲区 | L10, L19, L33 |
| A/B6：未来 gateway E2E/消费责任 | L35, L37, L38 |

### B4. 互证、重复、冲突与后续事实边界

| 类别 | 总账 ID | 核算结论 |
|---|---|---|
| 三报告重复互证 | L01, L03, L08 | status/read-api/gateway 或 status/mutations/gateway 对同一现状重复陈述；只保留一个事实 ID，不提高置信度。 |
| 两报告重复互证 | L05, L11, L14–L16, L19, L28, L32 | 来源均保留；没有新事实由“多数同意”生成。 |
| 资产与偏离并存 | L05↔L06；L11↔L12–L16；L21↔L25/L26；L28–L30↔L31 | 资产仅证明其明示范围，不能抵销目标契约偏离。 |
| 归属边界 | L16↔L35；L29↔L34；L32↔L35；L08/L28↔L38 | 引擎供给缺口与未来 gateway 消费责任分别记账。 |
| 语义边界 | L20；L25↔L21；L18 | 特例 resume 不外推；当前 compile 不冒充 pinned；三流现状不替代目标可见性裁决。 |
| 事实冲突 | 无 | 五份报告中未发现不可同时为真的事实主张。 |
| 需后续事实输入但本轮不调查 | L09, L17, L18, L24 | 保持静态未知；R6 只索引，不把它们改写为调查计划或实现任务。 |

### B5. 覆盖计数与核算结论

| 指标 | 计数 |
|---|---:|
| 输入报告 | 5 |
| 来源核算单元 | 46 |
| 已映射来源核算单元 | 46 |
| 无法归类/遗漏 | 0 |
| 总账记录 | 38 |
| 偏离 | 20 |
| 静态未知 | 4 |
| 测试同错或盲区 | 4 |
| 可保留资产 | 6 |
| 纯未来消费端责任 | 4 |
| 登记事实冲突 | 0 |

核算结论：五份 R4 报告已完整进入统一账目并可双向映射；重复事实已合并但来源保留，静态未知与测试盲区未被偏离或资产吞并，未来 gateway 责任未被误记为当前引擎偏离。本账只足以作为 R6 的事实索引输入，不能据此给出修补方案、范围结论、裁决或新需求。

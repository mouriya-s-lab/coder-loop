# RFC #545 R9：修补后预期地基

本文把 R5 供给账、R7 事实报告与 R8 收敛合同回锚为下游可以消费的**保证**。它不描述实现方案、PR 规模、issue 拆分或施工顺序；“预期”表示该保证只有在对应修补与运行证明完成后才成立，不能把现存局部资产当作已经交付的产品能力。

## A. 主 agent 摘要

### 修补后预期地基

context 服务保持 `item | chain | group` 封闭 scope、credential-derived author、opaque body、socket command 与 append-only chain-lifetime storage 的稳定产品边界。修补后的地基应同时保证：持久层入口与生命周期不再绕过边界；每次 append 接受/拒绝判定具有一致审计，真实协议边界显式拒绝且 socket 异常不挂起；合法历史数据逐字保真；公开 read 有精确 typed response、稳定可穷尽分页和 credential confinement；group 只消费并行结构层给出的权威容器身份与归属结论；required/expected 在统一 run finalize 上求值；prompt 给无状态 agent 与真实 CLI 一致的可执行寻址说明而不注入 entry body；文档、`shared.md` 并存边界与纯证明账一致。

### 可保留的现存资产

- scope/author ADT、persisted parser、SQLite chain FK 与复合索引、credential-derived socket author、typed command/auth 分类和 arktype 边界惯例；
- begin/chunk/commit 的 typed wire 与 CLI body/body-file 输入形态，但不把现有 session/result 语义当成可靠提交保证；
- stable tree/runtime node storage、parent linkage、terminal tree persistence 与穷尽 traversal 的局部底料，但不从 fixture ancestry 推导 group membership；
- existing backoff/exhausted、typed event infrastructure、doc builder/phase slicing/runtime binding count guard；
- `shared.md` 的显式创建、幂等与 prompt 注入机制，它继续与 context 并存而不被替代。

### 修补后才可依赖的保证

当前不能依赖 store 是唯一权威入口、active chain 无独立 entry delete、soft delete 与 context 清理原子、item/group 引用始终有效、append result 恰好对应 durable entry+audit、session 可恢复、任意合法 body 都能通过 request transport、公开 read/分页/auth/response boundary、真实 group membership、tool outcome evaluator、统一 finalize、context capability doc 或全部 phase 的 prompt sentinel 证明。下游只能在对应 Foundation ID 的 runtime proof 完成后依赖这些保证。

### 尚缺的外部能力

- 工具声明位：`[[tools]]`、per-phase `toolRequirements` 与有 outcome 才可 `required` 的 typed compile 合同；
- 并行结构层的合法 source 数学、权威容器身份与归属结论及真实 `par` producer/branch credential 路径；RFC #545 不从 runtime 可表达 ancestry 自造答案；
- trigger/validator 统一 scheduler run lifecycle 与共同 finalize 点；
- GUI 仅作为未来 read boundary 的消费者。已访问源码/IaC 中未发现现存 context GUI/hook consumer，未登记生产脚本仍不可外推为不存在。

### 明确范围外

不新增 exactly-once caller 产品要求；不要求 partial malformed persisted rows 的逐行容错；不自造 response cap；不定义 nested `par` membership、结合律或扁平化；不增加 `run` scope；不新增 GUI 行为；不改 `shared.md` 机制；不把 evidence、transition 或持久业务语义收编进 context；不为正文外的自由 topic/tag、跨 chain 查询或 required-read 预埋合同。若某个现存主张比原需求更强，收敛到本文保证，而不是从反例生长新需求。

## B. Foundation 明细

### F-01 Storage authority / lifecycle

- **稳定条款：** D3/D6/D7/D11、S01–S04/S06。author 仅由 credential/operator 路径构造；entry append-only，与 chain 同生共死；合法 scope key 必须解析到本 chain 的真实对象。
- **R7 实然问题：** D-01 证明公开 store append/delete 绕过 socket authority；active chain 可独立删 entries；soft chain status 与 context 清理分事务且 restart 不自动对账；item delete不清 context，schema也没有 item/group引用完整性。D-03 另证 direct store/SQL 可形成 parser 拒绝或悬空数据。
- **唯一收敛：** 权威性、append-only、chain lifecycle 与引用完整性仍是原条款；不因当前旁路而弱化，也不把具体数据库机制升格为需求。
- **修补后保证：** 所有产品可达写删路径遵守同一 authority；active chain 无 entry 独立删除；chain lifecycle 结束后无 residue 且重启后终态一致；新 entry 的 item/group key 在写入时是 caller chain 内合法身份。
- **仍需 runtime proof：** socket/store 全入口对抗；soft delete 正常、故障与 restart；item delete/并发 append；跨 chain、悬空 key 与 active-chain delete 拒绝。
- **下游依赖边界：** 可依赖 chain-lifetime cleanup 与合法引用；不得依赖 physical FK cascade、fixture-only store invariants、生产存量已清洁或未登记 direct-SQL caller 不存在。

### F-02 Append / audit / transport

- **稳定条款：** D7/D9、S05/S09/S12。写入经 socket；每次 admission 判定有审计；body 不截断，不设 context 自造 cap，真实外部边界须显式报错。
- **R7 实然问题：** D-02 证明 commit 先落 entry、后 audit/response，caller 可收到失败但 entry 已存在；无 operation identity/result query/replay，session 在 disconnect/restart 后不可恢复且无 TTL；固定 code-unit chunk 遇 JSON escaping 会越过 1 MiB request boundary。D-04 实测单响应 64 MiB 可完整返回，但未达到真实极限。
- **唯一收敛：** 保留稳定条款实际要求：接受与拒绝判定各自有一致审计；body 不截断；真实协议边界显式拒绝；socket 异常拒绝而不挂起。不从 D-02 的失败窗口新增 exactly-once、operation identity、caller 唯一确定结果或 session durability 要求，也不凭未知极限发明 cap。
- **修补后保证：** 每次 admission 接受/拒绝判定产生与该判定一致的审计；合法 body 在真实协议边界内逐字传输，越界时显式拒绝且不静默截断；socket 提前 end/close 或响应不完整时 caller 得到拒绝而不挂起。
- **仍需 runtime proof：** 接受/拒绝两类审计内容；socket 提前 end/close 与不完整响应；JSON 高转义膨胀下的完整传输或显式 boundary error；真实 response 极限测量。
- **下游依赖边界：** 可依赖判定审计、边界显式拒绝与异常不挂起；不得依赖 exactly-once retry、operation identity、caller 能唯一判断提交事实、unfinished session 的持久/清理保证、无限 payload、OS/runtime 未测极限或日志替代审计。

### F-03 Persisted exactness

- **稳定条款：** D5/D9/D14、S05/S08/S10/S11。合法 envelope 精确 typed，body 逐字保留且不解释语义；迁移保全合法既有数据。
- **R7 实然问题：** D-03 证明 schema 接受集合宽于 arktype parser，单条 malformed author/scope 可毒化整链 list；migration/startup 不规范化历史 JSON；生产 DB 是否含异常 row未知。D-04 将该 parser failure 与合法 key pagination 明确分离。
- **唯一收敛：** 保证合法 persisted row 的 exact round-trip 与 boundary parse；历史异常存量先作为事实审计，不把 partial malformed 容错新增为产品需求。
- **修补后保证：** 所有产品写入的新 row 都在 persisted schema 与 typed parser 的共同合法集合中；合法历史 row 迁移、重开和读取逐字段/逐字一致；malformed 数据以明确 boundary failure 暴露。
- **仍需 runtime proof：** 使用生产同一 parser 的只读存量审计；合法 Unicode/control/LF 大 body migration+restart round-trip；malformed fixture 的确定失败分类。
- **下游依赖边界：** 可依赖合法 row exactness；不得依赖生产存量无异常、逐行跳过坏 row、自动清洗或跨 chain 失败隔离，除非另有权威需求。

### F-04 Read pagination / response

- **稳定条款：** D9/D10/D14/D15、S14/S16–S20/S22。过滤闭集、显式正整数 `pageSize`、stable keyset、`nextCursor | exhausted`、typed request/response，且可持续翻页至穷尽；无默认 magic limit或静默缩页。
- **R7 实然问题：** D-04/D-05 证明当前没有公开 context read CLI/daemon/boundary；唯一内部 list 是 chain 全量单响应。`createdAt,id` 对第一页时已存在且 key 不变的集合可做 keyset，但页间新写入是否纳入必须由定义决定；回填/direct SQL 可破坏假设。response 当前未见 cap，极限未知。
- **唯一收敛：** 分页保证针对请求定义的稳定集合并明确 concurrent append 可见性；具体 cursor representation 不是 RFC 决策。response 只服从实测 transport boundary，不自造 cap。
- **修补后保证：** 合法 filter逐项生效，边界外参数拒绝；游标不使目标集合已有 entry 漏读或重复；每页 response 过精确 parser，caller 可直到 exhausted。
- **仍需 runtime proof：** 同秒 UUID、页间前/后 cursor append、held snapshot/restart、全部 filter组合、多页大 body与真实 response boundary error。
- **下游依赖边界：** 可依赖公开 typed pagination合同；不得把内部全量 list 当 API、假设新写入一定纳入/排除、假设无限单响应或使用 offset/free query。

### F-05 Read authorization / classification

- **稳定条款：** D3/D7/D14、S14–S16/S20/S21。agent read 是 A 域命令，结果恒限 credential chain；operator 无凭证可选 chain；事件流仍拒绝 agent；命令分类穷尽。
- **R7 实然问题：** D-05 证明现有 `read-no-auth` 会忽略身份，CLI credential tuple 与 daemon auth Record 是双源且已漂移；遗漏新命令会把 agent 调用退化成 operator。当前无专用 chain-bound read class/handler。
- **唯一收敛：** daemon credential identity 是授权权威，显式 selector只能被核验、丢弃或拒绝，不能扩权；CLI 自动附带不是安全边界。
- **修补后保证：** agent 对他 chain selector/entry 零可见且不能因命令清单漂移绕过；operator path 与 agent path typed 区分；read request/result 全程精确 ADT 并穷尽分类。
- **仍需 runtime proof：** real CLI credential composition、raw socket伪造 chain、失活/跨 chain credential、operator no-credential、事件流拒绝与分类守卫。
- **下游依赖边界：** 可依赖 daemon confinement；不得依赖 CLI 重写、自觉不传 chain、`read-no-auth` 或复制 prompt handle 获得权限。

### F-06 Group 合法身份消费

- **稳定条款：** D2/D3/D11/D14、S23–S28。group key 是并行结构层赋予 run 的真实 `par` 容器稳定 id；同组过滤可互见，组外按 group 不命中，chain scope仍是同 chain 自由读。
- **R7 实然问题：** D-06 证明 durable fixture可表达/恢复多个结构 `par` 祖先，但正常 producer只造 seq+leaf；无真实 par scheduler/updater/branch credential、无 resolver/membership/read，daemon group硬拒绝且 store接受任意 key。fixture 的多祖先来自宽 runtime shape，不证明合法 source数学或通信 membership。
- **唯一收敛：** K1 只认真实 `par` 路径证明；fixture仅局部证据。K4a 的“最近/全部祖先”都是伪问题；本 RFC 不定义 nested membership，只消费并行结构层未来给出的权威容器身份与归属结论；membership 基数与并行数学仍由上游定义。
- **修补后保证：** daemon 对真实 branch credential 与真实容器 key做 server-side membership验证；不存在/非成员/跨 chain key拒绝且不落库；真实同组两 branch 可双向写读，terminal/restart后身份语义稳定。
- **仍需 runtime proof：** 真实 producer物化、两个真实 branch credential双向写读、组外/伪造/跨 chain、terminal/restart/join后chain read；fixture只能证明 durable shape/parser/admission局部性质。
- **下游依赖边界：** 可依赖并行结构层给出的合法 identity/归属结论；不得依赖结构 ancestry 自行决定 membership 集合或基数、假定 nested `par` 合法、fixture关掉真实路径或新增run scope。

### F-07 Finalize / outcome

- **稳定条款：** D4/D5/D14、S29–S39。context outcome仅是本 run author 下至少一条 entry；required失败走现有 retry/exhausted，expected只发 validation；一切 run 同语义；判定不看 body且与 credential revoke 同一 finalize 边界。
- **R7 实然问题：** D-07 证明当前无 tool registry/outcome evaluator/existence query；空 tools projection是负资产。child close到revoke有多段 await，late write窗口存在；completeRun/clearCurrentRun分事务且crash恢复无证。普通/item-trigger/chain-trigger/validator lifecycle不同，item-trigger attempts不递增，chain-trigger无attempt，validator无runner lifecycle。
- **唯一收敛：** K2 不缩窄“一切 run”；CAP-IN-4 缺失只使运行证明待定。K3 是跨 RFC供给账，不生成重复标准。required-read仍范围外，因为没有真实输出定义。
- **修补后保证：** 对有 outcome 的 typed capability，finalize基于该 run credential author的durable existence一次确定 verdict；required/expected/undeclared三态及 body不透明语义一致；判定后无迟到写改变 verdict，失败复用既定终态通道。
- **仍需 runtime proof：** outcome正负、other-run/空白/marker body、late write与crash/restart、普通/item-trigger/chain-trigger/validator各 required/expected/undeclared路径。
- **下游依赖边界：** 可依赖统一 verdict与现有失败语义；不得依赖 audit计数代替 existence、provider调用动作、内容质量、当前空 projection或未统一 lifecycle 已成立。

### F-08 Prompt executable addressing

- **稳定条款：** D8/D11/D14、S19/S29/S36/S42；K4b唯一合同。声明 capability 的 phase获得真实 append/read用法与本 run 可执行 scope寻址，不注入 entry body。
- **R7 实然问题：** P-01 对应 proof尚缺；D-05/D-06/D-07证明当前 CLI需要 chain selector及item/group stable key，credential只推导author/chain authority；有 `chainName` 与 item binding，无合法 group binding、read命令、toolRequirementsDoc或context capability。静态“无消费边”不能替代全 phase sentinel证明。
- **唯一收敛：** 参数若自动推导就明确无需填写；若 CLI显式要求stable key就提供当前合法值；无合法scope明确不可用。identity字段组合不是产品分叉，run/phase标签不是scope，值不是capability。
- **修补后保证：** 无状态agent只凭文档即可对每个当前可用scope组成合法真实命令；无猜key、伪key或fallback；未声明phase不获文档；body sentinel在所有prompt零命中，daemon仍独立鉴权。
- **仍需 runtime proof：** direct与trigger/validator phase正负注入；实际append/read命令执行；无group时负路径；全phase sentinel；raw socket证明prompt handle不扩权；docs/help/schema一致。
- **下游依赖边界：** 可依赖文档可执行性；不得依赖opaque credential曝光、entry摘要、author identity标签、未实现flag、run scope或prompt值作为授权。

### F-09 Docs / `shared.md` coexistence

- **稳定条款：** D1/D12/D13/D15、S13/S40–S43。`shared.md` 是自由prompt注入面，context是结构化受控中间态；context不承担transition、持久业务事实或后继必需交付；GUI只消费read boundary。
- **R7 实然问题：** P-03 已在固定基线运行证明 `shared.md` create与显式prompt注入、且不写context store；D-05证明root/nested help与CLAUDE命令列表漂移，旧“durable/唯一/GitHub唯一”措辞未表达并存边界；P-02在可访问源码/IaC中未发现GUI/hook context consumer。
- **唯一收敛：** 保留两通道并存与职责边界，文档直接替换为当前结论；K5无定义旧编号/issue引用删除，不从残渣猜能力。
- **修补后保证：**作者手册、CLAUDE、相关docs、help与真实typed command/tool语义一致且no-legacy；`shared.md`行为零回归；read boundary变更对未来consumer显式。
- **仍需 runtime proof：** 冻结SHA复跑shared create/injection/context零替代；help/命令/doc一致性；可访问外部consumer复核。
- **下游依赖边界：** 可依赖并存边界和read boundary所有权；不得依赖所有生产机器绝无私有脚本、context替代transition或文档陈述替代runtime行为。

### F-10 Pure proofs / integrated evidence

- **稳定条款：** D14、S10/S19/S28/S39/S44，以及真实路径S23。纯函数/ADT证明覆盖解析、filter、cursor、lineage消费、outcome与prompt渲染；终态在冻结SHA复核，不用狭窄检查支持宽主张。
- **R7 实然问题：** P-03 汇总现有proof只覆盖write/tree/backoff/shared局部资产；store直写、旧group拒绝、空tools、手工credential与常见Unicode测试会共同锁定错误。read、真实par、prompt、finalize故障路径不可运行。D-01～D-07分别列出故障注入与外部未知。
- **唯一收敛：** pure proof只证明其输入/输出合同；fixture不证明producer，静态零引用不证明runtime零泄漏，unit绿不证明socket/finalize。真实group只有S23一条真实路径标准，S44复核它而不另造完成口径。
- **修补后保证：** 每个pure invariant有穷尽typed oracle；每个跨边界保证有相同scope的runtime证据；冻结SHA证据可重跑并明确观察最终状态。
- **仍需 runtime proof：** F-01～F-09逐项所列路径，尤其故障/restart、公开read、真实par、统一finalize、all-phase prompt与shared零回归。
- **下游依赖边界：** 可依赖与证据scope等宽的保证；不得用fixture、mock、typecheck、无grep命中、旧real-e2e或单接口smoke外推未覆盖的生产语义。

## C. 反向覆盖审计

| 输入 | Foundation 覆盖 |
|---|---|
| D-01 lifecycle | F-01、F-03、F-10 |
| D-02 append transport | F-02、F-10 |
| D-03 historical data | F-01、F-03、F-04 |
| D-04 pagination/response | F-02、F-04、F-10 |
| D-05 read auth | F-04、F-05、F-08、F-09 |
| D-06 group lineage | F-01、F-06、F-08、F-10 |
| D-07 finalize/outcome | F-07、F-08、F-10 |
| P-01 prompt sentinel | F-08、F-10 |
| P-02 external consumers | F-04、F-09 |
| P-03 proof ledger | F-09、F-10 |
| K1 | F-06、F-10：真实路径唯一，fixture局部 |
| K2 | F-07：范围不缩窄，等待统一lifecycle |
| K3 | F-07：跨RFC供给账，不造重复标准 |
| K4a | F-06：删除祖先候选，只消费真实容器身份 |
| K4b | F-08：唯一可执行寻址合同 |
| K5 | F-09：无定义残留删除 |

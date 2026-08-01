# RFC #547 — R7 十四份细节报告收件与覆盖核算

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 只读输入：`12-r6-detail-index.md` 与 `13-r7-01-*.md` 至 `13-r7-14-*.md` 全文。  
> 本报告只核算收件、任务索引覆盖、依赖消费、报告间一致性与 R8 分组资格；不复查源码或实验，不裁决、不设计、不估算、不改写任何 R7 报告。

## A. 摘要（≤1页）

R7 的 14 个索引项均有对应报告，固定基线一致，均采用 A 摘要 + B 证据附录的双层结构，并在正文末尾给出收束结论；R7-11 的尾结论是 B10 末尾的加粗段而非独立二级标题，但结论内容完整。逐项把索引中的稳定条款/总账、必须事实、实验边界、复杂因果、消费者、根因、事实支持形态、未知与尾结论映射到报告章节后，**14/14 项有映射，未映射索引项为 0**，通过收件覆盖 gate。

覆盖并不等于所有未知已消失。14 份报告都保留了其调查边界内无法由当前系统证明的外部 owner、产品语义或未来机制；这些未知被显式列出，没有被改写成“不存在”。两处实验闭环为“事实已覆盖、任务索引所述最强运行路径未新跑”的半写证据：R7-08 未新跑会创建 worktree 的 stub-runner success/failure/kill/restart 路径，改以生产调用图、19 个 store tests 与既有 integration inventory限定结论；R7-11 未新跑 create→spawn→edit→resume→kill/restart 全时间线，改用 R7-02/03 的隔离观察和本报告静态 resolver/SQL 时间线互证。两处均明确标注不能证明的部分，未把未执行路径冒充实验成功；它们是 R8 可见的证明缺口，不是索引事实漏写。其余报告的索引实验边界均有实验登记、明确的只读/隔离路径，或在任务禁止条件下给出边界说明。

强制依赖均被实际消费：

- R7-07→R7-08：R7-08 不只引用文件名，还把 R7-07 的退化线性 compiled tree、phase/leaf identity 与无递归声明作为 constructor/scheduler 调用图的输入。
- R7-08→R7-10/R7-11：R7-10 使用 runtime identity 首次持久化时点、无 typed transition commit 与无 container scheduler authority核对每个 gate host；R7-11 使用 run-start局部事务、dynamic leaf/closure identity、restart/current-source行为与无全局 transition commit界定 definition ref 的 attribution-only 作用。
- R7-04+R7-13→R7-14：R7-14 以 R7-04 的已知外部 owner/installed producer边界和 R7-13 的 repository/typed-chain owner、持久化/closure事实核对 external boundary 与 fallback；没有把“已核 owner 无实现”外推为全系统不存在。

报告之间未发现不可解释的事实冲突。表面张力均可按代码层、生命周期或身份域解释：compiled tree 与 runtime storage、cache冻结与 restart漂移、opaque item id 与 GitHub入口残留、repository列与prompt binding双读面、hook carrier与gate execution、tool与gate，均被报告明确分层。没有报告提前选择稳定条款的裁决结果、给出实施顺序或规模估算；多份报告列出的“候选/事实支持形态”均声明非完备、不排序、不推荐，只记录由现状决定的后果。

**覆盖结论：14/14 收件，14/14 索引项映射，缺项 0；两项运行证明部分闭合（R7-08、R7-11），未知继续进入 R8，不阻断事实覆盖 gate。**

## B. 覆盖附录

### B1. 核算口径

每份报告按以下十个槽位核对：

1. 固定基线与稳定条款/总账；
2. 索引“必须建立事实”；
3. 索引最小实验与副作用边界；
4. 复杂因果及放大条件；
5. production/外部消费者；
6. 根因集合；
7. 事实支持的形态与确定后果；
8. 未知、盲区与置信边界；
9. A 摘要 + B 附录双层结构；
10. 尾部收束结论。

判定：

- **覆盖**：索引问题在报告中有明确章节或矩阵，允许结论是“不存在”“未知”或“任务边界下未运行”，但必须说明证据边界。
- **半写**：问题有事实回答，但索引点名的最强实验路径未新执行，报告以较弱证据闭合并保留证明缺口。
- **缺项**：索引要求在报告中没有可定位内容。
- **冲突**：两报告对同一基线、同一对象、同一时点给出不能由边界差异解释的互斥事实。

### B2. 14/14 覆盖矩阵

| R7 | 稳定条款/总账 | 必须事实 → 报告章节 | 实验边界 → 报告章节 | 因果/消费者/根因 | 形态/未知/双层/尾结论 | 核算 |
|---|---|---|---|---|---|---|
| 01 Finding authority | D1、P-D1-2；`D-01,D-05,A-01,A-02,T-01,T-02` → 题注、B1 | compile/load 全入口、warning success/error/cache/reload、doctor/status分类、异步拆分 → B1-B4 | warning preset走 compile、isolated daemon status、doctor → B5 | cache归属、callback/event durability、全部消费者 → A2、B2-B4 | B6形态、A3/B7未知、A/B结构、独立尾结论 | 覆盖 |
| 02 Cache coherence | §2.3、D1、D10；`D-02,D-22,A-03,T-02,J-07` → 题注、B1 | key/创建/命中/失效、并发promise、edit/materialize/create/resume/restart读面 → B2-B6 | H1/H2、失败修复、并发冷请求、daemon重建 → B7 | root/amplifier、consumer图、resolver生命周期 → B4-B5、B8 | B10形态、A3/B9未知、A/B、B12尾结论 | 覆盖 |
| 03 Materialize transaction | D1、§2.3、D10；`D-03,A-03,T-02` → 题注、B1 | 全文件副作用、异常目录、旧版可达、并发发布、下次load/cleanup → B2-B7 | syntax/missing/concurrency/marker损坏目录快照 → B7 | 发布点/marker/prune/绝对路径/无锁根因与消费者 → A2、B4-B6 | B9形态、A3/B8未知、A/B、B11尾结论 | 覆盖 |
| 04 External schema chain | P-D1-1、P-D2-4；`D-04,U-01,A-02,J-01,T-01` → 题注 | owner/连接、instance/source/private shape、版本/cache/failure、typed binding producer → B1-B7 | installed CLI、已知外仓/包只读核验 → B2-B5 | instance≠schema、code≠app、owner未落地、外部消费者矩阵 → A2、B3-B8 | B9形态、A3/B10未知、A/B、尾结论 | 覆盖 |
| 05 Binding type authority | §2 C/E/F、P-D2-1/4/5/6/7、P-D6-3；账项 → B1 | bundled/fixture值域、结构深度/nullable、跨phase冲突、projection consumer、agent result → B2-B8 | isolated compile/render结构值 probe → B9 | 类型证据丢失、consumer无法得出事实、doc/result边界、根因 → A2、B2/B6-B8 | B11形态、A3/B10未知、A/B、B13尾结论 | 覆盖 |
| 06 Binding admission | §2 D/§2.3、P-D2-2/3；账项 → B1 | create/add/batch/update入口、最早决定、原子性、副作用、history/recovery、render error/retry → B2-B10 | isolated loop-data的各入口与spawn错值登记 → B14 | 两套缺值语义、spawn时间线、root/amplifier → A3、B7-B13 | B13形态、A6/B11未知、A/B、尾结论 | 覆盖 |
| 07 Compiled tree model | P-D3-1/2/3/4/5/7/8、§2.4；账项 → B1 | phase consumers、identity生成/引用/冲突、validation/finding次序、linear兼容、外部数组假设 → B2-B10 | nested declaration boundary probe → B9 | 双读面、identity/root/amplifier/consumer → A3、B3-B12 | B13形态、A4/B11未知、A/B、尾结论 | 覆盖 |
| 08 Runtime transition | P-D3-1/3/4/6/8/9、§2.4/2.5；账项 → 题注 | production constructor图、推进权威、cursor/closure/run事务、failure/kill/restart、par pin/resource → B1-B10 | 19个SQLite/tree tests；未新跑worktree stub-runner，明确证明边界 → B11 | close多事务、局部exactly-once、recovery、全部runtime消费者 → A1-A2、B2-B10 | B13形态、A3/B12未知、A/B、尾结论 | **半写实验；事实覆盖** |
| 09 Tool capability | §2 G/H、P-D4-1…5；账项 → 题注 | tool硬编码/doctor调用、runner边界、C6 API/event/persistence、run/tool identity、failure/recovery → B1-B7 | local doctor probe + known external owner只读核验 → B3/B6 | declaration→projection→doctor/runner/outcome/finalize链与tool/gate分离 → A1-A2、B1-B8 | B10形态、A3/B9未知、A/B、尾结论 | 覆盖 |
| 10 Gate handshake | P-D5-1…4、§2.4；账项 → 题注、B10 | 八点调用位置/host、identity时点、四层binding、unsupported/missing/script failure/recovery → B2-B5 | isolated daemon marker/effective view；scheduling由既有integration互证 → B6-B7 | carrier→view调用图、host矩阵、error/recovery矩阵、接缝 → B3-B8 | B9形态、B5/B7未知、A/B、结论 | 覆盖 |
| 11 Definition pin | D10 P-D10-1…6；账项 → 题注、B1 | pre-run字段全集、全consumer source、ref事务、H1/H2、missing/corrupt/GC、external owner → B2-B7 | 未新跑完整worktree/runner timeline；复用R7-02/03实验并给静态timeline → B5/B10 | create→run-start→resume/restart、ref attribution、materialized/row分离 → A2、B3-B6 | B9形态、A3/B7-B8未知、A/B、B10末尾尾结论 | **半写实验；事实覆盖** |
| 12 GitHub notation | P-D7-1/3/4、§2 H；账项 → B1 | 全CLI/wire/preset/docs/migration入口、opaque转换、调用者、外部脚本、失败语义 → B2-B7 | isolated parse/request覆盖opaque/non-GitHub/legacy → B8 | 四套转换/兼容层、consumer依赖与同错 → A2、B2-B9 | B10形态、A3/B9未知、A/B、B12尾结论 | 覆盖 |
| 13 Repository authority | P-D7-2、§2.5；账项 → 题注、B1 | 列/metadata读写、存量null/冲突/非GitHub、migration/version、closure资源、external identity → B2-B10 | isolated DB三形态 + closure/run/reopen + 列变更 → B4-B5 | 双权威、worktree/recovery、migration/crash、root/boundary → A2-A3、B3-B12 | B13形态、A4/B10-B11未知、A/B、尾结论 | 覆盖 |
| 14 Chain fallback | D9 P-D9-1…3、D10接缝；账项 → 题注、B1 | null/non-null组合、全resolver、存量分布、无item字段、external boundary/error → B2-B11 | isolated DB/status/recovery/chain-complete前置与direct resolver probes → B6/B8-B10 | 多resolver fallback、empty chain、restart/definition接缝、root/amplifier → A2-A3、B4-B7/B12-B13 | B14形态、A4/B9-B10未知、A/B、尾结论 | 覆盖 |

**矩阵结果：14/14 报告覆盖；未映射索引项 = 0。**

### B3. 缺项、半写与格式核对

#### B3.1 缺项

没有索引级缺项。每个索引项的“稳定条款、必须事实、实验边界、独立边界”都能定位到报告正文。

#### B3.2 半写

| 报告 | 索引期待的最强路径 | 实际报告证据 | 未冒充的证明缺口 | gate影响 |
|---|---|---|---|---|
| R7-08 | isolated daemon + stub runner + git fixture覆盖 success/failure/kill/restart/SQLite/events/resources | production调用图、事务时间线、19项store tests、既有integration源码/清单 | 本轮未新跑真实process crash与worktree路径 | 不造成事实槽位缺失；R8必须保留runtime全链证明缺口 |
| R7-11 | create→spawn→edit→resume→kill/restart完整H1/H2 | R7-02/03隔离结果 + resolver/SQL/static H1/H2 timeline | 本轮未创建worktree、未spawn runner、未跑全时间线 | 不造成consumer/ref事实缺失；不可把时间线升级为新E2E |

两份报告都明确记录未执行原因、替代证据与不能证明的内容，因此没有证据虚报。

#### B3.3 双层结构与尾结论

- 14/14 均有 A 摘要与 B 附录。
- 13/14 有独立“尾结论/结论”标题。
- R7-11 在 B10 最后一段以 `R7-11尾部结论` 加粗收束，语义完整但标题层级不统一；不影响覆盖计数。
- 14/14 摘要均承担问题、结论、因果/影响、资产/未知或 readiness；未发现摘要把附录尚未支持的结论写成既定事实。

### B4. 前置依赖是否实际消费

| 依赖 | 下游实际使用 | 定位 | 判定 |
|---|---|---|---|
| R7-07 → R7-08 | 退化 linear compiled tree、phase→leaf identity、无recursive constructor输入；据此区分“compiled identity关联”与“runtime tree实例化” | R7-08 A1、B1-B3、B14 | 已消费，不是仅引用 |
| R7-07 → R7-10 | compiled point/host没有identity payload；container variant与compiled tree缺口相邻 | R7-10 B4、B9-B10 | 间接消费，经R7-08收束 |
| R7-07 → R7-11 | pre-run compiled字段全集、projection丢失内容、phase identity packet | R7-11 B2、B4、B10 | 已消费 |
| R7-08 → R7-10 | identity在run-start才持久、close无唯一commit、container无scheduler authority；用于八点host矩阵 | R7-10 A、B4-B5、B8-B10 | 已消费，不是仅引用 |
| R7-08 → R7-11 | run-start局部原子事务、dynamic root/leaf/closure、ref只作attribution、restart后behavior另读current | R7-11 A1-A2、B3-B5、B10 | 已消费 |
| R7-02/03 → R7-11 | path-only promise cache时间线；materialize publish/prune/corrupt行为 | R7-11 A1、B5-B6、B10 | 已消费，并明确没有替代definition pin |
| R7-04 → R7-14 | installed producer/known owners/typed boundary不存在性边界；保留未checkout/未来owner未知 | R7-14 题注、A2/A4、B10、B15 | 已消费 |
| R7-13 → R7-14 | typed-chain owner仍未知、repository不是future identity、持久态/closure边界 | R7-14 题注、A2/A4、B7/B10、B15 | 已消费 |

强制核对的四组依赖全部满足。报告没有用上游结论替代自己的索引事实：R7-08仍独立枚举runtime调用图，R7-10仍独立枚举八点与四层binding，R7-11仍独立枚举definition consumer/ref生命周期，R7-14仍独立枚举全部resolver/null组合。

### B5. 报告间冲突核对

#### B5.1 无不可解释冲突

| 表面张力 | 报告 | 可解释边界 |
|---|---|---|
| `CompileResult`是权威 vs 系统无单一finding权威 | R7-01 | 前者是单次compile ADT/CLI，后者是loadPreset、daemon callback、status/doctor跨消费者 |
| daemon同进程H1冻结 vs restart后旧实例H2 | R7-02、R7-11 | path-only success promise只在进程寿命内；definition ref不解析内容 |
| content hash/rename是真实资产 vs materialize不可回滚 | R7-03、R7-11 | identity/hash正确不等于compile verdict前发布或ref-aware retention |
| public projection instance存在 vs schema artifact不存在 | R7-04、R7-05 | instance、runtime boundary、可分发schema是三个对象 |
| chain binding开放/缺类型权威 vs new item preset XOR admission | R7-05/R7-06、R7-14 | binding value schema与preset locator admission是不同字段和边界 |
| compiled tree只有退化phase seq vs runtime有seq/par/join ADT/SQL | R7-07、R7-08 | compiled producer与runtime fixture/store资产不同；production无递归constructor |
| runtime leaf/closure identity存在 vs gate没有host identity | R7-08、R7-10 | identity可在run-start后存在，但gate declaration/point没有ref或调用点 |
| tool/hook carrier存在 vs capability不存在 | R7-09、R7-10 | carrier/projection与executor/enforcement/handshake不同；tool与gate又是不同模型 |
| opaque item id已存在 vs GitHub记法未退役 | R7-12 | storage/wire主体与CLI/queue/batch/migration兼容入口不同 |
| repository列是权威 vs metadata binding覆盖prompt | R7-13 | 正是双读面：target/status/fingerprint与render消费不同来源 |
| status可读empty/no-source chain vs invalid preset load可失败 | R7-01、R7-14 | “完全无source的empty success”与“存在但load失败的source error”是不同输入 |
| known owners无consumer vs external system不存在 | R7-04、R7-09、R7-10、R7-13、R7-14 | 所有报告都把结论限定为已访问owner，并保留未checkout/未定owner未知 |

#### B5.2 术语边界已保持

以下对象没有被报告互相替代：

- compile finding authority ≠ daemon cache；
- cache coherence ≠ materialize file transaction ≠ execution definition pin；
- binding type authority ≠ instance admission；
- compiled recursive tree ≠ runtime scheduler transition；
- tool registry ≠ gate decision point；
- item GitHub notation ≠ repository resource identity ≠ chain preset fallback；
- hook declaration persistence ≠ gate execution；
- chain-complete preset trigger ≠ gate capability handshake；
- status admission gate ≠ script gate。

### B6. 未知核算

| 未知族 | 来源报告 | 已确定边界 | 仍未知内容 |
|---|---|---|---|
| finding产品语义 | 01 | 当前四种读面、时序/归属/保真差异 | doctor是否吸收、replay/durability语义 |
| definition时间与发布 | 02/03/11 | cache、file publish、ref attribution三套现状 | pin内容边界、artifact owner/介质、hold/rebind政策 |
| external schema/typed chain | 04/05/13/14 | 已访问owner无实存producer/consumer | 未checkout/未定owner、版本/兼容合同 |
| binding value/admission | 05/06 | 值域、丢类型点、所有写入口/错误时点 | ValueType裁决、missing/default/patch政策 |
| recursive runtime | 07/08 | compiled线性、runtime store资产、scheduler真实权威 | tree constructor、transition payload/replay、par semantics |
| tool/gate external capability | 09/10 | 仓内无闭环，已知外部owner无同identity消费 | 未知外部C6 executor、capability协议 |
| GitHub/chain migration | 12/13/14 | 每层入口、双权威、fallback组合 | compatibility期、冲突处置、typed boundary owner |

所有未知都能追溯到索引原有未知或调查后真实证据空位；未发现报告凭“值得防御”新增系统需求。

### B7. 提前裁决、方案与规模审计

#### B7.1 裁决

- 报告会判定“当前符合/部分符合/不符合/无供给”，这是对稳定条款的事实核对，不是选择未来设计。
- P-D1-2、artifact载体、ValueType、admission时点、transition commit、tool/gate enforcement、migration/fallback政策等需要R8选择的问题均保持 pending。
- 没有报告修改稳定条款、提高威胁/信任/规模假设或把测试纪律编译成新产品机制。

#### B7.2 事实支持形态

R7-01/02/03/04/05/06/07/08/09/10/11/12/13/14 均列出事实支持的形态或候选边界。审计结果：

- 均标明“不推荐/不排序/非完备/不裁决”之一；
- 没有选择 winner；
- 没有给出实施步骤、文件改动清单或交付顺序；
- 形态后果均回指报告建立的当前消费者、身份、时序或失败事实。

因此这些段落属于 R8 输入形态，不构成提前实施方案。

#### B7.3 规模

14 份报告没有人日、工期、story point、文件数或实现复杂度估算。复杂度描述只用于解释因果链和跨层消费者，不是规模承诺。

### B8. R8-ready 分组建议（只按共享裁决问题聚类）

以下只把共享裁决问题放入同一档案准备组；不列选项、不指定实现 owner或顺序。

| 组 | 共享裁决问题 | R7输入 | 必须保持的独立边界 |
|---|---|---|---|
| G1 Compile result与公共合同 | finding权威、公共projection/schema、binding类型证据如何形成一致可消费合同 | 01、04、05 | cache时间语义与external owner未知不能被projection shape吞并 |
| G2 Definition版本生命周期 | source/cache、materialize发布、execution definition pin/restart的版本权威 | 02、03、11 | file transaction、process cache、instance resolver分别裁决 |
| G3 Binding实例准入 | source type authority与create/update/render错误时点 | 05、06 | 类型语言与事务/admission不可合并成一个“加校验”问题 |
| G4 Recursive execution语义 | compiled tree identity、runtime constructor、scheduler authority、transition/recovery | 07、08 | definition model先于runtime消费；store资产不等于scheduler供给 |
| G5 Capability合同 | tool registry/outcome identity与gate host/binding/handshake | 09、10 | tool与gate必须保留两种模型和判定点 |
| G6 Engine去GitHub化 | item notation、repository持久权威、chain declaration/fallback | 12、13、14 | 标识符入口、资源身份、定义选择三域分别保留 |
| G7 Cross-system owner与version | schema、definition、tool/gate、typed chain的外部producer/consumer边界 | 04、09、10、11、13、14 | “已知owner无实现”不能升级为“全系统不存在” |

R8 分组只减少重复裁决上下文；每个组内仍须保留报告已经证明的不同失败判定点。

### B9. 每个 R7 索引项的章节映射清单

以下是“未映射=0”复核用的简表：

1. **R7-01**：索引事实/消费者/生命周期→B1-B4；实验→B5；形态/盲区/结论→B6-B8/尾结论。
2. **R7-02**：cache全集→B2；materialize边界→B3；消费者/resolver→B4-B6；H1/H2→B7；根因/测试/形态→B8-B10；尾结论→B12。
3. **R7-03**：副作用/异常/并发→B2-B4；消费者/恢复→B5-B6；注入实验→B7；测试/形态→B8-B9；尾结论→B11。
4. **R7-04**：producer/artifact→B1-B2；owners/连接→B3-B5；version/failure→B6-B7；root/形态/未知→B8-B10；尾结论。
5. **R7-05**：type authority/value→B2-B5；projection/agent/doc consumers→B6-B8；probe→B9；tests/形态→B10-B11；尾结论→B13。
6. **R7-06**：入口/时点/事务→B2-B8；recovery/error→B9-B10；tests/root/shape→B11-B13；实验→B14；尾结论。
7. **R7-07**：declaration/normalization/readers→B2-B4；identity/validation/projection/linear→B5-B8；probe/external/tests/root/shape→B9-B13；尾结论。
8. **R7-08**：调用图/authority/store/cursor→B1-B4；事务/close/exactly-once/scenario/recovery/resources→B5-B10；实验/tests/shape→B11-B13；尾结论。
9. **R7-09**：declaration/hardcode/doctor/runner→B1-B4；API/external/outcome/recovery→B5-B7；gate分离/tests/shape→B8-B10；尾结论。
10. **R7-10**：carrier/effective view→B2-B3；point/host→B4；capability/error/recovery→B5；experiment/tests→B6-B7；call graph/shape/ledger→B8-B10；结论。
11. **R7-11**：条款→B1；pre-run全集→B2；consumer/ref→B3-B4；timeline/corrupt/owner→B5-B7；tests/shape/evidence→B8-B10；B10末尾尾结论。
12. **R7-12**：CLI/wire/转换→B2-B4；preset/docs/external/migration→B5-B7；experiment/tests/shape→B8-B10；尾结论→B12。
13. **R7-13**：schema/write/read→B2-B3；DB/closure/worktree/recovery→B4-B7；migration/crash/external/tests/root/shape→B8-B13；尾结论。
14. **R7-14**：persist/create/resolvers/combinations→B2-B5；empty-chain/recovery→B6-B7；experiment/population/external/consumers→B8-B11；tests/root/shape→B12-B14；尾结论。

映射复核结果：**14 项全部非空；0 项无章节映射。**

## 尾结论

R7 十四份报告全部收件并覆盖任务索引：14/14 有固定基线、稳定条款、必须事实、边界证据、因果/消费者/根因、事实支持形态、未知、A/B双层结构和收束结论；索引未映射项为0。R7-08与R7-11各保留一条未新跑最强runtime路径的证明缺口，但都明确限定替代证据，未虚报完成。R7-07→08、R7-08→10/11、R7-04+13→14均有事实级消费。报告间表面张力可由层、时点或身份域解释，未发现不可解释冲突，也未发现提前裁决、实施方案、顺序或规模估算。R8可按共享裁决问题分为七组，同时保持各报告已经建立的独立失败判定点与外部未知。

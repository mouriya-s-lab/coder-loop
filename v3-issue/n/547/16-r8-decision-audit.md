# RFC #547 — R8 七档案完整性与“真裁决”审计

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 只读输入：`15-r8-g1-*.md` 至 `15-r8-g7-*.md`、`14-r7-coverage-audit.md`、`AGGREGATE-547.md` 稳定条款。  
> 本报告只审计档案完整性和问题资格，生成下一步简洁 ballot 的真分叉清单；不填答案、不推荐、不裁决、不设计实现、不估算规模。

## A. 摘要（≤1页）

七份R8档案均完整说明了问题来源、稳定要求、当前事实、复杂因果、事实支持形态、确定后果、触点和未知，且都保持A摘要+B完整档案+尾结论结构。它们忠实吸收了R7覆盖摘要的七组边界：G1 compile contract、G2 definition lifecycle、G3 binding admission、G4 recursive execution、G5 capability contract、G6 engine de-GitHub、G7 cross-system owner。档案之间没有无法解释的事实矛盾。

“完整”不表示原列问题都应进入操作员ballot。按最细可独立回答的问句核算，共有 **108个原子问题**：G1 10、G2 18、G3 27、G4 10、G5 20、G6 11、G7 12。逐问分类后：

- **(a) 稳定RFC已定**：schema artifact与projection instance区分、source type唯一权威、canonical recursive tree唯一权威、创建成功前pin、全consumer同ref、missing/corrupt不得回退current、D4本仓/外树份额、D5 unsupported handshake、引擎原生机制不进DSL等，不得重新投票。
- **(b) 真操作员分叉**：经跨档案合并后得到 **44个真分叉**，覆盖finding、schema/typing、binding admission、definition/file/cache、recursive runtime、tool/gate、de-GitHub与owner边界。
- **(c) 证明/外部未知**：未checkout owner、真实C6/gate executor、FS fault injection、真实process crash/par路径、存量统计等应保留调查停点；它们不是产品形态选项。
- **(d) 重复可合并**：G1↔G3的binding合同、G2↔G7的definition owner、G4↔G2的chain definition、G5↔G7的tool/gate owner、G6↔G7的repository/chain boundary大量重复，统一映射到同一真分叉ID。

全部108问均有“原问题→分类→合并ID/停点”映射，**未映射=0**。复合问题中若一半已由稳定条款决定、另一半仍有工程分叉，映射明确拆开；不会因为句子含问号就把已定合同重新开放，也不会因外部owner未知阻塞本仓已明确份额。

交叉审计发现的主要“伪分叉”是：G1-Q5重新询问schema定义、G2-Q3重新询问pin是否在create成功前、G4-Q2重新询问canonical authority、G4-Q6重新询问runtime readiness是否为推进权威、G4-Q10把补跑证明与产品guard混写、G5若干问题把D4/D5固定轴再次问成开放语义、G7-Q5重新询问D4已定本仓/外树份额。审计保留其中尚未固定的identity、错误投影、migration或owner接缝，但从ballot删除已定部分。

**审计结论：7/7档案完整，108/108原子问题映射，真分叉44，未映射0；下一步ballot只应询问TF-01…TF-44，调查停点另列，不得由档案自身扩写需求。**

## B. 完整审计

### B1. 分类口径

| 分类 | 含义 | 下一步处置 |
|---|---|---|
| (a) 稳定RFC已定 | AGGREGATE已有明确要求、禁止项或唯一权威，不存在重新选择空间 | 从ballot删除；作为选项合法性约束 |
| (b) 真操作员分叉 | 真实系统事实支持两个以上会改变合同/迁移/失败语义的方向，且稳定条款未决定 | 进入简洁ballot |
| (c) 证明/外部未知 | 缺少运行证明、owner/API/存量事实或外部实现；调查结果才可能形成后续问题 | 记录调查停点，不作为产品选项 |
| (d) 重复可合并 | 已被同组或跨组另一问覆盖，分别投票会产生矛盾答案 | 映射到同一TF ID |

复合问题允许多分类，例如“(a)固定主张；(b/d)剩余工程分叉→TF-xx”。这不是漏判，而是防止一个句子把稳定合同和实现接缝捆绑重开。

### B2. 七档案完整性覆盖

| 档案 | 来源/稳定要求 | 当前事实/因果 | 形态/后果/触点 | 未知/证明边界 | 问题质量 | 结论 |
|---|---|---|---|---|---|---|
| G1 Compile contract | D1/D2、R7-01/04/05 | finding多读面、instance≠schema、type evidence丢失 | finding/schema/ValueType形态完整 | owner与agent result未知分开 | 10问完整；Q5含已定口径，Q8-10与G3重复 | 通过 |
| G2 Definition lifecycle | D1/D10、R7-02/03/11 | file/cache/resolver三因果时间线 | 三裁决点、file/cache/content形态完整 | runtime/FS/external proof明确不是决定 | 18问完整；Q3/Q18含已定部分 | 通过 |
| G3 Binding admission | D2、R7-05/06 | type authority与实例事务时间线 | 九轴逐项后果/触点 | 存量/owner停点明确 | 27原子问；与G1重叠但更细 | 通过 |
| G4 Recursive execution | D3/§2.4/2.5、R7-07/08 | compiled退化、runtime store骨架、close多事务 | definition/runtime/guard形态完整 | R7-08证明缺口单列 | 10问；Q2/Q6/Q10混入已定/证明部分 | 通过 |
| G5 Capability contract | D4/D5、R7-09/10 | tool与gate两模型、两identity链、两判定点 | tool六形态、gate十轴及禁止替代 | known owner无链与unknown owner分开 | 20问；固定D4/D5与工程接缝可拆 | 通过 |
| G6 Engine de-GitHub | D7/D9/D10、R7-12/13/14 | item/repository/chain三域时间线 | migration/compat/owner触点完整 | repo外consumer未知明确 | 11问；Q1/Q2可合并，Q10含owner未知 | 通过 |
| G7 Cross-system owner | 跨树S/C合同、R7外部调查 | owner证据分层、五类跨系统边界 | owner形态/调查规则完整 | B11明确停点 | 12问；多数是G1/G2/G5/G6重复或调查治理 | 通过 |

完整性结果：**7/7通过**。问题资格修剪不降低档案事实完整性。

### B3. 真分叉ID总表

| ID | 真分叉主题 | 合并来源 |
|---|---|---|
| TF-01 | Finding规范权威与rejected warning集合 | G1-Q1/Q3 |
| TF-02 | Doctor definition健康的时间面与职责 | G1-Q2 |
| TF-03 | Finding identity、归属、replay与durability | G1-Q4、G2-Q14 |
| TF-04 | Schema规范producer、分发面与首个consumer责任 | G1-Q6、G7-Q1/Q2 |
| TF-05 | Projection/schema/typed bindings公共合同面数量 | G1-Q7、G3-Q5a |
| TF-06 | Source type authority与use-site expectation边界 | G1-Q8、G3-Q1a/Q1b |
| TF-07 | ValueType首批封闭ADT与opaque JSON处置 | G1-Q8、G3-Q2a/Q2b、Q5a |
| TF-08 | Missing/null/required/default语义与归属 | G1-Q9、G3-Q3a/Q3b |
| TF-09 | 结构/标量prompt projection与typed render error | G1-Q9、G3-Q4a-c |
| TF-10 | Agent-owned typed result对象、owner与失败状态 | G1-Q10、G3-Q5b |
| TF-11 | Typed admission的domain边界与最早决定时点 | G3-Q6a/Q6c |
| TF-12 | Update patch与merge后完整对象合法性 | G3-Q6b |
| TF-13 | Batch原子性、definition读取与旁路refinement | G3-Q7a-c |
| TF-14 | Binding存量违规数据migration政策 | G3-Q8a/Q8b |
| TF-15 | 静态/动态preflight、错误落点、retry与副作用回滚 | G3-Q3c、Q9a-c |
| TF-16 | Preset definition创建前字段闭集 | G2-Q1、G7-Q3/Q4 |
| TF-17 | Chain definition字段闭集与owner | G2-Q2、G3-Q6c、G7-Q3/Q9 |
| TF-18 | Definition pin/create事务接缝与orphan | G2-Q3/Q16 |
| TF-19 | Current-source/instance读面与preset/chain ref关系 | G2-Q4/Q5 |
| TF-20 | 无内容历史实例的definition migration政策 | G2-Q6 |
| TF-21 | Artifact publish verdict、snapshot与integrity | G2-Q7/Q8/Q11 |
| TF-22 | Artifact publish/retire、retention与并发所有权 | G2-Q9/Q10 |
| TF-23 | Process cache职责、identity、寿命与失效 | G2-Q12/Q13 |
| TF-24 | Definition content形态、统一resolver与missing/corrupt外显 | G2-Q15/Q17/Q18、G7-Q4 |
| TF-25 | Recursive DSL语法、linear compatibility与projection迁移 | G4-Q1/Q4 |
| TF-26 | Recursive node identity作用域与引用错误分类 | G4-Q3 |
| TF-27 | Runtime tree constructor时点、事务与失败可见性 | G4-Q5 |
| TF-28 | Scheduler authority迁移及旧phase/status/run事实角色 | G4-Q6 |
| TF-29 | Typed transition commit payload与多事实关联 | G4-Q7、G5-Q14 |
| TF-30 | Transition recovery、replay/retry/hold与外部副作用dedupe | G4-Q8 |
| TF-31 | Par concurrency/reopen参数、guard与原生机制证明接缝 | G4-Q9/Q10 |
| TF-32 | Tool identity、provider边界与entry-existence作用域 | G5-Q1/Q2/Q3 |
| TF-33 | Expected语义与required finalize判定 | G5-Q4/Q5 |
| TF-34 | Registry公共形状、doctor availability与prompt doc | G5-Q6/Q7/Q8 |
| TF-35 | C6 identity handshake、outcome persistence/finalize/recovery | G5-Q9/Q10、G7-Q5 |
| TF-36 | Gate declaration identity、point/host闭集与pre-spawn时点 | G5-Q11/Q12/Q13、G7-Q7 |
| TF-37 | Optional语义与global/chain/item binding resolution | G5-Q15/Q17 |
| TF-38 | Gate capability advertisement/version与unsupported边界 | G5-Q16、G7-Q7 |
| TF-39 | Gate executor、decision persistence/recovery与读面 | G5-Q18/Q19/Q20 |
| TF-40 | De-GitHub breaking发布、clean rename与runtime/history兼容边界 | G6-Q1/Q2/Q3 |
| TF-41 | Repository单一权威、target selector与typed producer前置关系 | G6-Q4、G7-Q10 |
| TF-42 | Repository存量冲突政策与closure/resource migration不变量 | G6-Q5/Q6 |
| TF-43 | Chain omitted/null/legacy/both-set/empty/mixed语义 | G6-Q7/Q8/Q9、G7-Q11 |
| TF-44 | Engine清零gate ownership scope与历史migration窄豁免 | G6-Q11 |

真分叉总数：**44**。

### B4. G1原问题映射（10/10）

| 原问题 | 分类 | 合并ID/停点 | 审计说明 |
|---|---|---|---|
| G1-Q1 Finding权威 | (b) | TF-01 | CompileResult与另一个明确validation权威是真分叉 |
| G1-Q2 Doctor时间面 | (b) | TF-02 | current/cache/history/runtime-only会改变对外语义 |
| G1-Q3 Rejected集合 | (d) | TF-01 | 与Q1同一规范集合边界 |
| G1-Q4 Finding归属/durability | (b) | TF-03 | identity/replay/durability未被稳定条款决定 |
| G1-Q5 Schema合同定义 | (a) | — | P-D1-1已定：schema是可分发artifact，instance/boundary不得冒充 |
| G1-Q6 Producer/首consumer | (b)+(c) | TF-04；STOP-01 | producer责任是真分叉；未定consumer身份先调查 |
| G1-Q7 公共面数量 | (b) | TF-05 | schema/projection/bindings边界未定 |
| G1-Q8 类型权威/ValueType | (a)+(d) | TF-06、TF-07 | source schema唯一权威已定；variant闭集与expectation接缝仍待裁 |
| G1-Q9 Missing/nullable/projection | (d) | TF-08、TF-09 | 由G3细分 |
| G1-Q10 Agent-owned数据边 | (a)+(d) | TF-10 | typed result与agent owner已为D2稳定方向；具体对象/失败接缝待裁 |

### B5. G2原问题映射（18/18）

| 原问题 | 分类 | 合并ID/停点 | 审计说明 |
|---|---|---|---|
| G2-Q1 Preset定义闭集 | (b) | TF-16 | P-D10-1要求列闭集但未给具体集合 |
| G2-Q2 Chain定义闭集 | (b) | TF-17 | chain字段归属是真分叉 |
| G2-Q3 Pin完成时点 | (a)+(b) | TF-18 | “创建成功前”已定；具体事务接缝仍待裁 |
| G2-Q4 读面命名 | (b) | TF-19 | current与instance必须分开已定，具体API外显待裁 |
| G2-Q5 两类ref关系 | (b) | TF-19 | preset/chain consumer ownership未定 |
| G2-Q6 历史实例口径 | (b) | TF-20 | migration/不可运行语义是真分叉 |
| G2-Q7 Publish verdict | (b) | TF-21 | file transaction独立分叉 |
| G2-Q8 Snapshot一致性 | (b) | TF-21 | hash/copy/compile同一bytes边界未定 |
| G2-Q9 Publish/retire | (b) | TF-22 | retention依据未定 |
| G2-Q10 并发所有权 | (b) | TF-22 | 与retention同一file lifecycle ballot |
| G2-Q11 Artifact完整性 | (b) | TF-21 | marker/verdict/损坏语义未定 |
| G2-Q12 Cache职责/identity | (b) | TF-23 | source cache与definition cache边界未定 |
| G2-Q13 Cache寿命 | (b) | TF-23 | success/failure/restart语义未定 |
| G2-Q14 Findings一致性 | (d) | TF-03 | 与G1 finding identity/replay合并 |
| G2-Q15 Definition内容形态 | (b) | TF-24 | content carrier未定 |
| G2-Q16 Create事务接缝 | (d) | TF-18 | 与Q3合并 |
| G2-Q17 全consumer resolver | (a)+(d) | TF-24 | “全consumer同ref”已定；resolver外显未定 |
| G2-Q18 Missing/corrupt外显 | (a)+(d) | TF-24 | hold/error且不fallback已定；状态/恢复入口未定 |

### B6. G3原问题映射（27/27）

| 原问题 | 分类 | 合并ID/停点 |
|---|---|---|
| G3-Q1a source catalog还是use-site expectation | (b) | TF-06 |
| G3-Q1b expectation是约束还是解释权 | (a)+(b) | TF-06；source解释权唯一已定 |
| G3-Q1c authority固定、载体后定 | (a)+(c) | STOP-02；不把载体缺证据变产品票 |
| G3-Q2a 首批ValueType variants | (b) | TF-07 |
| G3-Q2b `json`退役/recursive/opaque | (b) | TF-07 |
| G3-Q2c 信息不足时opaque预留 | (a)+(c) | STOP-03；§2.4禁止空预留variant |
| G3-Q3a null与missing关系 | (b) | TF-08 |
| G3-Q3b required/default归属 | (b) | TF-08 |
| G3-Q3c runtime pending vs static missing errors | (b) | TF-15 |
| G3-Q4a structure prompt projection | (b) | TF-09 |
| G3-Q4b number/boolean文本兼容 | (b) | TF-09 |
| G3-Q4c render error字段 | (b) | TF-09 |
| G3-Q5a public JSON内嵌还是catalog+ref | (b) | TF-05、TF-07 |
| G3-Q5b 提前公开owner variants | (d) | TF-10 |
| G3-Q5c external未知时关闭字段 | (c) | STOP-04 |
| G3-Q6a admission boundary | (b) | TF-11 |
| G3-Q6b update patch/merged object | (b) | TF-12 |
| G3-Q6c chain owner未知是否blocked | (b)+(d) | TF-11、TF-17 |
| G3-Q7a batch全拒绝 | (b) | TF-13 |
| G3-Q7b parse与DB transaction关系 | (b) | TF-13、TF-18 |
| G3-Q7c bypass refined/unsafe migration | (b) | TF-13 |
| G3-Q8a 违规存量政策 | (b) | TF-14 |
| G3-Q8b 无损转换集合 | (b) | TF-14 |
| G3-Q8c 无统计先盘点 | (c) | STOP-05 |
| G3-Q9a 静态/动态preflight | (b) | TF-15 |
| G3-Q9b deterministic错误落点/retry | (b) | TF-15 |
| G3-Q9c 动态失败副作用/rollback | (b) | TF-15 |

### B7. G4原问题映射（10/10）

| 原问题 | 分类 | 合并ID/停点 | 审计说明 |
|---|---|---|---|
| G4-Q1 声明入口/linear过渡 | (b) | TF-25 | 语法与compat view未定 |
| G4-Q2 Canonical authority | (a)+(d) | TF-25 | normalized recursive tree唯一权威已定；双读面迁移仍待裁 |
| G4-Q3 Identity | (b) | TF-26 | explicit id scope/move/error分类未定 |
| G4-Q4 Projection兼容 | (b) | TF-25 | schemaVersion迁移分叉 |
| G4-Q5 Runtime constructor | (b) | TF-27 | 时点/事务/失败可见性未定 |
| G4-Q6 Scheduler authority | (a)+(b) | TF-28 | runtime readiness权威已定；旧事实过渡角色未定 |
| G4-Q7 Transition commit | (b) | TF-29 | payload/关联未定 |
| G4-Q8 Recovery/另查 | (b)+(c) | TF-30；STOP-06 | recovery语义是真分叉；fault injection是证明停点 |
| G4-Q9 Par与原生机制 | (a)+(b) | TF-31 | base/branch/pin/seq/cleanup不进DSL已定；concurrency/reopen与证明接缝待裁 |
| G4-Q10 Guard与补跑证明 | (a)+(b)+(c) | TF-31；STOP-07 | unsupported guard已定；status/event位置待裁；补跑不是产品票 |

### B8. G5原问题映射（20/20）

| 原问题 | 分类 | 合并ID/停点 |
|---|---|---|
| G5-Q1 Tool identity | (b) | TF-32 |
| G5-Q2 Provider boundary | (a)+(b) | TF-32；四轴正交已定 |
| G5-Q3 Entry-existence scope | (b) | TF-32 |
| G5-Q4 Expected语义 | (b) | TF-33 |
| G5-Q5 Required finalize | (a)+(b) | TF-33；required需outcome已定 |
| G5-Q6 Registry公共形状 | (a)+(b) | TF-34；四轴与projection真实化已定 |
| G5-Q7 Doctor availability | (a)+(b) | TF-34；声明驱动已定 |
| G5-Q8 Prompt文档 | (a)+(b) | TF-34；同表消费已定 |
| G5-Q9 C6合同 | (b)+(c) | TF-35；STOP-08 |
| G5-Q10 Outcome persistence/recovery | (b) | TF-35 |
| G5-Q11 Gate identity/required optional | (a)+(b) | TF-36、TF-37；具名required/optional已定 |
| G5-Q12 Point ADT闭集 | (a)+(b) | TF-36；稳定四点已定，现存额外点迁移待裁 |
| G5-Q13 Pre-spawn时点 | (b) | TF-36 |
| G5-Q14 Decision/transition | (d) | TF-29 |
| G5-Q15 Optional缺失 | (b) | TF-37 |
| G5-Q16 Capability handshake | (a)+(b) | TF-38；unsupported pre-schedule已定，advertisement/version未定 |
| G5-Q17 Binding resolution | (b) | TF-37 |
| G5-Q18 Executor合同 | (b)+(c) | TF-39；STOP-09 |
| G5-Q19 Decision persistence/recovery | (b) | TF-39 |
| G5-Q20 Gate读面 | (b) | TF-39 |

### B9. G6原问题映射（11/11）

| 原问题 | 分类 | 合并ID/停点 |
|---|---|---|
| G6-Q1 opaque id统一checkpoint | (b) | TF-40 |
| G6-Q2 clean rename发布边界 | (d) | TF-40 |
| G6-Q3 runtime legacy/history migration边界 | (b) | TF-40 |
| G6-Q4 repository退列后selector | (b) | TF-41 |
| G6-Q5 repository冲突政策 | (b) | TF-42 |
| G6-Q6 closure/worktree不变量 | (a)+(b) | TF-42；真实resource identity链已定，migration验收粒度未定 |
| G6-Q7 omitted/null操作语义 | (b) | TF-43 |
| G6-Q8 legacy null/both-set恢复 | (b) | TF-43 |
| G6-Q9 empty/mixed chain来源 | (b) | TF-43 |
| G6-Q10 external typed boundary owner/readiness | (b)+(c) | TF-17；STOP-10 |
| G6-Q11 清零ownership scope | (b) | TF-44 |

### B10. G7原问题映射（12/12）

| 原问题 | 分类 | 合并ID/停点 | 审计说明 |
|---|---|---|---|
| G7-Q1 Schema责任 | (d) | TF-04 | 与G1-Q6合并 |
| G7-Q2 首个schema consumer | (c)+(d) | TF-04；STOP-01 | owner未定先停，不猜载体 |
| G7-Q3 Definition owner | (d) | TF-16、TF-17、TF-24 | 与G2合并 |
| G7-Q4 Definition外部消费 | (c)+(d) | TF-24；STOP-11 | 外部字段未知不阻塞本仓pin |
| G7-Q5 Tool本仓/外树分界 | (a)+(d) | TF-35 | D4份额已定，只剩identity handshake |
| G7-Q6 C6调查停点 | (c) | STOP-08 | 纯调查治理，不是产品票 |
| G7-Q7 Gate本仓/外树分界 | (a)+(d) | TF-36、TF-38、TF-39 | D5声明/外部binding边界已定，owner接口未定 |
| G7-Q8 Gate executor停点 | (c)+(d) | TF-36；STOP-09 | point差异进TF-36，owner证据先停 |
| G7-Q9 Typed chain owner冲突 | (b)+(d) | TF-17 | S8/C2 owner是真分叉 |
| G7-Q10 Repository迁移 | (d) | TF-41、TF-42 | 与G6合并 |
| G7-Q11 Preset/empty-chain | (d) | TF-43 | 与G6合并 |
| G7-Q12 未知治理 | (c) | STOP-12 | 只制定调查停点，不形成产品形态 |

### B11. 原问题映射核算

| 档案 | 原子问题数 | 已映射 | 未映射 |
|---|---:|---:|---:|
| G1 | 10 | 10 | 0 |
| G2 | 18 | 18 | 0 |
| G3 | 27 | 27 | 0 |
| G4 | 10 | 10 | 0 |
| G5 | 20 | 20 | 0 |
| G6 | 11 | 11 | 0 |
| G7 | 12 | 12 | 0 |
| **合计** | **108** | **108** | **0** |

### B12. 下一步简洁ballot的真分叉清单

本节只给ballot题干，不给选项、默认值或答案。

#### Compile、schema与binding合同

1. **TF-01**：规范finding authority及rejected前warnings的集合边界是什么？
2. **TF-02**：doctor的definition健康读取哪个时间面，并与runtime health如何分工？
3. **TF-03**：findings采用什么identity/归属/replay/durability合同？
4. **TF-04**：schema规范producer与首个独立consumer责任归谁？
5. **TF-05**：projection、schema、typed bindings组成几个公共合同面？
6. **TF-06**：source type唯一权威与use-site expectation如何分界？
7. **TF-07**：首批ValueType封闭ADT包含什么，opaque JSON如何处置？
8. **TF-08**：missing/null/required/default如何区分并归属？
9. **TF-09**：结构/标量如何投影到prompt，typed render error包含什么？
10. **TF-10**：agent-owned typed result的对象、owner与失败状态是什么？
11. **TF-11**：typed admission在哪个domain boundary及最早决定时点发生？
12. **TF-12**：update以patch操作还是merge后完整对象为合法性判据？
13. **TF-13**：batch原子性、definition读取与旁路refinement合同是什么？
14. **TF-14**：违规存量binding如何migration？
15. **TF-15**：静态/动态preflight、错误落点、retry与副作用回滚如何分层？

#### Definition生命周期

16. **TF-16**：PresetDefinition包含哪些创建前字段？
17. **TF-17**：ChainDefinition包含哪些字段，owner是谁？
18. **TF-18**：definition publish/ref与create如何组成事务，orphan如何界定？
19. **TF-19**：current-source与instance读面及两类ref关系如何外显？
20. **TF-20**：无definition内容的历史实例采用什么migration语义？
21. **TF-21**：artifact publish verdict、bytes snapshot与integrity合同是什么？
22. **TF-22**：publish/retire、retention与并发所有权合同是什么？
23. **TF-23**：process cache缓存什么identity，寿命与失效如何定义？
24. **TF-24**：definition content、统一resolver及missing/corrupt状态如何表达？

#### Recursive execution

25. **TF-25**：recursive DSL语法、linear compatibility与projection迁移如何安排？
26. **TF-26**：node identity作用域、move/rename稳定性与引用错误如何定义？
27. **TF-27**：runtime constructor在哪个边界，以何事务和失败状态实例化？
28. **TF-28**：scheduler迁到runtime authority时旧phase/status/run事实扮演什么角色？
29. **TF-29**：typed transition commit携带什么，并如何关联status/run/closure/event/gate？
30. **TF-30**：crash后replay/retry/hold及外部副作用dedupe边界是什么？
31. **TF-31**：par concurrency/reopen、guard与引擎原生资源证明如何接缝？

#### Tool与Gate

32. **TF-32**：tool identity、provider边界与entry-existence作用域是什么？
33. **TF-33**：expected与required finalize的可观察语义是什么？
34. **TF-34**：registry、doctor availability与prompt doc的公共合同是什么？
35. **TF-35**：C6如何以同identity完成outcome persistence/finalize/recovery？
36. **TF-36**：gate declaration、point/host identity及pre-spawn时点如何定义？
37. **TF-37**：optional语义与global/chain/item binding resolution如何定义？
38. **TF-38**：gate capability如何advertise/version并在何边界unsupported？
39. **TF-39**：gate executor、decision persistence/recovery与读面合同是什么？

#### Engine去GitHub化

40. **TF-40**：breaking发布、clean rename与runtime/history兼容边界是什么？
41. **TF-41**：repository退列后的单一权威/selector及typed producer前置关系是什么？
42. **TF-42**：repository冲突migration与closure/resource不变量如何处理？
43. **TF-43**：omitted/null/legacy/both-set/empty/mixed chain语义是什么？
44. **TF-44**：engine清零gate采用什么ownership scope及历史migration窄豁免？

### B13. 调查停点清单

| 停点 | 调查对象 | 达到何种证据前保持未知 | 禁止误推 |
|---|---|---|---|
| STOP-01 | 首个独立schema consumer | owner、可运行producer identity、真实读取/失败路径 | 不因owner未定猜artifact载体 |
| STOP-02 | use-site expectation载体 | 真实跨phase冲突需求 | 不重开source authority唯一性 |
| STOP-03 | ValueType额外variants | 真实值域/consumer证据 | 不用opaque预留违反§2.4 |
| STOP-04 | external consumer字段需求 | 独立consumer读取字段清单 | 不阻塞本仓已定type真实性 |
| STOP-05 | binding存量 | 离线分布/历史definition证据 | 不由零样本选择normalize政策 |
| STOP-06 | transition crash | close步骤fault injection与side-effect证据 | 不把proof gap当recovery选项 |
| STOP-07 | real par/join/process路径 | constructor/scheduler存在后可运行全链 | 不以当前不可达路径生成新需求 |
| STOP-08 | C6 owner/API | compiled tool→run invocation→outcome→finalize/restart链 | issue登记/HAPI event不冒充合同 |
| STOP-09 | gate executor owner | binding→host decision→transition→restart链 | carrier/point字符串不冒充executor |
| STOP-10 | external typed chain producer | owner、artifact、parse/version/error路径 | 不因未知阻塞可独立的repository事实 |
| STOP-11 | GUI/hook definition消费 | owner实际读取projection/content/identity字段 | 不扩张本仓definition闭集 |
| STOP-12 | GUI、remote session、C6、hook owner治理 | 各自达到G7 B11的证据门槛 | unknown不改写不存在 |

调查停点不进入产品ballot；调查完成后若产生新的真实分叉，必须重新对照稳定问题清单，不能直接从证据空位生成需求。

### B14. G1-G7交叉重复与矛盾核对

#### B14.1 已合并的交叉重复

| 重复组 | 档案 | 合并结果 |
|---|---|---|
| Binding contract | G1 Q8-10、G3 Q1-5 | TF-06…TF-10 |
| Finding/cache | G1 Q4、G2 Q14 | TF-03 |
| Definition owner/content | G2 Q1-5/Q15-18、G7 Q3-4 | TF-16…TF-19、TF-24 |
| Chain definition | G2 Q2、G3 Q6c、G6 Q10、G7 Q9 | TF-17 |
| Transition/gate | G4 Q7、G5 Q14 | TF-29 |
| Tool外树 | G5 Q9-10、G7 Q5-6 | TF-35 + STOP-08 |
| Gate外树 | G5 Q11-20、G7 Q7-8 | TF-36…TF-39 + STOP-09 |
| Repository/chain | G6 Q4-10、G7 Q9-11 | TF-41…TF-43 |

#### B14.2 表面矛盾及解释

| 表面矛盾 | 审计结论 |
|---|---|
| G1询问schema含义，稳定P-D1-1已定义 | G1-Q5是(a)，删除；只保留producer/consumer/公共面分叉 |
| G2询问pin时点，P-D10-2已定create成功前 | 删除“是否create前”，只保留事务接缝TF-18 |
| G4询问canonical authority，D3已定normalized recursive tree | 删除authority选择，只保留compat/projection迁移TF-25 |
| G4询问scheduler authority，D3已定runtime readiness | 删除是否采用runtime authority，只保留旧事实过渡角色TF-28 |
| G5询问四轴/required/handshake基本语义，D4/D5已定 | 固定部分作约束，只保留identity、scope、error、persistence工程分叉 |
| G7询问D4本仓/外树分界，D4已定本仓声明、C6执法 | 删除owner份额重开，只保留同identity handshake TF-35 |
| G6要求外部typed chain owner，G7强调unknown不阻塞本仓 | 不矛盾：owner归属进TF-17，尚无owner证据进STOP-10；repository migration可独立裁 |
| G4 transition与G5 gate commit互相引用 | 不矛盾：TF-29定义transition commit，TF-36…39定义gate host/decision；gate不得成为第二transition权威 |

未发现同一稳定条款下不可调和的事实冲突。

### B15. 防止产物自身生成需求

下一步ballot必须遵守：

1. 只询问TF-01…TF-44，不把档案中“可能触点”扩写成新机制。
2. (a)项作为选项合法性约束，不列“是否遵守”票。
3. STOP项只问是否达到证据门槛，不问产品偏好。
4. 不因某形态在档案中出现就要求实现；形态是后果枚举，不是需求来源。
5. 不因两个档案都提到同一对象就创建两票；使用合并ID。
6. ballot答案若要求改变AGGREGATE稳定假设，必须先显式重开RFC，而不是在工程选项中暗改。
7. 证明计划在裁决后编制，不得用“容易测试”决定产品语义。

## 尾结论

七份R8档案事实完整，但其原始问卷混合了稳定RFC已定事项、真实产品/工程分叉、纯证明或外部未知以及跨档案重复。按108个原子问题逐项审计后，108项全部映射、未映射0；稳定事项从ballot删除，12类调查停点独立保留，重复问题合并为44个真分叉。G1-G7没有不可解释事实矛盾；主要风险是把schema/source authority/pin/canonical scheduler/D4-D5 owner等已定合同重新开放，或把未checkout owner与未跑E2E变成产品选项。下一步只能基于TF-01…TF-44编制简洁ballot，不填答案、不附推荐，并继续以AGGREGATE稳定条款而非R8产物自身作为需求权威。

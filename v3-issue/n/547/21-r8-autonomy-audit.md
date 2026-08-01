# R8 自主恢复审计 — 44/44 收敛与恢复 gate

> 审计输入仅限：AGGREGATE、`18-r8-autonomy-root-cause.md`、7份`19-r8-I`、6份`20-r8-E`及对应R7摘要。未查源码、未运行实验、未修改WORKFLOW。  
> 审计目标：判断R8是否已经把稳定事项、调查事实、工程合同和真实用户意图重新分开；本报告不直接改规格。

## A. 主 agent 摘要（≤1页）

**覆盖完整：44/44，未映射0。** 5个A均准确恢复稳定条款；7个I均已调查到足以形成确定约束；26个E各自恰好进入一份单一合同；原列6个U在“自主完成workflow”授权、稳定公理与最小改动原则下均不再需要操作员选择，剩余真用户问题数为 **0**。

分类恢复结果：

| 原分类 | 审计结果 |
|---|---|
| A×5 | 保持A；已由E合同作为前提恢复，没有重新开放 |
| I×7 | 全部闭合为事实约束：可证明迁移、legacy hold、或typed unsupported/dependency hold |
| E×26 | 6份报告一对一覆盖，无遗漏、无同一TF双权威 |
| U×6 | 均可按现存authority/最小机制给出唯一默认；不再向操作员外包 |

7个I的关键变化不是“外树已实现”，而是**owner、合同、人口或缺失事实已经足够**：I-35定位C6为同repo #597且未实现；I-37固定chain-over-global；I-39定位gate executor为#712链且未实现。未实现必须投影为compile可预览、create/schedule typed unsupported或既有instance hold，不能继续叫产品未知。I-14/I-20/I-42把真实中央状态钉为v14、15 chains/69 items/932 runs、全部pre-ref；这强制legacy只读/hold并允许repository column-only无损搬运，不允许current source伪造历史definition。

6份E总体严格收敛，但尚有 **8个跨报告接缝/恢复gate** 要由主agent在正式报告前统一：

1. compile result identity与definition content identity的单向ref关系；
2. publish、binding admission、chain/item row、runtime constructor的唯一事务顺序；
3. v14 migration中repository无损搬运与pre-ref hold的先后，以及binding值禁止无schema改写；
4. runtime effect ledger与#597 tool outcome/#712 gate journal不得形成重复commit；
5. gate pre-spawn、runtime claim、worktree/run副作用的精确顺序；
6. recursive声明未实现时compile入口也必须拒绝unknown `[tasks]`，不能只靠scheduler guard；
7. schema首个独立consumer未实现只形成dependency gate，不阻塞规范producer合同；
8. 六个原U的自主默认必须写入正式决策记录，不能继续以“参数”悬挂。

没有发现E报告把proof gap升级成产品机制；outbox/effect ledger、ref-aware GC、capability handshake等都能追溯到稳定的recovery、pin或unsupported要求。主要风险不是机制膨胀，而是接缝未统一时产生双identity、双journal或migration顺序冲突。

**R8恢复gate尚未通过。** 不是因为还需用户答题，而是主agent必须先把B3的8项写成一份统一集成合同，并把B4的六个自主默认落为正式裁决；之后才能形成R8正式报告。外树未实现的E2E仍按dependency/unsupported记录，不得冒充已验证完成。

## B. 逐TF审计

### B1. 44/44映射

| TF | 恢复来源 | 审计结论 |
|---|---|---|
| 01 | A；E-Compile | `CompileResult`唯一finding authority准确恢复；callback/event仅派生 |
| 02 | 原U | 自主定为doctor维持runtime/operational health；compile findings留在显式current compile读面 |
| 03 | E-Compile | deterministic result/finding refs、完整envelope cache、分层durability，单一 |
| 04 | 原U；I-35/37/39 owner模式 | 自主定为coder-loop compiler生产schema；未来独立consumer只负责消费 |
| 05 | E-Compile | 一个contract family，schema/compile/binding为不同文档角色而非三套authority |
| 06 | A；E-Compile/E-Binding | source schema唯一解释权；use-site不新增第二类型层 |
| 07 | 原U；I-14 | 自主冻结最小递归ADT，见B4；opaque `json`不作逃生舱 |
| 08 | E-Binding | missing/null/required/default封闭ADT及阶段语义单一 |
| 09 | 原U；E-Binding参数 | 自主定canonical JSON inline默认，显式声明可选其他projection |
| 10 | A；E-Binding/E-Runtime | `exit.*` agent-owned且不可覆盖外部source，准确恢复 |
| 11 | E-Binding | compile/create/add/spawn最早可决定边界单一 |
| 12 | E-Binding | 完整candidate replacement/patch validation与并发防覆盖单一 |
| 13 | E-Binding | batch全量plan/admit后单事务，旁路只限显式migration |
| 14 | I-14→E-Binding | 分布已足够：可证明/不兼容/definition unknown/非binding四类；无人工猜值 |
| 15 | E-Binding | preflight位于首个副作用前；deterministic error不retry |
| 16 | E-Definition | pre-run consumer字段机械闭包，未留下字段套餐 |
| 17 | 原U；D9/#705事实 | 自主定typed chain declaration boundary归#705；#547只消费，不复制parser |
| 18 | E-Definition | artifact先publish、create事务再写ref；orphan仅为可GC artifact |
| 19 | E-Definition | current compile与instance ref resolver严格双读面 |
| 20 | I-20→E-Definition | 0个可恢复历史definition；全部pre-ref只读/hold |
| 21 | E-Definition | 完整compile后staging verify/atomic publish/integrity单一 |
| 22 | E-Definition | ref reachability、retiring state与create/GC协调单一 |
| 23 | E-Definition | cache仅按tagged ref缓存verified bundle，不作authority |
| 24 | E-Definition | shared resolver、typed missing/corrupt hold、绝不current fallback |
| 25 | 原U；R7-07 | 自主定named referenced-node TOML；linear phases经compat normalizer进入同一tree |
| 26 | E-Runtime | explicit stable definition id与独立runtime id单一 |
| 27 | E-Runtime | chain/item admission时完整constructor，禁止first-run lazy append |
| 28 | E-Runtime | persisted readiness为scheduler唯一authority；旧phase/status只作单向projection |
| 29 | E-Runtime | typed transition record与业务effects单事务，唯一completion signal |
| 30 | E-Runtime | outbox/effect ledger、idempotency、unknown side effect hold单一 |
| 31 | I-31→E-Runtime | 当前无production par链；具名unsupported guard，禁止串行降级 |
| 32 | E-Capability | definition-scoped tool identity与四轴正交，单一 |
| 33 | A；E-Capability | required须确定outcome、expected不得冒充required，准确恢复 |
| 34 | E-Capability | registry由compile/doctor/prompt三consumer共享同一ref/version |
| 35 | I-35→E-Capability | owner为同repo #597，未实现；当前required runtime闭环应unsupported/hold |
| 36 | E-Capability | typed gate point/host/evaluation identity与runtime seam单一 |
| 37 | I-37→E-Capability | chain覆盖global、item不参与、selected/shadowed与missing三态已固定 |
| 38 | E-Capability | capability真实注册后才advertise；create/restart handshake单一 |
| 39 | I-39→E-Capability | owner为#712/#710/#713/#740/#714，未实现；不再是transport产品未知 |
| 40 | E-DeGitHub | 一个breaking checkpoint清旧CLI/wire/runtime alias，无兼容双权威 |
| 41 | E-DeGitHub | repository仅optional business binding，chain identity作selector |
| 42 | I-42→E-DeGitHub | v14为15条column-only、0 conflict；可无损搬运，冲突仍零写失败 |
| 43 | A；E-DeGitHub | default preset清零、per-item显式source、chain metadata独立，准确恢复 |
| 44 | E-DeGitHub | typed/API、public producer、historical allowlist三层窄gate |

核算：A 5、已闭合I 7、E 26、自主裁决原U 6，共44；未映射0。

### B2. A、I、E专项判定

#### 5个A

均准确：TF-01没有把incremental callback升级为authority；TF-06没有新增use-site解释层；TF-10保持agent-owned result与外部binding隔离；TF-33没有用availability/entry代替outcome；TF-43清除default preset但保留chain-level typed declaration。无稳定条款被弱化。

#### 7个I

| I | 已足够自主约束 | 不得声称 |
|---|---|---|
| 14 | 冻结四类migration；unknown/incompatible hold | 63个可转文本自动等于历史schema正确 |
| 20 | 全部pre-ref legacy只读/hold | current source/marker/status可恢复H1 |
| 31 | 当前non-degenerate par unsupported，compile/schedule均拒绝 | store round-trip等于production readiness |
| 35 | #597是owner，当前闭环未实现 | HAPI event是tool outcome |
| 37 | chain-over-global、item不参与、missing三态 | concat顺序是named precedence |
| 39 | #712链是owner，当前executor/journal未实现 | join evaluation表可复用为gate journal |
| 42 | current v14 repository无冲突可无损搬运 | 0 conflict取消未来冲突检测 |

因此7项都不再需要用户意图；未实现外树统一转typed dependency/unsupported/hold。

#### 26个E

| 报告 | TF | 单一性 |
|---|---|---|
| E-Compile | 03、05 | 一个content-addressed contract family |
| E-Binding | 08、11、12、13、15 | 一个shared admission constructor与阶段化preflight |
| E-Definition | 16、18、19、21、22、23、24 | 一个immutable bundle/ref lifecycle |
| E-Runtime | 26、27、28、29、30 | constructor→readiness→transition→recovery唯一链 |
| E-Capability | 32、34、36、38 | tool/gate分domain、共享identity/version/handshake |
| E-DeGitHub | 40、41、44 | 一个breaking checkpoint与窄清零gate |

每项只出现于一份主合同；其他报告仅引用seam。没有A/B/C选项残留。U参数仍在文字中，但B4给出自主默认后应删除“待用户提供”含义。

### B3. 跨E接缝与冲突

#### Gate-1：Compile ↔ Definition identity

E-Compile有`compileResultRef`，E-Definition有`PresetDefinitionRef.contentIdentity`。正式合同必须固定：

`compileResultRef`标识完整success/rejected envelope；只有compiled branch的`productIdentity`可成为`PresetDefinitionRef.contentIdentity`。definition bundle引用compile result/schema ref，但两者不得相等化或互相重新hash。warnings属于compile envelope并由definition ref可达，不进入另一个finding集合。

#### Gate-2：Definition ↔ Binding ↔ Runtime create

唯一顺序必须合并为：

1. compile current；
2. publish immutable definition；
3. pure binding admission与runtime materialization plan；
4. 一个`BEGIN IMMEDIATE`事务同时写chain/item row、tagged definition ref、admitted bindings、完整runtime nodes/edges/readiness；
5. commit后发events，之后才允许scheduler观察。

E-Definition若只写row/ref、E-Runtime另开constructor事务，会产生可见半实例；必须以上述组合替代。

#### Gate-3：真实v14 migration

repository column→business binding是已知语义的shape migration，可对15条column-only值无损执行；它不证明preset definition。所有15 chains/69 items仍标`legacy-definition-unproven`并hold。I-14的63条issue文本只是值级可逆，不得在目标ValueType/schema/ref未冻结时自动改历史值；即使后续转换，也不能解除definition hold。migration顺序须从v14 shape检测开始，保留row ids、69 items、932 runs、baseBranch和worktree历史。

#### Gate-4：Runtime ↔ Tool/Gate journals

E-Runtime的generic external-effect ledger只能保存effect dispatch/dedupe；#597 `ToolOutcomeEvaluation`与#712 `GateEvaluation`各自是领域journal。transition record引用并原子consume其decided/evaluated ref，不复制decision/outcome状态。event outbox同样只派生。否则会出现三份completion authority。

#### Gate-5：Pre-spawn顺序

固定为：runtime leaf `ready→claimed`并持久分配RunIntent/RunId → 解析capability与named binding → #712 pre-spawn evaluation → advance后才创建worktree/closure、run process side effects；hold保持同一RunIntent/evaluation epoch，不分配新RunId。binding/runtime required值preflight必须更早，在claim及任何资源副作用前完成。

#### Gate-6：Recursive unsupported

I-31证明unknown `[tasks]`当前会静默丢弃。runtime backstop必要但不充分：在TF-25语法/constructor尚未交付前，compile boundary必须对任何recursive declaration返回具名unsupported/rejected；legacy linear仍正常。已有store par rows或绕过入口再由scheduler backstop hold。两层都禁止顺序降级。

#### Gate-7：Schema owner/consumer

规范producer自然属于拥有canonical compiler/boundary的coder-loop；这不要求虚构GUI/hook repo。没有首个独立consumer时，schema producer可由自身round-trip验证，跨owner E2E登记为明确dependency checkpoint；不得因此只发projection instance，也不得把RFC完成谎称为外部集成已完成。

#### Gate-8：DeGitHub ↔ Definition/Binding

repository迁入chain business bindings后由typed chain boundary/admission读取；它不进入engine selector、definition content identity的专用字段或worktree identity。baseBranch保持engine-native pre-run chain input；其最终ChainDefinition字段归属遵循B4的#705 owner，不能因repository migration重开。

### B4. 原6个U的自主默认

原始用户已经要求自主完成workflow；以下均有唯一最小、低扩张答案，不再需要提问：

| TF | 自主裁决 | 依据 |
|---|---|---|
| 02 | doctor不吸收compile findings，继续只报runtime/operational health；definition健康由显式`compile current`查看 | 保持现有职责、避免doctor暗选current/cache/history |
| 04 | coder-loop compiler是唯一schema producer；未来GUI/hook/外挂owner只消费 | 类型authority在哪，schema producer就在哪；避免外部反向定义 |
| 07 | 首批`ValueType = string | number | boolean | null | array<T> | record<fields> | union<variants>`；无opaque json | 满足递归封闭、nullable与现存标量；不编未需variant |
| 09 | scalar沿类型canonical文本；structure默认inline canonical JSON；其他呈现必须显式声明 | 最小deterministic实现，无隐式fence或启发式 |
| 17 | chain task tree/top join typed boundary归#705；#547只消费其`ChainDefinitionRef` | D9 P-D9-2与既有owner最具体，避免双parser |
| 25 | TOML采用具名referenced-node table；现有`[[phases]]`仅作linear compatibility输入并立即normalize | stable explicit id/ref、递归引用与查环最直接；不维持双canonical model |

这些裁决应由主agent写入正式decision record；本审计不直接修改AGGREGATE。

### B5. R8恢复gate缺口

正式报告前必须满足：

1. 逐字纳入B4六项，不再标U或“待用户参数”；
2. 用B3统一六份E的identity、create事务、journal、pre-spawn和migration顺序；
3. 明确当前capability矩阵：C6/#597 absent、gate/#712 absent、par production absent；对应create/schedule行为均为typed unsupported/hold；
4. 将v14 pre-ref population设为只读/hold，repository shape migration不得解除hold；
5. 将首个独立schema consumer、#597、#712/#714、non-degenerate par E2E登记为实现dependency与验证缺口，不叫产品问题；
6. 保持“未跑真实路径=未完成验证”：R8可完成规范收敛，但不能宣称这些外树runtime已交付。

**尾结论：R8已实现44/44决策覆盖，5个A准确、7个I均已形成可执行约束、26个E各归唯一合同；在自主完成授权下原6个U也都有稳定公理与最小改动导出的唯一默认，剩余真用户问题为0。恢复gate当前只差主agent统一8个跨报告接缝并正式落盘六项自主裁决；外树未实现一律以typed unsupported/dependency hold表示，不再伪装成产品未知。**

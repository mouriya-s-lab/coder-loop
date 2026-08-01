# RFC #547 新说明文档：对抗性读者追问清单

> 读者假设：熟悉 coder-loop v2 的 preset、phase、daemon、scheduler、SQLite、runner 与 GitHub 迭代流程，但不了解 #547 的裁决过程。  
> 用途：审查说明文档是否真正解释 RFC，而不是写概要、抄旧文档或堆术语。本文只列必须回答的追问与写作陷阱，不设计大纲、不代写正文。  
> 事实边界：`AGGREGATE-547.md` 与 `24-r9-expected-foundation.md` 给出正式目标合同；`30-r12-rolling-decomposition.md` 给出当前 readiness（0 source-ready、10 not-yet）；`SYNTH-547-type-system-compile.md` 是历史合成素材，包含已被后续裁决修正或收窄的旧说法，不能直接作为当前结论。

## 一、读完后仍说不清“RFC到底实现什么”时，必须追问

1. #547改变的核心对象究竟是什么：TOML语法、装载期compiler、immutable definition、runtime task graph，还是四者之间的typed contract？
2. 为什么“v3类型系统”不是把动态preset变成TypeScript字面量联合？动态preset在引擎编译之后到来这一事实如何决定类型检查落点？
3. “最早可决定阶段验证”分别怎样划分definition load、chain/item create、pre-spawn与runtime transition？
4. 哪些错误仅凭定义即可拒绝，哪些必须等实例值出现，哪些只能等工具/gate/agent结果出现？
5. 为什么同一约束只能有一个authority，而不能compiler、daemon、renderer、scheduler各做一遍近似检查？
6. 十个domain D1–D10分别交付什么**独立产品**，而不是只给出十个名称？
7. D1的`CompileEnvelope`为何同时承载compiled/rejected branch与完整findings？它解决v2哪些“model与warning可拆错”的问题？
8. D2的递归`ValueType`到底允许哪些variant，为什么没有opaque json？
9. D2中source schema、binding declaration、candidate value、admitted value与rendered text为何必须是不同阶段/类型？
10. D3的definition node、runtime node、readiness、run fact与transition commit各是什么，谁能推进业务状态？
11. D4为什么把tool availability、invocation、outcome与requiredness拆成四轴？
12. D5为什么把gate declaration、named binding resolution、capability handshake与GateEvaluation journal分开？
13. D6为何只拥有doc layout/rendering，不重新拥有ValueType、default或canonical value serializer？
14. D7的“de-GitHub”具体清除哪些engine原语，又保留哪些合法的业务/remote adapter能力？
15. D8为何在plan退役之后仍需要dead-fragment finding？“不存在plan”与“fragment确实被消费”为什么是两件事？
16. D9为什么要求每个item显式pin `PresetDefinitionRef`，而chain declaration不能作为fallback？
17. D10的immutable definition artifact为何必须包含完整pre-run consumer closure，而不能只存hash/ref shell？
18. 八个Gate是在描述八个产品、八个事务边界，还是跨domain交付条件？每个Gate组合哪些owner的typed产物？
19. 文档能否用一段无缩写的语言说明：一个定义从source bytes到真实runner执行，中间形成哪些持久identity和typed artifact？
20. 文档是否明确说明RFC目标不是“做一个更大的preset parser”，而是建立definition→instance→runtime的单一authority链？

## 二、每项能力“为何必要”必须回答的反例追问

21. 如果保留v2的warning/model分离，哪类consumer会看到成功model却遗漏finding？
22. 如果cache仍按path而不是完整content/envelope identity，编辑preset后同进程与重启后会怎样分叉？
23. 如果public projection继续把所有variable写成string，GUI、CLI、hook与第三方如何区分number、boolean、null、array、record、union？
24. 如果missing/null仍转成空字符串，required/default与真实空字符串如何区分？
25. 如果structured value只在renderer晚期发现错误，为什么create成功本身就是错误的系统状态？
26. 如果binding use-site可以重新声明source type，同一source在两个phase发生冲突时谁是authority？
27. 如果runtime task tree已有SQLite ADT，却没有production constructor与scheduler consumer，为什么“表结构存在”不能算递归任务已实现？
28. 如果scheduler继续读linear phase/status而不读persisted readiness，recursive tree会在哪个点退化为装饰性metadata？
29. 如果runner exit自动推进item而不经过typed transition commit，授权、幂等、gate/join decision与outbox如何保持原子？
30. 如果non-degenerate par在runtime不可用时顺序执行，为什么这是语义篡改而不是合理fallback？
31. 如果tool requirement只检查prompt里有没有提到工具，为什么不能证明outcome达成？
32. 为什么`required` tool必须有可判定outcome，而“provider是engine”不是合法性的充分条件？
33. 如果context entry/event被当作ToolOutcome，哪些author、namespace、commit与run identity证据会丢失？
34. 如果gate的`optional`被解释成executor可以不存在，声明optional与missing named binding会被混成什么？
35. 为什么gate capability必须在create/resume握手，而不是scheduler遇到时静默跳过？
36. 如果gate decision只存在event或callback而没有唯一journal，restart时如何判断该重执行还是重消费？
37. 如果doc renderer按binding key或value内容选择format，rename或数据变化为何会改变未声明的prompt结构？
38. 为什么structured值默认必须是单行canonical JSON，block/fenced只能显式声明？
39. 如果repository仍是chain selector/NOT NULL列，为什么engine仍然知道GitHub？
40. 如果local worktree/reconcile读取repository，缺remote binding为何会错误阻断本地执行？
41. 如果保留`--issue` alias或GitHub记法normalize，为什么“opaque item id”仍不成立？
42. 如果default preset仍存在，新chain/item的omitted/null/legacy三种状态会怎样再次合并？
43. 如果legacy null item从chain/current推断definition，为什么历史H1无法被证明却会被伪装成可恢复？
44. 如果resume/restart重编current source而不是解析pinned ref，H1实例遇到H2 source后会发生什么？
45. 如果artifact只存source hash而不存prompt/fragments/status/tree/bindings声明，source消失后如何恢复exact H1？
46. 如果create分事务写row、bindings、runtime tree与outbox，崩溃时会出现哪些半实例？
47. 如果dispatch发生在commit前，commit结果未知时如何避免幽灵effect或重复effect？
48. 如果GC只看当前chain/item而不看runs/history/runtime refs，会删除哪些仍需解释的definition？
49. 如果dead-fragment检查只grep role names，它为何不能证明typed transitive consumer graph？
50. 如果旧SYNTH里的“已有半个编译器”被写成“compiler能力基本完成”，会掩盖哪些D1/D8 current缺口？

## 三、运行时机制必须讲清的追问

51. Source snapshot、CompileEnvelope、CompiledProductHandoff、live VerifiedDefinition与instance pinned ref的identity分别是什么，为什么不能互换裸hash？
52. D10 publish/verify与D10 create coordinator为什么是两个阶段，中间为什么必须经过D2 admission与D3 materialization plan？
53. 新chain创建时，typed ChainDefinition provider、D9 client与D10各做什么；谁绝不能复制parser？
54. 新item创建时，`PresetDefinitionRef`何时解析、何时校验、何时与bindings/runtime/outbox同事务pin？
55. Batch create/update如何先生成完整pure plan，并保证任一失败整批零写？
56. Candidate binding经过type/default/required/refinement后，持久化的admitted value还必须携哪些identity、owner与provenance？
57. Runtime resolver为何只接受pinned definition/ref与admitted storage，而不接受current source locator？
58. D2 canonical value text如何进入D6 renderer；prefix、suffix、style、label与blankBefore按什么固定顺序组合？
59. Definition tree如何从root id、keyed node declarations与child refs物化为RuntimeNode？
60. DefinitionNode→RuntimeNode为何是单向关联，runtime cursor/readiness为何不能反写definition？
61. Scheduler如何从persisted readiness选择节点、CAS claim、分配RunIntent/RunId并占用容量？
62. Pre-spawn guard在创建worktree、closure、process之前必须检查哪些definition integrity、capability、binding与unsupported事实？
63. `ready→claimed→held`时，为什么hold必须保留epoch、释放容量且不创建资源副作用？
64. Runner退出只产生什么execution fact？为什么它不能直接改变业务状态？
65. Agent提交的`exit.*`如何被D2验证、由D3授权并进入唯一transition commit？
66. Transition commit同一事务必须更新哪些runtime/readiness/cursor/journal consumption/outbox事实？
67. GateEvaluationRef与ToolOutcomeRef如何进入transition，而不把两个journal复制进transition store？
68. Container join、chain-complete与scripted join在consumer未交付时具体怎样typed unsupported/hold？
69. Mixed chain中不同item如何各自读取pinned preset vocabulary，为什么不存在代表preset？
70. Empty chain status与chain-complete如何避免加载default或虚构item？
71. Repository optional binding只在哪个remote operation adapter被消费？local closure/worktree路径如何证明零读取？
72. Status/events/GUI分别投影definition truth还是runtime truth，如何避免重新计算authority？
73. Public schema unknown version、definition kind mismatch与artifact corrupt分别在哪个边界停止？
74. 文档是否能完整叙述一个成功路径，同时指出每一步失败时“尚未发生”的副作用？

## 四、故障、恢复与并发必须回答的追问

75. Compile rejected后是否允许publish任何artifact、marker或cache success？
76. Source在一次compile中发生变化时如何检测`source-raced`，重试会读取什么？
77. Staging artifact写到一半崩溃、fsync后rename前崩溃、rename后metadata前崩溃，各自怎样恢复？
78. 同ref并发publish相同内容与不同内容分别如何收敛或报collision？
79. Create事务commit结果未知时，为什么要先查instance/outbox，而不是重跑create？
80. 两个scheduler同时claim同一readiness时，CAS/idempotency如何保证只有一个RunIntent？
81. Agent重复提交同一transition、提交stale transition、使用foreign run credential时分别返回什么？
82. Gate evaluation停在evaluating、decided未consume、consumed三种状态时restart分别做什么？
83. Tool outcome evaluation停在Pending/Evaluated/consumed边界时如何恢复且不伪造required success？
84. Capability在create时存在、restart时消失，为什么new reject与pinned hold必须分开？
85. Capability恢复后，held readiness如何按同identity/fingerprint重评，而不是新建第二evaluation？
86. Pinned definition missing、artifact missing、corrupt、unsupported schema、kind mismatch、retiring分别如何分类？
87. Legacy pre-ref chain/item/run为何一律`legacy-definition-unproven` hold，而不是迁移时加载current source？
88. Repository column staging为何不能解除legacy definition hold？
89. Migration遇到column/binding conflict时为什么整批零写，哪些row/count/FK/resource事实必须保留？
90. Definition GC如何mark全部persisted refs，并与publish/create并发协调？
91. Artifact进入retiring后，新resolver与新create如何响应；已有读者如何避免读到半删除内容？
92. Outbox dispatcher为什么只读committed rows；event为何永远不是Transition/ToolOutcome/GateEvaluation authority？
93. Worktree/closure创建失败与业务transition失败如何分域恢复，哪些资源可回收、哪些runtime事实必须保留？
94. Status读到corrupt/legacy/dependency unavailable时，如何展示typed error而不触发repair或fallback？
95. 哪些错误可确定性拒绝、哪些应hold等待外部状态、哪些可安全retry？文档是否给出一致判据？
96. 文档是否解释了“exactly once业务推进”依赖幂等identity与事务，而不是假设process只执行一次？

## 五、“明确不实现什么”必须回答的追问

97. RFC是否更换TOML为代码载体？如果不换，为什么？
98. 是否允许arktype expression成为公共类型语言？如果不允许，arktype只在哪个边界使用？
99. 是否新增opaque json、computed business key、optional-field soup或通用untyped map？
100. 是否定义新的join选择算法、par降级策略、best-of-n或reopen语义？
101. 是否把worktree起点、branch命名、pin、回收策略变成preset DSL字段？
102. 是否实现tool本体、transport、outcome journal/finalize runtime？哪些只定义contract seam？
103. 是否实现gate executor transport或scripted join consumer？缺失时为何不是silent inert？
104. 是否实现GUI、hook execution、remote daemon或第三方consumer？RFC只提供哪些projection/contract？
105. 是否保留default preset、implicit rebind、chain-wide representative preset或legacy null fallback？
106. 是否保留`--issue` alias、GitHub id normalize、repository inference或doctor硬编码`gh`？
107. 是否把repository彻底删除？为什么它仍可作为optional typed business binding存在？
108. 是否删除`baseBranch`？为什么它仍是typed ChainDefinition中的engine-consumed字段？
109. 是否恢复plan实体、fragment jump或旁路dead-fragment checker？
110. 是否允许D8为了自包含而顺手实现canonical fragment graph producer与D1 finding carrier？当前为何不允许？
111. 是否自动repair legacy pre-ref历史？为何“无法证明H1”是永久证据边界？
112. 是否把current compile findings当作既有instance健康真相？current与pinned读面如何分开？
113. 是否要求每个domain在依赖未交付时假装具备runtime能力？typed unsupported/reject/hold分别保护什么？
114. 是否在本文档里重新拆issue、规定实现顺序或承诺完整未来树？为什么R12明确禁止？

## 六、current、target、dependency与proof必须分栏回答的追问

115. 文档每次使用“有”“支持”“会”“保证”时，指的是current main、修补后target、具名dependency合同，还是尚未运行的proof？
116. 当前可直接复用的资产到底有哪些：canonical compiler/result/projection、source hash、doc renderer、runtime SQL ADT、hook carrier、opaque storage、事务/migration、baseBranch/closure？
117. 这些资产分别**不能证明**什么？例如runtime tree ADT为何不能证明production scheduler，hook carrier为何不能证明gate executor？
118. D1当前仍缺什么：single envelope authority、finding identity、schema artifact、cache/materialize/doctor同源、verified handoff？
119. D2当前仍缺什么：recursive ValueType贯通、typed admission/default/missing、CAS、typed exit与真实create→render→transition？
120. D3当前仍缺什么：compiled referenced tree、constructor、readiness scheduler、transition store与non-degenerate par runtime？
121. D4当前仍缺什么：ToolRegistry生产链与outcome/finalize dependency？
122. D5当前仍缺什么：typed gate contract以及真实evaluator/journal/recovery dependency？
123. D6当前已有renderer的哪部分，又缺typed value到真实prompt/runner链的哪部分？
124. D7当前哪些GitHub/repository原语仍闭合，target如何在一个breaking checkpoint清除？
125. D8当前plan退役到什么程度，为什么`S-33` canonical typed fragment graph与`S-07` typed finding carrier仍未进入main？
126. D9当前per-item preset与selector互斥有哪些资产，为什么default/legacy fallback与外部provider仍未闭合？
127. D10当前有tagged ref/FK/source hash哪些槽位，为什么definition content/resolver/pin/GC仍未交付？
128. 哪些具名dependency尚未交付：independent schema consumer、typed ChainDefinition provider、tool outcome/finalize runtime、gate evaluator/journal、scripted join consumer？
129. Independent schema consumer缺失为何只阻断cross-owner proof，而tool/gate provider缺失会阻断真实runtime capability？
130. Non-degenerate par是外部dependency、D3缺失能力还是proof gap？它当前必须表现为何种typed unsupported？
131. Remote adapter、fragment population、multi-value prompt、restart/GC与冻结SHA compatibility分别是能力缺口还是proof缺口？
132. 当前R12为什么是source-ready 0、本批0、延后10？这是否意味着RFC无效或blocked？
133. “零批次不是blocked”的可操作含义是什么：等待哪些main事实变化，再按哪些事实gate重检？
134. 为什么R11 expected seam不能直接写成current producer已经存在？
135. `S-33` target contract要求什么，而current fragment rows/phase role validation实际只有什么？
136. `S-07` target contract要求什么，而current finding projection实际只有什么？
137. 为什么不能为了让D8先开工而削掉transitive/invalid-kind/cycle或typed finding要求？
138. 为什么不能为了让D8先开工而把D1 carrier与graph producer一并塞进同一issue？
139. 文档是否明确：191项需求与36个seam是目标需求映射，不是191项实现已完成或36条runtime已接通？
140. 文档是否给出当前状态的证据语言，而不是仅在结尾加一句“尚未实现”来冲淡前文完成时态？

## 七、旧合成文档最容易诱发的追问

141. `SYNTH-547-type-system-compile.md`开头“依据RFC及全部sub-issue合并而成”是否会让作者误以为它是当前正式事实源？文档是否明确其历史素材地位？
142. SYNTH中的21个子issue、OPEN/CLOSED统计是否仍能代表当前工作图？如果没有重新核实，为什么不应写入新文档？
143. SYNTH所说`CompiledTaskModel`、`preset compile --json`、GUI/hook consumer是否是target设计还是current实现？
144. SYNTH说“#454后daemon校验、scheduler调度、渲染、CLI查询已唯一消费该产物”，这一历史主张是否与R5/R9所见断链冲突？新文档如何避免照抄？
145. SYNTH的递归seq/par、validator、reopen、script join描述是否混入了其他RFC的任务代数语义？#547当前只拥有哪些声明/typed seam？
146. SYNTH中“八项表达力需求全部接受”是否等于八项production runtime全部实现？
147. SYNTH把`json`列为开放渲染问题，但正式裁决已冻结structured默认单行canonical JSON；新文档是否删除旧摇摆？
148. SYNTH把compile findings与doctor关系列为开放问题，正式目标现在如何裁定current doctor与pinned instance读面？
149. SYNTH说chain级preset显式传或null，与D9“每item显式pin、无default/implicit rebind、legacy null hold”如何区分历史表述？
150. SYNTH的关闭验证表、child编号与“编译管线已合入”等说法是否经过当前事实复核？如果没有，为什么必须排除？
151. SYNTH中的具体源码行号、issue状态、命令与旧fixture是否可能已经过时？新说明是否把它们当背景证据而非当前保证？
152. SYNTH按旧issue边界组织知识，是否会诱导新文档再次用issue号代替capability/ref/schema identity？
153. SYNTH使用“零原语全部退役”的完成语气，而R9 current仍有repository、`--issue`、GitHub解析与default preset闭环；新文档如何改用current/target双栏？
154. SYNTH说dead-fragment与dead-vocabulary同构，是否会诱导作者假设current已有canonical typed FragmentRef graph？
155. SYNTH的“公共JSON投影六块”是否会被误写为当前public schema已经齐全，而D1/D4/D8 projection仍缺什么？
156. SYNTH把hook/GUI/第三方列为consumer，是否会让作者把independent consumer proof写成已通过？

## 八、术语堆砌检查：每个术语后必须能回答什么

157. 写`ADT`时，能否点名variant、owner、parse boundary与exhaustive consumer，而不是把“typed”当形容词？
158. 写`canonical`时，能否说明canonical的是source snapshot、compiled graph、value text、JSON projection还是artifact identity？
159. 写`identity`时，能否说明是FindingId、DefinitionNodeId、RuntimeNodeId、TransitionId、ToolOutcomeId、GateEvaluationId或DefinitionRef？
160. 写`ref`时，能否说明tagged kind、schema/version、integrity验证与resolver？
161. 写`schema`时，能否区分source schema、public ContractSchema、artifact manifest schema、payload schema与journal version？
162. 写`binding`时，能否区分declaration、candidate、admitted value、named gate binding与repository business binding？
163. 写`projection`时，能否说明它只读哪个authority，是否允许consumer round-trip，是否包含runtime truth？
164. 写`compile`时，能否说明它不臆造chain/item/runtime事实？
165. 写`runtime`时，能否区分scheduler readiness、runner process、transition commit、gate/tool journal与external effect？
166. 写`hold`时，能否说明适用于existing pinned instance、发生在哪个事务、是否释放capacity、如何重评？
167. 写`reject`时，能否说明适用于new admission、是否零写、错误identity与retry条件？
168. 写`unsupported`时，能否说明缺的是哪项capability，为什么不能fallback？
169. 写`journal`时，能否点名唯一authority，避免把event/outbox/context混称journal？
170. 写`atomic`时，能否列出同一事务内的rows与commit前禁止发生的副作用？
171. 写`immutable`时，能否说明artifact内容、pinned ref、current/pinned时间面与GC？
172. 写`provider`时，能否说明provider-owned parser/ADT/version/error与本仓client boundary？
173. 写`capability`时，能否说明advertisement版本、支持的point/decision/journal/payload，而不是“代码里有symbol”？
174. 写`proof gap`时，能否说明能力可能已定义但尚未通过哪条真实路径验证，避免改写成foundation缺失？
175. 写`foundation missing`时，能否点名唯一producer未交付，而不是仅仅“测试没跑”？
176. 写`source-ready`时，能否证明全部named seam输入已在main或已交付dependency中，而不是R11 expected图上有一条边？

## 九、最容易把未实现写成已实现的句式陷阱

177. “系统现在会在装载期完成全部验证”——是否遗漏create-time与runtime-only事实？
178. “编译器会生成完整递归任务图”——这是target还是current？current是否只有部分canonical compiler骨架？
179. “类型贯穿全链路”——真实typed create→render→transition E2E是否已跑？
180. “工具调用可被required执法”——tool outcome/finalize runtime是否已交付？
181. “gate在spawn前执行”——gate evaluator/journal capability是否已advertise？
182. “structured binding会渲染为canonical JSON”——D2→D6→真实runner链是否已接通并验证？
183. “engine已经与GitHub解耦”——current repository/CLI/parser/doctor残留是否仍存在？
184. “plan已退役，因此dead fragment可直接检查”——S-33 typed graph与S-07 carrier是否存在？
185. “每个item都pin immutable definition”——current create是否实际写完整bundle/ref/runtime？
186. “restart会恢复exact H1”——shared resolver、artifact content与restart proof是否已完成？
187. “legacy数据会被迁移”——不可证明历史是repair还是hold？
188. “public schema可供GUI/第三方使用”——schema artifact与independent consumer round-trip是否已交付？
189. “par已由runtime ADT支持”——production constructor/scheduler是否支持non-degenerate par？
190. “optional gate失败会被忽略”——是否混淆missing optional binding与selected gate executor failure？
191. “repository被删除”——是否漏掉optional business binding与remote adapter合法消费？
192. “无default preset意味着chain可以没有definition运行”——是否违反item显式pin与legacy hold？
193. “R12没有下一批，所以设计blocked”——是否误解零批次的事实gate语义？
194. “36 seams已经接通”——是否把R11 expected mapping写成runtime current？
195. “191项需求已经完成”——是否把需求覆盖审计写成实现完成率？

## 十、禁止写成概要的最终对抗检查

196. 一个只读v2 README的工程师，能否根据文档解释v2的一条item如何被v3 definition/item/runtime三层替代，而不是只记住“更typed”？
197. 读者能否指出一个值从raw chain/item输入到admitted typed value、canonical text、prompt bytes的每个owner和失败点？
198. 读者能否指出一个run从ready、claimed、spawn、exit fact到transition commit的每个持久事实和事务边界？
199. 读者能否解释tool、gate、join为何是三个不同decision/outcome domain，缺一时各自怎样停止？
200. 读者能否解释publish与create为何分相，以及D2/D3计划为何夹在两者之间？
201. 读者能否解释current source与pinned definition为何是两个时间面，并给出restart错误反例？
202. 读者能否解释new reject、existing hold、typed unsupported、deterministic failure与proof-unavailable的差别？
203. 读者能否列出明确不实现的内容，且不会把相邻RFC/runtime dependency偷渡回#547？
204. 读者能否从文档中单独列出current资产、target保证、具名dependency、proof gap四张不重叠清单？
205. 读者能否解释当前为什么0个unit source-ready，而不是误以为文档描述的target products已经存在？
206. 每个“为什么”是否最终落到一个v2失败机制、一个single-authority目标与一个可观察故障，而非价值口号？
207. 每个“如何工作”是否至少覆盖成功路径、最早失败点、持久化事实、外部副作用和restart恢复？
208. 每个“不实现”是否说明边界owner与缺席时的typed行为，而不是只写“out of scope”？
209. 是否有任何段落只能靠issue号、缩写或术语列表理解？若删掉编号，合同是否仍清楚？
210. 是否有任何target时态没有紧邻current状态或未交付标记，从而可能被读成“main今天已经这样运行”？

## 十一、必须直接标红的写作陷阱

- **旧文档摘抄陷阱：** 复制SYNTH的摘要、子issue状态、关闭验证、源码行号或“已合入”表述，却不以AGGREGATE/R9/R12重新裁定current/target。
- **时间面混淆陷阱：** 用现在时连续描述target pipeline，最后才补一句“尚未全部实现”。
- **覆盖率冒充完成率：** 把“D1–D10 10/10、191/191、36 seams”写成实现进度。
- **expected seam冒充供给：** 因R11画出S-33/S-07，就声称main已有typed fragment graph/finding carrier。
- **资产冒充能力：** 因有runtime SQL ADT、hook carrier、doc renderer、tagged ref，就声称scheduler、gate、typed render、immutable resolver已闭合。
- **proof冒充foundation或反向：** 测试没跑就说producer不存在；有producer shape就说真实runtime已证明。
- **issue号合同化：** 用`#705/#712/#597/#714/#747`代替provider/capability/schema/journal名称。
- **术语列表陷阱：** 连续罗列ADT、ref、schema、identity、journal、outbox，却不说producer、consumer、失败与持久化。
- **相邻RFC吞并陷阱：** 把task algebra、worktree公理、tool本体、gate executor、GUI、remote adapter全部写成#547自身实现。
- **fallback美化陷阱：** 把default preset、current recompile、par串行化、optional吞错描述成兼容性。
- **legacy修复臆断：** 以current source或repository staging推断历史H1 definition。
- **旁路authority陷阱：** 为了先做dead fragment、tool或gate，临时创建第二checker、第二journal或手写consumer shape。
- **运行时零验证陷阱：** 把“类型可计算”写成external outcome、gate decision、agent exit也无需runtime验证。
- **图胜于解释陷阱：** Mermaid连线存在，却没有文字解释每条artifact、authority与typed failure。
- **零批次失败叙事：** 把R12当前0批次写成停滞、blocked或设计不完整，而不是拒绝虚构source-ready的正确结果。

## 尾部审查结论

一篇合格的新说明文档必须让v2读者能回答上述问题，而不是只复述“装载期编译、全链路ADT、零原语”。尤其必须逐项解释必要性、成功/失败/恢复机制、owner与seam，并始终把current资产、target合同、具名dependency和proof gap分开。最危险的素材是`SYNTH-547-type-system-compile.md`中的历史完成时态、旧issue图与开放问题，以及R11/R12 expected seam的术语；未经AGGREGATE、R9和R12重新裁定，任何摘抄都可能把未实现写成已实现。当前真实状态仍是R12 source-ready 0、本批0、10个unit全部not-yet；这不削弱RFC目标，只禁止文档把目标图写成今日运行事实。

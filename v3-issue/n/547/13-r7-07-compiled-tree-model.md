# R7-07 · Compiled recursive tree 的声明、normalization 与 identity

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一设计锚点：`AGGREGATE-547.md` P-D3-1/2/3/4/5/7/8、§2.4。  
> 总账输入：`D-13,A-01,A-02,A-08,J-02,T-04`。  
> 范围：只调查定义声明、compile normalization、identity、projection 与 phase-list consumers；不进入 runtime 调度行为、transition commit 或方案裁决。

## A. 主 agent 摘要

### A1. 问题

稳定设计要求一棵任意嵌套、显式稳定 identity 的 compiled tree；现存线性 phase 数组只能 normalize 成同一递归模型，不能在 parse 后留下第二套模型。非法结构、reopen/join/dependsOn、候选引用与 typed transition path 必须在装载期拒绝，公共产物必须真实投影嵌套结构。R7-07 要确定现有 phase/status/DAG 编译主干究竟能承载到哪里，以及哪些消费者仍假设线性数组。

### A2. 结论与置信边界

**D-13 仍为无供给；P-D3-1/3/4/5/7/8 均没有现存完整供给。P-D3-2 在定义侧无供给；runtime 的 join ADT/SQL 是相邻层可保留资产，不构成 compiled declaration。**

1. TOML boundary 只有 `phases[]`，没有 `tasks/tree/node/seq/par/join/candidate/transition/dependsOn/reopen` 声明位，也没有显式 node identity 字段。
2. `buildCompiledTaskTree(phases)` 无条件生成固定三层退化树：`tasks:root → phase:<name> seq → task:<name> phase leaf`。它不是递归 parser/normalizer，只是从 phase list 派生 projection companion。
3. canonical model 同时保留 `phases[]` 与 `tasks`。大量生产消费者继续直接遍历/索引 `preset.phases`；只有 projection、scheduler run identity packet 与 migration definition helper 读取 `tasks.children`。因此 parse 后确有双读面，tasks 不是唯一结构权威。
4. identity 全由名称拼接生成。重复 phase name 在 parse 时拒绝，前缀隔离使现有 root/phase/task 集合在合法 phase name下唯一；但用户不能显式声明稳定 id，phase rename必然改变 identity，节点移动无从表达，更无 identity-reference table 可检查。
5. compile 校验顺序是 TOML parse/arktype boundary → local phase/status/reference checks → status DAG findings → prompt placeholder → fragment readability → source hash → build退化tree。结构树不存在，所以所有 par/join/reopen/candidate/typed transition well-formedness 都没有 finding variant或检查时点。
6. 公共 projection boundary把 root和每个phase taskTree硬编码为 `seq`，child硬编码为扁平 `phase[]`。它不能表达 nested seq/par、join候选或结构边；`phases` 仍是顶层数组。
7. 临时探针给现存 linear preset附加一个 `[tasks]` nested声明。compile成功、findings为空，产物仍是自动生成的线性树；用户声明被边界静默丢弃，而不是点名“不支持”或结构错误。
8. 仓内公共 compile JSON 只有 CLI producer和测试 consumer；未发现生产 external consumer实现。可确认 boundary/GUI接口假设都把 `phases` 当数组，但外部真实 consumer是否已硬编码数组保持未知，不能从 issue文本冒充实存证据。

### A3. 因果、影响与资产

根因不是“少一个 par variant”：声明 boundary 以 phase数组为唯一输入，compiler在全部校验完成后才机械派生tree；历史调度、rights、runner、trigger、DAG、doctor/status等消费者继续依赖 phase列表；公共 projection又固化相同数组形状。结构tree由此只是identity/展示伴生物，不能承载结构语义。

**当前影响**：linear bundled presets可稳定compile、投影、选择phase；identity链能关联已运行phase，但不能声称定义结构已递归化。未知 `[tasks]` 被忽略会给作者造成“声明已接受”的假象。

**未来放大**：若只扩 projection 或只扩 runtime ADT，现有 phase-list消费者仍会旁路tree；若从结构路径派生identity，移动节点会改变id；若外部consumer硬编码 `phases[].taskTree.children[]`，非退化投影会成为协议破坏面。

**可保留资产**：TOML→typed Preset→CompileResult主干；phase/status/trigger/exits局部校验；status DAG findings；compile validation顺序；public result boundary/round-trip；现有生成identity的前缀隔离和唯一性测试；runtime leaf/seq/par/join strict ADT与SQLite约束（仅作相邻层资产）。

### A4. 未知与下一步

- 外部 GUI/ingress 是否已有真实数组解析代码仍未知；本仓只证明接口形状和CLI producer。
- recursive declaration语法、identity命名规则、linear兼容读面、candidate/transition schema都必须由后续裁决/需求推导决定；本报告不设计。
- R7-08可使用本报告的consumer/identity表，调查生产 runtime constructor与scheduler旁路；不得把现有退化tree当作递归定义已存在。

本报告事实足够作为R8档案输入；候选形态见B12，非完备且不推荐。

---

## B. 证据附录

### B1. 设计对照

| 条款 | 判定 | 事实 |
|---|---|---|
| P-D3-1 | 无完整供给 | 无递归声明、显式稳定id或唯一normalized tree；仅从phases生成固定退化tree。 |
| P-D3-2 | 定义侧无供给 | compiler无join声明/union/candidate；runtime ADT资产不由compiled model产生。 |
| P-D3-3 | 无供给 | 无tree结构可校验；空par、reopen target、join完整性、dependsOn环没有finding。 |
| P-D3-4 | 无供给 | 无per-par concurrency/reopen budget声明或范围校验。 |
| P-D3-5 | 不符合 | projection root/phase固定seq，children固定phase leaf数组。 |
| P-D3-7 | 无供给 | 无具名candidate表、typed invocation或 `(definitionRef,candidateId)` compile引用。 |
| P-D3-8 | 无供给 | exit仍是status/chain-action列表，不是结构边typed transition path。 |
| §2.4 | 部分资产，不达终态 | 现有compile/result/exit variants有boundary与消费者；未来tree/join variants在定义侧不存在，不应以runtime空壳冒充。 |
| D-13 | 无供给 | R5结论被全入口/探针再次确认。 |
| A-01/A-02 | 可保留 | canonical compile主干、public projection boundary/round-trip、现有identity。 |
| A-08 | 相邻层资产 | runtime tree/join ADT与SQL存在，但没有定义constructor接缝。 |
| J-02 | 互补 | compiled leaf id会写进run definition packet；这只证明关联，不证明结构消费。 |
| T-04 | 同错风险 | nested/runtime tests主要fixture写入；linear identity测试不能证明recursive declaration。 |

### B2. TOML boundary：可声明与不可声明集合

`src/loop.ts:490-518` 的 `PresetTomlBoundary`顶层字段为：name、item、runtime、statuses、`phases[]`、fragments、agent。`PresetPhaseBoundary`只有name/prompt/runner/model/exits/variables/trigger/roles/rights。

因此下列稳定概念均没有外部输入位：

- task tree root、node kind、children；
- seq/par节点；
- explicit node id；
- join kind、validator invocation、candidate table；
- par concurrency/reopen budget与target；
- structural dependsOn；
- typed transition target/input/output schema。

ArkType对象没有在此使用 `"+":"reject"`。探针表明未知顶层`[tasks]`会被parse boundary丢弃并继续成功compile，而非作为结构finding保留。

### B3. 现有 normalization 实际形状

`src/loop.ts:780-787` 类型精确限定：

- `CompiledTaskNode = {identity, kind:"phase", phase}`；
- `CompiledPhaseTaskTree = {identity, kind:"seq", phase, children:[单一phase leaf]}`；
- `CompiledTaskTree = {identity, kind:"seq", children:phase trees[]}`。

`buildCompiledTaskTree`（`src/loop.ts:864-874`）对每个phase机械生成：

- root：`tasks:root`；
- phase container：`phase:${phase.name}`；
- leaf：`task:${phase.name}`。

它没有递归输入，也不接受已有node identity。`compilePresetOrThrow`直到全部DAG/template/fragment检查与hash之后，才在返回model时调用它（`src/loop.ts:4683-4695`）。所以它是late derived tree，不是结构声明的normalizer。

### B4. 双读面而非唯一canonical结构

`CompiledTaskModel = Preset & {sourceDir,sourceHash,tasks}`，原`Preset.phases[]`完整保留。生产读取可分两类：

#### 直接读取 `preset/model.phases[]`

| 消费族 | 位置 | 数组假设 |
|---|---|---|
| parse/local validation | `src/loop.ts:4788-4880` | declaration order、duplicate name、trigger lookup。 |
| status DAG checker | `src/preset-dag-check.ts:83-123` | flatten全部phase exits，按phase全局集合计算。 |
| compiler prompt validation | `src/loop.ts:4657-4673` | 每phase顺序读prompt。 |
| public projection/stateGraph | `src/loop.ts:2906-2953` | 以`model.phases.map`为外循环，再按name找tree child。 |
| runner selection | `src/loop.ts:5304-5404` | find/for/filter/首个non-trigger。 |
| scheduler phase plan | `src/scheduler.ts:607-622,701-712` | flatten non-trigger phases并用index+1推进。 |
| scheduler authorization | `src/scheduler.ts:1674-1681,3130` | 以phase name回查声明。 |
| daemon rights/exit/trigger/status mutation | `src/daemon.ts:2077,3306-3367,3909,4174,4294,4409` | 多处find/map known phase names。 |
| doctor/current-state validation | `src/loop.ts:5632-5643` | phases map成allowed set。 |

#### 读取 `tasks.children`

| 消费族 | 位置 | 实际用途 |
|---|---|---|
| public projection | `src/loop.ts:2935-2953` | 为每个phase按name找退化subtree并输出。 |
| scheduler run packet | `src/scheduler.ts:1623-1626` | flatten每phase的单一child id为`definitionPhases`。 |
| migration definition helper | `src/preset-migration-definition.ts:22-31` | 同样flatten为phase→single child id。 |

这证明tasks并未替代phase列表。尤其后二者直接取`phaseTree.children[0]`，对零/多child或nested child没有合法解释。

### B5. identity集合、引用与冲突面

#### 生成集合

canonical compiled identity只有：

- `tasks:root`；
- 每phase一个`phase:<name>`；
- 每phase一个`task:<name>`。

phase name重复在`parsePreset`（`src/loop.ts:4788-4792`）被拒绝。不同kind使用不同前缀，合法phase names即便带冒号，现有三集合仍可区分。`tests/unit/preset/compile.test.ts:117-139`专门构造`x`与`x:task`并断言现有集合唯一。

#### 引用集合

- projection的phase identity与taskTree identity来自`phase:<name>`；leaf来自`task:<name>`；
- scheduler/migration把leaf id存为`definitionNodeId`；
- SQLite runtime节点随后持`definitionRef + definitionNodeId`，属于R7-08/11消费层。

#### 冲突/稳定性边界

- 无显式id，用户不能让rename后identity保持不变；
- 不存在“移动节点”输入，因此无法验证移动不改id；
- 没有node-reference声明，故无悬空/重复explicit id检查；
- boundary只要求projection identity为string，未表达全树global uniqueness；唯一性来自当前builder构造和测试，而非可扩展声明规则；
- runtime `runtimeNodeId`与compiled `definitionNodeId`是不同命名域，不能用runtime schema反证compiled explicit identity已存在。

### B6. compile校验顺序与finding分类

生产顺序由`src/loop.ts:4590-4696`确定：

1. source/materialize解析与读取`preset.toml`；
2. TOML syntax error → `rule:"preset-toml"`；
3. ArkType boundary与`parsePreset` local checks → `rule:"preset-structure"`；
4. status DAG checker：deadlock为error、dead-vocabulary为warn；error先终止；
5. 逐phase读取prompt与placeholder双向检查；undeclared为`template-undeclared` error，unused成为warning；
6. fragment readability；
7. source hash；
8. `buildCompiledTaskTree(phases)`；
9. 返回compiled model/warnings。

现有local checks包含：phase name去重、至少一个non-trigger、exit status/action去重与词表归属、trigger source/status/exit一致性、变量source、roles、rights等（`src/loop.ts:4788-4879`）。DAG checker只分析status vocabulary/exits/triggers（`src/preset-dag-check.ts:1-123`）。

由于tree在第8步才无条件派生，且没有tree input，以下均不存在finding分类：empty par、duplicate node id、reopen target、missing join、candidate completeness、structural dependsOn cycle、transition target/schema compatibility。

### B7. public projection的非递归边界

`PresetCompileProjectionBoundary`（`src/loop.ts:533-583`）固定：

- `preset.taskTree.kind`只能是`seq`，只投影identity，不含root children；
- 顶层`phases`必须是array；
- 每phase的`taskTree.kind`只能是`seq`；
- children必须是`{kind:"phase",identity,phase}[]`；
- 无par、join、candidate、transition path字段。

`projectCompiledPreset`（`src/loop.ts:2900-2959`）以phases array为主循环，按phase name在tasks.children中find；找不到就throw。它并不递归project root tree。所谓“task tree可jq遍历”仅限退化phase块，不能满足P-D3-5的non-degenerate结构。

### B8. linear preset兼容读面

当前linear preset在五个读面具有稳定行为：

1. TOML `[[phases]]` declaration order；
2. `Preset.phases[]` typed model；
3. derived `tasks.children[]`相同顺序；
4. public `projection.phases[]`，每项带单leaf seq；
5. scheduler `nonTriggerPhases[]`从phase数组filter，顺序即推进顺序。

这组事实是兼容资产，也是未来结构化时必须显式处理的旁路集合。现状没有一个“只读normalized recursive tree，再派生linear view”的共同函数。

### B9. nested declaration探针

#### 环境

- 复制：`presets/single-phase-example` → `/tmp/rfc547-r7-07-probe-fabda733-ed63-4cd2-b9f7-4fdcaaea8bdf`
- 追加：

```toml
[tasks]
kind = "seq"
id = "root-explicit"
children = [{ kind = "phase", phase = "execute", id = "leaf-explicit" }]
```

- 脚本：`/tmp/rfc547-r7-07-probe.ts`
- 输出：`/tmp/rfc547-r7-07-probe.out`
- 命令：`bun /tmp/rfc547-r7-07-probe.ts`
- 副作用：只写`/tmp`；未启动daemon、未改bundled preset/DB。

#### 观察

compile返回`kind:"compiled"`、findings空；产物仍为：

- root `tasks:root`；
- phase `phase:run`；
- leaf `task:run`。

探针声明的`root-explicit/leaf-explicit/execute`均未进入model/projection，也未产生warning/error。故当前boundary不是“明确不支持nested tree”，而是未知声明可被静默忽略。

### B10. external consumer与数组假设

仓内对`projectPresetCompileResult`的生产调用只有CLI `preset compile --json`（`src/loop.ts:2962-2999`）；其余直接consumer为单元测试。未发现仓内GUI、hook或第三方ingress读取该JSON的生产代码。

能够确定：

- 对外boundary明确规定`phases`为array；
-接口文档/相邻RFC把该JSON登记为GUI/外部预校验输入；
- 现有仓内测试使用`.phases.map/flatMap`并固定退化children数组。

不能确定：外部repo是否已有实际parser、是否允许schemaVersion迁移、是否硬编码single child。该项保持未知，需R7-04的跨repo事实；本报告不以旧issue文本替代实存consumer。

### B11. 测试同错与证明边界

- `tests/unit/preset/compile.test.ts:20-60`证明linear model/projection round-trip、顺序与identity一致。
- `:117-139`证明当前prefix builder对delimiter-bearing phase names不碰撞。
- projection boundary测试只接受固定seq/phase arrays；它会把现有退化shape锁绿，但不证明recursive ADT。
- runtime nested seq/par/join tests通过`createTaskTree`fixture直接构造，绕过TOML/compiler；对应R5 `T-04`。
- 没有fixture要求nested declaration被接受、非法tree被finding拒绝、explicit id rename/move稳定、candidate/transition完整性。
- 本次探针补足“未知tasks字段实际如何处理”，结果是静默忽略；未运行全套测试，因为本调查无产品修改且任务要求最小boundary探针。

### B12. 根因、放大条件与修补边界

#### 观察→机制→历史

1. **观察**：compiled product有`tasks`却只退化。  
   **机制**：builder只接受phases。  
   **历史形态**：tree作为既有linear phase模型的派生identity/projection加入，而非替换其权威。
2. **观察**：nested声明无error且无效果。  
   **机制**：TOML boundary无tasks字段且开放未知key；parse结果不携带它。  
   **历史形态**：boundary原本只为既有preset shape服务。
3. **观察**：runtime支持seq/par，compiler不支持。  
   **机制**：两套ADT无constructor；runtime主要由fixture/store入口构造。  
   **后果**：不能因符号同名就认定定义供给存在。
4. **观察**：大量phase-array消费者。  
   **机制**：runner/rights/trigger/DAG/scheduler均从Preset继承旧模型。  
   **后果**：局部扩task projection会保留旁路根因。

#### 放大条件

- nested/par声明开始出现；
- node移动/rename需要稳定引用；
- join candidate或transition target开始引用node；
-外部consumer开始依赖schemaVersion 1 arrays；
- runtime constructor只消费tree而daemon rights/runner仍消费parallel phase list。

#### 修补边界（只陈述边界，不给方案）

只增加projection variant不会改变TOML/parser与phase-list消费者；只增加runtime constructor不会产生compiled structure；只给builder递归shape而不建立explicit identity/reference checks不能守P-D3-1/3；只在scheduler支持par会绕过compile well-formedness和P-D3-6 guard。根因跨声明、canonical normalization、identity、projection与consumer派生面。

### B13. 事实支持的候选形态（非完备、不推荐）

以下仅为事实能区分的形态，**候选非完备且不推荐任何一项**：

1. **recursive canonical + derived linear compatibility view**：确定后果是结构成为单一权威，旧消费者需明确改读derived view；能否保持schemaVersion 1未知。
2. **linear canonical + optional structural overlay**：确定后果是双事实源持续存在，必须定义冲突优先级；现状已经展示该风险。
3. **新recursive declaration与旧phases二选一后normalize**：确定后果是loader需判互斥/等价并产出一个模型；迁移期错误分类需明确。
4. **显式node id与结构位置分离**：确定后果是rename/move引用可独立，但需全局/局部唯一域及reference validation。
5. **版本化非退化projection并保留旧数组端点**：确定后果是外部consumer迁移可分期，但会产生多公共读面，是否允许由裁决决定。

### B14. 证据索引

| 事实 | 证据 |
|---|---|
| 稳定条款 | `AGGREGATE-547.md:106-119,307-316` |
| TOML/phase boundary | `src/loop.ts:490-518` |
| Preset与compiled types | `src/loop.ts:714-787` |
|退化builder/identity | `src/loop.ts:864-874` |
| projection boundary | `src/loop.ts:533-583` |
| projection实现 | `src/loop.ts:2900-2959` |
| compile顺序 | `src/loop.ts:4590-4696` |
| local phase校验 | `src/loop.ts:4788-4879` |
| DAG checker | `src/preset-dag-check.ts:1-123` |
| runner/trigger phase consumers | `src/loop.ts:5304-5404` |
| scheduler array plan | `src/scheduler.ts:607-622,701-712` |
| scheduler definition packet | `src/scheduler.ts:1623-1626` |
| migration flatten | `src/preset-migration-definition.ts:22-31` |
| daemon phase consumers | `src/daemon.ts:2077,3306-3367,3909,4174,4294,4409` |
| linear identity tests | `tests/unit/preset/compile.test.ts:20-60,117-139` |
| consumer inventory | `/tmp/rfc547-r7-07-src-consumers.txt` |
| nested probe | `/tmp/rfc547-r7-07-probe.ts`, `/tmp/rfc547-r7-07-probe.out` |
| R4/R5互证 | `05-r4-compile-artifact.md`, `07-r4-runtime-tree-identity.md`, `11-r5-supply-ledger.md:57-64,86,113-117,125-138` |

## 尾部结论

R7-07确认现有`CompiledTaskTree`不是递归声明的canonical normalization，而是在线性`phases[]`全部校验完成后生成的固定退化伴生物。identity前缀与linear round-trip是可保留资产，但无显式稳定id、结构引用、join/candidate/transition finding或non-degenerate projection；生产消费者仍广泛直接读取phase数组，少数tree消费者又假定每phase恰有一个child。nested `[tasks]`探针被静默忽略，进一步证明D-13/P-D3-1/3/4/5/7/8没有现存供给。runtime seq/par/join资产不能倒推定义层已实现。报告不裁决模型或迁移方式；所列形态非完备且不推荐。

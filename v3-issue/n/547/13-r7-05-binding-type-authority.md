# RFC #547 R7-05：Binding source type authority、公共投影与数据形状

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一设计锚点：`AGGREGATE-547.md` §2 C/E/F、P-D2-1/4/5/6/7、P-D6-3；R5 `D-07,D-10,D-11,D-12,A-05,A-06,J-01,T-01,T-03,U-01`；`06-r4-binding-type-flow.md`。  
> 边界：只调查现存类型权威、值域、公共投影、consumer 与 agent result 数据面；不裁决 `ValueType` variant、JSON呈现或实现归属，不设计、不估算。R7-06 独立调查 create/update admission 与失败时点。

## A. 主 agent 摘要（最多一页）

### A1. 问题与结论

**问题。** 现存 preset 的 source 类型证据如何从声明流到 canonical model、公共 projection 与消费者；bundled/fixture 实际值是否包含 nullable、嵌套结构与同 source 冲突；是否已有 agent-owned result object 可承载 `exit.*`？

**结论（高置信）。** 当前没有一条统一类型权威链，而是三条不相接的数据通道：

1. `[item.fields]` 保存 `string|number|boolean|json` 四词，但生产代码只用字段名确认 item source root；`type` 没有后续 consumer。
2. `[phases.variables]` 解析为 `item|chain|runtime` source、chain scalar fallback 与 doc；它不携带 source `ValueType`、required、文本 projection 或 target expectation。
3. item/chain 持久值是递归 `JsonValue` remainder，prompt 渲染出口却只接受 null/undefined、string、finite number、boolean：缺失/null 变 `""`，结构值抛错。

公共 compile projection 将全部变量无条件写为 `type:"string"`，仅保留 `key/sourceKind`；source path、item四词、fallback、required、doc、owner全部不公开。仓内生产 consumer 只有 compile CLI 输出该 projection；其他命中均为 projector本身或测试。独立 GUI/hook/第三方 consumer 因 R7-04 未完成而保持 `U-01` 未知，不能猜测其字段需求。

五个 bundled preset 共 **154** 个 phase-variable 引用：item 27、chain 24、runtime 103。实际 item schema 只声明 3 个 `string` 与3个 `number` 字段，零 `boolean/json`；chain fallback 实际出现 none、boolean、string，runtime 仍全为 string。故 bundled 数据无法证明 boolean/json/结构投影有效。

隔离 probe 进一步证明：compiler 接受 `string/number/boolean/json` item 声明、同一 `chain.shared` 在两个 phase 分别以 number `7` 与 boolean `false` fallback 引用，以及同一 `item.s` 改名绑定；projection仍全部 string且 findings为空。render 把 number/boolean文本化、null JSON变空串，nested object/array以 `item.j: cannot stringify value of type object` 失败。声明中的 `json` 不是结构型语言，也不是可渲染逃生舱。

### A2. 因果、影响与边界

- **类型证据来源分裂。** item四词属于 item field map；chain没有 schema；runtime key tuple/业务 literal全是 string。phase binding只指 source，不链接一个公共 source schema object。
- **same-source 冲突无表达也无检测。** phase binding没有 target type，故同 source跨phase不会形成显式 expectation冲突；chain fallback是每次 binding局部字段，同一 underlying source可被不同 phase赋不同 scalar类型，compiler不比较。
- **实际值域比声明宽。** item extra/chain remainder递归接受 JSON scalar、array、object、null；item source path还可下钻嵌套 object。声明 `string/number/boolean/json` 不约束这些值。渲染出口反而比存储窄。
- **公共投影丢证据。** 真实 source hash/phase结构保留不等于变量类型真实；固定 string boundary使独立 consumer无法区分 number、boolean、JSON、nullable、fallback或agent owner。
- **agent result 边界不存在。** runner stdout/stderr只落日志/字节与观测；stdout verdict parser已退役。业务完成经 daemon-gated item status 或 chain action，phase exit ADT无 payload；没有 agent result object、`exit.*` source、typed pending或防覆盖 owner。
- **doc资产局部成立。** `PresetVariableDoc` 是归一化 product，renderer逐声明读取，不按 key分支；但 TOML `variables="object"` 与手写 binding parser不是从公共精确 boundary推导，bundled测试仍用 `ISSUE` selector。

**当前影响。** compile JSON 对所有值声称 string；开放持久值可以在渲染时才暴露结构不兼容；相同 chain source在不同phase可得到不同fallback形状；agent只能写控制面 status/action，无法提交 typed path result。

**可保留资产。** source tagged union、known item/runtime source校验、chain fallback ADT、doc product/renderer、递归 JSON安全持久化、compile projection的版本化 boundary 与真实 source hash均是事实资产，但不共同构成类型权威。

### A3. 未知与下一阶段资格

R7-05 已建立 R8 所需的 source/value/projection/result 地面图，但不决定首批结构 variant、nullable表示、JSON文本形式或 owner字段形状。R7-04 未完成，因此外部 consumer 保持未知；R7-06 仍须独立建立实例准入与失败副作用时间线。

---

## B. 证据附录

## B1. 稳定条款与总账对照

| 条款/总账 | 现存事实 | 本片边界 |
|---|---|---|
| P-D2-1 / D-07 | item四词无人消费；chain无schema；runtime string-only | 类型权威链不成立 |
| P-D2-4 / D-11 | 无递归封闭 `ValueType`；结构 `JsonValue` 只在generic存储存在 | generic JSON不是公共类型语言 |
| P-D2-5 / D-10 | public variable仅 key/string/sourceKind | type/required/default不真实 |
| P-D2-6/7 / D-11 | source无`exit.*`，phase exit无payload/owner | agent-owned数据面无供给 |
| P-D6-3 / D-12 | doc parse后精确、renderer消费；outer variables仍宽object | 局部资产，未贯穿公共边界 |
| A-05/A-06 | source/doc/fallback ADT与声明驱动doc真实 | 可保留但不升级为D2符合 |
| J-01 | canonical projector唯一；变量投影固定string | S1/S2事实互证 |
| T-01/T-03 | 绿测守固定string、文本化与空串 | 测试不能证明新语义 |
| U-01 | 外部 schema/bindings/GUI/hook chain未知 | R7-04未完成，不推断 |

## B2. 类型权威链与丢失点

### B2.1 TOML outer boundary

- `PresetTomlBoundary.item.fields` 与 `phases[].variables` 都只验证为 `object`（`src/loop.ts:508-518,556-572`）。
- `BoundaryValue` 是 `unknown`，TOML先过外部边界再进入手写 parser，这是入口卫生；但每个 variable并非 named ArkType union。
- `parsePresetItemFields`把四词变成 `ReadonlyMap<string,PresetItemField>`（`src/loop.ts:443-459,4913-4938`）。
- `parseVariableBinding`手写读取 source/default/doc，产出局部 product后再解析 source（`src/loop.ts:4788-4819,4907-5037,5192-5203`）。

### B2.2 Canonical binding shape

`PresetVariableSource` 只有（`src/loop.ts:660-668`）：

- `{kind:"item",field:string}`；
- `{kind:"chain",field:string,fallback:none|scalar}`；
- `{kind:"runtime",key:string,ownership?:"preset"}`。

`PresetPhaseVariable` 只有 `key/source/doc`（`:672-682`）。没有 `ValueType`、required、projection、target expectation或agent owner。因此 canonical model虽保留 source与doc，却没有可贯穿的类型证据。

### B2.3 Source schema现状

| source | 声明证据 | 实际值容器 | 消费结果 |
|---|---|---|---|
| item engine field | 物理字段TS类型各异 | number/string/null等 | 经统一 stringify |
| item declared field | 四词 `string/number/boolean/json` | recursive `JsonValue` extra | 只校验root存在，type不消费 |
| chain | 无preset source schema | recursive `JsonObject` bindings remainder | 每binding局部fallback；统一stringify |
| runtime engine | closed key tuple | `Record<key,string>` | string或missing throw |
| runtime business | declared key + literal string | string | string |
| exit | 无source variant | 无result payload | 不可绑定 |

### B2.4 精确证据丢失表

| 边 | 输入 | 输出 | 丢失/伪造 |
|---|---|---|---|
| item TOML→map | 四词 | `PresetItemField.type` | 暂保留，之后无生产读点 |
| variables TOML→canonical | source/default/doc | `key/source/doc` | 无type/required/projection/expectation |
| canonical→public projection | source union/doc/fallback | key/string/sourceKind | path、fallback、doc、owner及真实type全丢 |
| API→item/chain storage | arbitrary JSON | typed known fields + remainder | 不带preset schema证据 |
| storage→render | recursive JsonValue | string | null/undefined坍缩；结构throw |
| runner→completion | stdout/stderr + daemon mutation | exitCode/status/action/log | 无typed result payload |

## B3. Bundled preset 全量声明清单

脚本 `/tmp/rfc547-r7-05-inventory.ts` 对五个 `presets/*` 逐个 `loadPreset`，输出 `/tmp/rfc547-r7-05-inventory.jsonl`；汇总脚本与结果为 `/tmp/rfc547-r7-05-summarize.ts`、`/tmp/rfc547-r7-05-summary.jsonl`。

| preset | phase数 | variable引用 | item | chain | runtime | item field schema | chain fallback种类 |
|---|---:|---:|---:|---:|---:|---|---|
| business-key-example | 1 | 3 | 1 | 0 | 2 | 无 | 无 |
| engine-integration | 2 | 6 | 2 | 0 | 4 | key:string | 无 |
| gh-issue-pr-iteration | 4 | 132 | 20 | 20 | 92 | issue:number; branch:string; pr:number; lastRunId:string | none/boolean/string |
| real-e2e-minimal | 2 | 10 | 3 | 4 | 3 | issue:number | none |
| single-phase-example | 1 | 3 | 1 | 0 | 2 | 无 | 无 |
| **合计** | **10** | **154** | **27** | **24** | **103** | string×3, number×3 | boolean/string/none |

结论边界：bundled只实际声明string/number item字段；没有boolean/json item field样本。runtime business key仅 `auditDemo`，value仍是literal string。bundled不能覆盖结构类型或agent-owned结果。

## B4. 实际值域、嵌套与nullable

### B4.1 Generic storage value域

`JsonValue`容许 null、string、finite JSON number、boolean、array与object递归；`requestJsonObject`/`isJsonValue`递归验证（`src/runtime-data.ts:658-663,755-763`）。item extra和chain metadata/bindings把未知键保留为remainder并round-trip（`:341-447,575-595`）。没有preset声明驱动的深度/shape refinement。

### B4.2 Item读取路径

- engine roots `id/status/agentCwd/runner/phase`来自物理字段；其中nullable字段会传入统一stringifier。
- 非engine root从extra读取；`item.a.b.c`会沿nested object逐段下钻，遇非object或缺段返回undefined（`src/loop.ts:6008-6030`）。
- 因而 nested source path真实存在，但 `[item.fields]`只给root四词，不能声明nested record成员、array element或union。

### B4.3 Render可接受域

`stringifyBindingValue`（`src/loop.ts:6075-6080`）：

| value | 结果 |
|---|---|
| undefined/null | `""` |
| string | 原值 |
| finite number | `String(value)` |
| boolean | `"true"/"false"` |
| array/object | throw，消息只含source label |

所以存储域严格大于渲染域。`json`声明不会选择canonical JSON projection；nullable也不是显式type variant，而是与missing共同坍缩。

## B5. 同 source 跨 phase 引用与冲突面

### B5.1 Bundled现状

bundled大量复用相同 source，例如 gh preset的 `item.issue`、`chain.repository`、runtime paths跨四phase重复。实际同source通常保持同binding key/fallback，但doc可按phase有无或改变label/suffix；doc是使用点属性，不是source type。

### B5.2 可表达的冲突

- phase variable没有target type，因此无法写“同source在phase A期望number、phase B期望boolean”；自然也没有该冲突checker。
- chain fallback属于每个binding source实例。隔离fixture中同一underlying `chain.shared` 在p1 fallback number `7`，p2 fallback boolean `false`，compile成功、findings空。
- 同一 `item.s` 可在p1绑定为 `S`，p2绑定为 `RENAMED`；这是合法alias，公共projection只能看到两个string item binding，无法关联同source。
- 同一个binding key也可在不同phase指向不同source kind；key作用域是phase，不形成全局identity。

这表明现状不是“冲突被允许后有降级”，而是冲突类型本身没有可比较证据；只有每使用点局部fallback形状。

## B6. 公共 projection 与全部 consumer

### B6.1 Boundary与projector

`PresetCompileProjectionBoundary`把变量写死为（`src/loop.ts:533-583`）：

```json
{"key":"string","type":"string","sourceKind":"item|chain|runtime"}
```

这里的 `type` 实际是 literal unit `"string"`，不是任意类型字段。`projectCompiledPreset`无条件构造该值（`src/loop.ts:2900-2959`）。

### B6.2 仓内消费者全集

- 生产：`preset compile <dir> --json`调用 `projectPresetCompileResult`并向stdout/stderr输出（`src/loop.ts:2962-3002`）。
- 仓内没有 daemon/status/scheduler/doctor 对该 public projection 的读取；它们读取canonical `Preset`或各自runtime view。
- 其他 `PresetCompileProjection` / `sourceKind` 命中均为 boundary、projector和 `tests/unit/preset/compile.test.ts`。
- migration helper消费canonical/materialized preset，不消费compile JSON。

因此 public projection当前是单一生产者、仓内零独立生产 consumer。R7-04尚无报告，外部GUI/hook/第三方consumer保持 `U-01`，本片不推导字段需求。

### B6.3 Consumer无法从当前实例得出的事实

独立consumer无法知道：`item.issue`而非其他item路径、number而非string、是否nullable/required、chain fallback及其类型、doc、canonical JSON projection、runtime pending、agent owner、同source复用关系。即使未来获得schema artifact，schema只会证明当前固定string shape，不能恢复被projector删除的语义。

## B7. Agent result object与 `exit.*` 数据面

### B7.1 现存runner输出

scheduler流式保存stdout/stderr、计数字节、生成excerpt与status artifact（`src/scheduler.ts:1940-2165,3298-3376`）。stdout内容不作为completion/result读取；生命周期GC明确不消费stdout（`:2309-2310`）。旧stdout verdict parser已退役（`src/loop.ts:1196-1204`）。

### B7.2 现存业务完成输入

- agent通过daemon-gated `item update --status`选择item-status exit；
- 或通过`item exit-action --action stop`选择chain-action；
- `PresetPhaseExit` ADT只有 `{status,when}` 或 `{action:"stop",when}`，无payload/schema（`src/loop.ts:684-710`）；
- scheduler读取item状态变化与child exit code，不解析结构化agent result。

### B7.3 缺失的边界

全repo没有 binding source `exit.*`、agent result object boundary、path-specific typed payload、agent-owned field marker、外部值防覆盖或typed pending。daemon JSON response的通用 `{ok,result}` 和observability event payload是控制面wire，不是agent产出的transition value，不能冒充P-D2-6/7。

## B8. Doc boundary与类型链

- `PresetVariableDoc`在parse后是非optional product：label/prefix/suffix/style/blankBefore（`src/loop.ts:670-682`）。
- binding未给label却给装饰字段、或给unknown字段会load-time拒绝；parser归一化缺省字段（`:4993-5031`）。
- `renderRuntimeInputsDoc`逐个variable读取doc并用同source resolver取值，不读variable key字面量（`:5824-5835`）。
- `src/`无 `=== "ISSUE"` consumer；bundled测试仍以 `candidate.key === "ISSUE"`选择样本（`tests/unit/preset/load-bundled.test.ts:217-233`）。
- 由于outer `variables="object"`和手写parser，新增doc字段需要人工同步boundary/parser/domain/renderer；TS只在parse后的product范围内提供链路压力。

## B9. 隔离 compile/render probe

### B9.1 Fixture

目录 `/tmp/rfc547-r7-05-probe/` 声明四种item field、两个phase、同一chain source不同fallback：

- p1：`S=item.s,N=item.n,B=item.b,J=item.j,X=chain.shared default 7`；
- p2：`RENAMED=item.s,X=chain.shared default false`。

脚本 `/tmp/rfc547-r7-05-probe.ts`；输出 `/tmp/rfc547-r7-05-probe-output.jsonl`；stderr `/tmp/rfc547-r7-05-probe-error.log`。

```sh
bun /tmp/rfc547-r7-05-probe.ts \
  > /tmp/rfc547-r7-05-probe-output.jsonl \
  2> /tmp/rfc547-r7-05-probe-error.log
```

退出码0。

### B9.2 Compile观察

- compile kind=`compiled`，findings空；
- S/N/B/J/X以及p2 RENAMED/X全部投影为`type:"string"`；
- 只保留对应 `sourceKind`；
- compiler未报告同一`chain.shared`的number/boolean fallback差异。

### B9.3 Render观察

| `item.j` | p1 | p2 |
|---|---|---|
| null | `text|42|true||7` | `text|false` |
| `{deep:{array:[1,true,null,"x"]}}` | throw `item.j: cannot stringify value of type object` | `text|false` |
| `[1,{x:false}]` | throw同上 | `text|false` |

该probe直接覆盖boolean/number文本化、JSON null坍缩、nested object/array失败、同source局部fallback异型与public projection失真。它不覆盖R7-06的daemon create/update副作用，也不代表首批`ValueType` variant决策。

## B10. 测试覆盖、同错与盲区

### B10.1 现有正向资产

- compile projection boundary/round-trip与determinism测试证明当前shape稳定；
- parse-schema测试证明doc字段parse/render泛化；
- prompt binding测试覆盖number/boolean文本化与chain fallback；
- runtime-data/migration测试证明generic JSON remainder保真。

### B10.2 同错

- compile测试只断言sourceKind并接受固定string，不能发现真实type丢失；
- prompt测试把number/boolean→string当预期，没有结构ValueType/explicit projection；
- bundled测试把default `""`与no-crash当兼容目标；
- `ISSUE` selector使doc测试没有完全按声明寻找样本；
- generic JSON round-trip只证明存储安全，反而绕过source schema。

### B10.3 盲区

- 四种item type与实际值的正反矩阵；bundled无boolean/json声明；
- nested record/array/union/nullable的公共shape与consumer traversal；
- same source跨phase target expectation冲突；
- source path、required/default/projection/owner在compile JSON的真实性；
- 独立consumer不import coder-loop源码解释projection；
- `exit.*` payload、agent owner、防覆盖与typed pending；
- runtime产生值解析失败后的明确状态；
-同一doc声明仅改key的bundled级逐字节等价守护。

## B11. 事实支持的所有 solution-shape 约束与确定后果（不作推荐）

以下不是方案列表，而是地面事实对后续裁决施加的约束：

1. 任一统一类型面必须覆盖item、chain、runtime与agent-owned path输入；只扩item四词会保留三通道分裂。
2. source path与source type必须可关联；只投影`sourceKind`无法检测same-source冲突或让consumer定位值。
3. nullable、missing与合法空串当前可观测地坍缩；任何后续语义必须明确三者关系，否则历史空串不能无歧义解释。
4. generic存储已容许任意递归JSON，而render只容许scalar；公开类型域若包含结构值，文本projection必须成为显式可消费事实，不能从`json`猜测。
5. chain fallback是per-binding局部值，同一underlying source可异型；若source schema为唯一权威，fallback兼容性必须有可比较的source证据。
6. 同source跨phasealias与doc差异是现存正常形态；类型一致性不能误把key重命名或doc差异当冲突。
7. public projection是版本化独立边界；canonical增加字段而projector仍删除它们不会改善外部consumer事实。
8. schema artifact只能描述已投影shape，不能恢复projector丢失语义；R7-04分发与本片投影真实性是两个独立条件。
9. runner stdout/stderr不是typed result通道；任何agent-owned值若存在，必须与日志、exit code及item status/action的现存控制面区别开。
10. phase exit ADT当前只表达控制选择；增加payload会影响声明、CLI query/write、持久化、scheduler readiness及consumer，而非只扩prompt变量。
11. doc product与renderer已有声明驱动资产；类型权威变化仍需保持doc字段从parse到render贯穿，不能恢复按业务key分支。
12. bundled只有string/number样本，不能作为boolean/json/结构variant的行为证明；fixture与独立consumer证据不可省略。

## B12. 证据索引

| 主题 | 证据 |
|---|---|
| outer boundary/public projection boundary | `src/loop.ts:508-583` |
| source/doc/exit domain shapes | `src/loop.ts:660-710` |
| runtime binding string面 | `src/loop.ts:1240-1302` |
| compile projector/CLI | `src/loop.ts:2900-3002` |
| variable/item/source/doc parse | `src/loop.ts:4788-5037,5192-5203` |
| prompt/doc resolve与stringify | `src/loop.ts:5778-5835,6008-6080` |
| generic JSON/remainder | `src/runtime-data.ts:341-447,575-595,658-663,755-763` |
| stdout verdict退役 | `src/loop.ts:1196-1204` |
| runner output/completion | `src/scheduler.ts:1940-2165,2309-2310,3298-3376` |
| projection tests | `tests/unit/preset/compile.test.ts:19-46` |
| doc selector/general parse tests | `tests/unit/preset/load-bundled.test.ts:217-233`; `tests/unit/preset/parse-schema.test.ts:33-97` |
| source inventory | `/tmp/rfc547-r7-05-inventory.ts`; `/tmp/rfc547-r7-05-inventory.jsonl`; `/tmp/rfc547-r7-05-summary.jsonl` |
| compile/render probe | `/tmp/rfc547-r7-05-probe.ts`; `/tmp/rfc547-r7-05-probe-output.jsonl`; `/tmp/rfc547-r7-05-probe-error.log` |

## B13. 尾部结论

**R7-05 尾部结论：现存 binding 数据面由未被消费的 item 四词、无类型的 source/doc/fallback canonical binding、开放递归 JSON 存储和 scalar-only renderer构成；它们没有共同类型权威。五个 bundled preset 的154个引用只覆盖string/number item声明，不能证明boolean/json/结构语义。公共projection把所有变量固定为string且删除path、fallback、required、doc与owner；仓内只有CLI生产该实例，外部consumer仍未知。隔离probe证明nested JSON会在render失败、null会变空串、同一chain source可跨phase采用number/boolean fallback而compile不报冲突。runner输出与phase exit也没有agent-owned result object或`exit.*` payload。因此D2类型权威、公开结构与agent数据边均无现存闭环；doc product/renderer、source ADT及generic JSON保真只可作为局部资产。**

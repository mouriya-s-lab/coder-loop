# RFC #547 R4/S2：binding 类型流与声明驱动消费者供给深审

> 调查基线：`main`，`699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 设计锚点：`AGGREGATE-547.md` §2 C–F、§2.2、§2.3、D2、D6、D11；`04-r3-supply-slicing.md` S2、B2、B7  
> 调查边界：只审现存供给；未修改产品代码、测试、配置、数据库或 workflow，未创建 worktree，未启动 daemon。

## A. 主 agent 摘要（最多一页）

### A1. 问题

现存供给能否形成 `source schema → binding → create-time admission → render/doc projection` 的精确类型链，并满足稳定 RFC D2/D6、§2 C–F 与代码红线？

### A2. 结论与置信

**结论：核心类型流不符合；doc renderer 的生产实现大体符合 D6，但其声明 boundary 和测试仍只部分符合。高置信。**

- D2 七项中：P-D2-1/2/3/4/5 **不符合**；P-D2-6/7 **无现存供给**。
- D6：P-D6-1、P-D6-2 的生产实现 **符合**；P-D6-3 因 `variables = "object"` 宽 boundary、手写 `ParsedVariableBinding` 和测试按 `ISSUE` 选取而 **部分符合**。
- §2 C/D **不符合**，E **符合**（没有 `computed`），F **部分符合**；§2.2 精确类型链红线 **不符合**，但外部 TOML/daemon JSON 的最外入口确实以 `unknown`/`BoundaryValue` 开始解析；§2.3 **不符合**，因为已有 chain/item 值不在 create/update 最早阶段按 source schema 验证，缺失拖到 render 且可伪造成空串。

### A3. 因果链

1. `[item.fields]` 有独立四词类型表，但其 `type` 在 parse 后没有生产消费者；chain binding 是开放 `JsonObject` remainder，runtime 全部压成 string。
2. `[phases.variables]` boundary 仅为 `"object"`；binding parser 只产出 source kind/path、chain scalar fallback 和 doc，不携带 source type、required 或 typed default。
3. compile projection 无条件写 `type: "string"`，只投影 `sourceKind`，丢失 source path、default、doc 和 required。
4. `chain.create` 不加载 preset 来核对 required chain bindings；`item.add/batch-add/update` 虽加载/定位 preset，却不消费 `[item.fields].type` 验证 extra 的声明字段或完备性。
5. render 把 item/chain 的 `null | undefined` 统一变成 `""`；结构值抛错，既无 canonical JSON projection，也没有穷尽的 ValueType/source-schema 决策。
6. doc renderer 本身逐条消费 `variable.doc`，没有业务 key 分支；但 boundary 与核心 binding 仍非同一精确声明链，bundled 测试还用 `candidate.key === "ISSUE"` 找目标。

### A4. 影响类别

- **错误阶段**：定义期可知的 default/type compatibility 未校验；实例期可知的 required/type 未拒绝；失败推迟至 render。
- **静默伪造**：缺失 item/chain 值成为空串，无法区分合法空串、缺值和显式 default。
- **公共投影失真**：第三方看到固定 string，不可能只靠 compile JSON 理解 number/boolean/json、required/default/owner。
- **双重类型词表**：`PresetItemFieldType` 与 binding 固定 string 并存，前者不约束存储/渲染。
- **声明驱动资产局部可保留**：doc ADT、parse-time doc 字段校验、renderer 和 bundled `prefix="#"` 声明属于可保留资产，但不能证明 D2。

### A5. 可保留资产

- `PresetVariableSource` 的 item/chain/runtime tagged union 与 source grammar/known-item-root/runtime ownership 校验。
- `PresetVariableDoc` 的非 optional product shape；`label` 门控装饰字段；`prefix/suffix/style/blankBefore` 的归一化。
- `renderRuntimeInputsDoc` 只读声明结构并逐变量渲染；生产 `src/` 无 `=== "ISSUE"`。
- daemon 请求先解析 JSON 为 `unknown`，TOML 也以 `BoundaryValue=unknown` 进入 boundary。
- item extra、chain metadata 的 request/stored parse 和 SQLite migration 具备 JSON 安全/恢复资产；它们尚未成为 RFC source-schema admission。

### A6. 未知

- S5 所称外部 `bindings.json` 的生产者/消费者不在本片 repo 现存供给中；本片只能判定 coder-loop 未提供 typed prompt bindings artifact，不能判外部实现。
- D11 冻结 SHA 的 V-R3/V-R4/V-R12 未运行；现存代码已足以证伪其前置供给，综合验收仍归未来 owner。

### A7. 接缝

- **S1**：canonical model 保留 doc/source union，但公共 projection 固定 string 且删去 source path/default/doc/required。
- **S3**：没有 `exit.*` source、typed transition input 或 agent-owned schema可交付；现有 phase exit ADT 是控制流，不是 D2 数据边。
- **S4**：runtime doc 的特殊 computed builders 仍按 runtime key switch；与 tool/gate 声明面无 typed binding 共享供给。
- **S6**：chain/item wire 与持久化接收开放 JSON；没有 create-time source-schema admission。历史 remainder/migration 保真不等于类型正确。

### A8. 下一步

主 agent 应把本报告作为 R4 的“现存供给符合性”输入：保留 doc 声明驱动资产，将 D2 主链与 D6 boundary/测试缺口交给后续需求侧裁决；本报告不设计补齐、不估规模、不重拆 issue。

---

## B. 证据附录

## B1. 稳定条款逐项判定

| 条款 | 判定 | 现存事实 |
|---|---|---|
| §2 C / P-D2-1 source schema 唯一权威 | **不符合** | item 有独立四词表但 type 无生产消费；chain 无 source schema；runtime string-only；binding 不携带类型。 |
| §2 D / P-D2-2 无静默降级 | **不符合** | `stringifyBindingValue(null/undefined) => ""` 同时覆盖 item/chain；最小实验复现。 |
| P-D2-3 最早可决定阶段 | **不符合** | chain create 不按 preset binding 验证；item add/update 不按 `[item.fields].type`/required 验证；render 才解析缺失/结构值。 |
| P-D2-4 公共结构类型 | **不符合** | 无递归封闭 ValueType；compile JSON 固定 string；json 值不能 canonical projection，render 对 object/array throw。 |
| P-D2-5 projection 真实 type/required/default | **不符合** | projection 仅 `{key,type:"string",sourceKind}`。 |
| P-D2-6 `exit.*` 同一类型流 | **无现存供给** | source union/grammar仅 item/chain/runtime；全 repo 无 binding `exit.*` 声明。 |
| P-D2-7 source owner/防伪/typed pending | **无现存供给** | 无 exit owner/schema/transition input；现有 runtime ownership 只区分 engine/preset business key，不是该保证。 |
| §2 E 不加 computed | **符合** | binding source union无 computed；businessKey value union仅 literal。 |
| §2 F / P-D6-1 doc 完全声明驱动 | **符合（生产）** | renderer 只迭代 `phase.variables`、读 `variable.doc` 与 `variable.source`；`src/` 无 ISSUE selector。 |
| P-D6-2 prefix + bundled migration | **符合（现存生产）** | doc product含 prefix；bundled preset显式 `prefix="#"`；测试覆盖实际渲染。 |
| P-D6-3 doc 字段贯穿 typed parse/render | **部分符合** | parse后为精确 `PresetVariableDoc`，renderer消费它；但 TOML variables boundary仍是宽 object、binding union手写，测试仍按 ISSUE key 选择。 |
| §2.2 unknown 只在边界 | **部分符合** | TOML/daemon JSON入口用 `BoundaryValue=unknown`；但 `variables="object"` 后手工 optional-field读取，daemon另有 `as JsonObject`，没有全链精确 ADT。 |
| §2.2 全链 ADT、禁止类型退化 | **不符合** | item field type在边界后失去约束，chain/render回到 `JsonObject`/string，projection固定 string。 |
| §2.3 验证阶段 | **不符合** | compile未判 default compatibility，create/update未判实例值，render静默补空。 |

## B2. 全生产入口与消费者盘点

### B2.1 source declarations

1. **item source**
   - 声明入口：`PresetTomlBoundary.item.fields` 只是 `object`（`src/loop.ts:508-513`）。
   - 词表：`PRESET_ITEM_FIELD_TYPES = string|number|boolean|json`（`src/loop.ts:443-459`）。
   - parser：`parsePresetItemFields` 将 boundary 值变成 `ReadonlyMap<string, PresetItemField>`（`src/loop.ts:4913-4938`）。
   - 实际用途：`isKnownPresetItemField` 只判断 root 是否存在（`src/loop.ts:4989-4991`）；repo 搜索显示 `PresetItemField.type` 无生产读点。
   - 存储值：任意安全 JSON 进入 `extra` remainder（`src/runtime-data.ts:409-447, 575-594`）。

2. **chain source**
   - CLI `--config-json` 归一化为开放 `JsonObject`，仅拒绝 nested object；array 仍允许（`src/loop.ts:5538-5558`）。
   - metadata parser 将 bindings 已知字段 `presetPath` 外全部保存为 remainder（`src/runtime-data.ts:98-104, 587-595, 730-733`）。
   - 没有 preset-level chain schema；phase binding 首次出现的 `chain.<field>` 只是字符串路径。

3. **runtime source**
   - engine runtime key 由常量 tuple 提供，类型全部 string；业务 key 只声明名字，literal 也只允许 string（`src/loop.ts:736-751, 1240-1273, 4941-4986`）。
   - `RuntimeBindings` 是 engine keys 的 string record 加开放 `Record<string,string|undefined>`（`src/loop.ts:1272`）。
   - runtime 缺值会 throw；此较 item/chain 严格，但仍无 ValueType。

4. **literal/default**
   - binding 没有 literal source variant。
   - 仅 chain binding 可声明 scalar fallback `null|boolean|number|string`（`src/loop.ts:113-117, 5003-5037`），没有和 source schema 做 compatibility 校验。

5. **exit source**
   - 无 binding source variant。`PresetVariableSource` 只有 item/chain/runtime（`src/loop.ts:660-668`）。
   - phase `PresetPhaseExit` ADT（item-status/chain-action）属于控制流，不携带 path-specific typed payload（`src/loop.ts:684-698`）。

### B2.2 binding parser/model

- TOML 外边界把 `phases[].variables` 定义为 `"object"`（`src/loop.ts:556-572`）；不是 named ArkType binding boundary。
- parse 顺序是 `BoundaryValue → ParsedVariableBinding{source:string,doc,chainFallback} → parseVariableSource → PresetVariableSource`（`src/loop.ts:4793-4819, 4907-4911, 5003-5031, 5192-5203`）。
- `ParsedVariableBinding` 是手写 product，其中 required、type、target expectation 均不存在。
- source grammar有封闭 prefix，但 source field/key为开放 string；新增 source prefix必须改 regex和 kind parser，现有消费者若收到新 variant会触发 TS，但这不等于 ValueType variant穷尽。
- chain fallback 是 tagged union，doc 是 `PresetVariableDoc|null`，这两处比 optional soup 更精确；但总体 binding 没有 RFC 要求的 `required|typed default` ADT。

### B2.3 compile/canonical/public projection

- `CompiledTaskModel = Preset & sourceDir/sourceHash/tasks`，因此 canonical 内存模型继承现有 source/doc/fallback，但不产生 ValueType/required（`src/loop.ts:780-787`）。
- 公共 boundary强制每个变量 `type=unit("string")`，只允许 sourceKind item/chain/runtime（`src/loop.ts:533-583`）。
- projector无条件构造 `{key,type:"string",sourceKind}`（`src/loop.ts:2935-2958`）。
- 实验 `/tmp/rfc547-s2-compile.json`：真实 bundled preset 的 ISSUE 声明来自 `[item.fields] issue="number"`，compile projection仍为 `{"key":"ISSUE","type":"string","sourceKind":"item"}`；变量字段集合仅 key/type/sourceKind。
- 因 source path、doc、default、required 均不在 projection，独立消费者无法判断 `item.issue` 与其他 item source，也无法判值 owner/缺失策略。

### B2.4 create/update admission 与事务时点

1. **chain create**
   - `handleChainCreate` 只校验请求 known keys、name/repository/baseBranch、generic metadata，再立即 `store.createChain`（`src/daemon.ts:2166-2219`）。
   - 它没有加载所选 preset 并遍历 phase bindings；required chain 值、source type/default compatibility均未判。
   - 注释称“Preset's own arktype boundary for bindings shape rejects malformed entries”，实际 runtime-data 的 chain bindings仅识别 presetPath，其余 remainder开放保存（`src/daemon.ts:2189-2192` 对照 `src/runtime-data.ts:587-595`）。这是声明与实然不一致的证据。

2. **item add**
   - 单条和 batch 都在写入前加载/定位 per-item preset，主要用于 rights/default status/idField（`src/daemon.ts:2887-2918, 2940-2978, 3001-3057`）。
   - `buildCreateItemInput` 把 caller extra 交给通用 JSON 安全 parser，未遍历 `preset.item.fields` 检查 required 或类型。
   - batch 在所有 input 构造后才 `createItems`，具备整批事务资产；但错误类型未被 binding schema发现。

3. **item update**
   - update 在 store write 前完成 caller/rights及少量硬编码字段校验（`src/daemon.ts:3104-3197`）。
   - `extra.branch`、`extra.pr` 仍由字面量特判验证（`src/daemon.ts:3156-3183`），没有消费 `[item.fields]` 声明。这是同一问题边界上的硬编码消费者。
   - 其他 declared item field只有 JSON安全/depth校验；不存在 `"number"`/`"boolean"`/`"json"` 的声明驱动 update admission。

4. **失败与副作用**
   - generic request错误在 store写入前发生，batch也先收集 inputs；这些是可保留事务资产。
   - binding missing/type failure根本没在 create/update产生，因此无相应 structured `invalid_request`/audit；它在后续 render静默空串或普通 `Error`。

### B2.5 runtime substitution

- 两条生产 spawn路径最终都调用 `renderPrompt`：legacy/main-loop处 `src/loop.ts:5467-5481`，scheduler处 `src/scheduler.ts:3142,3197`。
- `renderPrompt` 建 key→source map，doc/default/required不进入替换选择（`src/loop.ts:5778-5803`）。
- `resolveBinding`：
  - item查物理 engine field或 extra nested value；
  - chain取开放 JsonObject，缺失时用 fallback；
  - runtime走 declared ownership guard和 string map（`src/loop.ts:6017-6055`）。
- `stringifyBindingValue` 对 `null|undefined` 返回 `""`；string/finite number/boolean用隐式文本化；array/object抛 `cannot stringify`（`src/loop.ts:6075-6080`）。
- error只点 source label，不点 phase binding key；因此即便 object抛错，也不满足 P-D2-2 “点名 binding key 与来源”。
- 没有 canonical JSON renderer；`json` item field恰恰最容易在真实值为 object/array时抛错。

### B2.6 doc projection

- parse边界：
  - 未给 label却给 prefix/suffix/style/blankBefore会 load-time拒绝；
  -给 label后归一化全部字段为非 optional product；
  - unknown binding field被拒（`src/loop.ts:4993-5031`）。
- renderer逐变量读取 `doc`，为空则跳过；值仍由同一个 `resolveBinding(variable.source)`取得；格式完全由 prefix/style/suffix/blankBefore决定（`src/loop.ts:5824-5835`）。
- `rg '=== "ISSUE"|key === "ISSUE"' src tests`：`src/` 无命中；测试在 `tests/unit/preset/load-bundled.test.ts:217-233` 用 `candidate.key === "ISSUE"` 选择被测绑定。
- 声明驱动的泛化测试存在：两个不同 key、相同 doc声明由 parse/render产生声明效果（`tests/unit/preset/parse-schema.test.ts:33-55`）；这证明 renderer资产，但 bundled迁移守护仍绑定业务 key。
- bundled preset确有显式 prefix：
  - `presets/gh-issue-pr-iteration/preset.toml:92,193,244`
  - `presets/real-e2e-minimal/preset.toml:41,62`

### B2.7 其他按 key/source 字面量消费者

- `resolvePhaseBinding` 对若干 engine runtime doc key做 switch（`src/loop.ts:5806-5821`）。这些是 engine-owned computed runtime facts，不是业务 variable key分支；但它说明 runtime source仍非统一 ValueType流。
- `phaseDeclaredRuntimeBindingPaths` 按 runtime source key列举 filesystem path权限（`src/loop.ts:1286-1302`）。这是授权消费者，新增 runtime path key不会由 generic type自动覆盖。
- `buildRuntimeBindings`用大量 `?? ""` 构造动态 runtime facts（`src/loop.ts:6126-6181`）；这类空串可能是该 engine fact既定表达，但没有 typed pending/required语义可供消费者区分。

## B3. 精确类型证据在模块/存储/API 的丢失点

| 边 | 输入证据 | 输出 | 丢失 |
|---|---|---|---|
| TOML → item schema | string/number/boolean/json 词 | `PresetItemField{type}` | 暂未丢失，但随后无人消费 |
| TOML variables → binding | raw source/default/doc | `PresetPhaseVariable` | 无 required/type/target expectation；default与source schema未关联 |
| canonical → public compile JSON | source union + doc + fallback | key/string/sourceKind | source path/doc/default/required全部丢失，type伪固定 |
| CLI/daemon → chain storage | `JsonObject` | ChainBindings remainder | 无声明类型证据进入 |
| CLI/daemon → item storage | `JsonObject` extra | ItemExtra remainder | preset item field type未应用 |
| storage → render | JsonValue | string | null/undefined坍缩为空串，number/boolean文本化，structure抛错 |
| binding → runtime doc | source + doc | markdown string | doc字段保留；值侧仍继承上述坍缩 |

因此这不是“精确类型链部分断裂”，而是**存在三条并行且不相接的类型/形状通道**：

1. item field四词表（声明后基本只作 known-root目录）；
2. binding source/doc/fallback模型（无ValueType/required）；
3. generic JsonObject持久化 + string renderer。

这是调查中发现的复杂根因；没有第四种生产类型流。runtime engine facts的 string tuple属于第2/3条交界，不构成第四种公共 ValueType系统。

## B4. 外部 unknown、断言与红线

- `BoundaryValue` 明确定义为 `unknown`（`src/boundary-types.ts:1-2`）。
- TOML parse结果先落 `BoundaryValue`，再经 `PresetTomlBoundary.assert`/`parsePreset`（`src/loop.ts:4614-4627, 4711`）。
- daemon JSON先 `JSON.parse` 为 `unknown`，再确认 record（`src/daemon.ts:5005-5013`）。
- 但是 binding outer boundary只验证 variables为 object，不把每项解析成 named union；随后以 `isObjectRecord` + `Object.hasOwn`手工读取 optional字段。这满足“入口先 unknown”的最低边界卫生，不满足“外部输入立即解析为精确类型后贯穿”。
- daemon的 `handleChainUpdateBindings` 对已确认 object仍使用 `as JsonObject`（`src/daemon.ts:2626-2642`）；虽非核心 phase binding入口，仍说明全仓红线尚未成立。
- source ADT本身没有 default分支的 exhaustiveness问题；真正的逃逸是 `stringifyBindingValue`对所有 missing统一catch-all，以及 `JsonObject` remainder允许任意字段绕过声明。

## B5. migration、历史 preset、恢复路径

1. **bundled/historical preset**
   - gh preset声明 `issue=number`, `branch=string`, `pr=number`, `lastRunId=string`；real-e2e声明 `issue=number`；engine integration声明 `key=string`。
   - 所有 phase compile projection仍固定 string，故 migration后的真实 number source不公开。
   - gh preset多个 optional chain值显式 default `false`/`""`，说明现存作者依赖 fallback；没有 required默认语义。

2. **SQLite/runtime migration**
   - runtime-data用 remainder保留未知 chain bindings/item extra并可 round-trip（`src/runtime-data.ts:57-65, 98-104, 417-447, 714-719`）。
   - migration把历史 issue/branch/pr放入 current extra/bindings；对应测试位于 `tests/unit/sqlite-state/migrations.test.ts:691-797`。
   - 这保证历史数据不丢，却不能证明类型有效：stored parser仍只做 generic JSON/少量engine字段解析，未用当前 preset source schema重验证。

3. **恢复**
   - scheduler重启后从 item extra/chain metadata构造同一 `ResolveContext`，因此恢复继续沿开放 JSON→string renderer，不会补做create-time admission。
   - 历史缺字段会在 item/chain render被变成空串；runtime缺值可能throw。恢复语义因此仍三套不一致。

## B6. 最小实验

### E-S2-1：缺失 item/chain/runtime 的真实 resolve 结果

命令（repo root，未创建文件）：

```sh
bun -e 'import { resolveBinding } from "./src/loop.ts"; import { makeItem, makePreset, makeRuntime } from "./tests/unit/loop/helpers.ts"; const ctx={item:makeItem(),chain:{},runtime:makeRuntime(),preset:makePreset()}; /* 分别调用 missing item/chain/runtime */'
```

观察：

```text
{"kind":"item","field":"missing"} => ""
{"kind":"chain","field":"missing","fallback":{"kind":"none"}} => ""
runtime THREW runtime.missing: not an engine runtime fact or preset-declared business key
```

结论：R2内部修正已复核；**chain missing与item missing都静默空串**，runtime走另一失败语义。

### E-S2-2：真实 bundled compile projection

命令：

```sh
bun src/loop.ts preset compile presets/gh-issue-pr-iteration --json \
  > /tmp/rfc547-s2-compile.json
```

观察：iteration前八个变量全部 `type:"string"`；ISSUE也只有：

```json
{"key":"ISSUE","type":"string","sourceKind":"item"}
```

而 source声明为 `issue = "number"`。变量投影字段只有 `key,type,sourceKind`。

临时文件登记：`/tmp/rfc547-s2-compile.json`，只含本地 compile公共JSON投影，无凭据、无数据库状态；未写其他 `/tmp/rfc547-s2-*` 文件。

## B7. 测试同错与盲区

### B7.1 同错

- `tests/unit/preset/compile.test.ts:24-32` 只断言 public `sourceKind` 为 item，没有断言真实 type/required/default/source path；固定 string可以全绿。
- `tests/unit/loop/prompt-bindings.test.ts:89-103` 明确守护 number→string、boolean→string及chain default，却没有 missing item/chain must throw 断言。
- `tests/unit/preset/load-bundled.test.ts:237-241` 明确把 default `""` 及“no crash”当兼容性目标；这是稳定 D2 新要求下的同错证据，不是符合证据。
- `tests/unit/preset/load-bundled.test.ts:217-233` 用 `key === "ISSUE"` 选择 doc binding，未证明换名不变。
- item admission集成测试大量覆盖generic JSON safety、rights及branch/pr硬编码校验，但没有用 `[item.fields].type`驱动 add/update拒绝。

### B7.2 正向但范围有限

- `tests/unit/preset/parse-schema.test.ts:33-55` 证明 doc字段解析/渲染不依赖 ISSUE语义。
- `tests/unit/preset/parse-schema.test.ts:58-97` 证明缺 label与unknown doc字段在load边界拒绝。
- generic daemon事务测试可证明错误不产生部分写，但没有制造RFC binding schema错误，不能证明create-time admission。

### B7.3 缺失覆盖

- required chain/item缺值在 create/add/batch-add 的拒绝与结构化 diagnostic。
- item field四类型在 add/update 的正反例。
- typed default与source compatibility。
- json canonical projection及真实 spawn。
- compile JSON中的递归ValueType、required/default、source owner。
- exit.* owner/防伪/typed payload。
- 同doc声明仅改业务key后逐字节等价的 bundled级守护（V-6a意图）。
- migration旧值不合当前schema时的恢复/阻断语义。

## B8. 相邻片接缝证据

| 接缝 | 本片交付事实 | 对方需核对 |
|---|---|---|
| S1 ↔ S2 | canonical变量来自 `PresetPhaseVariable`; public projector在 `src/loop.ts:2945`固定string并删去声明细节 | S1确认该projection是否仍是唯一公共DTO；不能把round-trip boundary等同真实类型 |
| S2 ↔ S3 | 无exit.* source、agent-owned schema、typed transition input；现有phase exit仅控制流 | S3检查readiness/commit是否只有status/runner completion信号，不能声称消费typed数据边 |
| S2 ↔ S4 | runtime doc/guidance由engine runtime key switch计算；binding没有tool/gate ValueType共享面 | S4不得把“可在prompt显示字符串”当capability声明/执法供给 |
| S2 ↔ S5 | coder-loop没有typed `bindings.json`落盘供给；prompt只有最终string | S5若找到外部artifact，应证明其生产者不是从失真compile projection猜类型 |
| S2 ↔ S6 | chain/item generic JSON wire和SQLite remainder是真实入口；无preset-driven admission | S6检查其通用入口/迁移资产，不把generic安全parse冒充source schema parse |
| S2 ↔ D11 | V-R3/R4/R12及V-2a…g多数没有现存owner/供给 | D11未来冻结SHA运行；R4不提前执行或以局部绿测替代 |

## B9. 证据索引

| 证据 | 位置 |
|---|---|
| 宽 TOML boundary与固定 compile variable boundary | `src/loop.ts:508-518, 533-583` |
| source/doc/binding domain shapes | `src/loop.ts:660-682, 736-751, 877-879` |
| runtime string type | `src/loop.ts:1240-1273` |
| parse variable/source/default/doc | `src/loop.ts:4788-4819, 4907-5037, 5192-5203` |
| compile projection失真 | `src/loop.ts:2900-2959` |
| chain create无schema admission | `src/daemon.ts:2166-2219` |
| item add/batch/update事务与缺失schema消费 | `src/daemon.ts:2887-3197` |
| branch/pr字面量校验 | `src/daemon.ts:3156-3183` |
| generic request/stored JSON parse | `src/daemon.ts:5005-5112`; `src/runtime-data.ts:341-447, 511-595` |
| render空串/structure throw | `src/loop.ts:5778-5835, 6017-6080` |
| runtime/doc computed消费者 | `src/loop.ts:1286-1302, 5806-5821, 6126-6181` |
| bundled doc declarations | `presets/gh-issue-pr-iteration/preset.toml:92,193,244`; `presets/real-e2e-minimal/preset.toml:41,62` |
| doc test selector与泛化测试 | `tests/unit/preset/load-bundled.test.ts:212-233`; `tests/unit/preset/parse-schema.test.ts:33-97` |
| projection测试盲区 | `tests/unit/preset/compile.test.ts:19-32` |

## B10. 明确排除

- 未设计 ValueType variant、json呈现、required/default语法或transition payload。
- 未裁决 S3调度/commit、S4 capability执法、S5外部prompt落盘、S6通用原语的最终符合性。
- 未运行 D11整链路integration或real E2E。
- 未以 issue、commit、marker、绿测代替设计条款判定。

---

**尾部结论：现存 binding 供给由“未被消费的 item 四词类型表、无类型的 source/doc/fallback binding、开放 JSON 持久化与 string renderer”三条不相接通道组成，不能形成稳定 RFC D2 的精确类型链；create/update admission缺席且 item/chain missing 均静默 `""`。D6 的生产 renderer与 prefix迁移是可保留资产，但 binding outer boundary与 bundled测试仍未完全声明驱动。**

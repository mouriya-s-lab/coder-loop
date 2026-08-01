# RFC #547 R4/S4：capability 注册、gate/tool 声明与执法握手供给深审

> 调查基线：`main`，`699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 设计锚点：`AGGREGATE-547.md` §2 G/H、D4、D5、D11；`04-r3-supply-slicing.md` S4、B2、B7  
> 边界：只审现存供给；未修改产品代码、测试、配置、WORKFLOW 或数据库，未创建 worktree，未启动/访问中央 daemon。

## A. 主 agent 摘要（最多一页）

### A1. 问题

现存 capability 注册、gate/tool 声明与执法握手，是否分别满足稳定 RFC D4/D5、§2 G/H；声明能否经 compile 投影进入 doctor/prompt/runtime 授权与执法消费者，而不是只有空 shape 或旁路 carrier？

### A2. 结论与置信

**高置信结论：D4 tool registry 全部无现存生产供给；D5 preset gate 声明/投影/握手无现存生产供给。仓内另有可保留的四层 hook declaration foundation，但它既不是 D4 tool 模型，也不符合 D5 gate 声明契约，且测试明确钉住“调度时永不执行”。**

- D4 P-D4-1…5：均为 **无现存供给**；其中 doctor 的 `gh` 硬编码使 P-D4-1/P-D4-4 的当前行为同时 **不符合**。
- D5 P-D5-1…4：均为 **无现存供给**。`PresetHookPlaceholder` 只有 TS type 和 caller-supplied effective-view carrier，没有 TOML boundary、canonical model、compile projection或runtime消费者。
- §2 G：**无现存供给**；provider/availability/outcome/enforcement 四轴均不可表达。
- §2 H 的 doctor/工具名份额：**不符合**；`src/install-commands.ts` 无条件 `whichBinary("gh")` 并运行 `gh auth status`。
- §2.2/2.4：hook declaration 自身是封闭 ADT且 unknown响亮失败，可保留；但 gate placeholder没有完整variant生命周期，compile projection中的 `tools:[]`/`toolRequirements:[]`只是空占位。

### A3. 决定性因果

1. preset TOML boundary没有 `tools`、`toolRequirements`或`gates`字段。
2. 最小实验表明这些字段不是响亮失败，而是被 ArkType boundary静默丢弃；compile成功后 `tools=[]`、`phase.toolRequirements=[]`，gate完全不可见。
3. public compile boundary/projector确有 tool空数组字段，但 canonical `Preset`/`PresetPhase`没有对应模型；空数组不是供给。
4. doctor始终检查 `gh`，不读取所查 preset的任何tool声明；prompt没有 `toolRequirementsDoc`；runtime没有 required-tool outcome finalization或错误出口。
5. hook foundation有 observer/gate script declaration、四层持久化/effective view，但没有脚本执行；preset placeholder只含 name+point，缺 required/optional、host identity，并且没有生产入口。
6. `GateDecisionPoint`是另一词表：含 `tick/item.status-transition/container.advance/chain.complete/daemon.*`，缺稳定 D5 的 `container.join`及host identity；不能将 point string等同“挂点已定位”。

### A4. 影响类别

- **静默旁路**：作者写入看似合法的 tools/gates声明，compile成功但声明被删除。
- **公共投影假象**：DTO字段存在且永远空，独立消费者无法区分“无声明”和“引擎未实现声明”。
- **零原语残留**：doctor把 GitHub工具与认证硬编码为所有preset的共同前提。
- **无握手**：含gate的模型既不会结构化 `unsupported-capability` 拒绝，也不会执行gate；实际上preset gate根本未进入模型。
- **identity断链**：gate point没有phase/node/join host identity，runtime树虽有identity也无引用边。

### A5. 可保留资产

- `HookDeclaration` observer/gate tagged union、严格 ArkType boundary、unknown字段/点/缺字段响亮失败、exhaustive serialization。
- global/chain/item hook存储与重启恢复；effective view保留source provenance。
- task runtime已有 `runtimeNodeId/definitionRef/definitionNodeId` identity资产，可作为S3接缝事实；现存gate不引用它。
- compile public boundary和唯一projector已有未来字段位置，但现值只能登记为空placeholder，不能计为D4供给。

### A6. 未知

- 外树 C6 是否已有真实tool outcome执法或gate脚本执行：本repo无生产调用证据，**无法由本片确定**；确定方法是外树owner给出从本repo声明DTO到执行/finalize结果的同一identity闭环及失败实验。
- S3完整树调度符合性不在本片；这里只确认现存runtime identity可表达、gate声明未引用。

### A7. 接缝

- **S1**：compile DTO的tools/toolRequirements为空placeholder；canonical无生产者。
- **S2**：没有 `toolRequirementsDoc` binding/runtime fact；不能靠散文或普通string binding代替registry。
- **S3**：task identity存在，gate point/placeholder无host identity；point name不足以定位run/container/join实例。
- **外树**：hook carrier/effective view没有执行握手；若外树有实现，必须证明不靠私有猜测。

### A8. 下一步

主 agent应在R4登记“D4/D5核心无供给、hook foundation可保留但不可冒充”；后续需求侧再裁决补齐边界。本报告不设计provider/outcome/gate脚本语义，不估规模，不重拆issue。

---

## B. 证据附录

## B1. Tool 符合性表（D4 / §2 G/H）

| 稳定条款 | 判定 | 证据 |
|---|---|---|
| P-D4-1 一表三消费（doctor/prompt/外树） | **无现存供给；doctor现状不符合** | 无registry canonical；无prompt doc；doctor硬编码gh。 |
| P-D4-2 provider/availability/outcome/enforcement四轴正交 | **无现存供给** | repo无tool domain type/boundary；四轴均不能声明。 |
| P-D4-3 required只依赖outcome、entry-existence封闭ADT | **无现存供给** | 无outcome/enforcement type、compile rule或runtime finalize。 |
| P-D4-4 doctor声明驱动 | **不符合** | `whichBinary("gh")`和`gh auth status`无条件执行。 |
| P-D4-5 tools与phase requirements真实投影 | **无现存供给** | projection boundary有空shape，projector硬写两个空数组。 |
| §2 H 工具名零原语 | **不符合** | doctor仍有gh字面量与GitHub专用提示/认证调用。 |
| unknown tool声明响亮失败 | **不符合** | 实验中完整`[[tools]]`与phase requirement被静默删除，compile exit 0。 |
| runtime required outcome失败出口 | **无现存供给** | 无事件、错误variant、status或finalize consumer。 |

### B1.1 四轴分别判定

| 轴 | 可表达性 | 生产入口/消费者 |
|---|---|---|
| provider (`engine|external`) | **不可表达** | 无type、boundary、canonical字段；实验字段被丢弃。 |
| availability | **不可表达** | doctor只做硬编码gh/runner/coder-loop检查，不读取registry。 |
| outcome | **不可表达** | 无`entry-existence`或其他outcome ADT；无结果持久化/判定。 |
| enforcement (`required|expected`) | **不可表达** | phase无toolRequirements模型；无compile合法性判定和runtime执法。 |

四轴不是“部分混在一个字段”，而是**全部缺失**。runner declaration/doctor runner检查是现有runner选择机制，不等同tool registry：它没有outcome/enforcement，也不是`[[tools]]`的provider定义。

## B2. Gate 符合性表（D5）

| 稳定条款 | 判定 | 证据 |
|---|---|---|
| P-D5-1 typed preset声明、重名/位置校验 | **无现存供给** | `PresetPhaseBoundary`无gates；placeholder无parser；实验声明静默删除。 |
| P-D5-2 投影gate点全集 | **无现存供给** | compile projection无gates字段；canonical也无。 |
| P-D5-3 runtime capability握手/unsupported | **无现存供给** | 无`unsupported-capability`错误；hook测试明确never execute。 |
| P-D5-4 point variant + host identity | **无现存供给** | placeholder仅name/point；point词表与稳定D5不一致且不携带identity。 |
| unknown/invalid声明响亮失败 | **部分符合于hook脚本，不适用于preset gate** | Hook parser会拒绝；preset gate字段被静默删除。 |
| 恢复后仍执法 | **无现存供给** | hook declaration会恢复，但无执行；placeholder不持久化。 |

### B2.1 Gate 与 tool 必须分开

- Tool设计是registry + requirement + outcome/enforcement四轴；仓内没有。
- Gate设计是命名decision point + required/optional + host identity + capability handshake；仓内没有。
- `GateHookDeclaration`是带script/onFailure的外层hook配置；它不是preset声明点。
- `PresetHookPlaceholder`是三字段TS carrier；它不是tool requirement，也没有生产解析/投影/握手。

## B3. 全入口、模型、投影与消费者

### B3.1 Preset TOML入口

`PresetPhaseBoundary`字段只有 name/prompt/runner/model/exits/variables/trigger/roles/rights；`PresetTomlBoundary`只有 name/item/runtime/statuses/phases/fragments/agent（`src/loop.ts:490-518`）。

因此不存在：

- top-level `[[tools]]`
- phase `toolRequirements`
- phase/tree `gates`
- provider/availability/outcome/enforcement boundary
- gate required/optional、point/host boundary

ArkType对象未设置undeclared-key reject；实验确认unknown字段被剥离，而非compile diagnostic。

### B3.2 Canonical model

- `PresetPhase`没有toolRequirements/gates（`src/loop.ts:714-728`）。
- `Preset`没有tools/gates（`src/loop.ts:739-779`）。
- `CompiledTaskModel`只是`Preset`加source/hash/tasks，无法凭空恢复被boundary删掉的声明（`src/loop.ts:780-787`）。
- 搜索 `toolRequirements` 的生产命中只有public boundary和projector常量空数组。

### B3.3 Compile projection

public boundary声明：

- `phases[].toolRequirements: string[]`
- `tools: {id:string}[]`

见 `src/loop.ts:533-583`。

唯一projector硬写：

```ts
toolRequirements: []
tools: []
```

见 `src/loop.ts:2935-2955`。

这两个shape不含provider/availability/outcome/enforcement，即使非空也不足以满足P-D4-2/5。projection完全没有gate集合、point或host identity。

### B3.4 Doctor

`checkOperatorPrereqs`在读取任何preset tool registry之前：

1. `whichBinary("gh")`
2. 找到后`spawnCapture("gh", ["auth","status"])`
3. 再检查phase runner和coder-loop

见 `src/install-commands.ts:138-169`。

`runDoctorCommand`只从status取phase runners并调用上述函数（`src/install-commands.ts:272-300`）。即使fixture/preset无GitHub语义，也会检查gh；若传`--repo`还另跑`gh repo view`。没有“bundled preset显式声明gh”的现存声明。

### B3.5 Prompt/status

- repo无`toolRequirementsDoc` symbol或runtime binding。
- prompt renderer只处理phase variables和既有engine runtime doc builders，不读取tools。
- status snapshot无tool registry/requirements/outcome/gate声明；hook字段甚至被明确从item/run公开extra删除（`src/runtime-data.ts:438-443`；`tests/integration/daemon/hooks.integration.ts:117-163`）。
- public compile JSON是唯一带tool字段的外观，但值恒空且shape不真实。

### B3.6 Runtime授权/执法/错误出口

全repo搜索没有：

- `unsupported-capability`/`unsupported_capability`
- required-tool outcome finalization
- tool availability/outcome storage
- gate hold/advance execution调用
- preset gate实例化拒绝

现有daemon command rights/status gates是另一套授权机制；名字中含“gate”不等于D5声明gate。它们不消费preset gate point或tool registry。

## B4. Hook declaration foundation：可保留资产与边界

### B4.1 现存模型

`src/hook-declarations.ts:15-58`定义：

- observer hook：point/script/timeout
- gate hook：point/script/timeout/onFailure；tick另有minInterval
- preset placeholder：`{kind:"named-gate-placeholder",name,point}`
- effective hook四层：global/chain/preset/item，保留source provenance

Hook input使用严格ArkType `.onUndeclaredKey("reject")`，gate point为封闭enumeration，parser有assertNever，serializer对hook kind穷尽（`src/hook-declarations.ts:60-172`）。

### B4.2 生产入口与持久化

- global：`<loopDataRoot>/hooks.json`，version 1，daemon start读取；不存在允许空（`src/hook-declarations.ts:90-100`; `src/daemon.ts:1235-1244`）。
- chain：`metadata.hooks`经runtime-data parse/serialize并入SQLite。
- item：`extra.hooks`经同一parser/serializer并入SQLite。
- preset placeholder：**没有preset loader入口或持久化入口**；只由调用者传给`effectiveHookViewForItem`。
- effective view只是按global→chain→preset→item拼接（`src/hook-declarations.ts:138-145`; `src/daemon.ts:1215-1232`）。

### B4.3 执行事实

生产搜索中`effectiveHookViewForItem`没有调用点；只有测试直接调用。没有hook script spawn/execute函数。

`tests/integration/daemon/hooks.integration.ts:5-63`的测试名和断言明确是：

> “persist across all layers, reload on restart, and never execute during scheduling”

它创建会touch sentinel的global脚本，调度后断言sentinel不存在（行45-48）。因此四层carrier/effective view是**刻意的declaration-only foundation**，不得报成gate runtime供给。

### B4.4 授权

- agent writable control-plane字段集合显式包含`hooks`，默认拒绝；operator可经chain metadata/item extra写入（`src/daemon.ts:234`及field-write gate）。
- 这保护carrier不被任意agent改写，是可保留授权资产。
- 但“谁能写声明”不等于“声明被执行”；没有decision outcome、hold状态或审计event。

## B5. Gate host identity 与挂点可表达性

### B5.1 现存point词表

`GateDecisionPoint`有八个字符串：

- `run.pre-spawn`
- `run.post-exit`
- `item.status-transition`
- `container.advance`
- `chain.complete`
- `daemon.startup`
- `daemon.shutdown`
- `tick`

见 `src/hook-declarations.ts:15-27`。

### B5.2 与稳定D5的差异

稳定D5要求：

- `run.pre-spawn`/`run.post-exit`
- `container.join` + 稳定node id
- chain-complete引用顶层join identity
- point variant + host identity

现存词表：

- 有run前后字符串，但没有phase/task/run host identity字段；
- 是`container.advance`而非`container.join`；
- `chain.complete`没有顶层join identity；
- 额外含item/daemon/tick点，不能由本片裁决其未来去留；
- placeholder只有name/point，连required/optional都没有（`src/hook-declarations.ts:48`）。

所以“point enum存在”不构成P-D5-4部分实现；稳定契约的关键identity引用完全缺失。

### B5.3 S3提供的host identity事实

runtime task identity本身可表达：

```ts
runtimeNodeId
definitionRef
definitionNodeId
```

边界见 `src/task-runtime.ts:8-10, 66-68, 110`；daemon会按`runtimeNodeId`查persisted tree（`src/daemon.ts:817-818,1132-1142`）。

本片只得出接缝结论：**identity生产资产存在，但gate declaration/placeholder没有任何字段引用它，故无连接边。** 不评价树调度本身。

## B6. 未知声明、旁路、失败与恢复

### B6.1 Tool/preset gate unknown声明

不是响亮失败：实验完整声明被静默剥离，compile success。后果是required tool/gate等价于未声明，正中D5禁止的中间状态。

### B6.2 Hook unknown声明

严格失败：

- unknown gate point
- gate缺onFailure
- tick缺/非法minInterval
- unknown字段
- 空script/非正timeout

均由`parseHookDeclarations`拒绝；测试：`tests/unit/daemon/hook-declarations.test.ts:30-64`。

### B6.3 旁路

- compile boundary删除tools/gates是定义旁路。
- doctor绕过registry直接检查gh。
- preset placeholder由`effectiveHookViewForItem`参数传入，调用者可以构造任意type-correct列表，但没有来自compiled preset的权威来源。
- hook storage/effective view没有execution consumer，所有onFailure值在运行时无效果。

### B6.4 恢复

- global hook重启时重新读文件。
- chain/item hooks从SQLite恢复。
- integration测试证明恢复后carrier仍在（`tests/integration/daemon/hooks.integration.ts:50-59`）。
- 没有执行状态、decision fingerprint、hold/outcome持久化，因此恢复不能证明gate语义；它只证明声明carrier。
- preset placeholder不持久化，也不从preset重载。

## B7. 最小隔离实验

### E-S4-1：完整tool/gate声明是否响亮失败

临时fixture：

- `/tmp/rfc547-s4-fixture-1/preset.toml`
- `/tmp/rfc547-s4-fixture-1/run.md`

fixture包含：

```toml
[[tools]]
id = "probe-tool"
provider = "external"
availability = "path"
outcome = "entry-existence"

[[phases]]
toolRequirements = [{ tool = "probe-tool", enforcement = "required" }]
gates = [{ name = "approval", required = true, point = "run.pre-spawn" }]
```

命令：

```sh
bun src/loop.ts preset compile /tmp/rfc547-s4-fixture-1 --json \
  > /tmp/rfc547-s4-compile-1.stdout \
  2> /tmp/rfc547-s4-compile-1.stderr
```

观察：

- exit `0`
- stderr空
- projection `tools:[]`
- phase `toolRequirements:[]`
- 无gates字段、无finding/diagnostic

结论：unknown声明不是拒绝，而是被静默删除；空projection确为placeholder。

### E-S4-2：源码消费面闭包

命令：

```sh
rg -n 'toolRequirements|toolRequirementsDoc|unsupported-capability|effectiveHookViewForItem' src tests
```

观察：

- `toolRequirements`生产代码仅public boundary和硬编码空projector；
- 无`toolRequirementsDoc`或`unsupported-capability`；
- `effectiveHookViewForItem`生产定义仅一处，调用仅测试。

### 临时文件登记

- `/tmp/rfc547-s4-fixture-1/preset.toml`
- `/tmp/rfc547-s4-fixture-1/run.md`
- `/tmp/rfc547-s4-compile-1.stdout`
- `/tmp/rfc547-s4-compile-1.stderr`

均为本地隔离声明/compile输出，无凭据、数据库或daemon状态。另一次被命令安全策略拒绝的预备命令未创建可依赖产物；没有其他实验状态。

## B8. 测试同错与盲区

### B8.1 同错

- compile projection boundary/round-trip测试会接受tools与requirements恒空；没有fixture要求真实声明出现。
- hooks integration明确要求“never execute during scheduling”，所以它只能证明foundation，不能证明D5。
- effective view测试手工传入`PresetHookPlaceholder`（`tests/unit/daemon/hook-declarations.test.ts:11-20`）；绕过了不存在的preset loader/canonical/projection链。
- status projection测试要求hooks隐藏（`tests/integration/daemon/hooks.integration.ts:117-163`）；这可保护私有script路径，但也意味着没有公共gate观察面。
- doctor文档/测试把“gh + runner + coder-loop”写成固定operator prerequisites；这会让无GitHub preset仍绿，不证明声明驱动。

### B8.2 正向资产测试

- hook parser malformed matrix证明unknown/invalid hook声明响亮失败。
- global/chain/item round-trip和restart测试证明carrier持久化。
- exhaustiveness compile fixture守护HookDeclaration kind消费者。

这些测试均不覆盖preset gate或tool registry。

### B8.3 缺失覆盖

- provider=engine未知capability compile拒绝。
- required无outcome拒绝、required+entry-existence通过，且provider不影响判定。
- 两phase requirements各自prompt doc切片。
- 无gh preset doctor不查gh、bundled显式声明后才查。
- compile JSON真实tools四轴和phase requirement。
- gate重名/非法host-point compile拒绝。
- gate projection携带required/optional、point variant、host identity。
- capability缺失时实例化/调度结构化unsupported，且不spawn。
- hook/gate脚本真实执行、decision/hold/advance、副作用与恢复（若未来属于外树owner）。

## B9. 相邻片与外树接缝

| 接缝 | 本片事实 | 对方需交叉核对 |
|---|---|---|
| S1 ↔ S4 | public DTO有空tools/requirements，canonical无来源；gate投影不存在 | S1不得把schema字段/round-trip当真实供给 |
| S2 ↔ S4 | 无toolRequirementsDoc runtime binding；普通prompt散文不等于registry | S2的binding投影不能猜tool语义 |
| S3 ↔ S4 | runtime identity存在；gate point/placeholder不引用host identity | S3只交identity产生/持久化事实，不替gate补引用 |
| S4 ↔ S6 | hook carrier可在chain/item generic JSON持久化并受write gate保护 | S6不得把carrier持久化等同脚本执行 |
| S4 ↔ 外树 C6 | 本repo无outcome/gate执行或unsupported握手 | 外树若有实现需证明同一声明identity、失败不fallback |
| S4 ↔ D11 | V-R5/V-4*/V-5*现无完整owner供给 | 未来冻结SHA验收，R4不运行替代品 |

## B10. 证据索引

| 事实 | 位置 |
|---|---|
| preset boundary无tools/requirements/gates | `src/loop.ts:490-518` |
| canonical Preset/Phase无对应字段 | `src/loop.ts:714-779` |
| compile public空shape | `src/loop.ts:533-583` |
| projector硬编码空数组 | `src/loop.ts:2935-2955` |
| doctor硬编码gh | `src/install-commands.ts:138-169,272-300` |
| gate point与hook ADT | `src/hook-declarations.ts:15-58` |
| strict hook boundaries/parser | `src/hook-declarations.ts:60-136` |
| effective view/serialization | `src/hook-declarations.ts:138-172` |
| daemon四层view与global恢复 | `src/daemon.ts:1190-1244` |
| chain/item hook持久化 | `src/runtime-data.ts:341-443,511-559` |
| hook never execute测试 | `tests/integration/daemon/hooks.integration.ts:5-63` |
| status隐藏hooks | `tests/integration/daemon/hooks.integration.ts:65-167` |
| malformed/round-trip测试 | `tests/unit/daemon/hook-declarations.test.ts:10-65` |
| task host identity资产 | `src/task-runtime.ts:8-10,66-68,110`; `src/daemon.ts:817-818,1132-1142` |

## B11. 明确排除

- 不设计external wrapper、outcome新variant、availability resolver、runtime enforcement。
- 不裁决gate point改名、脚本binding/decision/hold语义。
- 不审S3树调度，只引用host identity存在性。
- 不以hook symbol、空projection、绿测或历史commit作为符合性。
- 不运行D11整链路integration或real E2E。

---

**尾部结论：现存代码没有D4 tool registry四轴，也没有D5 preset gate声明—投影—capability握手；完整声明会被compile静默删除，公共tools/toolRequirements只是恒空placeholder，doctor仍无条件硬编码gh。四层hook ADT、持久化与恢复是可保留foundation，但其preset placeholder无生产入口/host identity，且调度测试明确保证脚本不执行，不能冒充gate/tool生产闭环。**

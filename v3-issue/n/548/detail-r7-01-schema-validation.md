# RFC #548 R7-01 — 可消费 schema artifact 与创建期字段契约

**调查基线：** `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
**唯一设计锚点：** `AGG-548.md` 的 §2.1 D、§2.2、T2、STD-745、P-747-1/2/3/4。  
**边界：** 本报告建立当前源码、CLI、SQLite 与测试的事实，不选择 schema 载体、不定义新 grammar、不实现。

# A. 主 agent 摘要

## 问题与结论边界

当前系统存在两套彼此未连通的信息流：

1. preset loader 能把 `[item.fields]` 解析为 `name -> {type}`，并供 prompt binding 的**声明检查/运行期字符串化**使用；
2. `preset compile --json` 输出一个 `schemaVersion: 1` 的固定 projection instance，但 projection 不含 `item.idField`、field map、required 或请求 schema；仓内生产代码也没有消费该输出。

item 创建走另一条路径：CLI 将 `--field-json` 原样放入 daemon request 的 `extra`；daemon 加载 item 自己的 preset，只用其 entry status 与 idField，随后把任意安全 JSON `extra` 写进 SQLite。它没有把 `extra` 与 `preset.item.fields` 对照。因此“缺声明字段”“未声明字段”“声明类型不符”都能成功入库并进入 scheduler；只有 preset 不存在会在 insert 前失败。top-level unknown field 的 strict gate 属 daemon/CLI 请求 envelope，不是 preset `extra` 字段契约。

最小隔离 runtime 实验复现了这一因果链：合法、漏字段、未知 `extra.rogue`、`count:string/flag:number` 四次 `item add` 均 exit 0 且形成四行 DB；不存在 preset exit 1 且不新增行；CLI 未知 option 在发 socket 请求前 exit 1。实验还显示，字段违规成功创建后 scheduler 已尝试处理它们，故当前缺口不是只影响静态 artifact。

## 当前、未来与证明缺口

- **当前可确认：** grammar 只能表达四种 type，不能表达 required；compile projection 是实例投影而非 schema；`schemaVersion` 仅由 producer 自断言；仓内没有独立 compile artifact 消费者或 version mismatch 入口；daemon socket 保留 `{code,message,details}`，通用 item CLI 丢弃 `details`。
- **稳定条款要求但当前不存在：** 可版本化、可派生类型的消费 artifact；消费端从 artifact 派生；version mismatch 显式失败；引擎调用前的预校验；引擎创建期 required 兜底；四类违规的统一 typed verdict。
- **仍须裁决：** STD-745 已明确容许“CLI JSON Schema”或“独立版本化 package/artifact”两种载体；现有事实不能替 R8 选择。required 可进入现有 object field declaration，或由其他 schema 层表达；事实仅证明 string shorthand 无此信息、object form 当前也只读取 `type`。预校验消费端在仓外，无法从本仓判定其构建/发布集成。

## 因果、资产与未知

因果主链是：`PresetTomlBoundary.item.fields = object` → loader 得到 type-only map → compile projection 丢弃整个 item schema → 外部无法从 compile 输出派生请求类型 → CLI `fieldJson` 原样进入 `extra` → daemon 虽加载 preset，却不对照 field map → opaque JSON 入库。`schemaVersion` 没有消费者，因此修改输出中的版本目前不会触发任何生产失败。

可保留资产是：preset load 的结构/type vocabulary 检查、compile 的 closed ADT 与确定性 projection、daemon 在写入前加载 preset、socket error ADT、top-level known-key gate、SQLite create/batch transaction、`extra` 的 JSON 安全/大小检查。它们分别是窄地基，不等于 T2。

未知集中在树外消费 daemon：其实际语言/构建系统、artifact 获取方式、delivery-id verdict ADT 和日志消费者都不在本 repo；本报告不能证明树外存在独立 oracle。

## R8 材料是否具备

**部分具备，且足以暴露必须裁决的最小分叉。** 当前权威信息位置、丢失点、创建入口、错误保真边界和运行后果已经闭合；STD-745 载体（CLI schema / package）与 required 表达位置仍是稳定条款允许的真实分叉，应交 R8。树外发布/生成链的具体触点仍需在消费 daemon repo 落定，不能由本仓证据补写。

# B. 证据附录

## B1. 稳定条款

- T2 要求漏 required 或 preset 不存在在预校验或引擎创建期被拒绝，且不能到 spawn 后才失败：`AGG-548.md:95-99`。
- P-747-1 要求请求在任何引擎调用前通过编译产物校验；P-747-2 要求缺失、未声明、类型不符、preset 不存在的结构化拒绝；P-747-3 要求类型由 schema 派生且 version mismatch 显式失败；P-747-4 保留引擎创建期兜底：`AGG-548.md:101-104`。
- STD-745 明确允许 CLI JSON Schema 或独立版本化 artifact，并禁止 projection instance 冒充 schema：`AGG-548.md:111`。
- AGG 同时承认 required 创建期兜底是树外交付、STD-745 尚无独立验收表：`AGG-548.md:109-111,281`。

## B2. 声明与 grammar 的权威位置

### 当前可表达内容

- TOML 顶层边界只规定 `item.idField:string` 与可选 `item.fields:object`：`src/loop.ts:508-518`。
- field type 闭集是 `string | number | boolean | json`：`src/loop.ts:458-459`。
- 内存字段模型仅有 `{type}`，没有 required/optional 标志：`src/loop.ts:877-879`。
- parser 校验字段名并将每项归一为 `{type}`：`src/loop.ts:4913-4921`。
- string shorthand 与 object form 都最终只读 type；object form 的其他属性不进入模型：`src/loop.ts:4924-4935`。
- 文档同样只声明上述四种 type 与两种书写法，没有 required 语法：`docs/preset-authoring.md:118-123`。

### 真实消费者

- `parsePreset` 构造 `preset.item.fields` map：`src/loop.ts:4710-4712,4752-4763`。
- preset 变量声明只能引用 engine field、idField 或 field map 中显式声明的字段；未声明引用在 preset load 阶段失败：`docs/preset-authoring.md:155-160`。
- 运行期 binding 从 item `extra` 查值，缺失/null 转空字符串，scalar 转字符串，复合值才抛错：`docs/preset-authoring.md:196-204`；实际 lookup 落在 `src/loop.ts:6007-6036`。
- 这说明当前 field type 主要服务“允许引用什么”和 binding 字符串化；它没有形成 item creation validator。

## B3. Compile artifact 的生产、内容与消费者

### 生产与 shape

- projection boundary 固定含八个顶层 key：`schemaVersion,preset,statuses,stateGraph,phases,tools,fragments,findings`；没有 item/schema 字段：`src/loop.ts:533-583`。
- public result 是 `compiled|rejected` ADT；两支外层都写 `schemaVersion:1`，compiled projection 内又有一个 `schemaVersion:1`：`src/loop.ts:588-592`。
- projection builder 从 compiled model 选择 status、phase、rights、task tree 等字段，但完全不读取 `model.item`：`src/loop.ts:2900-2957`。
- builder 用同一 `PresetCompileProjectionBoundary` 自断言自己的结果：`src/loop.ts:2958-2966`。
- CLI 成功时只输出 projection（不是外层 `kind:"compiled"` envelope）；失败时 stderr 输出 rejected envelope：`src/loop.ts:2990-3002`。

### 仓内消费边界

在排除 `node_modules` 与本 RFC 调查目录后，对
`PresetCompileProjectionBoundary|projectCompiledPreset|projectPresetCompileResult|preset compile|schemaVersion`
全仓搜索，生产引用只位于 `src/loop.ts`；其余 compile projection 引用都在
`tests/unit/preset/compile.test.ts`。没有 daemon、scheduler、item CLI、构建脚本或 package export 消费 CLI artifact。

因此：

- 当前 `schemaVersion` 是输出字段和 producer-side boundary 常量，不是协商协议；
- 没有“把 schemaVersion mismatch 喂给生产消费者”的入口；
- item add 接口也没有 artifact/schemaVersion 参数，无法在现状下做 mismatch runtime 注入。

### Oracle 同源

- compile 测试直接 import producer 导出的 boundary、builder 和 projector：`tests/unit/preset/compile.test.ts:1-13`。
- deterministic 测试用 `projectCompiledPreset` 生产，再用同模块的 `PresetCompileProjectionBoundary` round-trip：`tests/unit/preset/compile.test.ts:41-53`。
- CLI 测试同样用 producer-exported boundary 解析 stdout：`tests/unit/preset/compile.test.ts:398-408`。
- rejected/compiled closed-variant 测试有效守住当前 ADT，但仍与 producer 同源：`tests/unit/preset/compile.test.ts:186-213`。

仓内没有独立 JSON Schema validator、生成的 consumer type、fixture-owned schema 或跨 package consumer 可作为独立 oracle。

## B4. Item 创建的数据流与全部入口

### 单项 PATH CLI

1. CLI 接受 `--field-json` 并解析成 JSON object：`src/loop.ts:1704-1752`。
2. request builder 将其原样赋给 daemon args 的 `extra`：`src/loop.ts:2260-2284`。
3. daemon 先做 top-level known-key gate：`src/daemon.ts:5153-5159`。
4. daemon 强制每 item 显式 preset，加载它并取 entry status/idField：`src/daemon.ts:3001-3024,3060-3086`。
5. daemon 把 wire itemId 回填到 `extra[idField]`，仅检查冲突：`src/daemon.ts:3025-3040`。
6. `validateItemExtra` 只做 JSON 安全/深度/runtime JSON parsing，不接收 preset field map：`src/daemon.ts:5109-5139`。
7. 创建输入随后直接写 store：`src/daemon.ts:3041-3057,2887-2937`。

### Batch、socket 与低层 store

- `item.batchAdd` 对每项走同一个 `buildCreateItemInput`，因此 required/type/unknown 行为与单项一致；整批在所有 inputs 构建后才 `createItems`：`src/daemon.ts:2940-2998`。
- socket response 在错误时保留 `DaemonError {code,message,details}`：`src/daemon.ts:792-801,1695-1722,5016-5018`。
- SQLite store 接收已构造的 `CreateItemInput.extra`，createItem/createItems 不加载 preset 或字段声明：`src/sqlite-state.ts:142-175,1739-1744`。
- store 类型把 `extra` 作为 opaque `ItemExtra`；这是 migration/fixture/低层 caller 所需的宽边界，不构成创建期 schema 兜底。

### update 是另一个持续违规入口

虽然 R7-01 的最小实验聚焦创建，现有 item.update 同样可 replace/patch `extra`：

- 它只对历史特例 `branch`/`pr` 做手写形状检查：`src/daemon.ts:3146-3184`；
- 其余键仍只经 `validateItemExtra`：`src/daemon.ts:3185-3193`；
- 所以即便未来只修 add，已存在 item 仍可通过 update 进入未声明/类型不符状态。事实支持的创建期契约必须明确 update 是否属于同一不变量的消费者，否则“创建时正确”不能推出持久态持续正确。

## B5. 四类错误与边界保真

| 类别 | 当前触发点 | socket shape | PATH item CLI | DB / runner 副作用 |
|---|---|---|---|---|
| preset 不存在 | daemon load preset，insert 前 | `code=invalid_request`；message 点名 unknown preset；details 取决于具体 load error | exit 1，stderr `invalid_request: unknown preset: ...` | 无 item |
| 漏 declared/required | 无 required grammar、无创建校验 | 成功 result | exit 0 JSON item | item 落库并可被 scheduler 处理 |
| 未声明 `extra` | 无 field-map 对照 | 成功 result | exit 0 JSON item | 未声明键原样落库 |
| 类型不符 | 无 field-map type 对照 | 成功 result | exit 0 JSON item | 错类型原样落库 |
| top-level unknown | CLI parser或 daemon known-key gate | daemon 为 `invalid_request` 且 details 含 field/allowed | CLI 自己的未知 option 不发请求 | 无 item |

通用 item CLI 对 daemon error 调 `fail(code: message)`，明确丢弃 `response.error.details`：
`src/loop.ts:2487-2504`。只有 daemon 专用 command helper 在 `--json` 时保留 details：
`src/loop.ts:2559-2569`。所以“socket 有 details”不能推出 `coder-loop item add --json`
有 typed JSON error；实验中的失败 stderr 也不是 JSON。

## B6. 最小隔离 runtime 实验

### 环境与步骤

- 本机 `/tmp/rfc548-r7-01-8886`；独立 git repo、preset、loop-data 与 daemon。
- preset 声明 `id:string,count:number,flag:boolean`；现有 grammar 无法标记 required。
- 执行真实入口：
  - `bun src/loop.ts preset compile <preset> --json`
  - `bun src/loop.ts daemon up --loop-data-root <data> --scheduler-interval-ms 3600000`
  - `bun src/loop.ts chain create ... --loop-data-root <data> --json`
  - 六次 `bun src/loop.ts item add ... --json`
  - `sqlite3 <data>/db.sqlite 'select item_id, extra from items order by id;'`
- 最后 `daemon down`，并删除隔离目录。

### 观察

| case | CLI exit | 关键观察 |
|---|---:|---|
| 完整合法 `count=1,flag=true` | 0 | DB row `valid` |
| 缺 `count,flag` | 0 | DB row `missing`, extra 仅有回填 id |
| 未声明 `rogue` | 0 | DB row `unknown`, `rogue:"x"` 保留 |
| `count:"wrong",flag:17` | 0 | DB row `mismatch`, 错类型保留 |
| bundled preset `does-not-exist` | 1 | stderr `invalid_request: unknown preset: does-not-exist`；无 row |
| CLI option `--nonesuch` | 1 | CLI 参数错误；无 socket mutation、无 row |

compile stdout 的八 key projection 不含 `item` 或字段 schema；其 `schemaVersion` 为 1。
DB 查询确认正好四个成功 case 落库。由于 fixture repo 尚无 commit，scheduler 随后给四个 item
写入 spawn backoff，错误为无法解析 `refs/heads/main`；这额外证明三类字段违规没有在 scheduler
之前被挡住。该 spawn 错误不是字段实验的预期业务结果，只用于定位拒绝时序。

### schemaVersion mismatch 的最小结论

不能构造“喂给现有消费端”的实验，因为仓内不存在读取 compile JSON 的生产命令/daemon
请求，item.add 也无 schemaVersion/artifact 参数。静态搜索与 CLI surface 一致地证明：
当前 mismatch 是**无消费者的证明缺口**，不是一个被隐藏的 fallback 分支。

## B7. 历史、迁移与持久态

- item 的 preset/presetPath 在 store 类型仍为 nullable，以支持 migration/低层 fixture；daemon
  新建边界才强制二选一：`src/sqlite-state.ts:155-160`。
- `extra` 随 item row 直接持久化；update 也直接替换它：
  `src/sqlite-state.ts:1762-1803`。
- 当前 migration 保障历史 opaque identity/per-item preset 可读，并不会为历史 `extra`
  补 required/type 证据。若未来校验只发生在 add，历史行与 update 后行仍没有同等保证。
- compile artifact 本身不入库、不关联 item，也没有 artifact schemaVersion migration。

## B8. 测试盲区与“同错”

1. `item-add-strict-fields` 测试把 top-level strict 当作字段 strict，同时明确接受
   `extra.note`：`tests/integration/daemon/item-crud.integration.ts:219-265`。这正是 envelope
   与 preset field contract 的混淆。
2. daemon harness 自动为没传 preset 的 item.add/batchAdd 注入默认 preset：
   `tests/integration/daemon/harness.ts:580-609`。它方便非 preset 测试，但不能证明生产
   caller 可省略 preset。
3. compile tests只守当前 projection，并用 producer boundary 作 oracle，无法发现 item schema
   从 projection 消失。
4. 没有测试覆盖 declared field missing、unknown extra、type mismatch 在 add/batch/update 的
   一致拒绝，也没有测试证明拒绝后零 DB/零 scheduler 副作用。
5. 没有 external consumer fixture、type generation、schemaVersion mismatch 或 PATH item CLI
   typed-error 测试。

## B9. 事实支持的实现形态与具体触点（不作选择）

以下只列稳定条款明示或当前结构真实容纳的形态：

1. **artifact 载体分叉：**
   - CLI emit JSON Schema；
   - 独立版本化 package/artifact。
   两者均来自 STD-745 明文。若沿 CLI projection 扩展，触点是
   `PresetCompileProjectionBoundary/projectCompiledPreset/runPresetCommand`；若独立 artifact，
   当前 repo 尚无发布/消费触点，必须新增独立边界，不能把现有 projection instance改名当 schema。
2. **required 表达分叉：**
   - 现有 object declaration `{type=...}` 结构事实上可承载更多声明信息；
   - 独立 schema 层也符合 STD-745。
   当前 string shorthand 与内存 `PresetItemField` 均无 required，R8 必须定义 normalization
   后的单一权威模型，不能让 loader 与 artifact 各持平行 shape。
3. **校验位置是两层而非二选一：**
   - P-747-1 的树外 consumer prevalidation；
   - P-747-4/AGG 兜底的 engine creation validation。
   本仓具体创建触点是 `buildCreateItemInput`，batch 已复用它；update 是否维持同一持久态
   不变量必须显式裁决。
4. **错误保真触点：**
   - daemon 已有 `DaemonError` 与 wire details；
   - `requestDaemonResult` 当前压平 details。
   要满足 typed verdict，必须同时覆盖 daemon 构造与 PATH item CLI 渲染/exit 协议；只改
   socket error 不会改变真实外部入口。
5. **version mismatch 触点：**
   - producer 常量现位于 compile boundary/builder；
   - consumer 触点在本仓不存在。
   因而 mismatch 证明必须绑定真实树外 consumer 或新增的本仓消费命令，不能只对 producer
   boundary 写自测。

## B10. 证据索引

| 主题 | 证据 |
|---|---|
| type-only grammar | `src/loop.ts:458-459,877-879,4913-4935` |
| compile 丢 item schema | `src/loop.ts:533-583,2900-2957` |
| schemaVersion producer-only | `src/loop.ts:588-592,2962-2966,2990-3002` |
| CLI extra 传递 | `src/loop.ts:1704-1752,2260-2284` |
| daemon preset load/id 回填 | `src/daemon.ts:3001-3057,3060-3086` |
| 无 field-map 校验 | `src/daemon.ts:5109-5139` |
| add/batch 写入 | `src/daemon.ts:2887-2998` |
| socket error ADT | `src/daemon.ts:792-801,1695-1722,5016-5018` |
| PATH CLI 丢 details | `src/loop.ts:2487-2504` |
| update 继续允许任意 extra | `src/daemon.ts:3146-3193` |
| store/migration 宽边界 | `src/sqlite-state.ts:142-175,1739-1744,1762-1803` |
| compile oracle 同源 | `tests/unit/preset/compile.test.ts:1-53,186-213,398-408` |
| strict-fields 同错 | `tests/integration/daemon/item-crud.integration.ts:219-265` |
| harness 自动 preset | `tests/integration/daemon/harness.ts:580-609` |


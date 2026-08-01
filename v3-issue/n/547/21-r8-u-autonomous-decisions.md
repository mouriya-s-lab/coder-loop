# RFC #547 R8：六个 U 类项目的自主裁决建议

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。  
> 输入：`AGGREGATE-547.md`、R7/R8事实档案、`18-r8-autonomy-root-cause.md`、19/20系列报告、完整落盘的 [#705](https://github.com/mouriya-s-lab/coder-loop/issues/705) / [#745](https://github.com/mouriya-s-lab/coder-loop/issues/745) / [#747](https://github.com/mouriya-s-lab/coder-loop/issues/747)。  
> 授权解释：用户要求自主完成workflow，并明确反对把调查与工程选择返还给操作员。本报告据真实owner、稳定公理、最小改动、YAGNI和兼容成本给出单一建议，不改规格/代码/WORKFLOW。

## A. 摘要（≤1页）

六项都可自主收敛；**仍需用户裁决 0 项**。原先把它们列为 U 类的依据已经变化：TF-04/17 的真实owner现已由可访问issue合同确定；TF-07的最低闭集能由稳定验收和真实值域共同限定；TF-02/09/25虽影响公开行为，但用户已授权按现有架构和最小机制自主完成，且每项存在明显支配解，无不可替代的业务偏好。

| TF | 单一建议裁决 | 核心依据 |
|---|---|---|
| 02 doctor findings | doctor只诊断**current definition/source**；pinned instance健康归status/instance doctor子面，不混入默认doctor | current与instance是两问题；职责分离最小、无历史扫描成本 |
| 04 schema owner | `mouriya-s-lab/coder-loop`是规范schema producer；以versioned CLI-readable artifact分发；#747外部消费daemon是首个独立consumer | #745/#747已明确producer缺口与zero-source-import消费合同 |
| 07 ValueType闭集 | 首批精确为 `string | number | boolean | null | array<T> | record<fields> | union<variants>`；`json`仅是编译为该递归ADT的糖，不是opaque variant | 稳定D2已钉四型基线+array/record/union、V-R4/V-2c要求结构JSON；人口只证明三类业务scalar，不支持更多专用variant |
| 09 JSON呈现 | canonical JSON **inline** 为默认 | placeholder可位于任意文本上下文；inline不引入Markdown/fence结构假设，字节确定且兼容当前模板替换 |
| 17 ChainDefinition owner | `mouriya-s-lab/coder-loop` / #705唯一拥有ADT、boundary、parse/version error；外部producer只提交该boundary | #705正文逐字“本child导出并唯一拥有”；owner冲突已被真实合同消解 |
| 25 recursive DSL | 采用**referenced node table**：root id + keyed node declarations + child id refs | explicit stable id、一处定义、多处引用、cycle/dangling检查与move-stability直接同构；避免TOML深层inline结构复制 |

这些裁决不增加需求：doctor职责按既有命令边界收窄；schema与chain owner遵循现有issue；ValueType只采用AGGREGATE已钉最小variant；JSON呈现只选待裁默认；recursive DSL只选待裁inline/reference语法。其余migration、projection、runtime、error和transaction继续消费既有E类合同。

## B. 六项逐项决议

## B1. TF-02 — doctor definition健康的时间面

### 真实问题是否仍存在

存在，但已从“多个同等产品方向”缩小为默认命令职责。`20-r8-e-compile-contract.md`已提供三个可寻址读面：current compile、cached result ref、retained pinned definition ref。D10与R7事实又明确current source和历史instance不能互相代替。

### 决议

**`coder-loop doctor <target>` 默认且唯一诊断当前target将要使用的current definition/source。**

- 编译current source并呈现同一个`CompileEnvelope` findings；不生成第二finding集合；
- runtime binary/tool availability仍按current compiled registry检查；
- pinned instance的missing/corrupt/ref健康在`status`的instance/definition section呈现；如保留doctor入口，只能是显式`doctor --definition-ref <tagged-ref>`，不默认遍历历史实例；
- cache只加速同一current content identity，不改变时间面；
- doctor不得把runtime run健康、历史definition损坏和current source findings合成一个总绿/红结论。

### 证据与理由

1. 当前doctor本来就是target/current-oriented运维入口；没有真实“默认扫描全部历史实例”的operator路径证据。
2. D10要求旧实例读pinned definition，不能用current结果判断其健康。
3. 默认混合current+history会引入无界扫描、retention耦合和“一个旧实例使新配置doctor红”的误导。
4. 显式mode必选会破坏现有CLI且没有歧义收益；职责分离已足以避免混淆。

### 否决

- 否决默认同时列current+所有instance：成本无界，两个问题合成一个状态。
- 否决必选`current|instance`：给现有明确默认制造程序性负担。
- 否决doctor只读cache：cache不是authority，cold/miss不可改变诊断。

### 后果 / E合同参数

TF-03/05继续以current compile envelope为doctor输入；TF-19/24把pinned instance健康投影到status/ref resolver；TF-34 doctor availability只消费current registry。仍未知仅是CLI字段命名，不影响职责合同。

## B2. TF-04 — schema规范producer、分发面与首consumer

### 真实问题是否仍存在

**owner问题已不存在。** [#745](https://github.com/mouriya-s-lab/coder-loop/issues/745)明确在coder-loop交付schema artifact；[#747](https://github.com/mouriya-s-lab/coder-loop/issues/747)明确外部消费daemon只从公开artifact派生类型、零private source import。此前“本树还是外树”的登记被后续真实issue拆分解决：producer在本仓，consumer在外挂路径。

### 决议

**`mouriya-s-lab/coder-loop`是唯一规范schema producer；schema作为versioned、CLI-readable独立artifact发布；#747消费daemon是首个独立consumer。**

具体边界：

- schema artifact与projection instance分离；
- coder-loop从自身公共boundary/ADT生成schema并为其分配`schemaVersion/schemaIdentity`；
- CLI提供机器可读schema获取面，外部consumer无需npm/private TS import；
- #747在构建或启动时取得并生成/验证consumer type；unknown version响亮失败；
- projection、rejected envelope、typed binding values均引用同一schema family；
- engine create仍是最终兜底，外部prevalidation只加速拒绝。

### 事实理由

- #745的问题陈述精确指出当前CLI只有instance、private arktype边界不可消费。
- #747要求daemon停机时仍能预校验，因此不能每请求依赖live engine，但可以消费已发布/version-pinned CLI artifact。
- standalone package会新增发布registry、安装和版本同步面；CLI artifact沿现有唯一公开binary最小。
- 让外部repo生产schema会倒置authority：consumer无法从projection instance恢复被删的类型信息。

### 否决

- 否决外部consumer手写schema：平行shape漂移，直接违反#747。
- 否决consumer import `src/loop.ts`：coder-loop private且#746/#747禁止source import。
- 否决projection instance冒充schema：值样本不能描述union/required/rejected分支。
- 否决共享第三repo做规范producer：无真实owner，增加发布链且失去source ADT同源。

### 后果 / E合同参数

TF-05采用schema/compiled/runtime三面分离并以ref关联；E-Compile的`ContractSchema`由coder-loop发布；独立consumer E2E由#747真实repo负责。仍未知是CLI子命令精确拼写与artifact文件布局，属于实现细节。

## B3. TF-07 — 首批ValueType封闭ADT

### 真实问题是否仍存在

“可以随意选择哪些variant”已不存在。AGGREGATE D2明确钉住“**四型基线 + array/record/union等结构variant**”，且`json`不是opaque逃生舱；V-R4要求结构化json能真实spawn render，V-2c要求结构精化。真实population又只证明业务binding使用string/number/boolean；内部array/object明确不是binding，不能据此添加业务专用variant。

### 决议

首批public ADT精确为：

```ts
ValueType =
  | StringType
  | NumberType
  | BooleanType
  | NullType
  | ArrayType<{ element: ValueType }>
  | RecordType<{ fields: ClosedFieldMap<ValueType> }>
  | UnionType<{ variants: NonEmptyArray<ValueType> }>
```

- `json`是source语法糖：compile为递归`union(null|string|number|boolean|array<json>|record<json>)`或更窄的显式shape；public artifact中不保留opaque `json` variant；
- record默认closed，额外key拒绝；开放record需真实需求后新增显式variant；
- number先沿现有JSON number，不新增integer、enum、tuple、map、literal、optional等专用variant；refinement作为各variant的typed约束字段，不能携arktype表达式到公共wire；
- null是值variant，missing不是ValueType；required/default由binding合同处理。

### 真实值域证据

- 当前preset：item字段证明number/string；chain default证明boolean/string；DB实际binding证明text/integer/boolean default形态。
- 当前无structured binding人口；但稳定验收V-R4/V-2c已明确要求结构json，因此array/record/union不是凭空扩张。
- union是递归JSON与nullable shape的闭合工具；没有union就只能恢复opaque json或另造special case。
- `dependsOn`、migration、scheduler objects不是binding，不能产生额外ValueType需求。

### 否决

- 否决只做scalars：不能满足V-R4/V-2c与D2递归公开类型。
- 否决named external schema ref作为首批唯一结构面：当前没有schema catalog需求，会让每个结构值依赖第二resolver。
- 否决opaque json：丢字段type/required证据，违反稳定裁决。
- 否决tuple/enum/map/literal：无population或验收consumer证据，违反YAGNI/variant准入。

### 后果 / E合同参数

E-Binding的`ValueType`参数由上述ADT替换；schema exporter必须递归生成array/record/union；renderer消费canonical JSON；migration只处理符合目标source schema的可证子集。仍未知的业务field schema（如历史6条非数字issue）不改变语言闭集，只决定具体source声明/hold。

## B4. TF-09 — JSON prompt默认呈现

### 真实问题是否仍存在

仅剩AGGREGATE逐字登记的一个用户可见默认：fenced code block或inline。typed render error字段、strategy registry等已经由E合同收敛，不属于本项。

### 决议

**结构化JSON默认使用inline canonical JSON。**

规则：UTF-8、canonical key order、无非语义空白的单行JSON；string/number/boolean/null仍用各自canonical scalar文本。显式doc renderer可选择更适合人读的块状展示，但普通prompt placeholder默认不注入Markdown fence。

### 事实理由

1. placeholder可出现在句内、列表、JSON、shell说明或markdown任意位置；fence要求块级上下文，renderer无法仅凭value保证合法布局。
2. inline替换与现有字符串模板模型兼容，改动最小；fence会增加换行、语言标签和围栏转义规则。
3. canonical inline字节确定，适合definition hash、golden test和exact replay。
4. 结构值大小已有size/depth boundary；可读性不能通过默认改变模板语法解决。

### 否决

- 否决默认fenced：在句内placeholder产生结构破坏，并把Markdown语义耦合进typed value renderer。
- 否决每ValueType自选任意strategy：同值跨phase文本漂移，扩大公共schema。
- 否决禁止结构插值：直接违反V-R4。

### 后果 / E合同参数

E-Binding renderer的结构projection固定为`canonical-json-inline-v1`；render error仍含binding/source/expected/actual/path，不需strategy字段（strategy由type/version确定）。未来显式block doc renderer是新需求，不改变默认。

## B5. TF-17 — ChainDefinition字段与owner

### 真实问题是否仍存在

**owner问题已由真实owner合同消解。** [#705](https://github.com/mouriya-s-lab/coder-loop/issues/705)逐字要求：“本child导出并唯一拥有该声明的精确ADT、arktype boundary与静态校验，写入方不得再造第二套parser。”它还把chain task tree、top-level join和`chain.baseBranch`放在同一chain metadata声明家族，并由#743规范化为`ChainDefinitionRef`。

### 决议

**`mouriya-s-lab/coder-loop` / #705唯一拥有并版本化ChainDefinition ADT、boundary、parse和errors；外部/CLI producer只提交该typed boundary。**

最小字段闭包由pre-create consumers机械求得：

- chain task tree root及显式node identities；
- container joins与typed candidate refs；
- `baseBranch`声明；
- chain-level typed bindings/defaults；
- chain-level runner/model或调度metadata中在首次run前决定行为的字段；
- definition schema version/identity。

运行时items、cursor、join evaluation、reopen count、runs、worktree、session和effect facts不进入ChainDefinition。repository等business binding只有被真实chain pre-run consumer读取时才通过typed binding引用，不复制物理列。

### 事实理由

- #705是实际实现owner issue，不是AGGREGATE的旧推测。
- chain definition由coder-loop scheduler/runtime消费；让外部repo定义会迫使引擎import或复制外部shape。
- #743 pin/resolver需要本仓可解析、可版本化artifact。
- writer-owned parser会导致CLI、daemon、external ingress各自解释tree/join。

### 否决

- 否决外部owner生产、本仓只存opaque JSON：无法装载期校验或constructor。
- 否决shared第三repo共同owner：无真实repo/API，产生双发布协调。
- 否决chain metadata自由字典：非法状态可持久化，恢复无法按definition ref解释。

### 后果 / E合同参数

E-Definition的`UChainContract`参数关闭：owner=coder-loop，字段按本仓pre-run consumer闭包；E-Runtime在chain create同事务pin并constructor；E-Binding对chain值走同一admission。仍未知仅是字段逐项inventory的最终机械结果，不是owner/产品分叉。

## B6. TF-25 — recursive DSL inline/reference语法

### 真实问题是否仍存在

存在且仅限公开TOML语法：nested inline tree或referenced node table。canonical recursive tree、linear兼容normalize、projection版本与runtime行为已由D3/E合同固定，不在这里重开。

### 决议

**采用referenced node table。** 一个root id，节点按显式id声明，children/targets/dependsOn/reopen/candidates均引用id。概念形状：

```toml
[tasks]
root = "root"

[[tasks.nodes]]
id = "root"
kind = "seq"
children = ["build", "verify"]

[[tasks.nodes]]
id = "verify"
kind = "par"
children = ["unit", "integration"]
join = { kind = "validator", candidate = "verify-gate" }
```

具体TOML字段拼写由实现按boundary命名规范落地，但语法范式不再开放。

### 事实理由

1. D3要求每个可引用node有显式stable id；table天然以id作为定义/引用中心。
2. move节点只改parent children引用，不搬动/复制整段nested subtree，直接满足move-stability。
3. reopen、dependsOn、transition target和candidate本来就是跨node引用；统一引用机制比inline节点+额外ref混合简单。
4. compile可先建`id→node` map，再做duplicate/dangling/cycle/well-formedness；错误可精确点名id。
5. TOML深层inline array-of-inline-tables可读性和diff较差，且大型tree缩进/括号成本随深度增长。
6. referenced table避免同一node被文本复制来表达多处引用；非法共享由compiler按tree parent不变量拒绝。

### Linear compatibility

现有`[[phases]]`继续作为明确语法糖，normalize为同一referenced recursive model；同一preset禁止同时声明`[[phases]]`与`[tasks]`，避免precedence。public projection只发布canonical recursive tree；若保留`phases` compatibility view，必须标记derived/non-authoritative并有退役版本，不能被scheduler读取。

### 否决

- 否决nested inline：跨node引用仍需另建id resolver，形成“结构按嵌套、引用按表”的双模型；深层TOML diff成本高。
- 否决inline与reference长期双grammar：parser/错误/round-trip双倍，canonical前冲突。
- 否决一次性删除linear输入：bundled preset全是linear，迁移收益不足；语法糖normalize不产生第二模型。

### 后果 / E合同参数

E-Runtime的compiledRoot由referenced declarations解析后normalize；DefinitionNodeId直接取node `id`；TF-26 identity/move规则获得语法承载；P-D3-3的duplicate/dangling/cycle检查在map解析阶段完成。仍未知只是字段命名和TOML诊断location实现。

## B7. 六项对E合同的最终参数表

| E合同 | 注入参数 |
|---|---|
| E-Compile | doctor=current；schema producer=coder-loop CLI artifact；ValueType闭集固定 |
| E-Binding | recursive ValueType七variant；JSON inline canonical projection |
| E-Definition | ChainDefinition owner=coder-loop/#705；字段由pre-run consumer闭包 |
| E-Runtime | referenced node table提供stable DefinitionNodeId；linear输入normalize同一tree |
| External ingress | #747消费公开schema，zero private source import；unknown version拒绝 |
| Compatibility | current doctor与instance status分离；linear syntax sugar保留但post-parse无第二模型 |

## B8. 仍未知但不阻塞裁决

- schema CLI子命令/文件名、artifact缓存目录；
- ChainDefinition最终字段inventory的机械明细与schemaVersion编号；
- referenced DSL的精确TOML key spelling和source-location representation；
- explicit doc block renderer是否未来需要；
- 历史不兼容binding的业务修复值。

这些是实现或数据修复问题，不改变六项裁决。

## 尾结论

**6/6可自主裁决，0项仍需用户输入。** Doctor默认current并把pinned instance健康留给status/ref读面；schema与ChainDefinition规范owner均为coder-loop（分别#745与#705）；ValueType首批采用稳定最小递归闭集且无opaque json；JSON默认inline canonical；recursive DSL采用referenced node table并保留linear语法糖normalize。所有决定都来自稳定条款、真实owner/值域和最小兼容成本，不以个人偏好或虚构外部系统为依据。

# RFC #547 R4/S1：装载编译、artifact 与 finding 供给深审

> 审查基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 唯一设计锚点：`AGGREGATE-547.md` §2、D1、D8、D11；`04-r3-supply-slicing.md` S1、接缝与完成判据。  
> 审查范围：只调查现存生产供给；不提出实现方案，不改 issue、产品代码、测试、配置或数据库。

## A. 主 agent 摘要（最多一页）

### A1. 问题、结论与置信边界

**问题**：现存装载编译、canonical model、公共 projection/schema/finding 是否已经形成一个可作为稳定 RFC 地基的单一供给；所有生产入口、消费者、缓存与错误恢复是否保持同一语义；D8 的 plan 退役与 dead-fragment 检查是否互证。

**结论：不能作为完整稳定地基。**

| 稳定语义 | 结论 |
|---|---|
| §2 A：TOML 装载统一进入 canonical `CompiledTaskModel` | **部分符合** |
| §2 A：唯一公共投影、版本化 boundary、round-trip、identity | **部分符合** |
| §2 A：按需计算、不落缓存、重复装载同语义 | **不符合** |
| §2 B：TOML 载体；可分发 JSON Schema | **部分符合**（TOML 符合；schema artifact 无现存供给） |
| §2.3：定义期事实在唯一装载判定点执法 | **部分符合** |
| §2.4：本片现有 variant 有准入、持久化/事件/消费者同时存在 | **部分符合** |
| D1：结构化 `CompileResult` 与公共 projection | **部分符合** |
| P-D1-1：独立消费者可取得 schema 并派生类型 | **无现存供给** |
| P-D1-2：doctor 吸收 compile findings | **无现存供给**（且该项仍待裁决） |
| P-D8-1：dead-fragment warn | **无现存供给** |
| P-D8-2：plan 面完全退役并由 dead-fragment 检查互证 | **部分符合** |
| P-D8-3：不增加 fragment 跳转边 DSL | **符合** |

置信边界：以上结论覆盖仓内全部 `compilePreset` / `loadPreset` 生产调用点、daemon 缓存与物化路径、CLI projection、doctor、fragment role 消费、相关单元测试，并用隔离 fixture 直接证伪 dead-fragment finding。未启动中央 daemon，未触碰 `~/.coder-loop`；因此 daemon 长生命周期缓存差异由源码路径确定而非中央实例实验。

### A2. 因果链

1. **canonical 主干真实存在，但 finding 不属于 canonical model。** TOML 经 arktype boundary、局部/跨表检查后构造 `CompiledTaskModel`；生产加载均经 `loadPreset → compilePreset`。但 model 只是 `Preset` 增加 `sourceDir/sourceHash/tasks`，warnings 是并列的 `CompiledPresetProduct.warnings`，daemon 又通过 callback 单独采集两类旧 finding。公共 projection 必须由调用者同时传入 model 和 findings，尚非一个不可拆错的 canonical artifact。
2. **公共 DTO 有唯一投影函数和 boundary，但 schema 没有公共分发。** CLI success 输出 projection instance；rejection 输出另一个 public-result shape 到 stderr。arktype boundary 是源码内实现对象，仓内没有 JSON Schema artifact/CLI schema 输出，外部消费者无法“零源码 import”派生类型。
3. **daemon 的 path-only promise cache 破坏“按需计算”及跨入口一致性。** 首次成功后，同一路径源文件变化不会再次读取；CLI、status/direct loader 会读新源，daemon scheduler 仍消费旧 model，直到进程重启。失败 promise 会删除并重试，成功 promise 永久保留；两种恢复语义不同。
4. **materialize 在校验前产生并清理文件副作用。** daemon 路径先复制、写 marker、rename，并按同名 prune 旧 sibling，之后才 TOML parse/typecheck/template/fragment 校验。非法新源可先成为 `.materialized-complete` artifact，并删除旧副本，再被编译拒绝；不满足“失败先于装载副作用”。
5. **D8 只有退役半边。** bundled preset 已无 `plan/`、`role = "plan"`、dogfood `dev-plan`，DSL 也无 fragment 跳转字段；但 checker 只检查 status DAG 和 placeholder，未计算“注册 fragment 是否被任一 phase role 覆盖”。隔离 fixture 中 `dead` fragment 明确无人可见，compile findings 仍为空。
6. **现有绿色测试与同错。** 31 个相关测试全绿，证明现有实现契约稳定；它们没有 dead-fragment 用例，并把“所有 fragment 可读”与“按 phase slice 可见”分别验证，却未验证两者全集关系。bundled compile 的 97 条 warning（1 dead-vocabulary + 96 declared-unused）也使只断言“无 error”或“finding 非空”无法证明 D8。

### A3. 影响分层、可保留资产与下一步

**当前影响**

- CLI projection、daemon scheduler/status/chain-complete 与 migration helper 都从同一 compiler 主干取得 model，这是可保留的主干。
- daemon 进程内对 preset 编辑不可见，而 direct/status/CLI 可见；同一路径在同一时刻可有两套定义语义。
- 非法 daemon load 会记录旧式 placeholder/DAG observability 和 load failure，但公共 `CompileResult` warnings、daemon observability、doctor 三面不是同一 finding 消费链。

**未来接缝影响**

- **S2**：projection 目前把每个 variable 固定投影为 `type: "string"`；S2 若真实化类型，必须同时核对 canonical field、唯一 projection 与公共 schema，不能只扩 DTO。
- **S3**：S1 供应 `tasks:root` / `phase:*` / `phase:*:task` identity；当前 root/phase/task 已投影，但 daemon 的旧缓存可能让实例化消费旧 tree。
- **S4**：`tools=[]`、`toolRequirements=[]` 只是 projection 占位，不能作为 capability 供给存在性证据。
- **S6**：所有 create/admission 入口经 daemon loader 是优点；但 path cache 和预校验 materialize 副作用会放大入口语义分叉。
- **D11**：现有 unit tests 可作局部资产，不能替代冻结 SHA 上跨 consumer 验收。

**纯证明缺口**

- 未在真实 daemon 生命周期中修改同一路径 preset；源码已足以确定 cache key/失效行为，未来若需运行证据，应在隔离 loop-data-root 验证。
- 未证明外部 GUI/hook 的真实消费者，因为仓内没有 projection consumer；这正是“只有 CLI 生产者、无仓内外部消费证明”的边界。

**可保留资产**

- `CompileResult` 的 compiled/rejected 封闭分支与 non-empty error diagnostics。
- `projectCompiledPreset` / `projectPresetCompileResult` 的单一仓内投影入口及 arktype round-trip boundary。
- canonical root/phase/task identity 与 delimiter collision 测试。
- source hash 覆盖完整 source tree；direct/materialized projection 等价测试。
- DAG/placeholder 装载期拒绝与 daemon 统一 load-failure choke point。
- plan 目录/注册/命令的实际退役；fragment role 的显式声明、合法性校验和 per-phase slicing。

**未知**

- P-D1-2 是待裁决项，不能从现状推导 doctor 应吸收 findings。
- schema artifact 的归属仍是聚合文档登记的跨树问题；本报告只确认当前不存在。

**下一步（仅审查输入，不是实施方案）**：主 agent 在 R4 汇总中把“compiler 主干可保留”与四个缺口分开登记：schema 无供给、dead-fragment 无供给、daemon cache 语义分叉、materialize 失败前副作用；并把 S2/S3/S4/S6 接缝逐项交叉核对，不能用 D1 已落地标记覆盖这些反证。

---

## B. 证据附录

## B1. 设计逐条对照

### B1.1 §2 A / D1：canonical model 与装载即编译

**结论：部分符合。**

- TOML boundary 是 `PresetTomlBoundary`，载体明确为 TOML shape：`src/loop.ts:490-518`。
- 内存 `Preset` 和 `CompiledTaskModel`：`src/loop.ts:714-787`。后者是 `Preset & {sourceDir, sourceHash, tasks}`，不是 projection-only 对象。
- 封闭 result：
  - compiled product：`src/loop.ts:789-796`
  - rejected non-empty diagnostics：`src/loop.ts:798-805`
  - compile catches typed compile/structure failures：`src/loop.ts:4590-4599`
- 唯一生产构造点：`compilePresetOrThrow` 读 TOML、parse、DAG check、template check、fragment readability、hash、task tree，最终一次返回 model：`src/loop.ts:4608-4696`。
- `loadPreset` 不另行 parse，而是消费 `CompileResult`：`src/loop.ts:4602-4605`。

**限制/反证**

- `parsePreset` 仍是 exported，返回未带 `sourceHash/tasks` 的 `Preset`（`src/loop.ts:4710-4890`）；仓内生产源码没有直接调用它，只有 compiler 调用，故不是现存生产旁路，但 API 形状仍允许非 canonical 测试/未来调用者。
- warnings 不在 `CompiledTaskModel` 内，而与 model 并列（`src/loop.ts:789-792`）。`projectCompiledPreset(model, findings)` 接受两个独立参数（`src/loop.ts:2900`），调用者可以传空/错误 warning 集；类型不能证明 projection findings 与该次 model 同源。
- `loadPreset` 把 rejected ADT 压回拼接字符串异常（`src/loop.ts:4603-4605`）。内部消费者不解析异常文本，但也不能按 diagnostic variant/rule 穷尽恢复。

### B1.2 §2 A：公共投影、identity、确定性

**结论：部分符合。**

单一仓内投影函数 `projectCompiledPreset` 逐块来源：

| projection 块 | canonical 来源 | 证据 |
|---|---|---|
| `preset` | `name/sourceDir/sourceHash/tasks.root` | `src/loop.ts:2910-2916` |
| `statuses` | `model.statuses` | `src/loop.ts:2917-2925` |
| `stateGraph.nodes/edges` | statuses、phase item-status exits、engine entry/exhausted/unblock | `src/loop.ts:2901-2908,2926-2933` |
| `phases` | phases + compiled task child lookup | `src/loop.ts:2935-2953` |
| `tools` | 常量空数组，不是 canonical 声明 | `src/loop.ts:2954` |
| `fragments` | `model.fragments` | `src/loop.ts:2955` |
| `findings` | 调用者传入的并列 warnings | `src/loop.ts:2956` |

- projection 末端执行 arktype assert：`src/loop.ts:2958-2959`。
- public result 的 compiled/rejected 两分支再过 boundary：`src/loop.ts:2962-2966`。
- schema v1 boundary 顶层与 variant：`src/loop.ts:531-592`。
- root/phase/task identity 由 compiled tree 产生并投影；相关测试比对 canonical 全集与 round-trip：`tests/unit/preset/compile.test.ts:41-62,119-139`。
- source hash 对 sorted `(relpath, bytes)` 全树计算：`src/loop.ts:4699-4707,4507-4535`；测试覆盖 fragment/template/auxiliary 改动：`tests/unit/preset/compile.test.ts:64-117`。
- direct/materialized projection 字节相同由测试覆盖：`tests/unit/preset/compile.test.ts:216-233`。

**限制/反证**

- `phases.roles` 不在 projection；隔离输出中 `phaseRolesProjected=[false]`，外部消费者只能看到 fragments，不能从公共 artifact 重算 dead reachability。
- `tools` 与 `toolRequirements` 是常量占位，不能证明 canonical model 已有对应语义。
- projection 中 `dir` 是绝对 source path；“同一 source 内容跨路径字节稳定”并不成立。现有义务只能解释为同一路径、同内容、同版本的重复投影。
- CLI success 只输出内层 projection，rejected 则输出带 `kind/schemaVersion/diagnostics` 的 public result到 stderr：`src/loop.ts:2990-3002`。成功/失败 wire 顶层并非同 shape；结构化但消费需同时按退出码和 stdout/stderr 分流。

### B1.3 §2 B / P-D1-1：schema artifact

**结论：无现存供给。**

- 仓内只有运行时 arktype 对象 `PresetCompileProjectionBoundary` / `PresetCompilePublicResultBoundary`（`src/loop.ts:533-592`）。
- `preset compile ... --json` 只输出 instance（`src/loop.ts:2990-3002`）。
- 全仓检索没有 JSON Schema 导出文件、schema CLI 分支或独立 artifact 消费者。
- tests 直接 import 私有源码 boundary（`tests/unit/preset/compile.test.ts:5-13`），这与“外部消费者零 coder-loop source import”相反，不能充当 schema 分发证明。

### B1.4 §2.3：最早可决定阶段与单一权威判定点

**结论：部分符合。**

装载期已执法：

- arktype 外形：`src/loop.ts:4710-4712`
- status vocabulary/cross references：`src/loop.ts:4713-4752,4838-4880`
- fragment id/role、phase role 合法性：`src/loop.ts:4775-4786,4824-4829,5124-5153`
- DAG finding：`src/loop.ts:4637-4656`
- prompt placeholder：`src/loop.ts:4657-4682`
- 所有 fragment readability：`src/loop.ts:4683-4685`

缺口：

- “fragment 注册但没有任何 phase role 覆盖”是纯定义期事实，现存 loader 未检查。
- fragment role slicing消费者只在渲染时做 filter：`src/loop.ts:6084-6101`；由于 compile projection 又不含 phase roles，公共消费者无法弥补。
- materialization 在以上校验之前发生（见 B4），使装载拒绝不是 fail-before-side-effect。

### B1.5 §2.4：variant 准入与穷尽

**结论：部分符合。**

- 现有 phase exit 两 variant 在 TOML boundary、内存 ADT、projection boundary 均闭合：`src/loop.ts:467-478,557-566,684-698`。
- parse cross-reference switch 有 `assertNeverPhaseExit`：`src/loop.ts:4841-4862`。
- public compile result 是 compiled/rejected 闭合 union：`src/loop.ts:588-592,803-805`。

限制：

- 本片没有新增 task-tree/tool/type variant；现有 `seq/string/empty tools` 是退化基线，不能据此判 S2/S3/S4 variant 完成。
- `loadPreset` 把 rejected union 转 exception，运行消费者没有保留 result variant；错误恢复只能按 throw 成败处理。

### B1.6 D8：plan 退役、dead-fragment 与禁止替代 DSL

| 性质 | 结论 | 证据 |
|---|---|---|
| P-D8-1 dead-fragment warn | 无现存供给 | checker `src/preset-dag-check.ts:84-101` 只产 dead-vocabulary/deadlock；隔离 fixture 明确有不可达 fragment，findings `[]` |
| P-D8-2 plan 面退役 | 部分符合 | `find presets -type d -name plan` 无输出；`role = "plan"`、`plan/index`、`init-queue`、`dev-plan` 全仓生产面无命中；但没有 dead-fragment 检查互证 |
| P-D8-3 不加跳转边声明位 | 符合 | `PresetFragmentBoundary` 仅 `id/role/path`（`src/loop.ts:502-506`）；phase 只有 roles，无 fragment jump edge |

bundled preset 当前 compile 有 97 warnings，其中 1 条 `dead-vocabulary`、其余 96 条 `declared-unused`。因此 V-8a“无 dead-fragment”即使成立也会在没有 checker 的情况下真空成立；不能用 findings 非空/无 error 推导检查存在。

## B2. 全部生产入口与旁路

| 入口 | loader 路径 | 缓存/物化 | 失败语义 |
|---|---|---|---|
| `preset compile <name|path> --json` | `compilePreset` | 无 cache；不 materialize | typed rejection 投 stderr，exit 1 |
| target runtime/status/普通 CLI | `loadTargetRuntime → loadPreset` | 无 cache；不 materialize | rejected 被压成异常 |
| status 每 item preset | `loadStatusItemPresets → loadPreset` | 单次 snapshot Map cache | 任一坏 preset 整体失败，无 silent fallback |
| chain-complete helper | `runPresetChainCompleteTriggerPhases → loadPreset`，除非测试/调用者注入 `input.preset` | 无全局 cache；不 materialize | 异常 |
| daemon scheduler、create admission、rights/status gate | `loadedPresetFromDirForChain → loadSchedulerPresetFromDirMaterialized → loadPreset` | path-only Promise cache；materialize | 记录 findings/load failure，删失败 cache，再抛 `DaemonError` |
| migration definition helper | `loadPreset(... materialize)` | materialize；无进程 cache | stderr 文本 + exit 1 |

源码调用点：

- `src/loop.ts:2993,3197,4164,5432`
- `src/daemon.ts:4422-4465,5485-5492`
- `src/preset-migration-definition.ts:17-31`

生产源码中 `parsePreset` 只有 `compilePresetOrThrow` 调用；没有绕过 canonical compiler 的现存生产调用点。测试会直接调用 `parsePreset`，不算生产旁路。

## B3. 消费者与同源性

### B3.1 canonical model 消费者

- scheduler 类型显式要求 `CompiledTaskModel`：`src/scheduler.ts:337`。
- scheduler 创建 definition phase identity 读 `preset.tasks.children`：`src/scheduler.ts:1623`。
- migration helper读相同 tree identities：`src/preset-migration-definition.ts:23-30`。
- runtime/status/chain-complete 仍大量以较宽 `Preset` 参数消费 canonical model 的 Preset 部分；类型系统不会强迫这些消费者持有 `sourceHash/tasks`。

### B3.2 projection/schema 消费者

- 仓内生产消费者只有 CLI writer；没有 GUI/hook/外挂从该 public projection 读取的代码证据。
- tests 是 boundary consumer，但通过源码 import arktype，不能证明独立 schema consumer。

### B3.3 finding 消费者

- CLI：`CompileResult.warnings → projectCompiledPreset.findings`。
- daemon：placeholder 与 DAG findings 通过两个 callback 单独收集，再写 `preset.placeholder_check` / `preset.dag_check` observability：`src/daemon.ts:4448-4483,4520-4556`。
- load failure：统一写 `daemon.preset_load_failed`：`src/daemon.ts:4501-4515`。
- doctor：只调用 status snapshot并显示 runner/git/live runtime health；没有读取 compile projection/findings：`src/install-commands.ts:272-315`。

所以“finding 同源”仅在单次 compiler 内部成立；CLI DTO、daemon observability 与 doctor 并非同一公共 finding 投影的三个消费者。

## B4. 事务、副作用、缓存与错误恢复

### B4.1 materialize 先于编译拒绝

调用顺序：

1. `compilePresetOrThrow` 在读/parse TOML 前调用 `materializePreset`：`src/loop.ts:4608-4614`。
2. materialize 收集全树、复制、写 `.materialized-complete`、rename：`src/loop.ts:4417-4477`。
3. rename 后 prune 同名旧 hash siblings：`src/loop.ts:4478-4486,4489-4503`。
4. 随后才 TOML parse、结构/DAG/template/fragment checks：`src/loop.ts:4614-4685`。

结果：编译失败不会回滚 target，也可能已经删掉旧 materialized sibling。staging 自身有 finally cleanup，但“已完成 marker 的非法 artifact”和旧 sibling prune 不回滚。故装载拒绝不满足 fail-before-side-effect。

### B4.2 daemon cache 与重复装载

- cache key 只是绝对 preset directory：`src/daemon.ts:4448-4450,4606-4608`。
- cold load promise 立即写 cache：`src/daemon.ts:4461-4465`。
- success 后不失效；source hash 不参与 key。
- failure 删除 cache，下次操作会重读：`src/daemon.ts:4475-4477`。
- materialize 本身按 content hash 可复用且并发 rename race 有 marker 检查：`src/loop.ts:4420-4467`；但 daemon path cache 使成功后根本不会再次到达 content-hash 判断。

**放大条件**：daemon 长运行 + 同一路径 preset 在首次成功后被编辑。scheduler/create/status gate 继续读旧 promise；CLI/direct status helper可读新文件。重启 daemon 才消除分叉。

### B4.3 failure observability

- daemon cold failure会记录当次收集到的 placeholder/DAG finding及 load failure，再拒绝操作：`src/daemon.ts:4475-4497`。
- callback 自身失败会逃出 `CompileResult` channel；测试明确固定这一行为：`tests/unit/preset/compile.test.ts:330-365`。
- 非 callback 的未知异常也会逃出 typed rejection，因为 `compilePreset` 仅转换 `PresetCompileFailure` 与 `PresetStructureError`：`src/loop.ts:4590-4599`。这可区分基础设施故障与预期诊断，但公共消费者不能假设调用总返回 `CompileResult`。

## B5. 测试覆盖、同错、盲区与可保留资产

### B5.1 本次执行

```text
bun test tests/unit/preset/compile.test.ts tests/unit/preset/fragments.test.ts tests/unit/preset/dag-check.test.ts
31 pass, 0 fail, 110 expect()
```

这证明当前契约与本报告反证同时成立，不证明 RFC 已满足。

### B5.2 覆盖到的资产

- compiled/rejected closure、non-empty/error-only diagnostics。
- projection determinism、boundary JSON round-trip、identity 全集。
- source hash 输入覆盖与 materialized/direct projection 等价。
- typed source failures、missing prompt/fragment、callback infrastructure failure。
- DAG error/warn、fragment role 合法性、slice 与全量 readability。

### B5.3 同错与盲区

1. 没有 dead-fragment fixture/test；fragment tests 只证明“roles 指向已声明 role”和“所有 fragment 可读”，两者不能推出每个 fragment 至少被一个 phase 消费。
2. 没有 daemon successful-cache 后 source edit 的测试。
3. 没有 invalid materialized compile 对旧 sibling/完成 marker 的 rollback 测试。
4. projection tests 直接传 `[]` findings，反而展示 model/findings 可被拆开。
5. schema tests import源码 boundary，没有独立 artifact/schema derivation consumer。
6. bundled DAG test只断言无 error，不会发现缺失的 warn rule。
7. doctor tests/实现不消费 compile findings，P-D1-2 无证明。

## B6. 隔离实验与临时文件登记

### B6.1 dead-fragment 证伪

fixture：

- phase `run.roles=["used"]`
- fragment `used(role=used)`
- fragment `dead(role=dead)`
- 所有文件均存在且合法

命令：

```text
bun src/loop.ts preset compile /tmp/rfc547-s1-dead-fragment-547 --json
```

观察：

```json
{
  "findings": [],
  "fragments": [
    {"id":"used","role":"used","path":"used.md"},
    {"id":"dead","role":"dead","path":"dead.md"}
  ],
  "phaseRolesProjected": [false]
}
```

这直接证明 loader 接受不可达 fragment、没有 warn，且 public projection 缺少重算 reachability 所需的 phase roles。

### B6.2 bundled 脏 finding

```text
bun src/loop.ts preset compile gh-issue-pr-iteration --json
jq '{findingCount:(.findings|length),findings}' ...
```

观察：`findingCount=97`；规则分布为 1 条 `dead-vocabulary` 与 96 条 `declared-unused`，无 `dead-fragment`。

### B6.3 文件登记

- `/tmp/rfc547-s1-dead-fragment-547/{preset.toml,run.md,used.md,dead.md}`
- `/tmp/rfc547-s1-dead-output-547.json`
- `/tmp/rfc547-s1-bundled-output-547.json`

均为本地隔离 fixture/output；未写 repo 产品面，未启动 daemon，未触碰 `~/.coder-loop`。

## B7. 证据索引

| 主题 | 主要证据 |
|---|---|
| DSL/TOML boundary | `src/loop.ts:490-518` |
| public boundaries | `src/loop.ts:531-592` |
| canonical/result ADT | `src/loop.ts:739-805` |
| unique projection | `src/loop.ts:2900-2967` |
| CLI wire | `src/loop.ts:2969-3002` |
| compiler/load boundary | `src/loop.ts:4572-4697` |
| source hash | `src/loop.ts:4699-4707,4507-4535` |
| fragment/role parse | `src/loop.ts:4775-4786,4824-4829,5124-5153` |
| fragment runtime slice | `src/loop.ts:6084-6101` |
| materialize transaction | `src/loop.ts:4417-4503` |
| daemon cache/recovery | `src/daemon.ts:4448-4498,4606-4608` |
| doctor | `src/install-commands.ts:272-315` |
| migration consumer | `src/preset-migration-definition.ts:17-31` |
| compiler tests | `tests/unit/preset/compile.test.ts:18-413` |
| fragment tests | `tests/unit/preset/fragments.test.ts:16-197` |
| DAG checker/tests | `src/preset-dag-check.ts:84-101`; `tests/unit/preset/dag-check.test.ts` |

## B8. 尾部结论

S1 现存供给不是“未实现”：统一 compiler 主干、canonical tree identity、结构化 compile result、单一仓内 projection、typed boundary、source hash、plan 实体退役均可保留。但它也不是稳定 RFC 地基：**schema artifact 与 dead-fragment finding 无现存供给；daemon 成功缓存使同一路径定义在消费者间分叉；materialize 在拒绝前写入并 prune；finding 在 model、CLI、daemon observability、doctor 间没有一个不可拆错的公共同源链。** 因而 D1/§2 A/B/§2.3/2.4 总体只能判“部分符合”，D8 只能判“退役半边部分符合”，不得以 symbol 存在、31 个绿色测试或 bundled compile 成功覆盖这些反证。

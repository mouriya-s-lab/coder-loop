# 已实现代码事实核实(对照 AGGREGATE-547 逐域)

> 核实基线:`main@699842e`(2026-07-29 切换,含 #749)。方法:直接运行 AGGREGATE §5 的只读检测器 + 符号扫描 + `preset compile` 实跑。所有断言带 `path:line` 或命令输出。
> 结论先行:**草稿(7 月中旬认知)与代码现状的偏差远大于预期**——运行态半边(任务树/闭包/定义引用)已大幅落地,若干"待做"已被顺手完成,而聚合文档登记为跨树消费的关键能力(C1)已在本仓库。

## 0. 基线与 7 月中旬后合入的相关 PR

| PR | 内容 | 触及域 |
|---|---|---|
| #674 (55ff3b2) | CompiledTaskModel + `preset compile --json` | D1(已知) |
| #671 (a3ff0e9) | events 消费契约 | 观测面 |
| #677 (d381d06) | context entry 写入基座(`src/context-entry.ts`、`context_entries` 表) | 原§4-C 方向(#545)能力,已在本仓库 |
| #672 (b2b9295) | hook 四层声明模型(`src/hook-declarations.ts`) | **D5 的挂点词表已在本仓库** |
| #678 (9844e99) | runner `--add-dir` 授权面收敛 | 递出面 |
| #675 (9ac3b87) | **v3 任务树运行态持久化 + status 快照树 shape(含闭包状态表)** | D3/D10 运行态半边 |
| #751 (7172d3e) | 测试目录化重组(`tests/unit/**`、`tests/integration/**`) | 全部验收命令的测试路径引用过时 |
| #676→#759 | runner 缺席语义合入后**被 revert** | 警示:该线不稳定 |
| #749 (699842e) | 任务闭包资源生命周期:起点/挂起/重开/消费/启动对账(scheduler 145 处 closure 引用) | 供给条款(§2.5)的引擎侧实现 |
| — (ff08ca2) | gh-issue-pr-iteration 按 Claude runner 精简重构 | **plan 面已退役**(非 issue PR) |

另有两个树内验收脚本已存在:`scripts/issue-558-integration.ts`、`scripts/issue-560-integration.ts`(+ `src/issue-558-historical-fixture.ts`)——聚合 §4.3 里"不可识别"的 #558/#560 现已可识别为任务树持久化/闭包对账的 integration 验收。

## 1. 逐域现状

### D1 编译管线 — ✅ 已落地;两项遗留仍开放

实跑 `bun src/loop.ts preset compile gh-issue-pr-iteration --json`:`schemaVersion:1`;顶层八 keys 与契约精确集一致;`phases[0]` keys = `exits/identity/model/name/rights/runner/taskTree/toolRequirements/trigger/variables`;变量携带 `{key, type:"string", sourceKind}`;`tools: []` 占位;`preset.taskTree` 与 per-phase `taskTree` 均存在(退化 seq:`{kind:"seq", identity:"phase:iteration", children:[{kind:"phase", identity:"task:iteration"}]}`)。
遗留不变:schema artifact 分发(P-D1-1)无实现;doctor 与 findings 关系(P-D1-2)未裁。

### D2 变量绑定类型流 — ❌ 基本未动

- 静默 `""` 原样:`stringifyBindingValue` 对 null/undefined 返回 `""`(`src/loop.ts:6076`);item 缺失静默、chain 走 fallback、runtime throw(`src/loop.ts:6033-6056`)——三套失败语义不一致**原样保留**。
- 无 `ValueType`、无 `exit.*` source、无创建期 required 校验;compile 投影的 `type` 字段全 `"string"` 基线。

### D3 任务树 — **运行态半边已大幅落地(超出草稿认知);定义面与生产连接未做**

已在(#675/#749):
- 完整运行态 snapshot ADT:`src/task-runtime.ts` — leaf/seq/par 节点、`TaskNodeIdentity{runtimeNodeId, definitionRef, definitionNodeId}`、join `drain | validator`(candidate = `(definitionRef, candidateId)`,`src/task-runtime.ts:29-32`)、`ParReopenSnapshot{count, budgetRef}`、`pinCommit`、join `epoch/bindingVersion` 演化位(`src/task-runtime.ts:35-58`)。
- SQLite 全套表(schema **v16**,`src/sqlite-state.ts:810`):`execution_definitions / task_trees / task_nodes / task_{leaf,seq,par}_nodes / task_join_bindings / task_join_evaluation_bindings / task_closures / closure_reachability_* / closure_sessions / closure_consumption_intents / active_runs / context_entries`(`src/sqlite-state.ts:305`)。
- daemon 只读面:`store.getTaskTree` 多处消费、树遍历含穷尽 switch(`src/daemon.ts:1132-1150`)。
- closure 生命周期 + reachability + 消费采样在 scheduler 大量落地(#749)。

未在:
- **生产写入路径不存在**:`createTaskTree` 仅被 `scripts/issue-558-integration.ts:134`、`scripts/issue-560-integration.ts:333` 等 fixture 调用——运行态树不从任何定义生成,现行调度仍走 v2 线性 phase。
- DSL 无树声明位:`PresetTomlBoundary`(`src/loop.ts:508-513`)只有 name/statuses/phases/fragments 等,无 tree/tools/hooks/gates。
- transition path(P-D3-8/9)、par 调度 guard(P-D3-6)、装载期结构检查(P-D3-3)均无。

### D4 工具注册表 — ❌ 声明面未做;shape 占位已在

无 `[[tools]]` 声明位;compile 产物 `tools:[]`、`toolRequirements:"string[]"` 是 #549 占位(`src/loop.ts:573,580,2946`)。doctor 仍无条件查 `gh`(`src/install-commands.ts:143-148`)。

### D5 gate 声明位 — 挂点词表已在本仓库;preset 声明位未做

- `GateDecisionPoint` 封闭词表已在:`run.pre-spawn / run.post-exit / item.status-transition / container.advance / chain.complete / daemon.startup / daemon.shutdown / tick`(`src/hook-declarations.ts:15-27`),连同 hook 四层声明模型(#672)与 `PresetHookPlaceholder = {kind:"named-gate-placeholder"; name; point}` 类型(`src/hook-declarations.ts:48`)。
- **聚合 §4.2-C1 需要修正**:这不再是跨树未落地依赖,能力已在本仓库。
- **词表偏差**:代码词表是 `container.advance` / `chain.complete`,聚合(草稿锚定裁决)写的是 `container.join`(带稳定 node id)与"chain-complete 引用顶层 join identity"——命名与语义锚点不一致,需在拆分时对齐(→ 03 待裁)。
- preset TOML 无 gate 声明位、compile 无 gate 投影、能力握手无。

### D6 doc 渲染 — 大头已落地;剩余仅 boundary 精化

- `=== "ISSUE"` 特判**清零**(V-R2 该份额已达成,grep 无命中)。
- prefix 声明驱动已在:doc 声明字段 `prefix/suffix/style/blankBefore`(`src/loop.ts:672,4997,5015`,#611)。
- 剩余与旧树终版契约记载一致:`"variables?": "object"` 宽 boundary 仍在(`src/loop.ts:496`)。**证实并收窄 §6-4**:#735 的性质 2 过时,真实剩量只有 boundary 精化 + 测试 selector(测试已迁 `tests/unit/preset/`)。

### D7 GitHub 记法退役 — 部分完成;草稿预设的 migration 基线严重过时

已完成(#419/#456/#457 线):wire 层 `issueNumber` 整数选择器退役、opaque `itemId` 字符串已是 wire 词表(`src/daemon.ts:442,471,3576,5835`);umbrella 值已迁 `chain.metadata.bindings`(`src/daemon.ts:2189`,#457);`metadata.bindings` 通路已在(`src/loop.ts:2193,5538`)。
未完成:`DEFAULT_PRESET_NAME`(`src/daemon.ts:408`/`src/loop.ts:79`)、`REPOSITORY_REF_PATTERN`(`src/daemon.ts:429,4751`)、`normalizeQueueIssueId`(`src/loop.ts:4371`)、`inferRepositoryFromGit`(`src/loop.ts:4348`)全在;`--issue` flag 以向后兼容名义保留(`src/loop.ts:280,2051` 注释自认)。
**基线过时**:schema 已到 **v16**,聚合 V-7f 与 §6-8 说的"v13→v14"完全失效;repository 物理列现状需按 v16 重查(daemon 注释称物理列退役 tracked in #419)。

### D8 plan 面与 dead-fragment — 退役已完成(半个 issue 已被顺手做掉);检查未做

- `presets/gh-issue-pr-iteration/plan/` **目录不存在**;`role = "plan"` 计数 **0** —— V-R7 已达成,来源是 `ff08ca2`(preset 精简重构,非 issue PR)。
- dead-fragment 编译检查不存在:`src/preset-dag-check.ts` 仅有 R3 dead-vocabulary(`:25,62,219`)。V-R6 未达成。

### D9 chain preset fallback — ❌ 未退;但 presetless 语义已半在

`DEFAULT_PRESET_NAME` 仍是 seed 语义:未传 preset 时填默认名,注释明言"callers that explicitly want a presetless chain pass `preset: null`"(`src/daemon.ts:2172-2178`)——显式 null 的 presetless 通路**已存在**,待退的只是缺省时的 seed 行为。chain-complete trigger 仍是 v2 fingerprint 机制(`src/daemon.ts:645-719`),chain 层任务树声明无。

### D10 不可变执行定义 — 引用与持久化骨架已在;内容寻址与消费半边未做

已在:tagged `ExecutionDefinitionRef = PresetDefinitionRef | ChainDefinitionRef`(`src/task-runtime.ts:3-5`,带 arktype boundary `:61`)——**类型形态与聚合 P-D10-2 要求完全一致**;`execution_definitions` 表 + 任务节点外键引用(`src/sqlite-state.ts:654-671`)。
未在:表只存 `(kind, content_identity, semantic_hash, schema_version)`,**不存定义内容**;`semantic_hash` 用 identity 占位写入(`src/sqlite-state.ts:2360`);写入仅 fixture 路径;scheduler resume 从 pin 读定义(P-D10-3)无;缺失定义显式 hold(P-D10-4)无。

### D11 综合验收 — 测试基建重组完毕;两个树内 integration 驱动已在

测试树已目录化(#751):unit 在 `tests/unit/**`(含 `preset/compile.test.ts`、`sqlite-state/task-tree.test.ts`、`sqlite-state/migrations.test.ts`),integration 在 `tests/integration/{cli,scheduler,daemon}/`。聚合 §5 所有引用 `src/*.test.ts` 路径的验收命令(继承自草稿契约)**路径全部失效**。`scripts/issue-558-integration.ts`、`scripts/issue-560-integration.ts` 是运行态树/闭包的进程级验收驱动。

## 2. 对聚合文档的修正清单(现状核实产出)

1. **§4.2-C1 撤销**:`GateDecisionPoint` 已在本仓库(#672),D5 对它的依赖是树内既成事实;新增词表偏差待裁(`container.advance` vs `container.join`)。
2. **§4.3 收窄**:#558/#560 已可识别(任务树持久化/闭包对账,已合入且有 integration 驱动);剩余不可识别:#698/#706/#709/#710/#713/#726/#732/#733。
3. **§6-4 证实并扩大为"新 issue 系统性过时"**:D6 剩量仅 boundary 精化;D8 的 plan 退役半已完成;D7/D9 的 migration 基线(v13→v14)失效(现 v16);D9 的 presetless null 通路已半在;D3/D10 的运行态半边已落地——**九个 OPEN 实现 issue 无一与代码现状对齐**。
4. **§6-8 失效**:migration 序协调的对象版本号已不存在。
5. **§5 验收命令的测试路径引用需全部按 `tests/` 重写**(#751)。
6. **运行态/定义面分界是重拆的新事实基础**:v3 的"下半身"(运行态 ADT、SQLite、closure、identity 链、definitionRef)已建成且有 fixture 级验收;缺的是"上半身"(DSL 声明位、编译校验、compile→runtime 生产连接、类型流、工具/gate 声明)与两者的接线。草稿把这些当成一个 issue 的前后半,现实是它们已经是两个不同完成度的工程。

## 3. 现状核实的边界

- 未运行完整测试套件(`bun test`),上述以静态事实与单命令实跑为准。
- repository 物理列在 v16 的最终形态、`chains` 表当前列集未逐列核对。
- `ff08ca2`(plan 退役)等非 issue commit 的完整改动面未逐一审读。
- hook 四层(#672)的 chain 层绑定与执行深度、context entry(#677)的消费端未深查——它们属外树能力线,本次只登记存在性。
